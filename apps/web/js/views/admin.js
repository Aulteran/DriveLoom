// Instance administration: accounts, invitations and the audit log.
import { get, post, put, del } from '../api.js';
import { h, form, field, select, confirmDialog, toast } from '../ui.js';
import { render, state } from '../main.js';
import { date, dateTime } from '../format.js';
import { withFreshSignIn } from './settings.js';
import { icon } from '../icons.js';

const SECTIONS = [['users', 'Accounts', 'users'], ['invites', 'Invitations', 'mail'], ['audit', 'Audit log', 'list']];

const act = (label, fn, cls = 'secondary') => h('button', { class: cls, onclick: async (e) => {
  const btn = e.currentTarget; btn.disabled = true;
  try { const msg = await fn(); if (msg === false) { btn.disabled = false; return; } render(); if (typeof msg === 'string') toast(msg); }
  catch (err) { toast(err.code === 'last_admin' ? 'The instance must keep an active administrator.' : err.message); btn.disabled = false; }
} }, label);

async function users() {
  const { items } = await get('/v1/admin/users');
  const me = state.account.id;
  return h('section', { class: 'panel' },
    h('h2', {}, 'Accounts'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', { class: 'hide-sm' }, 'Joined'), h('th', { class: 'num hide-sm' }, 'Vehicles owned'), h('th', {}, 'Role'), h('th', {}, 'Status'))),
      h('tbody', {}, items.map((u) => h('tr', {},
        h('td', {}, h('strong', {}, u.displayName || u.email), u.displayName ? h('div', { class: 'small muted' }, u.email) : null),
        h('td', { class: 'hide-sm' }, date(u.createdAt)),
        h('td', { class: 'num hide-sm' }, String(u.ownedVehicleCount)),
        h('td', {}, u.id === me ? 'Administrator (you)' : select('role', [['user', 'User'], ['admin', 'Administrator']], u.instanceRole, {
          'aria-label': `Role of ${u.email}`,
          onchange: async (e) => {
            try { await put(`/v1/admin/users/${u.id}/role`, { role: e.target.value }); toast('Role changed.'); } catch (err) { toast(err.message); }
            render();
          },
        })),
        h('td', {}, h('span', { class: `badge ${u.status === 'active' ? '' : 'warn'}` }, u.status === 'active' ? 'Active' : 'Disabled'), ' ',
          u.id === me ? null : u.status === 'active'
            ? act('Disable', async () => {
              if (!(await confirmDialog(`Disable ${u.email}? They are signed out everywhere and cannot sign in until re-enabled.`, 'Disable'))) return false;
              await put(`/v1/admin/users/${u.id}/status`, { status: 'disabled' });
              return 'Account disabled.';
            })
            : act('Enable', async () => { await put(`/v1/admin/users/${u.id}/status`, { status: 'active' }); return 'Account enabled.'; }))))))),
    h('p', { class: 'small muted' }, 'Passwords are never visible here. An operator can reset one from the server command line; see the deployment guide.'));
}

async function invites() {
  const { items } = await get('/v1/admin/invites');
  const shown = h('div');
  const create = form({}, [
    h('div', { class: 'grid' },
      field('Email (optional)', h('input', { name: 'email', type: 'email', autocomplete: 'off' }), 'Leave empty for an invitation anyone with the link can use once.'),
      field('Valid for', select('days', [['1', '1 day'], ['7', '7 days'], ['30', '30 days']], '7'))),
    h('button', { type: 'submit' }, 'Create invitation'),
  ], async (v, el) => {
    const inv = await withFreshSignIn(() => post('/v1/admin/invites', { email: v.email.trim() || null, expiresInDays: Number(v.days) }));
    const link = `${location.origin}${location.pathname}#/register?invite=${encodeURIComponent(inv.token)}`;
    el.reset();
    shown.replaceChildren(h('div', { class: 'notice' },
      h('p', {}, h('strong', {}, 'Copy this link now.'), ' It is shown only once and works once, until ', dateTime(inv.expiresAt), '.'),
      h('p', {}, h('code', { class: 'secret' }, link)),
      h('button', { type: 'button', class: 'secondary', onclick: async () => {
        try { await navigator.clipboard.writeText(link); toast('Link copied.'); } catch { toast('Copy failed; select the link and copy it by hand.'); }
      } }, 'Copy link')));
    const list = await get('/v1/admin/invites');
    table.replaceWith(table = inviteTable(list.items));
  });
  let table = inviteTable(items);
  return h('div', {},
    h('section', { class: 'panel' }, h('h2', {}, 'Invite someone'),
      h('p', { class: 'muted' }, state.instance.registration === 'open' ? 'Registration is open on this instance, so anyone can sign up. Invitations matter when it is closed.' : 'Registration is closed. Only people with an invitation can create an account.'),
      create, shown),
    h('section', { class: 'panel' }, h('h2', {}, 'Invitations'), table));
}

function inviteTable(items) {
  if (!items.length) return h('p', { class: 'muted' }, 'No invitations yet.');
  const now = Date.now();
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'For'), h('th', { class: 'hide-sm' }, 'Created'), h('th', {}, 'State'), h('th', {}))),
    h('tbody', {}, items.map((i) => {
      const expired = !i.usedAt && Date.parse(i.expiresAt) < now;
      return h('tr', {},
        h('td', {}, i.email ?? h('span', { class: 'muted' }, 'Anyone with the link')),
        h('td', { class: 'hide-sm' }, date(i.createdAt)),
        h('td', {}, i.usedAt ? `Used ${date(i.usedAt)}` : expired ? 'Expired' : `Open until ${date(i.expiresAt)}`),
        h('td', { class: 'num' }, i.usedAt ? null : act(expired ? 'Delete' : 'Revoke', async () => { await del(`/v1/admin/invites/${i.id}`); return 'Invitation removed.'; })));
    }))));
}

async function audit(query) {
  const before = query?.get('before');
  const { items } = await get(`/v1/admin/audit?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
  const detail = (d) => {
    const parts = Object.entries(d ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    return parts.length ? parts.join(', ') : '';
  };
  return h('section', { class: 'panel' },
    h('h2', {}, 'Audit log'),
    h('p', { class: 'muted' }, 'Security and sharing events, newest first. Fuel records and passwords are never logged.'),
    items.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Event'), h('th', { class: 'hide-sm' }, 'Actor'), h('th', { class: 'hide-sm' }, 'Subject'), h('th', { class: 'hide-sm' }, 'Details'))),
      h('tbody', {}, items.map((e) => h('tr', {},
        h('td', {}, dateTime(e.occurredAt)),
        h('td', {}, h('code', {}, e.action)),
        h('td', { class: 'hide-sm small' }, e.actorId ? h('code', {}, e.actorId.slice(-8)) : 'system'),
        h('td', { class: 'hide-sm small' }, e.subjectId ? `${e.subjectType ?? ''} ${e.subjectId.slice(-8)}` : ''),
        h('td', { class: 'hide-sm small muted' }, detail(e.details))))))) : h('p', { class: 'muted' }, 'No events.'),
    h('p', { class: 'row' },
      before ? h('a', { href: '#/admin/audit' }, 'Newest') : null,
      items.length === 100 ? h('a', { href: `#/admin/audit?before=${items[items.length - 1].id}` }, 'Older events') : null));
}

export async function adminView(section, query) {
  if (state.account?.instanceRole !== 'admin') return h('div', { class: 'panel empty' }, h('h1', {}, 'Administrators only'), h('p', {}, h('a', { href: '#/' }, 'Back to your vehicles')));
  if (!SECTIONS.some(([k]) => k === section)) section = 'users';
  const body = section === 'invites' ? await invites() : section === 'audit' ? await audit(query) : await users();
  return h('div', {},
    h('h1', {}, 'Administration'),
    h('nav', { class: 'tabs', 'aria-label': 'Administration sections' }, SECTIONS.map(([k, label, ic]) => h('a', { href: `#/admin/${k}`, 'aria-current': k === section ? 'page' : undefined }, icon(ic), label))),
    body);
}
