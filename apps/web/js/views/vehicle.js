// One vehicle: dashboard, fuel log, members, data (export/import) and settings.
// The sidebar in main.js links the sections; each returns its own heading.
import { api, get, post, patch, put, del } from '../api.js';
import { h, form, field, select, toast, confirmDialog, download } from '../ui.js';
import { go, render, state } from '../core.js';
import { qty, date, dateTime, money, REASONS, ROLE, GRANTABLE_ROLES, ROLE_HELP, UNIT, canEditVehicle, canAddFuel, canChangeFill, localInput, toInstant, vehicleTitle, vehicleDescription, vehicleLabel } from '../format.js';
import { economyChart, barChart } from './chart.js';
import { currencyOptions, pageHead } from './vehicles.js';
import { icon } from '../icons.js';

const SECTIONS = { overview: 'Dashboard', log: 'Fuel log', members: 'Members', data: 'Import & export', settings: 'Vehicle settings' };

const meta = (v) => [vehicleTitle(v) === vehicleDescription(v) ? '' : vehicleDescription(v), ' ', h('span', { class: `badge ${v.role === 'owner' ? 'accent' : ''}` }, ROLE[v.role]), v.archived ? h('span', { class: 'badge warn' }, 'Archived') : null];

export async function vehicleView(id, tab, query) {
  const v = await get(`/v1/vehicles/${id}`);
  if (!SECTIONS[tab]) tab = 'overview';
  const canAdd = canAddFuel(v) && !v.archived;
  if (tab === 'overview') return { vehicle: v, title: SECTIONS[tab], view: await overviewTab(v, canAdd, query) };
  const body = tab === 'members' ? await membersTab(v) : tab === 'data' ? dataTab(v, canEditVehicle(v) && !v.archived)
    : tab === 'settings' ? await settingsTab(v) : await logTab(v, canAdd, query);
  return { vehicle: v, title: SECTIONS[tab], view: h('div', {}, pageHead(vehicleTitle(v), SECTIONS[tab], meta(v)), body) };
}

// ---------- fuel log ----------
function fillForm(v, existing, done) {
  const prefs = state.prefs;
  const f = existing;
  const quantity = (name, unitName, units, value, unit, attrs) => h('div', { class: 'inline' },
    h('input', { name, inputmode: 'decimal', required: true, pattern: '\\d+(\\.\\d{1,3})?', value: value ?? '', ...attrs }),
    select(unitName, units, unit, { 'aria-label': `${name} unit` }));
  const otherCurrency = f?.cost && f.cost.currency !== v.currency;
  const rate = h('div', { hidden: !otherCurrency },
    field(`Exchange rate (${v.currency} per 1 unit of the purchase currency)`, h('input', { name: 'exchangeRate', inputmode: 'decimal', value: f?.cost?.exchangeRate ?? '' })),
    field(`Or the amount in ${v.currency}`, h('input', { name: 'reportingAmount', inputmode: 'decimal', value: otherCurrency && !f?.cost?.exchangeRate ? f.cost.reportingAmount : '' }), 'A purchase in another currency needs one of these. No rate is ever assumed.'));
  const currency = select('costCurrency', currencyOptions(f?.cost?.currency ?? v.currency), f?.cost?.currency ?? v.currency, { onchange: (e) => { rate.hidden = e.target.value === v.currency; } });
  return form({ class: 'panel' }, [
    h('h2', {}, existing ? 'Edit fill-up' : 'Add a fill-up'),
    h('div', { class: 'grid' },
      field('Date and time', h('input', { name: 'occurredAt', type: 'datetime-local', required: true, value: localInput(f ? new Date(f.occurredAt) : new Date()) })),
      field('Odometer', quantity('odometer', 'odometerUnit', [['km', 'km'], ['mi', 'mi']], f?.odometer.value, f?.odometer.unit ?? v.odometerUnit, { 'aria-label': 'Odometer reading' })),
      field('Fuel', quantity('volume', 'volumeUnit', [['l', 'L'], ['gal_us', 'US gal'], ['gal_imp', 'imp gal']], f?.volume.value, f?.volume.unit ?? prefs.volumeUnit, { 'aria-label': 'Fuel volume' })),
      field('Cost (optional)', h('div', { class: 'inline' }, h('input', { name: 'amount', inputmode: 'decimal', value: f?.cost?.amount ?? '', 'aria-label': 'Amount paid' }), currency))),
    rate,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'full', checked: f ? f.full : true }), 'Filled the tank completely'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'missedPrevious', checked: f?.missedPrevious ?? false }), 'I missed logging an earlier purchase'),
    field('Notes', h('textarea', { name: 'notes', maxlength: 500 }, f?.notes ?? '')),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, existing ? 'Save changes' : 'Add fill-up'), h('button', { type: 'button', class: 'secondary', onclick: () => done(false) }, 'Cancel')),
  ], async (x) => {
    const body = {
      occurredAt: toInstant(x.occurredAt),
      odometer: { value: x.odometer.trim(), unit: x.odometerUnit },
      volume: { value: x.volume.trim(), unit: x.volumeUnit },
      full: x.full === 'on', missedPrevious: x.missedPrevious === 'on', notes: x.notes,
      cost: x.amount.trim() ? { amount: x.amount.trim(), currency: x.costCurrency, ...(x.costCurrency !== v.currency ? { exchangeRate: x.exchangeRate.trim() || null, reportingAmount: x.reportingAmount.trim() || null } : {}) } : null,
    };
    if (existing) await patch(`/v1/vehicles/${v.id}/fill-ups/${existing.id}`, body);
    else await post(`/v1/vehicles/${v.id}/fill-ups`, body);
    done(true);
    return existing ? 'Fill-up updated.' : 'Fill-up added.';
  });
}

async function logTab(v, canEdit, query) {
  // canEdit: may log fill-ups. Drivers see actions only on the rows they logged.
  const mayChange = (f) => !v.archived && canChangeFill(v, f, state.account.id);
  const PAGE = 100;
  const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
  const { items, total } = await get(`/v1/vehicles/${v.id}/fill-ups?limit=${PAGE}&offset=${offset}`);
  const slot = h('div');
  const open = (existing) => {
    slot.replaceChildren(fillForm(v, existing, (changed) => { slot.replaceChildren(); if (changed) render(); }));
    slot.querySelector('input')?.focus();
  };
  const row = (f) => h('tr', {},
    h('td', {}, date(f.occurredAt), f.notes ? h('div', { class: 'small muted' }, f.notes) : null),
    h('td', { class: 'num' }, qty(f.display.odometer), f.odometer.unit !== f.display.odometer.unit ? h('div', { class: 'small muted' }, `entered ${qty(f.odometer)}`) : null),
    h('td', { class: 'num' }, qty(f.display.volume), f.full ? null : h('div', { class: 'small muted' }, 'partial')),
    h('td', { class: 'num hide-sm' }, f.cost ? money(f.cost.amount, f.cost.currency) : '—', f.cost && f.cost.currency !== f.cost.reportingCurrency ? h('div', { class: 'small muted' }, `= ${money(f.cost.reportingAmount, f.cost.reportingCurrency)}`) : null),
    h('td', { class: 'num' }, f.interval?.available ? h('strong', {}, qty(f.interval.economy)) : h('span', { class: 'small muted' }, REASONS[f.interval?.reason] ?? '')),
    canEdit ? h('td', { class: 'num' }, mayChange(f) ? [
      h('button', { class: 'ghost', 'aria-label': `Edit fill-up of ${date(f.occurredAt)}`, onclick: () => open(f) }, 'Edit'),
      h('button', { class: 'ghost', 'aria-label': `Delete fill-up of ${date(f.occurredAt)}`, onclick: async () => {
        if (!(await confirmDialog(`Delete the fill-up of ${dateTime(f.occurredAt)}?`, 'Delete'))) return;
        await del(`/v1/vehicles/${v.id}/fill-ups/${f.id}`); toast('Fill-up deleted.'); render();
      } }, 'Delete')] : null) : null);
  // The dashboard's "Add fill-up" lands here with ?add=1; drop it so a re-render does not reopen the form.
  if (canEdit && query.get('add') === '1') {
    history.replaceState(null, '', `#/vehicles/${v.id}/log`);
    open(null);
    setTimeout(() => slot.querySelector('input')?.focus(), 0);
  }
  return h('div', {},
    canEdit ? h('div', { class: 'row', style: 'margin-bottom:16px' }, h('button', { onclick: () => open(null) }, icon('plus'), 'Add fill-up')) : null,
    slot,
    items.length ? h('div', { class: 'panel table-wrap' }, h('table', {},
      h('caption', { class: 'muted small', style: 'text-align:left;padding-bottom:8px' }, `${total} fill-ups, newest first. Economy is shown on the full fill that closes each interval.`),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col', class: 'num' }, 'Odometer'), h('th', { scope: 'col', class: 'num' }, 'Fuel'), h('th', { scope: 'col', class: 'num hide-sm' }, 'Cost'), h('th', { scope: 'col', class: 'num' }, 'Economy'), canEdit ? h('th', { scope: 'col', class: 'num' }, h('span', { class: 'hide-sm' }, 'Actions')) : null)),
      h('tbody', {}, items.map(row))),
      total > PAGE ? h('div', { class: 'row spread', style: 'margin-top:12px' },
        offset > 0 ? h('a', { href: `#/vehicles/${v.id}/log?offset=${Math.max(0, offset - PAGE)}` }, '← Newer') : h('span'),
        h('span', { class: 'muted small' }, `${offset + 1}–${Math.min(total, offset + PAGE)} of ${total}`),
        offset + PAGE < total ? h('a', { href: `#/vehicles/${v.id}/log?offset=${offset + PAGE}` }, 'Older →') : h('span')) : null)
      : h('div', { class: 'panel empty' }, h('p', {}, 'No fill-ups yet.'), h('p', { class: 'small' }, 'Economy appears after two full fills: the first one sets the starting point.')));
}

// ---------- dashboard ----------
export const WINDOWS = [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months'], ['all', 'All time']];
export const DAY = 86_400_000;

export const statsUrl = (v, from, to) => {
  const q = new URLSearchParams();
  if (from) q.set('from', from.toISOString());
  if (to) q.set('to', to.toISOString());
  return `/v1/vehicles/${v.id}/stats${q.size ? `?${q}` : ''}`;
};

/** The last twelve calendar months in local time, oldest first. */
export function lastMonths(n = 12) {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const from = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    return { from, to, label: from.toLocaleDateString(undefined, { month: 'short' }), long: from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
  });
}

/** Whether economy `a` is better than `b`; consumption units are better when lower. */
const better = (a, b, unit) => (unit === 'l_per_100km' ? Number(a) < Number(b) : Number(a) > Number(b));

function kpi(label, ic, value, note, extra) {
  return h('div', { class: `kpi${extra ? ` ${extra}` : ''}` },
    h('div', { class: 'kpi-k' }, icon(ic), label),
    h('div', { class: 'kpi-v' }, value),
    note ? h('div', { class: 'kpi-note' }, note) : null);
}

function trend(cur, prev, periodName) {
  if (!cur || !prev || cur.value === prev.value) return prev ? `Same as the previous ${periodName}` : null;
  const up = better(cur.value, prev.value, cur.unit);
  // Direction is in words and an arrow as well as colour.
  return h('span', { class: `delta ${up ? 'good' : 'bad'}` }, h('span', { 'aria-hidden': 'true' }, up ? '▲ ' : '▼ '),
    `${up ? 'Better' : 'Worse'} than the previous ${periodName} (${qty(prev)})`);
}

const prevNote = (text, periodName) => `Previous ${periodName}: ${text}`;

export function compactMoney(currency) {
  try {
    const f = new Intl.NumberFormat(undefined, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 });
    return (n) => f.format(n);
  } catch { return (n) => String(n); }
}

function chartPanel(title, sub, body, cls = '') {
  return h('section', { class: `panel chart-panel ${cls}` }, h('div', { class: 'panel-head' }, h('h2', {}, title), sub ? h('span', { class: 'small muted' }, sub) : null), body);
}

function daysAgo(iso) {
  const d = Math.floor((Date.now() - Date.parse(iso)) / DAY);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

async function overviewTab(v, canEdit, query) {
  const win = WINDOWS.some(([k]) => k === query.get('window')) ? query.get('window') : '90';
  const days = win === 'all' ? null : Number(win);
  const now = Date.now();
  const from = days ? new Date(now - days * DAY) : null;
  const prevFrom = days ? new Date(now - 2 * days * DAY) : null;
  const periodName = days === 365 ? '12 months' : `${days} days`;
  // Only compare with the previous period when it has data, so new vehicles do not show zeros.
  const months = lastMonths();
  const [cur, prev, recent, ...monthly] = await Promise.all([
    get(statsUrl(v, from, null)),
    days ? get(statsUrl(v, prevFrom, from)) : Promise.resolve(null),
    get(`/v1/vehicles/${v.id}/fill-ups?limit=5`),
    ...months.map((m) => get(statsUrl(v, m.from, m.to))),
  ]);
  const unit = state.prefs.economyUnit;
  const cmp = days && prev.fillCount > 0;
  const addFill = canEdit ? h('a', { class: 'button', href: `#/vehicles/${v.id}/log?add=1` }, icon('plus'), 'Add fill-up') : null;
  const period = h('div', { class: 'period' }, h('label', { for: 'win' }, 'Period'),
    select('window', WINDOWS, win, { id: 'win', onchange: (e) => go(`#/vehicles/${v.id}?window=${e.target.value}`) }));
  const head = pageHead('Dashboard', vehicleTitle(v), meta(v), [period, addFill]);

  if (!recent.total) {
    return h('div', {}, head,
      h('section', { class: 'panel empty-dash' },
        h('div', { class: 'empty-art', 'aria-hidden': 'true' }, icon('chart')),
        h('h2', {}, 'No fill-ups yet'),
        h('p', { class: 'muted' }, 'Charts and reports appear here once you log fill-ups. Economy needs two full fills: the first sets the starting point.'),
        canEdit ? h('div', { class: 'row center' }, addFill, canEditVehicle(v) ? h('a', { class: 'button secondary', href: `#/vehicles/${v.id}/data` }, icon('upload'), 'Import a CSV') : null) : null));
  }

  // ---- headline figures ----
  const kpis = h('div', { class: 'kpis' },
    kpi('Average economy', 'gauge', cur.economy ? qty(cur.economy) : '—',
      cur.economy ? (cmp && trend(cur.economy, prev.economy, periodName)) || `Over ${cur.intervalCount} full-to-full intervals` : 'Needs two full fills in the period', 'hero'),
    kpi('Spent', 'wallet', money(cur.spend.amount, cur.spend.currency), cmp ? prevNote(money(prev.spend.amount, prev.spend.currency), periodName) : `${cur.spend.costedFillCount} of ${cur.fillCount} fill-ups have a cost`),
    kpi('Distance', 'route', qty(cur.distance), cmp ? prevNote(qty(prev.distance), periodName) : 'Closed full-to-full intervals'),
    kpi('Fuel', 'drop', qty(cur.volume), cmp ? prevNote(qty(prev.volume), periodName) : 'Closed full-to-full intervals'),
    kpi('Cost per distance', 'chart', cur.costPerDistance ? `${money(cur.costPerDistance.value, cur.costPerDistance.currency)} / ${cur.costPerDistance.per}` : '—',
      cmp && prev.costPerDistance ? prevNote(`${money(prev.costPerDistance.value, prev.costPerDistance.currency)} / ${prev.costPerDistance.per}`, periodName) : null),
    kpi('Fill-ups', 'fuel', String(cur.fillCount), cmp ? prevNote(String(prev.fillCount), periodName) : `${recent.total} recorded in total`));

  // ---- at a glance ----
  const last = recent.items[0];
  const pick = (cmp) => cur.series.reduce((best, p) => (!best || cmp(p.economy, best.economy) ? p : best), null);
  const best = pick((a, b) => better(a, b, unit)), worst = pick((a, b) => better(b, a, unit));
  const glanceRow = (k, val, sub) => h('li', {}, h('span', { class: 'muted' }, k), h('span', { class: 'glance-v' }, val, sub ? h('span', { class: 'small muted' }, sub) : null));
  const glance = h('section', { class: 'panel glance' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'At a glance')),
    h('ul', { class: 'glance-list' },
      glanceRow('Last fill-up', date(last.occurredAt), daysAgo(last.occurredAt)),
      glanceRow('Odometer', qty(last.display.odometer)),
      glanceRow('Fill-ups recorded', String(recent.total)),
      glanceRow('Best interval', best ? `${best.economy} ${UNIT[unit]}` : '—', best ? date(best.at) : null),
      glanceRow('Worst interval', worst ? `${worst.economy} ${UNIT[unit]}` : '—', worst ? date(worst.at) : null)),
    cur.unavailableIntervalCount ? h('p', { class: 'small muted' }, `${cur.unavailableIntervalCount} interval(s) in this period are left out because a purchase was missed or the distance is zero.`) : null);

  // ---- monthly reports ----
  const bucket = (pickValue) => months.map((m, i) => ({ label: m.label, long: m.long, ...pickValue(monthly[i]) }));
  const spendItems = bucket((st) => ({ value: Number(st.spend.amount), text: money(st.spend.amount, st.spend.currency) }));
  const distItems = bucket((st) => ({ value: Number(st.distance.value), text: qty(st.distance) }));
  const fuelItems = bucket((st) => ({ value: Number(st.volume.value), text: qty(st.volume) }));
  const distUnit = UNIT[monthly[0].distance.unit], volUnit = UNIT[monthly[0].volume.unit];

  // ---- recent fill-ups ----
  const recentList = h('section', { class: 'panel recent' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Recent fill-ups'), h('a', { class: 'small', href: `#/vehicles/${v.id}/log` }, 'Full log', icon('arrow'))),
    h('ul', { class: 'recent-list' }, recent.items.map((f) => h('li', {},
      h('span', { class: 'recent-icon', 'aria-hidden': 'true' }, icon('fuel')),
      h('div', { class: 'recent-main' }, h('strong', {}, date(f.occurredAt)), h('div', { class: 'small muted' }, `${qty(f.display.volume)}${f.full ? '' : ' · partial'} · ${qty(f.display.odometer)}`)),
      h('div', { class: 'recent-side' },
        f.cost ? h('div', {}, money(f.cost.amount, f.cost.currency)) : h('div', { class: 'muted' }, '—'),
        h('div', { class: 'small muted' }, f.interval?.available ? qty(f.interval.economy) : (REASONS[f.interval?.reason] ?? '')))))));

  const periodLabel = WINDOWS.find(([k]) => k === win)[1].toLowerCase();
  return h('div', { class: 'dashboard' }, head, kpis,
    h('div', { class: 'dash-grid' },
      chartPanel(`Economy (${UNIT[unit]})`, periodLabel, economyChart(cur.series, unit), 'span-8'),
      glance,
      chartPanel('Monthly spending', 'last 12 months', barChart({ items: spendItems, label: `spending per month in ${v.currency}`, unitLabel: `Spent (${v.currency})`, tick: compactMoney(v.currency), empty: 'No costs recorded in the last 12 months.' }), 'span-6'),
      chartPanel(`Distance per month (${distUnit})`, 'last 12 months', barChart({ items: distItems, label: `distance per month in ${distUnit}`, unitLabel: `Distance (${distUnit})`, empty: 'Distance appears once full-to-full intervals close.' }), 'span-6'),
      chartPanel(`Fuel per month (${volUnit})`, 'last 12 months', barChart({ items: fuelItems, label: `fuel per month in ${volUnit}`, unitLabel: `Fuel (${volUnit})`, empty: 'Fuel appears once full-to-full intervals close.' }), 'span-6'),
      recentList),
    h('p', { class: 'small muted' }, 'Units follow your preferences under Settings. Averages sum distance and fuel first, then divide. Distance and fuel count closed full-to-full intervals; spending counts every costed purchase.'));
}

// ---------- members ----------
async function membersTab(v) {
  const { items } = await get(`/v1/vehicles/${v.id}/members`);
  const me = state.account.id;
  const owner = v.role === 'owner';
  const rows = items.map((m) => h('tr', {},
    h('td', {}, m.displayName || m.email, m.userId === me ? ' (you)' : '', h('div', { class: 'small muted' }, m.email)),
    h('td', {}, owner && m.role !== 'owner'
      ? select('role', GRANTABLE_ROLES, m.role, { 'aria-label': `Role for ${m.email}`, style: 'width:auto', onchange: async (e) => { await put(`/v1/vehicles/${v.id}/members/${m.userId}`, { role: e.target.value }); toast('Role changed.'); } })
      : ROLE[m.role]),
    h('td', { class: 'num' },
      owner && m.role !== 'owner' ? h('button', { class: 'ghost', onclick: async () => {
        if (!(await confirmDialog(`Make ${m.email} the owner? You will become an Authorized Manager, and the new owner can change your role.`, 'Transfer ownership'))) return;
        await put(`/v1/vehicles/${v.id}/owner`, { userId: m.userId }); toast('Ownership transferred.'); render();
      } }, 'Make owner') : null,
      (owner && m.role !== 'owner') || (m.userId === me && m.role !== 'owner') ? h('button', { class: 'ghost', onclick: async () => {
        const leaving = m.userId === me;
        if (!(await confirmDialog(leaving ? 'Leave this vehicle? You will lose access to it.' : `Remove ${m.email} from this vehicle?`, leaving ? 'Leave' : 'Remove'))) return;
        await del(`/v1/vehicles/${v.id}/members/${m.userId}`);
        if (leaving) go('#/'); else render();
      } }, m.userId === me ? 'Leave' : 'Remove') : null)));
  return h('div', {},
    h('div', { class: 'panel table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Member'), h('th', { scope: 'col' }, 'Role'), h('th', { scope: 'col' }))), h('tbody', {}, rows))),
    owner ? form({ class: 'panel' }, [
      h('h2', {}, 'Share this vehicle'),
      h('p', { class: 'muted small' }, `${ROLE.editor}: ${ROLE_HELP.editor} ${ROLE.driver}: ${ROLE_HELP.driver} ${ROLE.viewer}: ${ROLE_HELP.viewer} Only you can manage members.`),
      h('div', { class: 'grid' }, field('Email of a user on this instance', h('input', { name: 'email', type: 'email', required: true })), field('Role', select('role', GRANTABLE_ROLES, 'viewer'))),
      h('button', { type: 'submit' }, 'Add member'),
    ], async (x, el) => { await post(`/v1/vehicles/${v.id}/members`, { email: x.email, role: x.role }); el.reset(); render(); return 'Member added.'; }) : null);
}

// ---------- import & export ----------
function dataTab(v, canEdit) {
  const exporter = (format) => h('button', { class: 'secondary', onclick: async () => {
    const res = await api('GET', `/v1/vehicles/${v.id}/export?format=${format}`, undefined, { raw: true });
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `driveloom.${format}`;
    download(name, await res.blob());
  } }, icon('download'), format === 'csv' ? 'Download CSV' : 'Download JSON');
  const report = h('div');
  const showReport = (r) => report.replaceChildren(h('div', { class: r.committed ? 'notice' : r.summary.invalid ? 'error' : 'notice' },
    h('p', {}, r.committed ? 'Imported.' : r.dryRun ? 'Preview only. Nothing has been saved yet.' : 'Nothing was imported.'),
    h('p', {}, `${r.summary.total} rows: ${r.summary.created} ${r.committed ? 'added' : 'to add'}, ${r.summary.duplicates} already present, ${r.summary.invalid} invalid.`),
    r.errors.length ? h('ul', {}, r.errors.map((e) => h('li', {}, `Row ${e.row}: ${e.message}`))) : null));
  return h('div', {},
    h('div', { class: 'panel' }, h('h2', {}, 'Export'),
      h('p', { class: 'muted' }, 'CSV opens in any spreadsheet. JSON includes the vehicle details and can create a new vehicle on another DriveLoom instance. Neither contains member names or emails.'),
      h('div', { class: 'row' }, exporter('csv'), exporter('json'))),
    canEdit ? form({ class: 'panel' }, [
      h('h2', {}, 'Import fill-ups'),
      h('p', { class: 'muted small' }, 'Use a DriveLoom CSV or JSON export, or a CSV with the columns occurred_at, odometer, odometer_unit, volume, volume_unit and optionally full, missed_previous, cost_amount, cost_currency, exchange_rate, reporting_amount, notes. Rows already present are skipped. If any row is invalid, nothing is imported.'),
      field('File', h('input', { name: 'file', type: 'file', accept: '.csv,.json,text/csv,application/json', required: true })),
      h('div', { class: 'row' }, h('button', { type: 'submit', name: 'mode', value: 'preview' }, 'Preview'), h('button', { type: 'submit', class: 'secondary', name: 'mode', value: 'commit' }, 'Import')),
      report,
    ], async (_x, el, submitter) => {
      const file = el.querySelector('input[type=file]').files[0];
      const text = await file.text();
      const json = /\.json$/i.test(file.name) || file.type === 'application/json';
      let data = text;
      if (json) { try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); } }
      try {
        const r = await post(`/v1/vehicles/${v.id}/import`, { format: json ? 'json' : 'csv', data, dryRun: submitter?.value !== 'commit' });
        showReport(r);
      } catch (err) { if (err.problem?.report) { showReport(err.problem.report); return; } throw err; }
    }) : null);
}

// ---------- settings ----------
async function settingsTab(v) {
  const owner = v.role === 'owner';
  const canEdit = canEditVehicle(v);
  const optIn = await get(`/v1/vehicles/${v.id}/comparison`);
  const parts = [];
  if (canEdit) {
    parts.push(form({ class: 'panel' }, [
      h('h2', {}, 'Details'),
      h('div', { class: 'grid' },
        field('Nickname (optional)', h('input', { name: 'name', maxlength: 80, value: v.name ?? '' })),
        field('Make', h('input', { name: 'make', maxlength: 80, value: v.make ?? '' })),
        field('Model', h('input', { name: 'model', maxlength: 80, value: v.model ?? '' })),
        field('Year', h('input', { name: 'year', type: 'number', value: v.year ?? '' })),
        field('State or province (optional)', h('input', { name: 'plateRegion', maxlength: 10, placeholder: 'ON', value: v.plateRegion ?? '', autocomplete: 'off' })),
        field('Licence plate (optional)', h('input', { name: 'plateNumber', maxlength: 12, placeholder: 'CXPZ101', value: v.plateNumber ?? '', autocomplete: 'off' })),
        field('VIN (optional)', h('input', { name: 'vin', maxlength: 20, value: v.vin ?? '', autocomplete: 'off' }), 'Plate and VIN are visible only to this vehicle\'s members, never to friends.'),
        field('Odometer unit', select('odometerUnit', [['km', 'Kilometres'], ['mi', 'Miles']], v.odometerUnit)),
        field('Reporting currency', select('currency', currencyOptions(v.currency), v.currency), 'Cannot change once costs are recorded.')),
      h('button', { type: 'submit' }, 'Save'),
    ], async (x) => {
      await patch(`/v1/vehicles/${v.id}`, { name: x.name || null, make: x.make || null, model: x.model || null, year: x.year ? Number(x.year) : null, plateRegion: x.plateRegion || null, plateNumber: x.plateNumber || null, vin: x.vin || null, odometerUnit: x.odometerUnit, currency: x.currency });
      render(); return 'Saved.';
    }));
    const preview = v.imageVersion ? h('img', { src: `/v1/vehicles/${v.id}/image?v=${v.imageVersion}`, alt: `Photo of ${vehicleLabel(v)}`, style: 'max-width:280px;border-radius:8px;display:block;margin-bottom:12px' }) : null;
    parts.push(form({ class: 'panel' }, [
      h('h2', {}, 'Photo'), preview,
      field('Image', h('input', { name: 'image', type: 'file', accept: 'image/jpeg,image/png,image/webp', required: true }), 'JPEG, PNG or WebP, up to 5 MB. Only members can see it.'),
      h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Upload'),
        v.imageVersion ? h('button', { type: 'button', class: 'danger', onclick: async () => { await del(`/v1/vehicles/${v.id}/image`); render(); } }, 'Remove photo') : null),
    ], async (_x, el) => {
      const file = el.querySelector('input[type=file]').files[0];
      if (file.size > 5 * 1024 * 1024) throw new Error('That image is larger than 5 MB.');
      await put(`/v1/vehicles/${v.id}/image`, file); render(); return 'Photo updated.';
    }));
  }
  parts.push(h('div', { class: 'panel' },
    h('h2', {}, 'Compare with friends'),
    h('p', { class: 'muted' }, 'When on, your friends see this vehicle\'s nickname, make, model, year and its average economy for the period they choose. They never see its plate or VIN, fill-ups, dates, distances, notes or members.'),
    owner ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: optIn.enabled, onchange: async (e) => {
      try { await put(`/v1/vehicles/${v.id}/comparison`, { enabled: e.target.checked }); toast(e.target.checked ? 'Shared with friends.' : 'No longer shared.'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
    } }), 'Share this vehicle\'s economy with my friends') : h('p', {}, optIn.enabled ? 'The owner shares this vehicle with their friends.' : 'Not shared. Only the owner can change this.')));
  const vis = await get(`/v1/vehicles/${v.id}/service-visibility`);
  if (vis.moduleEnabled) {
    parts.push(h('div', { class: 'panel' },
      h('h2', {}, 'Service page'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: vis.showService, onchange: async (e) => {
        try { await put(`/v1/vehicles/${v.id}/service-visibility`, { showService: e.target.checked }); toast(e.target.checked ? 'Service page shown.' : 'Service page hidden.'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
      } }), 'Show Service page for this vehicle'),
      h('p', { class: 'small muted' }, 'Only changes your own menus. Service data and what you are allowed to do are not affected.')));
  }
  if (owner) {
    parts.push(h('div', { class: 'panel' },
      h('h2', {}, v.archived ? 'Archived' : 'Archive'),
      h('p', { class: 'muted' }, v.archived ? 'Archived vehicles are read-only and hidden from the main list.' : 'Archive a vehicle you no longer drive. Its history stays and can be exported.'),
      h('button', { class: 'secondary', onclick: async () => { await put(`/v1/vehicles/${v.id}/archive`, { archived: !v.archived }); render(); } }, v.archived ? 'Unarchive' : 'Archive vehicle'),
      h('p', { class: 'small muted', style: 'margin-top:12px' }, 'To hand this vehicle to someone else, add them as a member, then use “Make owner” on the Members page.')));
  }
  return h('div', {}, parts);
}
