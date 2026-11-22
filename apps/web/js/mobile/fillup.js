// Quick fill-up: the centre tab of the phone shell (route #/fill), also opened
// by legacy …/log?add=1 links. A full-height sheet that opens on the odometer
// with the decimal keypad, prefilled with the vehicle's latest reading and the
// current time. The save bar stays above the on-screen keyboard and carries a
// live economy preview, computed by ../economy.js exactly as the server will.
//
// Contract with the shell: openFillUp({ vehicle, onClose, edit })
//   - vehicle: the active vehicle (from GET /v1/vehicles), or null when the
//     account has none. Its id, odometerUnit and currency scope the form.
//   - edit: optional, a FillUp from the API. The sheet then opens prefilled
//     with its entered values, checks and previews it against the vehicle's
//     other records, and saves with PATCH. Corrections keep no draft.
//   - onClose({ saved }): called exactly once when the sheet goes away;
//     `saved` is true after a fill-up was stored, so the shell refreshes the
//     screen underneath.
//
// Values stay strings end to end; a locale keypad's comma becomes a point. The
// typed entry (form fields only) is kept in sessionStorage while the sheet is
// open, so a refresh restores it. It is dropped on save, on an explicit
// discard and on sign-out (clearFillUpDrafts). Nothing is written offline.
import { get, post, patch, ApiError } from '../api.js';
import { h, toast, select, confirmDialog } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../core.js';
import { UNIT, vehicleTitle, localInput, toInstant, date as shortDate, canAddFuel, canChangeFill } from '../format.js';
import { currencyOptions } from '../views/vehicles.js';
import {
  normalizeDecimal, checkDecimal, checkOccurredAt, checkSequence, previewInterval, latestFill, distanceBetween, unitPrice, difference, lowerIsBetter, RULES,
} from '../economy.js';
import { openSheet } from './sheet.js';
import { DRAFT_PREFIX, clearFillUpDrafts } from '../local.js';

// ---------- draft persistence ----------
const FIELDS = ['occurredAt', 'odometer', 'odometerUnit', 'volume', 'volumeUnit', 'amount', 'currency', 'exchangeRate', 'reportingAmount', 'full', 'missedPrevious', 'notes'];
const FLAGS = new Set(['full', 'missedPrevious']);
const onlyFields = (x) => Object.fromEntries(FIELDS.filter((k) => k in x).map((k) => [k, FLAGS.has(k) ? x[k] === true : String(x[k] ?? '')]));

function readDraft(key) {
  try { const raw = sessionStorage.getItem(key); return raw ? onlyFields(JSON.parse(raw)) : null; } catch { return null; }
}
function writeDraft(key, values) { try { sessionStorage.setItem(key, JSON.stringify(onlyFields(values))); } catch { /* not kept */ } }
function dropDraft(key) { try { sessionStorage.removeItem(key); } catch { /* nothing kept */ } }

export { clearFillUpDrafts };

// ---------- on-screen keyboard ----------
// The visual viewport shrinks under the keyboard; the sheet follows it through
// two custom properties (set via CSSOM, as the CSP forbids style attributes).
function trackViewport(dialog) {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  const update = () => {
    const height = vv ? vv.height : window.innerHeight;
    const keyboard = Math.max(0, window.innerHeight - height - (vv ? vv.offsetTop : 0));
    root.setProperty('--m-vvh', `${Math.round(height)}px`);
    root.setProperty('--m-kb', `${Math.round(keyboard)}px`);
    dialog.classList.toggle('m-kb-open', keyboard > 60);
  };
  update();
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  return () => {
    vv?.removeEventListener('resize', update);
    vv?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    root.removeProperty('--m-vvh');
    root.removeProperty('--m-kb');
  };
}

// ---------- copy ----------
const DECIMAL_MSG = {
  format: () => 'Use digits with an optional decimal point, like 42.5.',
  scale: (o) => `Use at most ${o.maxScale} decimal places.`,
  negative: () => 'This can’t be negative.',
  zero: () => 'This must be more than zero.',
  too_large: (o) => `This is more than the largest value allowed, ${o.max}.`,
};
const DATE_MSG = { format: 'Choose the date and time.', future: 'That is more than a day from now.', past: 'Choose a date after 1900.' };
const REASON_COPY = {
  partial_fill: ['Partial fill.', 'Economy for this tank appears after your next full fill-up.'],
  no_previous_full_fill: ['First full fill.', 'It sets the starting point; economy appears from the next full fill-up.'],
  no_distance: ['No distance.', 'The odometer has not moved since the last full fill, so there is no figure.'],
  missed_fill: ['Missed purchase.', 'A purchase before this one was not logged, so this tank has no figure.'],
};
const VOLUME_UNITS = [['l', 'L'], ['gal_us', 'US gal'], ['gal_imp', 'imp gal']];
const DISTANCE_UNITS = [['km', 'km'], ['mi', 'mi']];
const unitText = (u) => UNIT[u] ?? u;

let uid = 0;

export function openFillUp({ vehicle, onClose, edit = null } = {}) {
  if (!vehicle || vehicle.archived || !(edit ? canChangeFill(vehicle, edit, state.account?.id) : canAddFuel(vehicle))) return notAllowed(vehicle, onClose, edit);
  const v = vehicle;
  const key = edit ? null : `${DRAFT_PREFIX}${state.account?.id ?? ''}.${v.id}`;
  const n = ++uid;
  const formId = `fu-form-${n}`;
  let prefs = { distanceUnit: 'km', volumeUnit: 'l', economyUnit: 'l_per_100km', ...(state.prefs ?? {}) };
  let existing = null;      // the vehicle's fill-ups once loaded (API FillUp objects)
  let latest = null;
  let average = null;       // 90-day economy { value, unit }
  let saving = false;
  let saved = false;
  const touched = new Set();

  // ---------- fields ----------
  const decimalField = (name, label, unitControl, { hint = true, required = false, placeholder, enter = 'next' } = {}) => {
    const id = `fu-${name}-${n}`;
    const input = h('input', {
      id, name, type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', enterkeyhint: enter,
      class: 'm-fu-input', placeholder, 'aria-required': required ? 'true' : undefined,
      'aria-describedby': [hint ? `${id}-hint` : null, `${id}-err`].filter(Boolean).join(' '),
    });
    const hintEl = hint ? h('div', { id: `${id}-hint`, class: 'm-fu-hint' }) : null;
    const err = h('div', { id: `${id}-err`, class: 'm-fu-err' });
    const wrap = h('div', { class: 'm-fu-field' },
      h('label', { for: id, class: 'm-fu-label' }, label),
      h('div', { class: `m-fu-box${unitControl ? ' m-fu-has-unit' : ''}` }, input, unitControl ?? null),
      hintEl, err);
    return { name, input, hint: hintEl, err, wrap };
  };
  const unitSelect = (name, options, value, label) => select(name, options, value, { class: 'm-fu-unit', 'aria-label': label });

  const odoUnit = unitSelect('odometerUnit', DISTANCE_UNITS, v.odometerUnit, 'Odometer unit');
  const volUnit = unitSelect('volumeUnit', VOLUME_UNITS, prefs.volumeUnit, 'Fuel unit');
  const currency = unitSelect('currency', currencyOptions(v.currency), v.currency, 'Currency paid in');
  const odo = decimalField('odometer', 'Odometer', odoUnit, { required: true });
  odo.wrap.classList.add('m-fu-odo');
  const vol = decimalField('volume', 'Fuel', volUnit, { required: true, hint: false });
  const cost = decimalField('amount', 'Cost', currency, { placeholder: 'Optional', enter: 'done' });
  const rate = decimalField('exchangeRate', `Exchange rate (${v.currency} per 1 unit)`, null, { hint: false });
  const reporting = decimalField('reportingAmount', `Or the amount in ${v.currency}`, null, { hint: false, enter: 'done' });
  const rateBox = h('div', { class: 'm-fu-rate', hidden: true },
    h('p', { class: 'm-fu-note' }, 'A purchase in another currency needs one of these. No rate is ever assumed.'), rate.wrap, reporting.wrap);

  const whenId = `fu-when-${n}`;
  const when = h('input', { id: whenId, name: 'occurredAt', type: 'datetime-local', class: 'm-fu-when', value: localInput(), 'aria-describedby': `${whenId}-err` });
  const whenErr = h('div', { id: `${whenId}-err`, class: 'm-fu-err' });
  const dateField = { name: 'occurredAt', input: when, err: whenErr };

  const toggle = (name, title, sub, checked) => {
    const id = `fu-${name}-${n}`;
    const input = h('input', { id, name, type: 'checkbox', role: 'switch', class: 'm-switch', checked, 'aria-describedby': `${id}-d` });
    const subEl = h('span', { id: `${id}-d`, class: 'm-fu-toggle-sub' }, sub);
    return { input, subEl, row: h('div', { class: 'm-fu-toggle' }, h('label', { for: id, class: 'm-fu-toggle-text' }, h('span', { class: 'm-fu-toggle-title' }, title), subEl), input) };
  };
  const full = toggle('full', 'Filled the tank', 'Needed to work out economy', true);
  const missed = toggle('missedPrevious', 'I missed logging an earlier purchase', 'This tank then gets no economy figure', false);
  const notesId = `fu-notes-${n}`;
  const notes = h('textarea', { id: notesId, name: 'notes', maxlength: 500, rows: 2, class: 'm-fu-notes' });

  const restored = h('p', { class: 'm-fu-restored', role: 'status', hidden: true }, icon('history'), h('span', {}, 'Restored the entry you were typing.'));
  const loadNote = h('p', { class: 'm-fu-note', hidden: true });

  // ---------- preview ----------
  const pvBig = h('span', { class: 'm-fu-pv-big' });
  const pvUnit = h('span', { class: 'm-fu-pv-unit' });
  const pvDetail = h('p', { class: 'm-fu-pv-detail' });
  const pvCompare = h('p', { class: 'm-fu-pv-compare', hidden: true });
  const pvTitleId = `fu-pv-${n}`;
  const preview = h('section', { class: 'm-fu-preview', 'aria-labelledby': pvTitleId },
    h('h3', { id: pvTitleId, class: 'm-label' }, 'This tank · preview'),
    h('p', { class: 'm-fu-pv-line' }, pvBig, pvUnit), pvDetail, pvCompare);

  // ---------- save bar ----------
  const barValue = h('span', { class: 'm-fu-bar-value' }, '—');
  const barMsgId = `fu-msg-${n}`;
  const barMsg = h('p', { id: barMsgId, class: 'm-fu-bar-msg', role: 'alert', hidden: true });
  const saveLabel = edit ? 'Save changes' : 'Save fill-up';
  const saveBtn = h('button', { type: 'submit', form: formId, class: 'm-fu-save' }, icon('check'), h('span', {}, saveLabel));
  const footer = h('div', { class: 'm-fu-bar' },
    h('div', { class: 'm-fu-bar-preview', 'aria-live': 'polite', 'aria-atomic': 'true' }, h('span', { class: 'm-fu-bar-k' }, 'This tank'), ' ', barValue),
    barMsg,
    h('div', { class: 'm-fu-bar-actions' },
      h('button', { type: 'button', class: 'secondary m-fu-cancel', onclick: () => sheet.requestClose() }, 'Cancel'),
      saveBtn));

  const form = h('form', { id: formId, class: 'm-fu-form', novalidate: true },
    restored, loadNote, odo.wrap,
    h('div', { class: 'm-fu-pair' }, vol.wrap, cost.wrap),
    rateBox,
    full.row,
    h('div', { class: 'm-fu-field' }, h('label', { for: whenId, class: 'm-fu-label' }, 'Date and time'), when, whenErr),
    h('details', { class: 'm-fu-more' },
      h('summary', {}, h('span', { class: 'm-fu-more-text' }, h('span', { class: 'm-fu-toggle-title' }, 'More options'), h('span', { class: 'm-fu-toggle-sub' }, 'Missed purchase, notes')), icon('chevron', 'icon m-fu-more-caret')),
      missed.row,
      h('div', { class: 'm-fu-field' }, h('label', { for: notesId, class: 'm-fu-label' }, 'Notes'), notes)),
    preview);

  // ---------- values ----------
  const values = () => ({
    occurredAt: when.value, odometer: odo.input.value, odometerUnit: odoUnit.value, volume: vol.input.value, volumeUnit: volUnit.value,
    amount: cost.input.value, currency: currency.value, exchangeRate: rate.input.value, reportingAmount: reporting.input.value,
    full: full.input.checked, missedPrevious: missed.input.checked, notes: notes.value,
  });
  const apply = (x) => {
    if ('occurredAt' in x) when.value = x.occurredAt;
    if ('odometer' in x) odo.input.value = x.odometer;
    if (DISTANCE_UNITS.some(([u]) => u === x.odometerUnit)) odoUnit.value = x.odometerUnit;
    if ('volume' in x) vol.input.value = x.volume;
    if (VOLUME_UNITS.some(([u]) => u === x.volumeUnit)) volUnit.value = x.volumeUnit;
    if ('amount' in x) cost.input.value = x.amount;
    if (x.currency && [...currency.options].some((o) => o.value === x.currency)) currency.value = x.currency;
    if ('exchangeRate' in x) rate.input.value = x.exchangeRate;
    if ('reportingAmount' in x) reporting.input.value = x.reportingAmount;
    if ('full' in x) full.input.checked = x.full;
    if ('missedPrevious' in x) missed.input.checked = x.missedPrevious;
    if ('notes' in x) notes.value = x.notes;
  };
  // A correction starts from what was entered, not the converted display values.
  if (edit) {
    const c = edit.cost;
    apply({
      occurredAt: localInput(new Date(edit.occurredAt)), odometer: edit.odometer.value, odometerUnit: edit.odometer.unit,
      volume: edit.volume.value, volumeUnit: edit.volume.unit, amount: c?.amount ?? '', currency: c?.currency ?? v.currency,
      exchangeRate: c?.exchangeRate ?? '', reportingAmount: c && c.currency !== v.currency && !c.exchangeRate ? c.reportingAmount : '',
      full: edit.full, missedPrevious: edit.missedPrevious, notes: edit.notes ?? '',
    });
    if (edit.missedPrevious || edit.notes) form.querySelector('.m-fu-more').open = true;
  }
  let pristine = values();
  const isDirty = () => { const now = values(); return FIELDS.some((k) => now[k] !== pristine[k]); };

  const draft = key ? readDraft(key) : null;
  if (draft) { apply(draft); restored.hidden = false; }

  // ---------- validation (the server's rules, on strings) ----------
  const setError = (f, message) => {
    f.err.textContent = message ?? '';
    f.err.classList.toggle('m-fu-err-on', !!message);
    if (message) f.input.setAttribute('aria-invalid', 'true'); else f.input.removeAttribute('aria-invalid');
    return message ?? null;
  };
  const decimalError = (raw, rule, emptyMessage) => {
    const s = normalizeDecimal(raw);
    if (!s) return emptyMessage ?? null;
    const code = checkDecimal(s, rule);
    return code ? DECIMAL_MSG[code](rule) : null;
  };
  const occurredAt = () => (when.value ? new Date(when.value) : null);
  const dateError = () => { const d = occurredAt(); const code = d ? checkOccurredAt(d) : 'format'; return code ? DATE_MSG[code] : null; };
  const otherCurrency = () => currency.value !== v.currency;

  const checks = {
    odometer: () => {
      const e = decimalError(odo.input.value, RULES.odometer, 'Enter the odometer reading.');
      if (e || !existing || dateError()) return e;
      const out = checkSequence(existing, { occurredAt: occurredAt(), odometer: { value: normalizeDecimal(odo.input.value), unit: odoUnit.value } });
      return out ? `${out.detail} Check the digits.` : null;
    },
    volume: () => decimalError(vol.input.value, RULES.volume, 'Enter how much fuel you bought.'),
    amount: () => decimalError(cost.input.value, RULES.amount),
    exchangeRate: () => {
      if (!otherCurrency() || !normalizeDecimal(cost.input.value)) return null;
      const e = decimalError(rate.input.value, RULES.exchangeRate);
      if (e) return e;
      return normalizeDecimal(rate.input.value) || normalizeDecimal(reporting.input.value) ? null : `Add the exchange rate or the amount in ${v.currency}.`;
    },
    reportingAmount: () => (otherCurrency() && normalizeDecimal(cost.input.value) ? decimalError(reporting.input.value, RULES.reportingAmount) : null),
    occurredAt: dateError,
  };
  const fields = { odometer: odo, volume: vol, amount: cost, exchangeRate: rate, reportingAmount: reporting, occurredAt: dateField };
  const check = (name) => setError(fields[name], checks[name]());
  const checkAll = () => Object.keys(checks).filter((name) => check(name));

  // A message appearing on blur moves the rows below it. While a finger or
  // button is down, wait until its click has landed, so the tap that caused
  // the blur still reaches the control under it.
  let pressed = false;
  const pending = new Set();
  const checkSoon = (name) => { if (pressed) pending.add(name); else { check(name); recount(); } };
  const released = () => {
    pressed = false;
    setTimeout(() => { for (const name of pending) check(name); pending.clear(); recount(); }, 0);
  };

  // ---------- live preview ----------
  const setPreview = (big, unit, detail) => {
    pvBig.textContent = big; pvUnit.textContent = unit; pvDetail.textContent = detail;
    preview.classList.toggle('m-fu-preview-empty', !unit);
  };
  const setBar = (text) => { if (barValue.textContent !== text) barValue.textContent = text; };
  function updatePreview() {
    pvCompare.hidden = true;
    const odoValue = normalizeDecimal(odo.input.value), volValue = normalizeDecimal(vol.input.value);
    // Odometer hint: the latest reading and the distance since it.
    if (latest) {
      const okOdo = odoValue && !checkDecimal(odoValue, RULES.odometer);
      const dist = okOdo ? distanceBetween(latest.odometer.value, latest.odometer.unit, odoValue, odoUnit.value) : null;
      odo.hint.textContent = `Last reading ${latest.odometer.value} ${unitText(latest.odometer.unit)} on ${shortDate(latest.occurredAt)}${dist !== null ? ` · ${dist.startsWith('-') ? '' : '+'}${dist} ${unitText(odoUnit.value)}` : ''}`;
    }
    // Price per unit, a hint only.
    const amount = normalizeDecimal(cost.input.value);
    cost.hint.textContent = amount && volValue && !checkDecimal(amount, RULES.amount) && !checkDecimal(volValue, RULES.volume)
      ? `${unitPrice(amount, volValue)} ${currency.value}/${unitText(volUnit.value)}` : '';

    if (!full.input.checked) {
      const [title, text] = REASON_COPY.partial_fill;
      setPreview(title, '', text); setBar('Partial fill, no figure yet'); return;
    }
    if (!existing) { setPreview('—', '', loadNote.hidden ? 'Loading this vehicle’s records…' : 'The preview needs this vehicle’s records.'); setBar('—'); return; }
    if (!odoValue || !volValue || checkDecimal(odoValue, RULES.odometer) || checkDecimal(volValue, RULES.volume) || dateError()) {
      setPreview('—', '', 'Enter the odometer reading and the fuel to see this tank’s economy.'); setBar('—'); return;
    }
    const draftFill = { occurredAt: occurredAt(), odometer: { value: odoValue, unit: odoUnit.value }, volume: { value: volValue, unit: volUnit.value }, full: true, missedPrevious: missed.input.checked };
    if (checkSequence(existing, draftFill)) { setPreview('—', '', 'Check the odometer reading.'); setBar('—'); return; }
    const i = previewInterval(existing, draftFill, prefs);
    if (!i.available) {
      const [title, text] = REASON_COPY[i.reason] ?? ['No figure.', ''];
      setPreview(title, '', text); setBar(title.replace(/\.$/, '')); return;
    }
    const unit = unitText(i.economy.unit);
    setPreview(i.economy.value, unit, `${i.distance.value} ${unitText(i.distance.unit)} on ${i.volume.value} ${unitText(i.volume.unit)}`);
    setBar(`${i.economy.value} ${unit}`);
    if (average && average.unit === i.economy.unit) {
      const diff = difference(i.economy.value, average.value);
      const abs = diff.replace(/^-/, '');
      pvCompare.hidden = false;
      if (/^[0.]+$/.test(abs)) { pvCompare.replaceChildren(`Same as your 90-day average of ${average.value}.`); return; }
      const higher = !diff.startsWith('-');
      const better = higher !== lowerIsBetter(i.economy.unit);
      pvCompare.replaceChildren(
        h('span', { 'aria-hidden': 'true' }, higher ? '▲ ' : '▼ '),
        `${abs} ${higher ? 'above' : 'below'} your 90-day average of ${average.value}, `,
        h('strong', { class: better ? 'good' : 'bad' }, better ? 'better' : 'worse'), '.');
    }
  }

  // ---------- connection ----------
  // "Fix N fields" follows the fields as they are corrected.
  let fixShown = false;
  const recount = () => {
    if (!fixShown) return;
    const left = Object.values(fields).filter((f) => f.input.getAttribute('aria-invalid')).length;
    if (left) message(`Fix ${left} ${left === 1 ? 'field' : 'fields'} to save.`); else { message(null); fixShown = false; }
  };
  const message = (text, tone = 'bad') => { barMsg.textContent = text ?? ''; barMsg.hidden = !text; barMsg.dataset.tone = tone; };
  let offlineShown = false;
  function updateOnline() {
    const offline = navigator.onLine === false;
    saveBtn.disabled = offline || saving;
    if (offline) { saveBtn.setAttribute('aria-describedby', barMsgId); message('You are offline. Your entry stays on this phone; saving needs a connection.', 'warn'); offlineShown = true; }
    else if (offlineShown) { saveBtn.removeAttribute('aria-describedby'); message(null); offlineShown = false; }
  }

  // ---------- events ----------
  const persist = () => { if (!key) return; if (isDirty()) writeDraft(key, values()); else dropDraft(key); };
  for (const f of [odo, vol, cost, rate, reporting]) {
    f.input.addEventListener('input', () => {
      // A comma from a locale keypad becomes a point as it is typed.
      if (f.input.value.includes(',')) {
        const at = f.input.selectionStart;
        f.input.value = f.input.value.replace(/,/g, '.');
        if (at !== null) f.input.setSelectionRange(at, at);
      }
      touched.add(f.name);
      if (f.input.getAttribute('aria-invalid')) { check(f.name); recount(); }
    });
    f.input.addEventListener('blur', () => { if (touched.has(f.name) || f.input.value) checkSoon(f.name); });
  }
  const ORDER = [odo.input, vol.input, cost.input, rate.input, reporting.input];
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement || e.target.tagName === 'SUMMARY') return;
    // Return moves to the next field; Save is a deliberate tap.
    e.preventDefault();
    const visible = ORDER.filter((x) => x.offsetParent !== null);
    const next = visible[visible.indexOf(e.target) + 1];
    if (next) next.focus(); else e.target.blur();
  });
  form.addEventListener('input', () => { touched.add('any'); persist(); updatePreview(); });
  form.addEventListener('change', (e) => {
    if (e.target === currency) { rateBox.hidden = !otherCurrency(); if (rateBox.hidden) { setError(rate, null); setError(reporting, null); } }
    if (e.target === when || e.target === odoUnit) { check('occurredAt'); if (normalizeDecimal(odo.input.value)) check('odometer'); recount(); }
    persist(); updatePreview();
  });
  rateBox.hidden = !otherCurrency();
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving || navigator.onLine === false) return;
    message(null); fixShown = false;
    const bad = checkAll();
    if (bad.length) {
      message(`Fix ${bad.length} ${bad.length === 1 ? 'field' : 'fields'} to save.`);
      fixShown = true;
      fields[bad[0]].input.focus();
      return;
    }
    const x = values();
    const amount = normalizeDecimal(x.amount);
    const body = {
      occurredAt: toInstant(x.occurredAt),
      odometer: { value: normalizeDecimal(x.odometer), unit: x.odometerUnit },
      volume: { value: normalizeDecimal(x.volume), unit: x.volumeUnit },
      full: x.full, missedPrevious: x.missedPrevious, notes: x.notes,
      cost: amount ? {
        amount, currency: x.currency,
        ...(x.currency !== v.currency ? { exchangeRate: normalizeDecimal(x.exchangeRate) || null, reportingAmount: normalizeDecimal(x.reportingAmount) || null } : {}),
      } : null,
    };
    saving = true; updateOnline();
    saveBtn.lastChild.textContent = 'Saving…';
    try {
      const made = edit ? await patch(`/v1/vehicles/${v.id}/fill-ups/${edit.id}`, body) : await post(`/v1/vehicles/${v.id}/fill-ups`, body);
      if (key) dropDraft(key);
      saved = true;
      const e2 = made?.interval?.available ? made.interval.economy : null;
      sheet.close();
      const done = edit ? 'Fill-up updated' : 'Fill-up saved';
      toast(e2 ? `${done} · ${e2.value} ${unitText(e2.unit)}` : `${done}.`);
    } catch (err) {
      serverError(err);
    } finally {
      saving = false;
      if (!saved) { saveBtn.lastChild.textContent = saveLabel; updateOnline(); }
    }
  });

  function serverError(err) {
    if (!(err instanceof ApiError)) {
      message('Not saved: the server could not be reached. Your entry is kept here; try again when you are connected.');
      return;
    }
    const map = [[/^occurredAt/, dateField], [/^odometer/, odo], [/^volume/, vol], [/^cost\.exchangeRate/, rate], [/^cost\.reportingAmount/, reporting], [/^cost/, cost]];
    let target = null;
    if (err.code === 'odometer_out_of_sequence') { target = odo; setError(odo, `${err.message} Check the digits.`); }
    else if (err.code === 'duplicate_fill_up') { target = odo; setError(odo, err.message); }
    else if (err.code === 'reporting_amount_required') { target = rate; setError(rate, `Add the exchange rate or the amount in ${v.currency}.`); }
    else if (err.code === 'validation_failed') {
      const hit = map.find(([re]) => re.test(err.message));
      if (hit) { target = hit[1]; setError(target, err.message); }
    }
    message(target ? 'Not saved. Fix the highlighted field.' : `Not saved. ${err.message}`);
    target?.input.focus();
  }

  // ---------- open ----------
  const sheet = openSheet({
    title: edit ? 'Edit fill-up' : 'Add a fill-up', sub: vehicleTitle(v), size: 'full', className: 'm-fill', label: 'Close without saving',
    content: form, footer,
    guard: async () => {
      if (!isDirty()) { if (key) dropDraft(key); return true; }
      const discard = await confirmDialog(edit ? 'Discard your changes to this fill-up?' : 'Discard this fill-up? What you typed will be lost.', 'Discard', true, 'Keep editing');
      if (discard && key) dropDraft(key);
      return discard;
    },
    onClose: () => {
      stopViewport();
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
      onClose?.({ saved });
    },
  });
  const stopViewport = trackViewport(sheet.dialog);
  sheet.dialog.addEventListener('pointerdown', () => { pressed = true; }, true);
  sheet.dialog.addEventListener('pointerup', released, true);
  sheet.dialog.addEventListener('pointercancel', released, true);
  updateOnline();
  updatePreview();
  odo.input.focus();
  odo.input.select();

  // The latest reading, the records the preview needs and the 90-day average.
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  Promise.all([
    get(`/v1/vehicles/${v.id}/fill-ups?limit=5000`),
    get('/v1/preferences').catch(() => null),
    get(`/v1/vehicles/${v.id}/stats?from=${encodeURIComponent(since)}`).catch(() => null),
  ]).then(([list, p, stats]) => {
    if (!sheet.dialog.isConnected) return;
    if (p) prefs = { ...prefs, distanceUnit: p.distanceUnit, volumeUnit: p.volumeUnit, economyUnit: p.economyUnit };
    // A correction is checked against the other records only, never against itself.
    existing = edit ? list.items.filter((x) => x.id !== edit.id) : list.items;
    latest = edit ? null : latestFill(existing);
    average = stats?.economy ?? null;
    if (latest && !draft && !touched.size && !odo.input.value) {
      const reading = latest.odometer.unit === odoUnit.value ? latest.odometer.value
        : latest.display.odometer.unit === odoUnit.value ? latest.display.odometer.value : '';
      odo.input.value = reading;
      pristine = { ...pristine, odometer: reading };
      if (document.activeElement === odo.input) odo.input.select();
    }
    if (!latest && !edit) odo.hint.textContent = 'The first fill-up for this vehicle.';
    if (touched.has('odometer') || draft) check('odometer');
    updatePreview();
  }, () => {
    if (!sheet.dialog.isConnected) return;
    loadNote.hidden = false;
    loadNote.textContent = 'This vehicle’s records could not be loaded, so the odometer check and the preview are unavailable. You can still save.';
    updatePreview();
  });
  return sheet;
}

/** No vehicle, a read-only role (or another member's fill-up) or an archived vehicle: say why, offer the way on. */
function notAllowed(vehicle, onClose, edit = null) {
  const content = !vehicle
    ? [h('p', {}, 'Add a vehicle first, then log its fill-ups here.'), h('a', { class: 'button m-wide', href: '#/garage' }, icon('car'), 'Go to Vehicles')]
    : [h('p', {}, vehicle.archived ? 'This vehicle is archived. Unarchive it to add fill-ups.' : edit ? 'You can change only the fill-ups you logged.' : 'You can view this vehicle but not add fill-ups to it.')];
  return openSheet({ title: 'Add a fill-up', sub: vehicle ? vehicleTitle(vehicle) : null, size: 'full', content, onClose: () => onClose?.({ saved: false }) });
}
