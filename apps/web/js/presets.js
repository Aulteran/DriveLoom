// Community maintenance recommendations: the banner on the Maintenance tab and
// the five-step review-and-import flow. Presets are advisory suggestions that
// ship with this server; nothing is fetched, nothing is added until the owner
// finishes the flow, and nothing here writes odometer or fuel data. The server
// works out every due point (the preview call), this file only presents it and
// never claims a task is up to date when it has no completed service behind it.
// Reminders are not part of this flow: imported tasks start with email
// reminders off and are turned on later, per task, in the task editor.
import { get, post } from './api.js';
import { h, field, select } from './ui.js';
import { icon } from './icons.js';
import { plainDate } from './format.js';

/** The matching presets for this vehicle, or null when the module is off or the call fails (the tab then looks exactly as before). */
export const loadPresets = async (v) => { try { return await get(`/v1/vehicles/${v.id}/maintenance/presets`); } catch { return null; } };

/** Presets that still have something to offer: at least one task the vehicle has not already imported. */
export const offerable = (list) => (list?.items ?? []).filter((p) => p.tasks.some((t) => !t.alreadyImported));

export const TRUST_LABEL = { community: 'Community suggestion — not an official manufacturer requirement', manufacturer: 'Manufacturer information' };

const num = (n) => Number(n).toLocaleString();
const dist = (d) => (d ? `${num(d.value)} ${d.unit}` : '');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DECIMAL = /^\d+(\.\d{1,3})?$/;

/** An interval in plain words: "Every 6 months or 5,000 mi, whichever comes first". */
export function ruleText(months, distance) {
  const parts = [];
  if (months) parts.push(`${months} month${Number(months) === 1 ? '' : 's'}`);
  if (distance) parts.push(dist(distance));
  if (!parts.length) return 'No interval set';
  return `Every ${parts.join(' or ')}${parts.length > 1 ? ', whichever comes first' : ''}`;
}

const presetTitle = (p, list) => [p.year ?? list.vehicle.year ?? (p.yearRange ? p.yearRange.join('–') : null), list.vehicle.make ?? p.make, list.vehicle.model ?? p.model].filter(Boolean).join(' ');

/** The banner (or the gentle hint) at the top of the Maintenance tab. Read-only members see nothing. */
export function presetBanner(v, list, { phone = false, onReview }) {
  if (!list?.canApply) return null;
  const offered = offerable(list);
  const cls = `${phone ? 'm-card ' : 'panel '}mt-note pr-banner`;
  if (offered.length) {
    return h('section', { class: cls, 'aria-label': 'Maintenance recommendations' }, icon('list'),
      h('div', { class: 'pr-banner-text' },
        h('strong', {}, 'Maintenance recommendations available'),
        h('p', { class: 'small muted' }, 'Suggested maintenance tasks for this vehicle are ready to review. They are advisory, and nothing is added unless you choose to import it.')),
      offered.map((p) => h('button', { type: 'button', class: 'secondary', 'aria-label': offered.length > 1 ? `Review maintenance recommendations for ${presetTitle(p, list)}` : 'Review maintenance recommendations', onclick: () => onReview(p) }, 'Review')));
  }
  if (list.missing.length) {
    const words = list.missing.map((m) => (m === 'year' ? 'model year' : m));
    return h('p', { class: `${phone ? 'm-card ' : 'panel '}mt-note small muted pr-hint` }, icon('list'),
      `Add this vehicle's ${words.join(', ').replace(/, ([^,]*)$/, ' and $1')} in its details and DriveLoom can check whether maintenance recommendations are available for it.`);
  }
  return null;
}

/** A modal dialog for the desktop page (the phone shell uses its bottom sheet instead). Escape and the close button close it. */
export function openDialog(title, build, onClose) {
  const back = document.activeElement;
  const id = `pr-dialog-${Math.random().toString(36).slice(2, 9)}`;
  const d = h('dialog', { class: 'pr-dialog', 'aria-labelledby': id },
    h('div', { class: 'pr-dialog-head' }, h('h2', { id }, title), h('button', { type: 'button', class: 'ghost', 'aria-label': 'Close', onclick: () => d.close() }, icon('close'))),
    build(() => d.close()));
  d.addEventListener('close', () => {
    d.remove();
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    onClose?.();
  }, { once: true });
  document.body.append(d);
  d.showModal();
  d.querySelector('[data-step-title]')?.focus();
}

const STEPS = ['Confirm vehicle', 'Review tasks', 'Starting points', 'Preview', 'Import'];

/**
 * The review-and-import flow for one preset. `summary` is the Maintenance
 * status (for the latest odometer reading); `close()` closes the dialog or
 * sheet; `onImported()` is told once the import went through so the caller can
 * refresh the list however the dialog ends up closing.
 */
export function presetFlow(v, list, preset, { summary, close, onImported }) {
  const today = ymd(new Date());
  const st = {
    market: false, variant: '', preview: null, done: null,
    rows: preset.tasks.map((t) => ({
      t, imported: !!t.alreadyImported, on: !t.alreadyImported,
      months: t.rule.months ? String(t.rule.months) : '', dist: t.rule.distance?.value ?? '', unit: t.rule.distance?.unit ?? v.odometerUnit,
      mode: 'unknown', date: '', odo: '', odoUnit: v.odometerUnit, link: '', linkOk: false, dup: 'skip',
    })),
  };
  const chosen = () => st.rows.filter((r) => r.on && !r.imported);
  const root = h('div', { class: 'pr-flow' });
  let previewSeq = 0;

  const errBox = () => h('div', { class: 'error', role: 'alert', hidden: true });
  const showErr = (box, msg) => { box.textContent = msg; box.hidden = false; box.scrollIntoView?.({ block: 'nearest' }); };
  const heading = (n, text) => [h('p', { class: 'small muted pr-progress' }, `Step ${n + 1} of ${STEPS.length}`), h('h3', { tabindex: -1, 'data-step-title': '' }, text)];
  const actions = (...btns) => h('div', { class: 'row pr-actions' }, btns);
  const back = (n) => h('button', { type: 'button', class: 'secondary', onclick: () => show(n) }, 'Back');
  const trustText = (t) => TRUST_LABEL[t.trust];
  const changed = (r) => {
    const m = r.months === '' ? null : Number(r.months);
    const d = r.dist === '' ? null : { value: r.dist, unit: r.unit };
    const p = r.t.rule;
    const sameD = (!d && !p.distance) || (d && p.distance && Number(d.value) === Number(p.distance.value) && d.unit === p.distance.unit);
    return { months: m !== (p.months ?? null), distance: !sameD };
  };

  /** Edited intervals become overrides; untouched fields are left to the preset. */
  const body = () => ({
    ...(st.variant ? { variant: st.variant } : {}),
    tasks: chosen().map((r) => {
      const c = changed(r);
      const overrides = {};
      if (c.months) overrides.intervalMonths = r.months === '' ? null : Number(r.months);
      if (c.distance) overrides.intervalDistance = r.dist === '' ? null : { value: r.dist, unit: r.unit };
      let baseline = { kind: 'none' };
      if (r.mode === 'tracking') baseline = { kind: 'tracking' };
      else if (r.mode === 'known') {
        if (r.link && r.linkOk) baseline = { kind: 'reported', linkServiceItemId: r.link };
        else baseline = { kind: 'reported', ...(r.date ? { on: r.date } : {}), ...(r.odo ? { odometer: { value: r.odo, unit: r.odoUnit } } : {}) };
      }
      return { presetTaskId: r.t.id, ...(Object.keys(overrides).length ? { overrides } : {}), baseline, onDuplicate: r.dup };
    }),
  });

  // ---- 1. vehicle and scope ----
  function step1() {
    const err = errBox();
    const market = h('input', { type: 'checkbox', checked: st.market, onchange: (e) => { st.market = e.target.checked; } });
    const variant = preset.needsQualifier.length
      ? field('Which version of this vehicle is it?', select('variant', [['', 'Choose one…'], ...preset.needsQualifier.map((x) => [x, x])], st.variant, { onchange: (e) => { st.variant = e.target.value; } }),
        'This preset differs by version, so DriveLoom asks instead of guessing.')
      : null;
    const sources = preset.sources.length
      ? h('ul', { class: 'pr-sources', 'aria-label': 'Sources' }, preset.sources.map((s) => h('li', {},
        /^https?:\/\//i.test(s.url) ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title) : s.title,
        ` (${s.kind === 'manufacturer' ? 'manufacturer information' : 'community source'})`, s.note ? ` — ${s.note}` : '')))
      : h('p', { class: 'small muted' }, 'This preset lists no external sources. Treat every interval as a starting suggestion.');
    return [
      ...heading(0, 'Confirm your vehicle'),
      h('p', {}, h('strong', {}, presetTitle(preset, list))),
      h('p', { class: 'small' }, 'These recommendations are advisory. They are bundled with this DriveLoom server and were not downloaded or looked up for you. Check every interval against your owner\'s manual or your mechanic.'),
      h('p', { class: 'small muted' }, `Reviewed on ${plainDate(preset.reviewedOn)}.`),
      h('h4', { class: 'pr-sub' }, 'Where this comes from'), sources,
      h('label', { class: 'check' }, market, 'This vehicle is a US-market vehicle'),
      h('p', { class: 'small muted' }, 'DriveLoom does not store a market for vehicles, so please confirm. Only US recommendations are available for now.'),
      variant, err,
      actions(h('button', { type: 'button', onclick: () => {
        if (!st.market) return showErr(err, 'Confirm that this is a US-market vehicle to continue.');
        if (preset.needsQualifier.length && !st.variant) return showErr(err, 'Choose which version of the vehicle this is.');
        show(1);
      } }, 'Next')),
    ];
  }

  // ---- 2. review and customise ----
  function step2() {
    const err = errBox();
    const cards = st.rows.map((r, i) => {
      const t = r.t;
      if (r.imported) {
        return h('li', { class: 'pr-task' }, h('strong', {}, t.name), h('p', { class: 'small muted' }, `Already imported${t.alreadyImported.archived ? ' (the task is archived)' : ''}. It stays exactly as it is.`));
      }
      const live = h('p', { class: 'small pr-rule', 'aria-live': 'polite' });
      const edited = h('p', { class: 'small muted', 'aria-live': 'polite' });
      const refresh = () => {
        live.textContent = ruleText(r.months, r.dist ? { value: r.dist, unit: r.unit } : null);
        const c = changed(r);
        edited.textContent = c.months || c.distance ? 'You changed this interval. It is saved as your own interval; the preset only stays on record as where the task started.' : '';
      };
      const months = h('input', { type: 'number', min: 1, max: 1200, step: 1, inputmode: 'numeric', value: r.months, oninput: (e) => { r.months = e.target.value.trim(); refresh(); } });
      const distance = h('input', { inputmode: 'decimal', value: r.dist, 'aria-label': `Distance interval for ${t.name}`, oninput: (e) => { r.dist = e.target.value.trim(); refresh(); } });
      const unit = select(`unit-${i}`, [['km', 'km'], ['mi', 'mi']], r.unit, { 'aria-label': `Distance unit for ${t.name}`, onchange: (e) => { r.unit = e.target.value; refresh(); } });
      const include = h('input', { type: 'checkbox', checked: r.on, onchange: (e) => { r.on = e.target.checked; } });
      refresh();
      return h('li', { class: 'pr-task' },
        h('label', { class: 'check' }, include, h('span', {}, 'Include ', h('strong', {}, t.name))),
        h('p', { class: 'small' }, t.description),
        h('p', { class: 'small pr-trust' }, h('span', { class: `badge ${t.trust === 'manufacturer' ? 'accent' : ''}` }, trustText(t))),
        t.sourceNote ? h('p', { class: 'small muted' }, t.sourceNote) : null,
        t.existingTaskMatch ? h('p', { class: 'small pr-dup-note' }, icon('alert'), `You already have a similar task, "${t.existingTaskMatch.name}". You will choose what to do about it in step 4.`) : null,
        live, edited,
        h('div', { class: 'grid' },
          field(`${t.name}: every how many months (optional)`, months, 'Calendar months.'),
          field(`${t.name}: every how far (optional)`, h('div', { class: 'inline' }, distance, unit), 'If you keep both, the task is due when either comes first.')));
    });
    return [
      ...heading(1, 'Review the tasks'),
      h('p', { class: 'small' }, 'Untick any task you do not want. Change an interval if your manual or mechanic says otherwise. These tasks are the only ones in the preset; nothing else is added.'),
      h('ul', { class: 'pr-tasks', 'aria-label': 'Suggested tasks' }, cards), err,
      actions(back(0), h('button', { type: 'button', onclick: () => {
        const on = chosen();
        if (!on.length) return showErr(err, 'Choose at least one task to import.');
        for (const r of on) {
          const label = r.t.name;
          if (r.months === '' && r.dist === '') return showErr(err, `${label}: keep at least one interval, in months or distance.`);
          if (r.months !== '' && !(/^\d+$/.test(r.months) && Number(r.months) >= 1 && Number(r.months) <= 1200)) return showErr(err, `${label}: months must be a whole number from 1 to 1200.`);
          if (r.dist !== '' && !(DECIMAL.test(r.dist) && Number(r.dist) > 0)) return showErr(err, `${label}: distance must be a positive number.`);
        }
        show(2);
      } }, 'Next')),
    ];
  }

  // ---- 3. baseline per task ----
  function step3() {
    const err = errBox();
    const r0 = summary?.reading;
    const reading = r0
      ? `Latest odometer on record: ${dist(r0.odometer)} on ${plainDate(r0.on)}${r0.stale ? ' (an old reading)' : ''}.`
      : 'No odometer reading is on record yet.';
    const sections = chosen().map((r, i) => {
      const t = r.t;
      const detail = h('div', { class: 'pr-baseline-detail' });
      const draw = () => {
        detail.replaceChildren();
        if (r.mode === 'known') {
          const items = t.suggestedServiceItems ?? [];
          detail.append(
            h('div', { class: 'grid' },
              field(`Date ${t.name} was last done (optional)`, h('input', { type: 'date', max: today, value: r.date, oninput: (e) => { r.date = e.target.value; } })),
              field(`Odometer when ${t.name} was last done (optional)`, h('div', { class: 'inline' },
                h('input', { inputmode: 'decimal', value: r.odo, 'aria-label': `Odometer when ${t.name} was last done`, oninput: (e) => { r.odo = e.target.value.trim(); } }),
                select(`odo-unit-${i}`, [['km', 'km'], ['mi', 'mi']], r.odoUnit, { 'aria-label': `Odometer unit for ${t.name}`, onchange: (e) => { r.odoUnit = e.target.value; } })),
              'What the odometer read then, if you know. It is used for this task only; your odometer records are not changed.')),
            h('p', { class: 'small muted' }, 'You can give a date, an odometer, or both. This is your own word, with no service record behind it.'));
          if (items.length) {
            const ok = h('label', { class: 'check', hidden: !r.link }, h('input', { type: 'checkbox', checked: r.linkOk, onchange: (e) => { r.linkOk = e.target.checked; } }),
              `Yes, link this recorded item to "${t.name}". It will count as the last time it was done, and the date and odometer you typed above are not used.`);
            detail.append(h('div', { class: 'pr-link' },
              field(`Or link a service you already recorded for ${t.name} (optional)`, select(`link-${i}`, [['', 'Do not link'], ...items.map((s) => [s.id, `${s.name}, ${plainDate(s.servicedOn)}${s.odometer ? `, ${dist(s.odometer)}` : ''}`])], r.link, { onchange: (e) => { r.link = e.target.value; if (!r.link) r.linkOk = false; ok.hidden = !r.link; } }),
                'Nothing is linked unless you pick one and confirm it.'), ok));
          }
        } else if (r.mode === 'tracking') {
          detail.append(h('p', { class: 'small pr-tracking' }, icon('clock'), 'DriveLoom will count from today and, when the latest odometer reading is recent, from that reading. This is not proof that the work was done: the task will not be shown as up to date until a service is recorded for it.'));
        } else {
          detail.append(h('p', { class: 'small muted' }, 'The task is added without a starting point and shows "Baseline needed" until you record a service or set one later. It will not be marked overdue or up to date.'));
        }
      };
      const radio = (mode, label) => h('label', { class: 'check' }, h('input', { type: 'radio', name: `bl-${i}`, value: mode, checked: r.mode === mode, onchange: () => { r.mode = mode; draw(); } }), label);
      draw();
      return h('fieldset', { class: 'svc-fieldset pr-baseline' }, h('legend', {}, t.name),
        radio('known', 'I know when it was last done'), radio('unknown', 'I don\'t know'), radio('tracking', 'Start tracking now'), detail);
    });
    return [
      ...heading(2, 'When was each one last done?'),
      h('p', { class: 'small' }, 'DriveLoom counts the next due point from the last time the work was done. Tell it what you know; a guess is better left as "I don\'t know".'),
      h('p', { class: 'small muted' }, `${reading} DriveLoom never changes your odometer from this flow.`),
      sections, err,
      actions(back(1), h('button', { type: 'button', onclick: () => {
        for (const r of chosen()) {
          if (r.mode !== 'known') continue;
          if (r.link) { if (!r.linkOk) return showErr(err, `${r.t.name}: confirm the link to the recorded service, or choose "Do not link".`); continue; }
          if (!r.date && !r.odo) return showErr(err, `${r.t.name}: give a date or an odometer, or choose "I don't know".`);
          if (r.date && r.date > today) return showErr(err, `${r.t.name}: the date it was last done cannot be in the future.`);
          if (r.odo && !DECIMAL.test(r.odo)) return showErr(err, `${r.t.name}: the odometer must be a number.`);
        }
        show(3);
      } }, 'Next')),
    ];
  }

  // ---- 4. preview ----
  const dueWords = (x) => {
    const due = [x.dueOn ? plainDate(x.dueOn) : null, x.dueOdometer ? `at ${dist(x.dueOdometer)}` : null].filter(Boolean);
    return due.join(' or ');
  };
  function previewLine(x, row) {
    if (x.result === 'skipped') {
      return x.reason === 'already_imported'
        ? 'Already imported earlier. Nothing changes.'
        : `Skipped. Your existing task "${row?.t.existingTaskMatch?.name ?? x.name}" is left exactly as it is.`;
    }
    if (x.result === 'linked') return `Your existing task "${x.name}" is tagged as coming from this preset. Its interval, starting point and reminder settings are kept.`;
    if (x.baseline === 'tracking') {
      return `Tracking from today, which is not a completed service. ${dueWords(x) ? `Check by ${dueWords(x)} at the latest. ` : ''}It will not be shown as up to date.`;
    }
    if (x.status === 'no_baseline') {
      return x.distanceBaselineMissing ? 'Baseline needed: the last time has no odometer, so the next distance cannot be worked out.' : 'Baseline needed. No due date yet; it will not be marked overdue or up to date.';
    }
    const word = { overdue: 'Overdue', due_soon: 'Due soon', unknown_reading: 'Odometer reading needed' }[x.status];
    return `${word ? `${word}. ` : ''}Next due ${dueWords(x)}.${x.baseline === 'reported' ? ' Counted from what you reported.' : x.baseline === 'completion' ? ' Counted from the service you linked.' : ''}`;
  }
  function step4() {
    const err = errBox();
    const out = h('div', { class: 'pr-preview', 'aria-live': 'polite' });
    const next = h('button', { type: 'button', disabled: true, onclick: () => show(4) }, 'Next');
    const run = async () => {
      const seq = ++previewSeq;
      out.replaceChildren(h('p', { class: 'small muted', role: 'status' }, 'Working out the next due points…'));
      next.disabled = true; err.hidden = true;
      try {
        const res = await post(`/v1/vehicles/${v.id}/maintenance/presets/${preset.id}/apply?preview=true`, body());
        if (seq !== previewSeq) return;
        st.preview = res;
        out.replaceChildren(...paint(res));
        next.disabled = false;
      } catch (e) {
        if (seq !== previewSeq) return;
        out.replaceChildren();
        showErr(err, e?.message ?? String(e));
      }
    };
    const paint = (res) => [
      res.reading
        ? h('p', { class: 'small muted' }, `Worked out with the latest odometer reading: ${dist(res.reading.odometer)} on ${plainDate(res.reading.on)}${res.reading.stale ? ', which is old; DriveLoom does not estimate mileage since' : ''}.`)
        : h('p', { class: 'small muted' }, 'No odometer reading is on record, so distance points cannot be checked yet.'),
      h('ul', { class: 'pr-results', 'aria-label': 'Preview of the import' }, res.results.map((x) => {
        const row = st.rows.find((r) => r.t.id === x.presetTaskId);
        const dup = row?.t.existingTaskMatch && x.reason !== 'already_imported';
        return h('li', { class: 'pr-result' },
          h('strong', {}, x.name),
          x.result === 'created' ? h('p', { class: 'small muted' }, ruleText(x.intervalMonths, x.intervalDistance)) : null,
          h('p', { class: 'small' }, previewLine(x, row)),
          dup ? h('fieldset', { class: 'svc-fieldset pr-dup' }, h('legend', {}, `You already have "${row.t.existingTaskMatch.name}"`),
            ['skip', 'link'].map((v2) => h('label', { class: 'check' }, h('input', { type: 'radio', name: `dup-${x.presetTaskId}`, value: v2, checked: row.dup === v2, onchange: () => { row.dup = v2; run(); } }),
              v2 === 'skip' ? 'Skip: leave my task alone and import nothing for this item' : 'Link: mark my task as coming from this preset')),
            h('p', { class: 'small muted' }, 'Linking only tags your existing task. Its interval, starting point and reminder settings are kept as they are.')) : null);
      })),
    ];
    run();
    return [
      ...heading(3, 'Preview'),
      h('p', { class: 'small' }, 'This is what would happen. Nothing has been saved yet.'),
      out, err,
      actions(back(2), next),
    ];
  }

  // ---- 5. reminders and import ----
  function step5() {
    const err = errBox();
    const res = st.preview?.results ?? [];
    const n = (k) => res.filter((x) => x.result === k).length;
    const go = h('button', { type: 'button', onclick: async () => {
      go.disabled = true; err.hidden = true;
      const label = go.textContent; go.textContent = 'Importing…';
      try {
        st.done = await post(`/v1/vehicles/${v.id}/maintenance/presets/${preset.id}/apply`, body());
        onImported?.();
        show(5);
      } catch (e) { showErr(err, e?.message ?? String(e)); go.disabled = false; go.textContent = label; }
    } }, 'Import');
    return [
      ...heading(4, 'Reminders and import'),
      h('p', {}, 'Imported tasks start with email reminders off; you can turn them on per task later.'),
      h('p', { class: 'small muted' }, 'Nothing is emailed because of this import, and your odometer and fuel records are not touched.'),
      h('p', { class: 'small' }, `This will add ${n('created')} task${n('created') === 1 ? '' : 's'}, link ${n('linked')} and skip ${n('skipped')}.`),
      err, actions(back(3), go),
    ];
  }

  // ---- result ----
  function stepDone() {
    const res = st.done.results;
    const group = (k, label) => {
      const rs = res.filter((x) => x.result === k);
      return rs.length ? h('div', {}, h('h4', { class: 'pr-sub' }, `${label}: ${rs.length}`), h('ul', {}, rs.map((x) => h('li', {}, x.name)))) : null;
    };
    return [
      h('h3', { tabindex: -1, 'data-step-title': '' }, 'Import finished'),
      h('p', { role: 'status' }, 'Your maintenance list is updated. Email reminders are off for the tasks that were added.'),
      group('created', 'Added'), group('linked', 'Linked to the preset'), group('skipped', 'Skipped'),
      actions(h('button', { type: 'button', onclick: close }, 'Back to the Maintenance list')),
    ];
  }

  const views = [step1, step2, step3, step4, step5, stepDone];
  function show(n, initial = false) {
    root.replaceChildren(...views[n]().flat(Infinity).filter(Boolean));
    if (!initial) root.querySelector('[data-step-title]')?.focus();
    root.closest('.m-sheet-body, dialog')?.scrollTo?.(0, 0);
  }
  show(0, true);
  return root;
}
