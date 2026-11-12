// One vehicle: fuel log, statistics, members, data (export/import) and settings.
import { api, get, post, patch, put, del } from '../api.js';
import { h, form, field, select, toast, confirmDialog, download } from '../ui.js';
import { go, render, state } from '../main.js';
import { qty, date, dateTime, money, REASONS, ROLE, UNIT, localInput, toInstant } from '../format.js';
import { economyChart } from './chart.js';
import { currencyOptions } from './vehicles.js';
import { icon } from '../icons.js';

const TABS = [['log', 'Fuel log', 'fuel'], ['stats', 'Statistics', 'chart'], ['members', 'Members', 'users'], ['data', 'Import & export', 'swap'], ['settings', 'Settings', 'gear']];

export async function vehicleView(id, tab, query) {
  const v = await get(`/v1/vehicles/${id}`);
  const canEdit = v.role !== 'viewer' && !v.archived;
  const body = tab === 'stats' ? await statsTab(v, query) : tab === 'members' ? await membersTab(v) : tab === 'data' ? dataTab(v, canEdit)
    : tab === 'settings' ? await settingsTab(v) : await logTab(v, canEdit, query);
  return h('div', {},
    h('a', { class: 'back', href: '#/' }, icon('back'), 'All vehicles'),
    h('div', { class: 'hero' },
      h('div', {}, h('h1', {}, v.name), h('p', { class: 'muted' }, [v.year, v.make, v.model].filter(Boolean).join(' ') || '', ' ', h('span', { class: 'badge' }, ROLE[v.role]), v.archived ? h('span', { class: 'badge' }, ' Archived') : null))),
    h('nav', { class: 'tabs', 'aria-label': 'Vehicle sections' }, TABS.map(([key, label, ic]) => h('a', { href: `#/vehicles/${v.id}/${key}`, 'aria-current': key === tab ? 'page' : undefined }, icon(ic), label))),
    body);
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
    canEdit ? h('td', { class: 'num' },
      h('button', { class: 'ghost', 'aria-label': `Edit fill-up of ${date(f.occurredAt)}`, onclick: () => open(f) }, 'Edit'),
      h('button', { class: 'ghost', 'aria-label': `Delete fill-up of ${date(f.occurredAt)}`, onclick: async () => {
        if (!(await confirmDialog(`Delete the fill-up of ${dateTime(f.occurredAt)}?`, 'Delete'))) return;
        await del(`/v1/vehicles/${v.id}/fill-ups/${f.id}`); toast('Fill-up deleted.'); render();
      } }, 'Delete')) : null);
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

// ---------- statistics ----------
const WINDOWS = [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year'], ['all', 'All time']];

async function statsTab(v, query) {
  const win = query.get('window') ?? '365';
  const from = win === 'all' ? null : new Date(Date.now() - Number(win) * 86_400_000).toISOString();
  const st = await get(`/v1/vehicles/${v.id}/stats${from ? `?from=${encodeURIComponent(from)}` : ''}`);
  const stat = (k, val, note) => h('div', { class: 'stat' }, h('div', { class: 'v' }, val), h('div', { class: 'k' }, k), note ? h('div', { class: 'small muted' }, note) : null);
  return h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:16px' }, h('label', { for: 'win', style: 'margin:0' }, 'Period'),
      select('window', WINDOWS, win, { id: 'win', style: 'width:auto', onchange: (e) => go(`#/vehicles/${v.id}/stats?window=${e.target.value}`) })),
    h('div', { class: 'panel' },
      h('div', { class: 'stats' },
        stat('Average economy', st.economy ? qty(st.economy) : '—', st.economy ? `over ${st.intervalCount} full-to-full intervals` : 'needs two full fills in the period'),
        stat('Distance', qty(st.distance)), stat('Fuel', qty(st.volume)),
        stat('Spent', money(st.spend.amount, st.spend.currency), `${st.spend.costedFillCount} of ${st.fillCount} fill-ups have a cost`),
        stat('Cost per distance', st.costPerDistance ? `${money(st.costPerDistance.value, st.costPerDistance.currency)} / ${st.costPerDistance.per}` : '—')),
      st.unavailableIntervalCount ? h('p', { class: 'small muted', style: 'margin-top:12px' }, `${st.unavailableIntervalCount} interval(s) in this period are left out because a purchase was missed or the distance is zero.`) : null),
    h('div', { class: 'panel' }, h('h2', {}, `Economy (${UNIT[state.prefs.economyUnit]})`), economyChart(st.series, state.prefs.economyUnit)),
    h('p', { class: 'small muted' }, 'Units follow your preferences under Settings. Averages sum distance and fuel first, then divide.'));
}

// ---------- members ----------
async function membersTab(v) {
  const { items } = await get(`/v1/vehicles/${v.id}/members`);
  const me = state.account.id;
  const owner = v.role === 'owner';
  const rows = items.map((m) => h('tr', {},
    h('td', {}, m.displayName || m.email, m.userId === me ? ' (you)' : '', h('div', { class: 'small muted' }, m.email)),
    h('td', {}, owner && m.role !== 'owner'
      ? select('role', [['editor', 'Editor'], ['viewer', 'Viewer']], m.role, { 'aria-label': `Role for ${m.email}`, style: 'width:auto', onchange: async (e) => { await put(`/v1/vehicles/${v.id}/members/${m.userId}`, { role: e.target.value }); toast('Role changed.'); } })
      : ROLE[m.role]),
    h('td', { class: 'num' },
      owner && m.role !== 'owner' ? h('button', { class: 'ghost', onclick: async () => {
        if (!(await confirmDialog(`Make ${m.email} the owner? You will become an editor.`, 'Transfer ownership'))) return;
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
      h('p', { class: 'muted small' }, 'Editors can add and correct fill-ups and edit details. Viewers can only read. Only you can manage members.'),
      h('div', { class: 'grid' }, field('Email of a user on this instance', h('input', { name: 'email', type: 'email', required: true })), field('Role', select('role', [['viewer', 'Viewer'], ['editor', 'Editor']], 'viewer'))),
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
  const canEdit = v.role !== 'viewer';
  const optIn = await get(`/v1/vehicles/${v.id}/comparison`);
  const parts = [];
  if (canEdit) {
    parts.push(form({ class: 'panel' }, [
      h('h2', {}, 'Details'),
      h('div', { class: 'grid' },
        field('Name', h('input', { name: 'name', required: true, maxlength: 80, value: v.name })),
        field('Make', h('input', { name: 'make', maxlength: 80, value: v.make ?? '' })),
        field('Model', h('input', { name: 'model', maxlength: 80, value: v.model ?? '' })),
        field('Year', h('input', { name: 'year', type: 'number', value: v.year ?? '' })),
        field('Odometer unit', select('odometerUnit', [['km', 'Kilometres'], ['mi', 'Miles']], v.odometerUnit)),
        field('Reporting currency', select('currency', currencyOptions(v.currency), v.currency), 'Cannot change once costs are recorded.')),
      h('button', { type: 'submit' }, 'Save'),
    ], async (x) => {
      await patch(`/v1/vehicles/${v.id}`, { name: x.name, make: x.make || null, model: x.model || null, year: x.year ? Number(x.year) : null, odometerUnit: x.odometerUnit, currency: x.currency });
      render(); return 'Saved.';
    }));
    const preview = v.imageVersion ? h('img', { src: `/v1/vehicles/${v.id}/image?v=${v.imageVersion}`, alt: `Photo of ${v.name}`, style: 'max-width:280px;border-radius:8px;display:block;margin-bottom:12px' }) : null;
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
    h('p', { class: 'muted' }, 'When on, your friends see this vehicle\'s name, make, model, year and its average economy for the period they choose. They never see fill-ups, dates, distances, notes or members.'),
    owner ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: optIn.enabled, onchange: async (e) => {
      try { await put(`/v1/vehicles/${v.id}/comparison`, { enabled: e.target.checked }); toast(e.target.checked ? 'Shared with friends.' : 'No longer shared.'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
    } }), 'Share this vehicle\'s economy with my friends') : h('p', {}, optIn.enabled ? 'The owner shares this vehicle with their friends.' : 'Not shared. Only the owner can change this.')));
  if (owner) {
    parts.push(h('div', { class: 'panel' },
      h('h2', {}, v.archived ? 'Archived' : 'Archive'),
      h('p', { class: 'muted' }, v.archived ? 'Archived vehicles are read-only and hidden from the main list.' : 'Archive a vehicle you no longer drive. Its history stays and can be exported.'),
      h('button', { class: 'secondary', onclick: async () => { await put(`/v1/vehicles/${v.id}/archive`, { archived: !v.archived }); render(); } }, v.archived ? 'Unarchive' : 'Archive vehicle'),
      h('p', { class: 'small muted', style: 'margin-top:12px' }, 'To hand this vehicle to someone else, add them as a member, then use “Make owner” on the Members tab.')));
  }
  return h('div', {}, parts);
}
