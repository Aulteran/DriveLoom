// Instance administration: accounts, invitations, default units, email (SMTP), single sign-on (OIDC) and the audit log.
import { get, post, put, del } from '../api.js';
import { h, form, field, select, confirmDialog, toast } from '../ui.js';
import { render, state } from '../main.js';
import { date, dateTime } from '../format.js';
import { withFreshSignIn } from './settings.js';
import { unitFields } from '../units.js';
import { icon } from '../icons.js';

const SECTIONS = [['users', 'Accounts', 'users'], ['invites', 'Invitations', 'mail'], ['units', 'Default units', 'sliders'], ['email', 'Email', 'mail'], ['signin', 'Single sign-on', 'key'], ['audit', 'Audit log', 'list']];

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

async function units() {
  const current = await get('/v1/admin/settings/units');
  return form({ class: 'panel' }, [
    h('h2', {}, 'Default units'),
    h('p', { class: 'muted' }, 'Every account sees these until its owner chooses their own units in Settings. Changing them here updates everyone who has not. Recorded values are never converted.'),
    unitFields(current, { hints: { currency: 'Default reporting currency for new vehicles.' } }),
    h('button', { type: 'submit' }, 'Save default units'),
  ], async (v) => {
    await put('/v1/admin/settings/units', v);
    state.prefs = await get('/v1/preferences');
    return 'Default units saved.';
  });
}

// The sign-in screen and Security page read these public facts once; refresh them after a change here.
const refreshInstance = async () => { state.instance = await get('/v1/auth/instance').catch(() => state.instance); };

// Settings that server environment variables manage are shown read-only.
const envNotice = (what, vars) => h('div', { class: 'notice' },
  h('p', {}, h('strong', {}, `${what} is configured by the server environment.`)),
  h('p', {}, `The variables ${vars} take precedence over anything saved here. Change them on the server and restart to edit it.`));

/** Runs a "test" request and reports the outcome in a toast, asking for a fresh sign-in when needed. */
const probe = (label, path, ok) => h('button', { type: 'button', class: 'secondary', onclick: async (e) => {
  const btn = e.currentTarget; btn.disabled = true;
  try { toast(ok(await withFreshSignIn(() => post(path)))); } catch (err) { toast(err.message); }
  btn.disabled = false;
} }, label);

const removeButton = (label, path, confirm, done) => h('button', { type: 'button', class: 'danger', onclick: async (e) => {
  const btn = e.currentTarget;
  if (!(await confirmDialog(confirm, label))) return;
  btn.disabled = true;
  try { await withFreshSignIn(() => del(path)); await refreshInstance(); render(); toast(done); } catch (err) { toast(err.message); btn.disabled = false; }
} }, label);

/** The switch at the top of an integration page. Off keeps the fields saved but the feature unused. */
const enableToggle = (c, label, hint) => h('div', { class: 'field' },
  h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'enabled', checked: c.enabled }), h('strong', {}, label)),
  h('div', { class: 'hint' }, hint));

async function email() {
  const c = await get('/v1/admin/settings/smtp');
  const head = [
    h('h2', {}, 'Email (SMTP)'),
    h('p', { class: 'muted' }, 'Lets DriveLoom send account recovery, email verification and sign-in codes. Without it, those features are off and an operator resets passwords from the command line.'),
    h('p', {}, h('span', { class: `badge ${c.configured ? 'accent' : 'warn'}` }, c.configured ? 'Email is on' : c.source === 'database' && !c.enabled ? 'Email is turned off (settings saved)' : c.secretUnreadable ? 'Password needs re-entering' : 'Email is off')),
  ];
  if (c.source === 'env') {
    return h('section', { class: 'panel' }, ...head, envNotice('Email', 'DRIVELOOM_SMTP_URL and DRIVELOOM_SMTP_FROM'),
      h('p', {}, 'Messages are sent from ', h('code', {}, c.from), '.'), h('p', { class: 'row' }, probe('Send a test message to me', '/v1/admin/settings/smtp/test', (r) => `Test message sent to ${r.sentTo}.`)));
  }
  return form({ class: 'panel' }, [
    ...head,
    enableToggle(c, 'Turn on email', 'Off keeps everything below saved but sends no email, so recovery, verification and sign-in codes stay unavailable.'),
    c.secretUnreadable ? h('div', { class: 'error' }, 'The saved password cannot be read with this server\'s secret key (for example after a restore onto a different key). Enter it again and save.') : null,
    h('div', { class: 'grid' },
      field('Server', h('input', { name: 'host', value: c.host, required: true, maxlength: 253, autocomplete: 'off', placeholder: 'smtp.example.com' })),
      field('Port', h('input', { name: 'port', type: 'number', min: 1, max: 65535, value: String(c.port), required: true }), 'Usually 587 (STARTTLS) or 465 (TLS).'),
      field('Connection security', select('security', [['starttls', 'STARTTLS (port 587)'], ['tls', 'TLS (port 465)'], ['none', 'None (trusted network only)']], c.security))),
    h('div', { class: 'grid' },
      field('Username', h('input', { name: 'username', value: c.username, maxlength: 255, autocomplete: 'off' }), 'Leave empty if the server needs no sign-in.'),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', maxlength: 512, placeholder: c.hasPassword ? 'Saved. Leave blank to keep it.' : '' }),
        c.hasPassword ? h('label', { class: 'row small' }, h('input', { type: 'checkbox', name: 'clearPassword' }), 'Remove the saved password') : null)),
    field('From address', h('input', { name: 'from', value: c.from, required: true, maxlength: 254, placeholder: 'DriveLoom <noreply@example.com>' })),
    h('div', { class: 'row' },
      h('button', { type: 'submit' }, 'Save email settings'),
      c.configured && c.enabled ? probe('Send a test message to me', '/v1/admin/settings/smtp/test', (r) => `Test message sent to ${r.sentTo}.`) : null,
      c.source === 'database' ? removeButton('Remove email settings', '/v1/admin/settings/smtp', 'Remove the saved email settings? Email recovery, verification and sign-in codes stop working.', 'Email settings removed.') : null),
    h('p', { class: 'small muted' }, 'The password is stored encrypted and is never shown again. A test message goes to your own address using the saved settings.'),
  ], async (v) => {
    const body = { enabled: !!v.enabled, host: v.host.trim(), port: Number(v.port), security: v.security, username: v.username.trim(), from: v.from.trim() };
    if (v.clearPassword) body.password = null; else if (v.password) body.password = v.password;
    await withFreshSignIn(() => put('/v1/admin/settings/smtp', body));
    await refreshInstance();
    render();
    return 'Email settings saved.';
  });
}

async function signin() {
  const c = await get('/v1/admin/settings/oidc');
  const redirect = h('div', { class: 'field' }, h('label', {}, 'Redirect URI'),
    h('code', { class: 'secret' }, c.redirectUri),
    h('div', { class: 'hint' }, 'Register this exact address with your identity provider.'),
    h('button', { type: 'button', class: 'secondary', onclick: async () => {
      try { await navigator.clipboard.writeText(c.redirectUri); toast('Redirect URI copied.'); } catch { toast('Copy failed; select it and copy by hand.'); }
    } }, 'Copy'));
  const head = [
    h('h2', {}, 'Single sign-on (OIDC)'),
    h('p', { class: 'muted' }, 'Lets people sign in with an OpenID Connect provider such as Authentik, Keycloak or Google. Accounts are linked by the provider\'s identity, never by email alone.'),
    h('p', {}, h('span', { class: `badge ${c.configured ? 'accent' : 'warn'}` }, c.configured ? 'Single sign-on is on' : c.source === 'database' && !c.enabled ? 'Single sign-on is turned off (settings saved)' : c.secretUnreadable ? 'Client secret needs re-entering' : 'Single sign-on is off')),
  ];
  if (c.source === 'env') {
    return h('section', { class: 'panel' }, ...head, envNotice('Single sign-on', 'DRIVELOOM_OIDC_ISSUER, DRIVELOOM_OIDC_CLIENT_ID and DRIVELOOM_OIDC_CLIENT_SECRET'),
      h('p', {}, 'Provider: ', h('code', {}, c.issuer), h('br'), 'Client ID: ', h('code', {}, c.clientId)), redirect,
      h('p', { class: 'row' }, probe('Check the provider', '/v1/admin/settings/oidc/test', (r) => `Provider reachable: ${r.issuer}`)));
  }
  return form({ class: 'panel' }, [
    ...head,
    enableToggle(c, 'Turn on single sign-on', 'Off keeps everything below saved but hides the sign-in button and refuses provider sign-ins.'),
    c.secretUnreadable ? h('div', { class: 'error' }, 'The saved client secret cannot be read with this server\'s secret key (for example after a restore onto a different key). Enter it again and save.') : null,
    redirect,
    field('Issuer URL', h('input', { name: 'issuer', type: 'url', value: c.issuer, required: true, maxlength: 512, autocomplete: 'off', placeholder: 'https://auth.example.com/application/o/driveloom/' }), 'An https address. DriveLoom reads the provider\'s discovery document from it.'),
    h('div', { class: 'grid' },
      field('Client ID', h('input', { name: 'clientId', value: c.clientId, required: true, maxlength: 255, autocomplete: 'off' })),
      field('Client secret', h('input', { name: 'clientSecret', type: 'password', autocomplete: 'new-password', maxlength: 1024, required: !c.hasClientSecret, placeholder: c.hasClientSecret ? 'Saved. Leave blank to keep it.' : '' }))),
    h('div', { class: 'row' },
      h('button', { type: 'submit' }, 'Save sign-on settings'),
      c.configured && c.enabled ? probe('Check the provider', '/v1/admin/settings/oidc/test', (r) => `Provider reachable: ${r.issuer}`) : null,
      c.source === 'database' ? removeButton('Remove sign-on', '/v1/admin/settings/oidc', 'Remove single sign-on? People who sign in only through the provider lose access until they have a password or passkey.', 'Single sign-on removed.') : null),
    h('p', { class: 'small muted' }, 'Changing the issuer is refused while any account depends on the current provider and has no password or passkey. The client secret is stored encrypted and never shown again.'),
  ], async (v) => {
    const body = { enabled: !!v.enabled, issuer: v.issuer.trim(), clientId: v.clientId.trim() };
    if (v.clientSecret) body.clientSecret = v.clientSecret;
    await withFreshSignIn(() => put('/v1/admin/settings/oidc', body));
    await refreshInstance();
    render();
    return 'Sign-on settings saved.';
  });
}

export async function adminView(section, query) {
  if (state.account?.instanceRole !== 'admin') return h('div', { class: 'panel empty' }, h('h1', {}, 'Administrators only'), h('p', {}, h('a', { href: '#/' }, 'Back to your dashboard')));
  if (!SECTIONS.some(([k]) => k === section)) section = 'users';
  const body = section === 'invites' ? await invites() : section === 'units' ? await units() : section === 'email' ? await email() : section === 'signin' ? await signin() : section === 'audit' ? await audit(query) : await users();
  return h('div', {},
    h('h1', {}, 'Administration'),
    h('nav', { class: 'tabs', 'aria-label': 'Administration sections' }, SECTIONS.map(([k, label, ic]) => h('a', { href: `#/admin/${k}`, 'aria-current': k === section ? 'page' : undefined }, icon(ic), label))),
    body);
}
