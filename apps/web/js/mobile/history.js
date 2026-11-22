// History (route #/vehicles/:id/log on the phone): the fuel log as card rows
// grouped by month, newest first. Filter chips sit under the title; the list
// API pages with limit/offset only, so the period and type filters apply to the
// rows loaded so far and "Load more" fetches the next page. A tap on a row opens
// a detail sheet with explicit Edit and Delete buttons (no swipe gestures).
import { get, del } from '../api.js';
import { h, toast } from '../ui.js';
import { icon } from '../icons.js';
import { go, render } from '../core.js';
import { qty, money, dateTime, REASONS, UNIT, vehicleTitle } from '../format.js';
import { Dec, unitPrice } from '../economy.js';
import { DAY, statsUrl } from '../views/vehicle.js';
import { openSheet } from './sheet.js';
import { confirmSheet } from './confirm.js';
import { openFillUp } from './fillup.js';
import { glyph } from './glyph.js';

const PAGE = 50;
export const PERIODS = [['30', 'Last 30 days', '30 d'], ['90', 'Last 90 days', '90 d'], ['365', 'Last 12 months', '12 mo'], ['all', 'All time', 'All']];
const TYPES = [['full', 'Full fills'], ['partial', 'Partial'], ['notes', 'With notes']];
const REASON_TEXT = {
  partial_fill: 'A partial fill has no figure of its own; it counts towards the next full fill.',
  no_previous_full_fill: 'The first full fill sets the starting point. Economy appears from the next full fill.',
  missed_fill: 'A purchase before this one was not logged, so this tank gets no figure.',
  no_distance: 'The odometer did not move since the previous full fill.',
};

const unitText = (u) => UNIT[u] ?? u;
const day = (iso) => new Date(iso).getDate();
const weekday = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
const monthKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}`; };
const monthLabel = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const longDate = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** The economy a row shows: the figure, or a tag saying why there is none. */
export function economyChip(f) {
  if (f.interval?.available && f.interval.economy) {
    return h('span', { class: 'm-econ' }, h('span', { class: 'm-econ-v' }, f.interval.economy.value), h('span', { class: 'm-econ-u' }, unitText(f.interval.economy.unit)));
  }
  const reason = f.full ? REASONS[f.interval?.reason] : 'Partial';
  return reason ? h('span', { class: 'm-tag' }, reason) : null;
}

/** One fill-up as a card row; `onOpen(f)` runs on tap. */
export function fillRow(f, onOpen, { month = false } = {}) {
  const cost = f.cost ? money(f.cost.amount, f.cost.currency) : null;
  const dist = f.interval?.available && f.interval.distance ? ` · +${f.interval.distance.value}` : '';
  // The row's name is its visible text, so voice control can say what it sees.
  return h('li', {}, h('button', { type: 'button', class: 'm-fill-row', 'aria-haspopup': 'dialog', onclick: () => onOpen(f) },
  h('span', { class: 'm-day' }, h('b', {}, String(day(f.occurredAt))), ' ', h('span', {}, month ? new Date(f.occurredAt).toLocaleDateString(undefined, { month: 'short' }) : weekday(f.occurredAt))),
  h('span', { class: 'm-fill-main' },
    h('span', { class: 'm-fill-title' }, [qty(f.display.volume), cost].filter(Boolean).join(' · ')),
    h('span', { class: 'm-fill-sub' }, `${qty(f.display.odometer)}${dist}`),
    f.notes ? h('span', { class: 'm-fill-note' }, f.notes) : null),
  h('span', { class: 'm-fill-side' }, economyChip(f))));
}

/** The detail sheet for one fill-up. `v` is the vehicle (role decides the actions). */
export function openFillDetail(v, f) {
  const canEdit = v.role !== 'viewer' && !v.archived;
  const i = f.interval;
  const hero = i?.available && i.economy
    ? h('p', { class: 'm-hero-line' }, h('span', { class: 'm-big' }, i.economy.value), h('span', { class: 'm-big-unit' }, unitText(i.economy.unit)))
    : h('div', { class: 'm-detail-reason' }, h('strong', {}, f.full ? (REASONS[i?.reason] ?? 'No figure') : 'Partial fill'), h('p', {}, REASON_TEXT[f.full ? i?.reason : 'partial_fill'] ?? ''));
  const row = (k, ...v2) => [h('dt', {}, k), h('dd', {}, ...v2)];
  const otherUnit = f.odometer.unit !== f.display.odometer.unit;
  const price = f.cost ? unitPrice(f.cost.amount, f.volume.value) : null;
  const facts = h('dl', { class: 'm-dl' },
    row('Odometer', h('span', { class: 'm-num' }, qty(f.display.odometer)), otherUnit ? h('span', { class: 'm-dd-sub' }, `Entered as ${qty(f.odometer)}`) : null),
    row('Fuel', h('span', { class: 'm-num' }, qty(f.display.volume)), ` · ${f.full ? 'full tank' : 'partial fill'}`),
    row('Cost', f.cost
      ? [h('span', { class: 'm-num' }, money(f.cost.amount, f.cost.currency)),
        price ? h('span', { class: 'm-dd-sub' }, `${price} ${f.cost.currency}/${unitText(f.volume.unit)}`) : null,
        f.cost.currency !== f.cost.reportingCurrency ? h('span', { class: 'm-dd-sub' }, `= ${money(f.cost.reportingAmount, f.cost.reportingCurrency)}`) : null]
      : h('span', { class: 'm-muted' }, 'Not recorded')),
    i?.available ? row('Interval', h('span', { class: 'm-num' }, `${qty(i.distance)} on ${qty(i.volume)}`), h('span', { class: 'm-dd-sub' }, 'Since the previous full fill, partial fills included.')) : [],
    f.missedPrevious ? row('Missed', 'An earlier purchase was not logged.') : [],
    row('Notes', f.notes ? f.notes : h('span', { class: 'm-muted' }, 'None')));

  const actions = canEdit ? h('div', { class: 'm-actions' },
    h('button', { type: 'button', class: 'secondary', onclick: () => {
      sheet.close();
      openFillUp({ vehicle: v, edit: f, onClose: ({ saved } = {}) => { if (saved) render(); } });
    } }, glyph('edit'), 'Edit'),
    h('button', { type: 'button', class: 'danger', onclick: async () => {
      const gone = await confirmSheet({
        title: 'Delete this fill-up?',
        message: `The fill-up of ${dateTime(f.occurredAt)} (${qty(f.display.volume)}) will be removed for every member of ${vehicleTitle(v)}. Economy is worked out again without it.`,
        confirmLabel: 'Delete fill-up',
        action: () => del(`/v1/vehicles/${v.id}/fill-ups/${f.id}`),
      });
      if (!gone) return;
      sheet.close();
      toast('Fill-up deleted.');
      render();
    } }, glyph('trash'), 'Delete'))
    : h('p', { class: 'm-muted m-small' }, v.archived ? 'This vehicle is archived, so its records are read-only.' : 'You can view this vehicle’s records but not change them.');

  const sheet = openSheet({ title: longDate(f.occurredAt), sub: `${time(f.occurredAt)} · ${vehicleTitle(v)}`, className: 'm-detail', content: [hero, facts, actions] });
  return sheet;
}

function filterUrl(v, period, type) {
  const q = new URLSearchParams();
  if (period !== 'all') q.set('period', period);
  if (type) q.set('type', type);
  return `#/vehicles/${v.id}/log${q.size ? `?${q}` : ''}`;
}

function openPeriodSheet(v, period, type) {
  let picked = null;
  const sheet = openSheet({
    title: 'Period',
    content: h('ul', { class: 'm-opts', 'aria-label': 'Periods' }, PERIODS.map(([k, label]) => h('li', {},
      h('button', { type: 'button', class: 'm-opt', 'aria-pressed': String(k === period), onclick: () => { picked = k; sheet.close(); } },
        h('span', { class: 'm-opt-text' }, h('span', { class: 'm-opt-name' }, label)), k === period ? icon('check', 'icon m-opt-check') : null)))),
    onClose: () => { if (picked && picked !== period) go(filterUrl(v, picked, type)); },
  });
  sheet.dialog.querySelector('.m-opt[aria-pressed="true"]')?.focus();
}

/** Sum of reporting amounts with exact decimals; null when none is costed. */
function monthSpend(items) {
  const costed = items.filter((f) => f.cost);
  if (!costed.length) return null;
  const scale = Math.max(...costed.map((f) => (f.cost.reportingAmount.split('.')[1] ?? '').length));
  return { amount: costed.reduce((t, f) => t.add(Dec.parse(f.cost.reportingAmount)), Dec.ZERO).toFixed(scale), currency: costed[0].cost.reportingCurrency };
}

export async function historyScreen(id, query) {
  const v = await get(`/v1/vehicles/${id}`);
  const canEdit = v.role !== 'viewer' && !v.archived;
  const period = PERIODS.some(([k]) => k === query.get('period')) ? query.get('period') : 'all';
  const type = TYPES.some(([k]) => k === query.get('type')) ? query.get('type') : null;
  const from = period === 'all' ? null : new Date(Date.now() - Number(period) * DAY);
  const [page, st] = await Promise.all([
    get(`/v1/vehicles/${v.id}/fill-ups?limit=${PAGE}&offset=0`),
    get(statsUrl(v, from, null)).catch(() => null),
  ]);
  const items = [...page.items];
  let total = page.total;

  const periodLabel = PERIODS.find(([k]) => k === period)[1];
  const chips = h('div', { class: 'm-chips', role: 'group', 'aria-label': 'Filters' },
    h('button', { type: 'button', class: 'm-chip m-chip-on', 'aria-haspopup': 'dialog', onclick: () => openPeriodSheet(v, period, type) },
      h('span', { class: 'm-vh' }, 'Period: '), periodLabel, icon('chevron', 'icon m-chip-caret')),
    TYPES.map(([k, label]) => h('button', {
      type: 'button', class: `m-chip${type === k ? ' m-chip-on' : ''}`, 'aria-pressed': String(type === k),
      onclick: () => go(filterUrl(v, period, type === k ? null : k)),
    }, label)));

  const summary = h('p', { class: 'm-summary' }, st
    ? [`${st.fillCount} ${st.fillCount === 1 ? 'fill-up' : 'fill-ups'}`, st.distance && st.intervalCount ? qty(st.distance) : null, st.spend.costedFillCount ? money(st.spend.amount, st.spend.currency) : null].filter(Boolean).join(' · ')
    : '');
  const list = h('div', { class: 'm-history-list' });
  const status = h('p', { class: 'm-summary m-center', role: 'status' });
  const more = h('button', { type: 'button', class: 'secondary m-wide', onclick: loadMore }, 'Load more');

  const inPeriod = (f) => !from || Date.parse(f.occurredAt) >= from.getTime();
  const matches = (f) => inPeriod(f) && (!type || (type === 'full' ? f.full : type === 'partial' ? !f.full : !!f.notes));
  // Newest first: once the oldest loaded row is before the period, nothing older can match.
  const exhausted = () => items.length >= total || (from && items.length && !inPeriod(items.at(-1)));

  function draw() {
    const shown = items.filter(matches);
    const groups = [];
    for (const f of shown) {
      const k = monthKey(f.occurredAt);
      if (groups.at(-1)?.key !== k) groups.push({ key: k, label: monthLabel(f.occurredAt), rows: [] });
      groups.at(-1).rows.push(f);
    }
    const done = exhausted();
    // A month's total is shown only once every row of it is loaded.
    const lastKey = items.length ? monthKey(items.at(-1).occurredAt) : null;
    list.replaceChildren(...groups.map((g, gi) => {
      const complete = done || g.key !== lastKey;
      const spend = complete ? monthSpend(items.filter((f) => monthKey(f.occurredAt) === g.key && matches(f))) : null;
      const hid = `m-hm-${gi}`;
      return h('section', { class: 'm-month', 'aria-labelledby': hid },
        h('h2', { class: 'm-month-head', id: hid }, h('span', {}, g.label), spend ? h('span', { class: 'm-num' }, h('span', { class: 'm-vh' }, ', spent '), money(spend.amount, spend.currency)) : null),
        h('ul', { class: 'm-card m-fill-list' }, g.rows.map((f) => fillRow(f, (x) => openFillDetail(v, x)))));
    }));
    if (!shown.length && done) {
      list.replaceChildren(h('div', { class: 'm-card m-empty' },
        h('h2', {}, 'No fill-ups match'),
        h('p', {}, type ? 'Try another filter, or a longer period.' : `Nothing was logged in the ${periodLabel.toLowerCase()}.`),
        h('a', { class: 'button secondary', href: filterUrl(v, 'all', null) }, 'Show all fill-ups')));
    }
    more.hidden = done;
    status.textContent = done ? (shown.length ? `${shown.length} shown${type || from ? ` of ${total} in total` : ''}.` : '') : `${items.length} of ${total} loaded.`;
  }

  async function loadMore() {
    more.disabled = true;
    more.textContent = 'Loading…';
    try {
      const next = await get(`/v1/vehicles/${v.id}/fill-ups?limit=${PAGE}&offset=${items.length}`);
      // A record added meanwhile shifts the offsets; skip anything already listed.
      const seen = new Set(items.map((f) => f.id));
      items.push(...next.items.filter((f) => !seen.has(f.id)));
      total = next.total;
      if (!next.items.length) total = items.length;
      draw();
    } catch (err) { toast(err.message); } finally { more.disabled = false; more.textContent = 'Load more'; }
  }

  const head = h('div', { class: 'm-title-text' }, h('h1', {}, 'History'), h('p', { class: 'm-sub' }, vehicleTitle(v)));

  if (!total) {
    return h('div', { class: 'm-screen m-stack' }, head,
      h('div', { class: 'm-card m-empty' },
        h('span', { class: 'm-empty-art', 'aria-hidden': 'true' }, icon('history')),
        h('h2', {}, 'No fill-ups yet'),
        h('p', {}, 'Each fill-up you log appears here, newest first. Economy appears after two full fills: the first sets the starting point.'),
        canEdit ? h('div', { class: 'm-actions' }, h('a', { class: 'button', href: '#/fill' }, icon('plus'), 'Log a fill-up'), h('a', { class: 'button secondary', href: `#/vehicles/${v.id}/data` }, icon('upload'), 'Import')) : null));
  }
  draw();
  return h('div', { class: 'm-screen m-stack' }, head, chips, summary, list, status, more);
}
