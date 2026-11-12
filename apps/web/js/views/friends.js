// Friends and aggregate comparisons. Friends see only per-vehicle averages
// for vehicles their owner opted in; never individual fill-ups.
import { get, post, put, del } from '../api.js';
import { h, form, field, select, confirmDialog, toast } from '../ui.js';
import { render } from '../main.js';
import { UNIT, money, date } from '../format.js';

const WINDOWS = [['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['365d', 'Last 12 months'], ['all', 'All time']];
const COST_REASON = { currency_mismatch: 'different currency', no_cost_data: 'no cost data' };

function person(p) {
  return h('div', {}, h('strong', {}, p.displayName || p.email), p.displayName ? h('div', { class: 'small muted' }, p.email) : null);
}

function people(title, rows, actions, empty) {
  return h('section', { class: 'panel' },
    h('h2', {}, title),
    rows.length
      ? h('ul', { class: 'list' }, rows.map((r) => h('li', { class: 'row spread' }, person(r), h('div', { class: 'row' }, actions(r)))))
      : h('p', { class: 'muted' }, empty));
}

const vehicleLabel = (v) => [v.name, [v.year, v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');

function comparisonTable(data) {
  const rows = [
    ...data.mine.map((v) => ({ who: 'You', v })),
    ...data.friends.flatMap((f) => f.vehicles.map((v) => ({ who: f.displayName || 'Friend', v }))),
  ];
  if (!rows.length) return h('p', { class: 'muted' }, 'Nothing to compare yet.');
  // A horizontal bar per vehicle, scaled to the largest economy value shown.
  const values = rows.map((r) => (r.v.economy ? Number(r.v.economy.value) : 0));
  const max = Math.max(...values, 0) || 1;
  const higherIsBetter = data.units.economy !== 'l_per_100km';
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Driver'), h('th', {}, 'Vehicle'), h('th', { class: 'num' }, `Economy (${UNIT[data.units.economy]})`), h('th', { class: 'num hide-sm' }, `Cost per ${UNIT[data.units.distance]}`))),
    h('tbody', {}, rows.map((r, i) => h('tr', {},
      h('td', {}, r.who),
      h('td', {}, vehicleLabel(r.v)),
      h('td', { class: 'num' }, r.v.economy
        ? h('div', { class: 'bar-cell' }, h('span', { class: 'bar', style: `width:${Math.max(2, Math.round((values[i] / max) * 120))}px` }), h('strong', {}, r.v.economy.value))
        : h('span', { class: 'small muted' }, 'not enough full fills')),
      h('td', { class: 'num hide-sm' }, r.v.costPerDistance ? money(r.v.costPerDistance.value, r.v.costPerDistance.currency) : h('span', { class: 'small muted' }, COST_REASON[r.v.costUnavailableReason] ?? '—'))))),
    h('caption', { class: 'small muted' }, higherIsBetter ? 'Higher economy is better.' : 'Lower consumption is better.', ' Costs are compared only in your preferred currency, never converted.')));
}

export async function friendsView(query) {
  const win = WINDOWS.some(([k]) => k === query.get('window')) ? query.get('window') : '90d';
  const [list, cmp] = await Promise.all([get('/v1/friends'), get(`/v1/comparisons?window=${win}`)]);
  const act = (label, fn, cls = 'secondary') => h('button', { class: cls, onclick: async (e) => {
    e.currentTarget.disabled = true;
    const btn = e.currentTarget;
    try { if ((await fn()) === false) { btn.disabled = false; return; } render(); } catch (err) { toast(err.message); btn.disabled = false; }
  } }, label);

  const add = form({ class: 'panel' }, [
    h('h2', {}, 'Add a friend'),
    h('p', { class: 'muted' }, 'Friends must already have an account on this instance. They see nothing until they accept, and then only the vehicles you choose to share.'),
    h('div', { class: 'row' }, field('Their email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'off' })), h('button', { type: 'submit' }, 'Send request')),
  ], async (v, el) => {
    const r = await post('/v1/friends', { email: v.email.trim() });
    el.reset(); render();
    return r.status === 'accepted' ? 'You are now friends.' : 'Request sent.';
  });

  return h('div', {},
    h('h1', {}, 'Friends'),
    h('section', { class: 'panel' },
      h('div', { class: 'row spread' }, h('h2', {}, 'Comparison'),
        select('window', WINDOWS, win, { 'aria-label': 'Comparison period', onchange: (e) => { location.hash = `#/friends?window=${e.target.value}`; } })),
      comparisonTable(cmp),
      h('p', { class: 'small muted' }, 'Share a vehicle from its Settings tab. Only owners can share, and sharing can be turned off at any time.')),
    list.incoming.length ? people('Requests for you', list.incoming, (r) => [
      act('Accept', () => put(`/v1/friends/${r.id}`), ''),
      act('Decline', () => del(`/v1/friends/${r.id}`)),
    ]) : null,
    people('Your friends', list.friends, (r) => [
      h('span', { class: 'small muted hide-sm' }, `since ${date(r.since)}`),
      act('Remove', async () => {
        if (!(await confirmDialog(`Remove ${r.displayName || r.email} as a friend? You will stop seeing each other's shared averages.`, 'Remove'))) return false;
        await del(`/v1/friends/${r.id}`);
      }),
    ], 'No friends yet.'),
    list.outgoing.length ? people('Waiting for an answer', list.outgoing, (r) => [act('Cancel', () => del(`/v1/friends/${r.id}`))]) : null,
    add);
}
