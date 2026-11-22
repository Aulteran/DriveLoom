// Friends and comparison on the phone (#/friends). Same endpoints and rules as
// views/friends.js: requests first with Accept and Decline, the comparison as
// stacked rows instead of a table, friends and outgoing requests as rows, and
// "Add a friend" in a sheet. Friends see per-vehicle averages only.
import { get, post, put, del } from '../api.js';
import { h, field } from '../ui.js';
import { icon } from '../icons.js';
import { render } from '../core.js';
import { UNIT, money, date, vehicleLabel } from '../format.js';
import { WINDOWS, COST_REASON } from '../views/friends.js';
import { openSheet } from './sheet.js';
import { page, section, staticRow, row, avatar, action, confirmSheet, sheetForm } from './kit.js';
import { loadInto, emptyState } from './states.js';

const SHORT = { '30d': '30 days', '90d': '90 days', '365d': '12 months', all: 'All time' };
const name = (p) => p.displayName || p.email;

function comparison(cmp, win) {
  const rows = [
    ...cmp.mine.map((v) => ({ who: 'You', you: true, v })),
    ...cmp.friends.flatMap((f) => f.vehicles.map((v) => ({ who: f.displayName || 'Friend', v }))),
  ];
  const higherIsBetter = cmp.units.economy !== 'l_per_100km';
  const values = rows.map((r) => (r.v.economy ? Number(r.v.economy.value) : 0));
  const max = Math.max(...values, 0) || 1;
  const seg = h('div', { class: 'm-seg m-seg-4', role: 'group', 'aria-label': 'Comparison period' },
    WINDOWS.map(([k, label]) => h('button', {
      type: 'button', 'aria-pressed': String(k === win), title: label,
      onclick: () => { location.hash = `#/friends?window=${k}`; },
    }, SHORT[k] ?? label)));
  return h('section', { class: 'm-group m-pad m-compare', 'aria-labelledby': 'm-cmp-h' },
    h('div', { class: 'm-compare-head' }, h('h2', { id: 'm-cmp-h' }, 'Comparison'),
      h('span', { class: 'm-note' }, `${UNIT[cmp.units.economy]} · ${higherIsBetter ? 'higher' : 'lower'} is better`)),
    seg,
    rows.length ? h('ul', { class: 'm-bars' }, rows.map((r, i) => {
      const bar = h('span', { class: 'm-bar-fill' });
      bar.style.setProperty('--m-w', `${Math.max(2, Math.round((values[i] / max) * 100))}%`);
      return h('li', { class: `m-bar-row${r.you ? ' m-bar-you' : ''}` },
        h('p', { class: 'm-bar-line' }, h('span', { class: 'm-bar-who' }, h('strong', {}, r.who), ' · ', vehicleLabel(r.v)),
          r.v.economy ? h('span', { class: 'm-bar-val' }, r.v.economy.value) : h('span', { class: 'm-note' }, 'not enough full fills')),
        r.v.economy ? h('span', { class: 'm-bar-track', 'aria-hidden': 'true' }, bar) : null,
        h('p', { class: 'm-note' }, r.v.costPerDistance
          ? `${money(r.v.costPerDistance.value, r.v.costPerDistance.currency)} per ${UNIT[cmp.units.distance]}`
          : `Cost not compared: ${COST_REASON[r.v.costUnavailableReason] ?? 'no data'}`));
    })) : emptyState({ title: 'Nothing to compare yet', text: 'Averages appear once you or a friend has shared vehicles with enough full fill-ups.' }),
    h('p', { class: 'm-note' }, 'Averages only, for vehicles their owners chose to share. Costs are never converted between currencies. Share a vehicle from its Vehicle settings.'));
}

function addFriendSheet() {
  const s = openSheet({
    title: 'Add a friend',
    content: sheetForm([
      h('p', { class: 'm-sheet-text' }, 'Friends must already have an account on this server. They see nothing until they accept, and then only the vehicles you choose to share.'),
      field('Their email', h('input', { name: 'email', type: 'email', inputmode: 'email', required: true, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', autocorrect: 'off', enterkeyhint: 'send' })),
      h('button', { type: 'submit', class: 'm-wide' }, 'Send request'),
    ], async (v) => {
      const r = await post('/v1/friends', { email: v.email.trim() });
      s.close(); render();
      return r.status === 'accepted' ? 'You are now friends.' : 'Request sent.';
    }),
  });
  s.dialog.querySelector('input')?.focus();
}

function friendSheet(f) {
  const s = openSheet({
    title: name(f), sub: `Friends since ${date(f.since)}`,
    content: [
      f.displayName ? h('p', { class: 'm-sheet-text' }, f.email) : null,
      h('div', { class: 'm-sheet-actions m-stack' },
        action('Remove friend', async () => {
          if (!(await confirmSheet({ title: `Remove ${name(f)}?`, text: 'You will stop seeing each other’s shared averages.', confirm: 'Remove friend' }))) return false;
          await del(`/v1/friends/${f.id}`);
          s.close(); render();
          return 'Friend removed.';
        }, { cls: 'danger m-wide' })),
    ],
  });
}

function lists(list) {
  const out = [];
  if (list.incoming.length) {
    out.push(section(`Requests for you · ${list.incoming.length}`, list.incoming.map((r) => h('li', { class: 'm-request' },
      h('div', { class: 'm-row m-row-static' }, avatar(name(r), 1),
        h('span', { class: 'm-row-label' }, name(r), h('span', { class: 'm-row-sub' }, r.displayName ? `${r.email} · wants to be friends` : 'wants to be friends'))),
      h('div', { class: 'm-pair' },
        action('Accept', async () => { await put(`/v1/friends/${r.id}`); render(); return 'You are now friends.'; }, { cls: 'm-solid' }),
        action('Decline', async () => { await del(`/v1/friends/${r.id}`); render(); return 'Request declined.'; }))))));
  }
  out.push(section(`Your friends · ${list.friends.length}`, list.friends.length
    ? list.friends.map((f) => row({ onclick: () => friendSheet(f), avatar: avatar(name(f), 2), label: name(f), sub: `${f.displayName ? `${f.email} · ` : ''}since ${date(f.since)}` }))
    : [h('li', {}, emptyState({ title: 'No friends yet', text: 'Add someone with an account on this server to compare economy.' }))]));
  if (list.outgoing.length) {
    out.push(section('Waiting for an answer', list.outgoing.map((r) => staticRow({
      label: name(r), sub: r.displayName ? r.email : null,
      trail: action('Cancel', async () => { await del(`/v1/friends/${r.id}`); render(); return 'Request cancelled.'; }),
    }))));
  }
  return out;
}

export function friendsScreen(query) {
  const win = WINDOWS.some(([k]) => k === query.get('window')) ? query.get('window') : '90d';
  const slot = h('div', { class: 'm-stack-l' });
  loadInto(slot, () => Promise.all([get('/v1/friends'), get(`/v1/comparisons?window=${win}`)]),
    ([list, cmp]) => {
      const parts = lists(list);
      // Requests lead, then the comparison, then everyone else.
      const requests = list.incoming.length ? [parts.shift()] : [];
      return h('div', { class: 'm-stack-l' }, ...requests, comparison(cmp, win), ...parts);
    },
    { label: 'friends' });
  return page({
    title: 'Friends',
    action: h('button', { type: 'button', class: 'm-head-btn', onclick: addFriendSheet }, icon('plus'), 'Add'),
  }, slot);
}
