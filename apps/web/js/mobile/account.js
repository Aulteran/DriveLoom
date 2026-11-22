// Settings, Profile and Account and security on the phone (#/settings/*,
// #/account). The same endpoints and rules as views/settings.js; the phone
// shows them as list rows, sheets and explicit buttons. Preferences save as
// soon as a choice changes, sending all four unit keys exactly as the desktop
// form does (null keeps following the instance default).
import { get, post, put, patch, del, setCsrf, passkeysSupported, createPasskey } from '../api.js';
import { h, field, select, toast } from '../ui.js';
import { icon } from '../icons.js';
import { go, render, refreshSession, state } from '../core.js';
import { dateTime } from '../format.js';
import { UNIT_KEYS, UNIT_LABELS, unitOptions, unitLabel } from '../units.js';
import { shortAgent } from '../views/settings.js';
import { themeControl } from '../theme.js';
import { openSheet, closeSheets } from './sheet.js';
import { page, section, row, staticRow, action, confirmSheet, withFreshSignIn, sheetForm, pill, OFFLINE_SAVE } from './kit.js';
import { loadInto } from './states.js';
import { installStatus } from './install.js';

// ---------- Settings: units, appearance, app ----------
function unitRow(key) {
  const p = state.prefs;
  const defaults = p.instanceDefaults ?? {};
  const inherited = (p.inherited ?? []).includes(key);
  const id = `m-unit-${key}`;
  const sel = select(key, [['', `${unitLabel(key, defaults[key])} (default)`], ...unitOptions(key, p[key])], inherited ? '' : p[key], { id, class: 'm-row-select' });
  sel.addEventListener('change', async () => {
    const previous = inherited ? '' : p[key];
    if (navigator.onLine === false) { sel.value = previous; toast(OFFLINE_SAVE); return; }
    // Every key goes up, as on the desktop: the others keep their current choice or default.
    const body = Object.fromEntries(UNIT_KEYS.map((k) => [k, k === key ? (sel.value || null) : ((p.inherited ?? []).includes(k) ? null : p[k])]));
    sel.disabled = true;
    try {
      state.prefs = await put('/v1/preferences', body);
      toast(`${UNIT_LABELS[key]} saved.`);
      render();
    } catch (err) { sel.value = previous; sel.disabled = false; toast(err.message); }
  });
  return h('li', {}, h('div', { class: 'm-row m-row-field' },
    h('label', { class: 'm-row-label', for: id }, UNIT_LABELS[key],
      key === 'currency' ? h('span', { class: 'm-row-sub' }, 'For new vehicles and friend comparisons') : null),
    sel));
}

export function settingsScreen() {
  const status = installStatus();
  return page({ title: 'Settings' },
    section('Units', UNIT_KEYS.map(unitRow), { note: 'These change how values are shown and compared. Nothing you have recorded is changed. “(default)” follows the units your administrator chose, including later changes.' }),
    h('section', { class: 'm-sec', 'aria-labelledby': 'm-theme-h' },
      h('h2', { class: 'm-label', id: 'm-theme-h' }, 'Appearance'),
      h('div', { class: 'm-group m-pad' }, themeControl()),
      h('p', { class: 'm-note' }, 'Motion follows your phone’s Reduce Motion setting.')),
    section('App', [
      row({ href: '#/more/install', icon: 'install', label: 'Install the app', trail: pill(status, status === 'Installed' ? 'good' : status === 'Needs HTTPS' ? 'warn' : '') }),
      row({ href: '#/settings/profile', icon: 'user', label: 'Profile' }),
      row({ href: '#/settings/security', icon: 'key', label: 'Account and security' }),
    ]));
}

// ---------- Profile ----------
export function profileScreen() {
  const a = state.account;
  return page({ title: 'Profile' },
    h('div', { class: 'm-group m-pad' }, sheetForm([
      field('Email', h('input', { value: a.email, disabled: true }), a.emailVerified ? 'Verified.' : 'Not verified yet.'),
      field('Display name', h('input', { name: 'display_name', maxlength: 80, value: a.displayName ?? '', autocomplete: 'name', autocapitalize: 'words', enterkeyhint: 'done' }), 'Shown to people you share vehicles with and to your friends.'),
      h('button', { type: 'submit', class: 'm-wide' }, 'Save profile'),
    ], async (v) => {
      await patch('/v1/auth/account', { display_name: v.display_name });
      await refreshSession(); render();
      return 'Profile saved.';
    })),
    h('section', { class: 'm-sec', 'aria-labelledby': 'm-del-h' },
      h('h2', { class: 'm-label', id: 'm-del-h' }, 'Delete your account'),
      h('div', { class: 'm-group m-pad m-danger-zone' },
        h('p', { class: 'm-note m-flush' }, 'Transfer or archive the vehicles you own first. Records you entered on vehicles shared with you stay with those vehicles. This cannot be undone.'),
        action('Delete account', async () => {
          if (!(await confirmSheet({ title: 'Delete your account?', text: `${a.email} is deleted permanently and you are signed out.`, confirm: 'Delete account' }))) return false;
          try { await withFreshSignIn(() => del('/v1/auth/account')); } catch (err) {
            if (err.code === 'owns_vehicles') throw new Error('You still own vehicles. Transfer ownership from each vehicle’s Members page, then try again.');
            throw err;
          }
          state.account = null; setCsrf(null); closeSheets(); go('#/signin');
          return 'Your account was deleted.';
        }, { cls: 'danger m-wide' }))));
}

// ---------- Account and security ----------
const after = async () => { await refreshSession(); render(); };

function passwordSheet(c) {
  const s = openSheet({
    title: c.password ? 'Change password' : 'Add a password',
    content: [
      sheetForm([
        c.password ? field('Current password', h('input', { name: 'current_password', type: 'password', autocomplete: 'current-password', required: true, enterkeyhint: 'next' })) : h('p', { class: 'm-sheet-text' }, 'You sign in without a password. You can add one.'),
        field('New password', h('input', { name: 'new_password', type: 'password', autocomplete: 'new-password', minlength: 12, required: true, enterkeyhint: 'done' }), 'At least 12 characters. Changing it signs out your other sessions.'),
        h('button', { type: 'submit', class: 'm-wide' }, c.password ? 'Change password' : 'Add password'),
      ], async (v) => {
        await withFreshSignIn(() => put('/v1/auth/password', { current_password: v.current_password, new_password: v.new_password }));
        s.close(); await after();
        return 'Password saved.';
      }),
      c.password ? h('div', { class: 'm-sheet-actions m-stack' }, action('Remove password', async () => {
        if (!(await confirmSheet({ title: 'Remove your password?', text: 'You will need a passkey or identity provider to sign in.', confirm: 'Remove password' }))) return false;
        await withFreshSignIn(() => del('/v1/auth/password'));
        s.close(); await after();
        return 'Password removed.';
      }, { cls: 'danger m-wide' })) : null,
    ],
  });
}

function totpSetupSheet() {
  const body = h('div', { class: 'm-form' });
  const s = openSheet({ title: 'Set up an authenticator', content: body, onClose: () => render() });
  body.append(h('p', { class: 'm-sheet-text' }, 'Preparing…'));
  withFreshSignIn(() => post('/v1/auth/totp')).then((t) => {
    body.replaceChildren(
      h('p', { class: 'm-sheet-text' }, 'Add this key to your authenticator app, then enter the 6-digit code it shows.'),
      h('p', {}, h('code', { class: 'secret m-secret' }, t.secret)),
      h('p', {}, h('a', { class: 'm-link', href: t.otpauth_uri }, 'Open in an authenticator app on this phone')),
      sheetForm([
        field('Code', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, required: true, enterkeyhint: 'done', class: 'm-code' })),
        h('button', { type: 'submit', class: 'm-wide' }, 'Turn on'),
      ], async (v) => {
        const out = await withFreshSignIn(() => post('/v1/auth/totp/confirm', { code: v.code.trim() }));
        await refreshSession();
        body.replaceChildren(
          h('div', { class: 'notice' }, h('strong', {}, 'Save these recovery codes now.'), ' Each works once if you lose your authenticator. They will not be shown again.'),
          h('ul', { class: 'codes m-codes' }, out.recovery_codes.map((code) => h('li', {}, h('code', {}, code)))),
          h('button', { type: 'button', class: 'm-wide', onclick: () => s.close() }, 'I saved them'));
        return 'Two-step sign-in is on.';
      }));
    body.querySelector('input[name=code]')?.focus();
  }, (err) => { if (err.message !== 'Confirmation cancelled.') toast(err.message); s.close(); });
}

function passkeySheet() {
  const s = openSheet({
    title: 'Add a passkey',
    content: sheetForm([
      h('p', { class: 'm-sheet-text' }, 'A passkey signs you in with your phone’s screen lock instead of a password.'),
      field('Name', h('input', { name: 'label', maxlength: 80, placeholder: 'Phone', autocapitalize: 'words', enterkeyhint: 'done' })),
      h('button', { type: 'submit', class: 'm-wide' }, 'Add a passkey'),
    ], async (v) => {
      const options = await withFreshSignIn(() => post('/v1/auth/passkeys/register/options'));
      await post('/v1/auth/passkeys/register/verify', { response: await createPasskey(options), label: v.label || 'Passkey' });
      s.close(); await after();
      return 'Passkey added.';
    }),
  });
}

function securityBody(c, sessions, linked) {
  const totpOn = c.totp;
  return h('div', { class: 'm-stack-l' },
    linked ? h('p', { class: 'notice', role: 'status' }, 'Your identity provider is linked.') : null,
    section('Sign-in', [
      row({ onclick: () => passwordSheet(c), icon: 'key', label: 'Password', sub: c.password ? 'Change or remove your password' : 'Not set: add one', trail: pill(c.password ? 'On' : 'Off', c.password ? 'good' : '') }),
      totpOn
        ? staticRow({ label: 'Authenticator app', sub: `Two-step sign-in is on · ${c.recoveryCodesRemaining} recovery codes left`, trail: action('Turn off', async () => {
          if (!(await confirmSheet({ title: 'Turn off two-step sign-in?', text: 'Signing in will no longer ask for a code from your authenticator app.', confirm: 'Turn off' }))) return false;
          await withFreshSignIn(() => del('/v1/auth/totp'));
          await after();
          return 'Two-step sign-in is off.';
        }) })
        : row({ onclick: totpSetupSheet, icon: 'shield', label: 'Authenticator app', sub: 'Ask for a code after your password', trail: pill('Off') }),
    ]),
    section('Passkeys', [
      ...c.passkeys.map((k) => staticRow({
        label: k.label || 'Passkey', sub: `Added ${dateTime(k.created_at)}${k.last_used_at ? ` · last used ${dateTime(k.last_used_at)}` : ''}`,
        trail: action('Remove', async () => {
          if (!(await confirmSheet({ title: `Remove “${k.label || 'Passkey'}”?`, text: 'You will no longer be able to sign in with this passkey.', confirm: 'Remove passkey' }))) return false;
          await withFreshSignIn(() => del(`/v1/auth/passkeys/${k.id}`));
          await after();
          return 'Passkey removed.';
        }),
      })),
      passkeysSupported()
        ? row({ onclick: passkeySheet, icon: 'plus', label: 'Add a passkey' })
        : staticRow({ label: 'This browser does not support passkeys.' }),
    ], { note: c.passkeys.length ? null : 'No passkeys yet.' }),
    state.instance?.oidc || c.oidc.length ? section('Identity provider', [
      ...c.oidc.map((i) => staticRow({
        label: i.email ?? 'Linked identity', sub: i.issuer,
        trail: action('Unlink', async () => {
          if (!(await confirmSheet({ title: 'Unlink this identity?', text: `You will no longer be able to sign in with ${i.email ?? 'it'}.`, confirm: 'Unlink' }))) return false;
          await withFreshSignIn(() => del(`/v1/auth/oidc/identities/${i.id}`));
          await after();
          return 'Identity unlinked.';
        }),
      })),
      state.instance?.oidc ? h('li', {}, h('div', { class: 'm-pad' }, action('Link an identity', async () => {
        const { authorization_url } = await withFreshSignIn(() => post('/v1/auth/oidc/start', { mode: 'link' }));
        location.assign(authorization_url);
        return false;
      }, { cls: 'secondary m-wide' }))) : null,
    ], { note: c.oidc.length ? null : 'Not linked.' }) : null,
    section('Signed-in devices', [
      ...sessions.map((s) => staticRow({
        label: [s.user_agent ? shortAgent(s.user_agent) : 'Unknown device', s.current ? pill('This device', 'accent') : null],
        sub: `Signed in ${dateTime(s.created_at)} · last active ${dateTime(s.last_seen_at)}`,
        trail: s.current ? null : action('Sign out', async () => { await del(`/v1/auth/sessions/${s.id}`); await after(); return 'Session signed out.'; }),
      })),
      sessions.length > 1 ? h('li', {}, h('div', { class: 'm-pad' }, action('Sign out everywhere else', async () => {
        const r = await post('/v1/auth/sessions/revoke-others');
        await after();
        return `Signed out ${r.revoked} other ${r.revoked === 1 ? 'session' : 'sessions'}.`;
      }, { cls: 'secondary m-wide' }))) : null,
    ]));
}

export function securityScreen(query) {
  const slot = h('div', {});
  loadInto(slot, async () => {
    // Fresh credentials, read directly: refreshSession() would treat a network error as signed out.
    const [s, { sessions }] = await Promise.all([get('/v1/auth/session'), get('/v1/auth/sessions')]);
    setCsrf(s.csrf_token); state.account = s.account;
    return { c: s.account.credentials, sessions };
  }, ({ c, sessions }) => securityBody(c, sessions, query.get('linked') === '1'), { label: 'account and security', rows: 5 });
  return page({ title: 'Account and security' }, slot);
}
