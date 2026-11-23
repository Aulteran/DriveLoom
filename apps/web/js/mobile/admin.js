// Administration on the phone (#/admin/*): accounts, invitations, default
// units, email (SMTP), single sign-on (OIDC) and the audit log. Same endpoints
// and request bodies as views/admin.js (smtpBody, oidcBody, inviteLink and
// auditDetail come from there); tables become rows and sheets, sections are
// wrapping chips, and nothing scrolls sideways.
import { get, post, put, del } from '../api.js';
import { h, field, select, toast } from '../ui.js';
import { icon } from '../icons.js';
import { render, state } from '../core.js';
import { date, dateTime } from '../format.js';
import { unitFields } from '../units.js';
import { SECTIONS, adminError, inviteLink, auditDetail, refreshInstance, smtpBody, oidcBody } from '../views/admin.js';
import { openSheet } from './sheet.js';
import { page, row, staticRow, avatar, pill, action, confirmSheet, withFreshSignIn, sheetForm, copyField } from './kit.js';
import { loadInto, emptyState } from './states.js';

const adminAction = (label, fn, opts = {}) => action(label, fn, { error: adminError, ...opts });

// ---------- accounts ----------
function userSheet(u) {
  const active = u.status === 'active';
  const role = select('role', [['user', 'User'], ['admin', 'Administrator']], u.instanceRole, { id: 'm-user-role' });
  const s = openSheet({
    title: u.displayName || u.email, sub: u.displayName ? u.email : null,
    content: [
      h('dl', { class: 'm-group m-facts' },
        h('div', {}, h('dt', {}, 'Joined'), h('dd', {}, date(u.createdAt))),
        h('div', {}, h('dt', {}, 'Vehicles owned'), h('dd', {}, String(u.ownedVehicleCount))),
        h('div', {}, h('dt', {}, 'Status'), h('dd', {}, active ? 'Active' : 'Disabled'))),
      h('div', { class: 'field' }, h('label', { for: 'm-user-role' }, 'Role'), role),
      adminAction('Save role', async () => {
        if (role.value === u.instanceRole) return 'No change.';
        await put(`/v1/admin/users/${u.id}/role`, { role: role.value });
        s.close(); render();
        return 'Role changed.';
      }, { cls: 'm-wide' }),
      h('div', { class: 'm-sheet-actions m-stack' }, active
        ? adminAction('Disable account', async () => {
          if (!(await confirmSheet({ title: `Disable ${u.email}?`, text: 'They are signed out everywhere and cannot sign in until re-enabled.', confirm: 'Disable account' }))) return false;
          await put(`/v1/admin/users/${u.id}/status`, { status: 'disabled' });
          s.close(); render();
          return 'Account disabled.';
        }, { cls: 'danger m-wide' })
        : adminAction('Enable account', async () => {
          await put(`/v1/admin/users/${u.id}/status`, { status: 'active' });
          s.close(); render();
          return 'Account enabled.';
        }, { cls: 'secondary m-wide' })),
      h('p', { class: 'm-note' }, 'Passwords are never visible here. An operator can reset one from the server command line.'),
    ],
  });
}

function users({ items }) {
  const me = state.account.id;
  const disabled = items.filter((u) => u.status !== 'active').length;
  const list = h('ul', { class: 'm-group m-list' }, items.map((u) => {
    const li = u.id === me
      ? staticRow({ avatar: avatar(u.displayName || u.email), label: u.displayName || u.email, sub: u.displayName ? `${u.email} · you` : 'you', trail: pill('Admin', 'accent') })
      : row({
        onclick: () => userSheet(u), avatar: avatar(u.displayName || u.email, u.status === 'active' ? null : 1),
        label: u.displayName || u.email, sub: [u.displayName ? u.email : null, `${u.ownedVehicleCount} ${u.ownedVehicleCount === 1 ? 'vehicle' : 'vehicles'}`].filter(Boolean).join(' · '),
        trail: u.status !== 'active' ? pill('Disabled', 'bad') : u.instanceRole === 'admin' ? pill('Admin', 'accent') : null,
      });
    li.dataset.q = `${u.displayName ?? ''} ${u.email}`.toLowerCase();
    return li;
  }));
  const search = h('input', { type: 'search', placeholder: 'Search accounts', 'aria-label': 'Search accounts', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', class: 'm-search' });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const li of list.children) li.hidden = !!q && !li.dataset.q.includes(q);
  });
  return h('div', { class: 'm-stack' },
    items.length > 6 ? search : null,
    h('p', { class: 'm-note' }, `${items.length} ${items.length === 1 ? 'account' : 'accounts'}${disabled ? ` · ${disabled} disabled` : ''}`),
    list);
}

// ---------- invitations ----------
function inviteSheet() {
  const body = h('div', {});
  const s = openSheet({ title: 'Invite someone', content: body, onClose: () => render() });
  body.append(
    h('p', { class: 'm-sheet-text' }, state.instance.registration === 'open'
      ? 'Registration is open on this server, so anyone can sign up. Invitations matter when it is closed.'
      : 'Registration is closed. Only people with an invitation can create an account.'),
    sheetForm([
      field('Email (optional)', h('input', { name: 'email', type: 'email', inputmode: 'email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', autocorrect: 'off' }), 'Leave empty for an invitation anyone with the link can use once.'),
      field('Valid for', select('days', [['1', '1 day'], ['7', '7 days'], ['30', '30 days']], '7')),
      h('button', { type: 'submit', class: 'm-wide' }, 'Create invitation'),
    ], async (v) => {
      const inv = await withFreshSignIn(() => post('/v1/admin/invites', { email: v.email.trim() || null, expiresInDays: Number(v.days) }));
      body.replaceChildren(
        h('div', { class: 'notice' }, h('p', {}, h('strong', {}, 'Copy this link now.'), ` It is shown only once and works once, until ${dateTime(inv.expiresAt)}.`)),
        copyField('Invitation link', inviteLink(inv.token)),
        h('button', { type: 'button', class: 'secondary m-wide', onclick: () => s.close() }, 'Done'));
      return 'Invitation created.';
    }));
  s.dialog.querySelector('input')?.focus();
}

function invites({ items }) {
  const now = Date.now();
  if (!items.length) return emptyState({ title: 'No invitations yet', text: 'Create one to let someone register while sign-up is closed.', action: h('button', { type: 'button', class: 'm-wide', onclick: inviteSheet }, icon('plus'), 'Invite someone') });
  return h('ul', { class: 'm-group m-list' }, items.map((i) => {
    const expired = !i.usedAt && Date.parse(i.expiresAt) < now;
    return staticRow({
      label: i.email ?? 'Anyone with the link',
      sub: `${i.usedAt ? `Used ${date(i.usedAt)}` : expired ? 'Expired' : `Open until ${date(i.expiresAt)}`} · created ${date(i.createdAt)}`,
      trail: i.usedAt ? null : adminAction(expired ? 'Delete' : 'Revoke', async () => {
        if (!expired && !(await confirmSheet({ title: 'Revoke this invitation?', text: `The link for ${i.email ?? 'anyone'} stops working.`, confirm: 'Revoke' }))) return false;
        await del(`/v1/admin/invites/${i.id}`); render();
        return 'Invitation removed.';
      }),
    });
  }));
}

// ---------- default units ----------
function units(current) {
  return h('div', { class: 'm-group m-pad' }, sheetForm([
    h('p', { class: 'm-note m-flush' }, 'Every account sees these until its owner chooses their own units in Settings. Changing them updates everyone who has not. Recorded values are never converted.'),
    unitFields(current, { hints: { currency: 'Default reporting currency for new vehicles.' } }),
    h('button', { type: 'submit', class: 'm-wide' }, 'Save default units'),
  ], async (v) => {
    await put('/v1/admin/settings/units', v);
    state.prefs = await get('/v1/preferences');
    render();
    return 'Default units saved.';
  }));
}

// ---------- modules ----------
function modules({ modules: m }) {
  const id = 'm-mod-service';
  return h('div', { class: 'm-group m-pad m-stack-s' },
    h('p', { class: 'm-note m-flush' }, 'Optional features, off until you turn them on for the whole server.'),
    h('div', { class: 'm-switch-row' },
      h('label', { for: id }, 'Service module'),
      h('input', { id, type: 'checkbox', role: 'switch', class: 'm-toggle', checked: m.service, onchange: async (e) => {
        const on = e.target.checked;
        try { const r = await put('/v1/admin/settings/modules/service', { enabled: on }); state.modules = r.modules; toast(on ? 'Service module enabled.' : 'Service module disabled.'); } catch (err) { e.target.checked = !on; toast(err.message); }
      } })),
    h('p', { class: 'm-note' }, 'Adds a Service page to vehicles for maintenance history. Each member can still hide it for a vehicle in that vehicle’s settings. Turning it off only hides the page: service data and everyone’s choices are kept and return when you turn it back on.'));
}

// ---------- email and sign-on ----------
const status = (on, label) => pill(label, on ? 'good' : 'warn');
const envNotice = (what, vars) => h('div', { class: 'notice' },
  h('p', {}, h('strong', {}, `${what} is configured by the server environment.`)),
  h('p', {}, `The variables ${vars} take precedence over anything saved here. Change them on the server and restart to edit it.`));
const probe = (label, path, ok) => adminAction(label, async () => ok(await withFreshSignIn(() => post(path))), { cls: 'secondary m-wide' });
const remove = (label, path, title, text, done) => adminAction(label, async () => {
  if (!(await confirmSheet({ title, text, confirm: label }))) return false;
  await withFreshSignIn(() => del(path)); await refreshInstance(); render();
  return done;
}, { cls: 'danger m-wide' });
const toggle = (c, label, hint) => h('div', { class: 'm-switch-field' },
  h('label', { class: 'm-switch-field-label', for: 'm-enabled' }, h('strong', {}, label), h('span', {}, hint)),
  h('input', { type: 'checkbox', role: 'switch', class: 'm-sw', id: 'm-enabled', name: 'enabled', checked: c.enabled }));

function email(c) {
  const badge = status(c.configured, c.configured ? 'Email is on' : c.source === 'database' && !c.enabled ? 'Turned off (settings saved)' : c.secretUnreadable ? 'Password needs re-entering' : 'Email is off');
  const intro = h('p', { class: 'm-note m-flush' }, 'Lets DriveLoom send account recovery, email verification and sign-in codes. Without it, an operator resets passwords from the command line.');
  if (c.source === 'env') {
    return h('div', { class: 'm-group m-pad m-stack' }, badge, intro, envNotice('Email', 'DRIVELOOM_SMTP_URL and DRIVELOOM_SMTP_FROM'),
      h('p', {}, 'Messages are sent from ', h('code', {}, c.from), '.'),
      probe('Send a test message to me', '/v1/admin/settings/smtp/test', (r) => `Test message sent to ${r.sentTo}.`));
  }
  return h('div', { class: 'm-stack' },
    h('div', { class: 'm-group m-pad' }, sheetForm([
      badge, intro,
      toggle(c, 'Turn on email', 'Off keeps everything below saved but sends no email.'),
      c.secretUnreadable ? h('div', { class: 'error' }, 'The saved password cannot be read with this server’s secret key (for example after a restore onto a different key). Enter it again and save.') : null,
      field('Server', h('input', { name: 'host', value: c.host, required: true, maxlength: 253, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', autocorrect: 'off', inputmode: 'url', placeholder: 'smtp.example.com' })),
      field('Port', h('input', { name: 'port', type: 'number', inputmode: 'numeric', min: 1, max: 65535, value: String(c.port), required: true }), 'Usually 587 (STARTTLS) or 465 (TLS).'),
      field('Connection security', select('security', [['starttls', 'STARTTLS (port 587)'], ['tls', 'TLS (port 465)'], ['none', 'None (trusted network only)']], c.security)),
      field('Username', h('input', { name: 'username', value: c.username, maxlength: 255, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', autocorrect: 'off' }), 'Leave empty if the server needs no sign-in.'),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', maxlength: 512, placeholder: c.hasPassword ? 'Saved. Leave blank to keep it.' : '' })),
      c.hasPassword ? h('label', { class: 'm-check' }, h('input', { type: 'checkbox', name: 'clearPassword' }), 'Remove the saved password') : null,
      field('From address', h('input', { name: 'from', value: c.from, required: true, maxlength: 254, autocapitalize: 'none', spellcheck: 'false', autocorrect: 'off', placeholder: 'DriveLoom <noreply@example.com>' })),
      h('button', { type: 'submit', class: 'm-wide' }, 'Save email settings'),
      h('p', { class: 'm-note' }, 'The password is stored encrypted and never shown again. A test message goes to your own address using the saved settings.'),
    ], async (v) => {
      await withFreshSignIn(() => put('/v1/admin/settings/smtp', smtpBody(v)));
      await refreshInstance(); render();
      return 'Email settings saved.';
    })),
    c.configured && c.enabled ? probe('Send a test message to me', '/v1/admin/settings/smtp/test', (r) => `Test message sent to ${r.sentTo}.`) : null,
    c.source === 'database' ? remove('Remove email settings', '/v1/admin/settings/smtp', 'Remove the email settings?', 'Email recovery, verification and sign-in codes stop working.', 'Email settings removed.') : null);
}

function signin(c) {
  const badge = status(c.configured, c.configured ? 'Single sign-on is on' : c.source === 'database' && !c.enabled ? 'Turned off (settings saved)' : c.secretUnreadable ? 'Client secret needs re-entering' : 'Single sign-on is off');
  const intro = h('p', { class: 'm-note m-flush' }, 'Lets people sign in with an OpenID Connect provider such as Authentik, Keycloak or Google. Accounts are linked by the provider’s identity, never by email alone.');
  const redirect = copyField('Redirect URI', c.redirectUri, { hint: 'Register this exact address with your identity provider.' });
  if (c.source === 'env') {
    return h('div', { class: 'm-group m-pad m-stack' }, badge, intro, envNotice('Single sign-on', 'DRIVELOOM_OIDC_ISSUER, DRIVELOOM_OIDC_CLIENT_ID and DRIVELOOM_OIDC_CLIENT_SECRET'),
      h('dl', { class: 'm-facts m-facts-flat' }, h('div', {}, h('dt', {}, 'Provider'), h('dd', {}, c.issuer)), h('div', {}, h('dt', {}, 'Client ID'), h('dd', {}, c.clientId))),
      redirect, probe('Check the provider', '/v1/admin/settings/oidc/test', (r) => `Provider reachable: ${r.issuer}`));
  }
  return h('div', { class: 'm-stack' },
    h('div', { class: 'm-group m-pad' }, sheetForm([
      badge, intro,
      toggle(c, 'Turn on single sign-on', 'Off keeps everything below saved but hides the sign-in button.'),
      c.secretUnreadable ? h('div', { class: 'error' }, 'The saved client secret cannot be read with this server’s secret key. Enter it again and save.') : null,
      redirect,
      field('Issuer URL', h('input', { name: 'issuer', type: 'url', inputmode: 'url', value: c.issuer, required: true, maxlength: 512, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', autocorrect: 'off', placeholder: 'https://auth.example.com/application/o/driveloom/' }), 'An https address. DriveLoom reads the provider’s discovery document from it.'),
      field('Client ID', h('input', { name: 'clientId', value: c.clientId, required: true, maxlength: 255, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', autocorrect: 'off' })),
      field('Client secret', h('input', { name: 'clientSecret', type: 'password', autocomplete: 'new-password', maxlength: 1024, required: !c.hasClientSecret, placeholder: c.hasClientSecret ? 'Saved. Leave blank to keep it.' : '' })),
      h('button', { type: 'submit', class: 'm-wide' }, 'Save sign-on settings'),
      h('p', { class: 'm-note' }, 'Changing the issuer is refused while any account depends on the current provider and has no password or passkey. The client secret is stored encrypted and never shown again.'),
    ], async (v) => {
      await withFreshSignIn(() => put('/v1/admin/settings/oidc', oidcBody(v)));
      await refreshInstance(); render();
      return 'Sign-on settings saved.';
    })),
    c.configured && c.enabled ? probe('Check the provider', '/v1/admin/settings/oidc/test', (r) => `Provider reachable: ${r.issuer}`) : null,
    c.source === 'database' ? remove('Remove sign-on', '/v1/admin/settings/oidc', 'Remove single sign-on?', 'People who sign in only through the provider lose access until they have a password or passkey.', 'Single sign-on removed.') : null);
}

// ---------- audit ----------
function audit({ items }, before) {
  if (!items.length) return emptyState({ title: 'No events', text: 'Security and sharing events appear here as they happen.' });
  const groups = new Map();
  for (const e of items) {
    const day = date(e.occurredAt);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(e);
  }
  return h('div', { class: 'm-stack-l' },
    [...groups].map(([day, events]) => h('section', { class: 'm-sec', 'aria-label': day },
      h('h2', { class: 'm-label' }, day),
      h('ul', { class: 'm-group m-list' }, events.map((e) => h('li', { class: 'm-audit' },
        h('p', { class: 'm-audit-top' }, h('code', {}, e.action), h('span', { class: 'm-note' }, new Date(e.occurredAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))),
        h('p', { class: 'm-note' }, `By ${e.actorId ? `…${e.actorId.slice(-8)}` : 'system'}${e.subjectId ? ` · ${e.subjectType ?? 'subject'} …${e.subjectId.slice(-8)}` : ''}`),
        auditDetail(e.details) ? h('p', { class: 'm-note m-audit-detail' }, auditDetail(e.details)) : null))))),
    h('div', { class: 'm-pair' },
      before ? h('a', { class: 'button secondary', href: '#/admin/audit' }, 'Newest') : null,
      items.length === 100 ? h('a', { class: 'button secondary', href: `#/admin/audit?before=${items[items.length - 1].id}` }, 'Older events') : null));
}

const LOAD = {
  users: [() => get('/v1/admin/users'), users, 'accounts'],
  invites: [() => get('/v1/admin/invites'), invites, 'invitations'],
  units: [() => get('/v1/admin/settings/units'), units, 'default units'],
  modules: [() => get('/v1/admin/settings/modules'), modules, 'modules'],
  email: [() => get('/v1/admin/settings/smtp'), email, 'email settings'],
  signin: [() => get('/v1/admin/settings/oidc'), signin, 'sign-on settings'],
};

export function adminScreen(section0, query) {
  if (state.account?.instanceRole !== 'admin') {
    return page({ title: 'Administrators only' }, emptyState({ title: 'You are not an administrator', text: 'Ask an administrator of this server if you need access.' }));
  }
  const sec = SECTIONS.some(([k]) => k === section0) ? section0 : 'users';
  const chips = h('nav', { class: 'm-sections', 'aria-label': 'Administration sections' },
    h('ul', {}, SECTIONS.map(([k, label]) => h('li', {}, h('a', { class: 'm-chip-link', href: `#/admin/${k}`, 'aria-current': k === sec ? 'page' : undefined }, label)))));
  const slot = h('div', {});
  const before = query.get('before');
  if (sec === 'audit') {
    loadInto(slot, () => get(`/v1/admin/audit?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`), (d) => audit(d, before), { label: 'audit log' });
  } else {
    const [load, fill, label] = LOAD[sec];
    loadInto(slot, load, fill, { label });
  }
  const title = SECTIONS.find(([k]) => k === sec)[1];
  return page({
    title: 'Administration',
    action: sec === 'invites' ? h('button', { type: 'button', class: 'm-head-btn', onclick: inviteSheet }, icon('plus'), 'Invite') : null,
  }, chips, h('h2', { class: 'm-subhead' }, title), slot);
}

