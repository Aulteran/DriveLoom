// Settings: display preferences, profile, and security (password, second
// factor, passkeys, identity providers, sessions, account deletion).
import { get, post, put, patch, del, setCsrf, passkeysSupported, createPasskey } from '../api.js';
import { h, form, field, select, confirmDialog, toast, errorBox, showError } from '../ui.js';
import { go, render, refreshSession, state } from '../main.js';
import { dateTime } from '../format.js';
import { currencyOptions } from './vehicles.js';

const SECTIONS = [['preferences', 'Preferences'], ['profile', 'Profile'], ['security', 'Security']];

/**
 * Run `fn`; when the server answers reauth_required, ask for the password or
 * an authenticator code, confirm it, and run `fn` once more.
 */
export async function withFreshSignIn(fn) {
  try { return await fn(); } catch (err) {
    if (err.code !== 'reauth_required') throw err;
    if (!(await reauthDialog())) throw new Error('Confirmation cancelled.');
    return fn();
  }
}

function reauthDialog() {
  const creds = state.account?.credentials ?? {};
  return new Promise((resolve) => {
    if (!creds.password && !creds.totp) {
      toast('Please sign out and sign in again to confirm this change.');
      resolve(false); return;
    }
    const box = errorBox();
    let done = false;
    const finish = (v) => { if (!done) { done = true; d.close(); resolve(v); } };
    const f = h('form', {},
      h('h2', {}, 'Confirm it is you'),
      h('p', { class: 'muted' }, 'This change needs a recent sign-in.'),
      box,
      creds.password ? field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password' })) : null,
      creds.totp ? field(creds.password ? 'Or an authenticator code' : 'Authenticator code', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 })) : null,
      h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Confirm'), h('button', { type: 'button', class: 'secondary', onclick: () => finish(false) }, 'Cancel')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      try {
        await post('/v1/auth/reauth', v.password ? { password: v.password } : { code: (v.code ?? '').trim() });
        finish(true);
      } catch (err) { showError(box, err); }
    });
    const d = h('dialog', {}, f);
    d.addEventListener('close', () => { d.remove(); finish(false); });
    document.body.append(d); d.showModal();
    f.querySelector('input')?.focus();
  });
}

// ---------- preferences ----------
function preferences() {
  const p = state.prefs;
  return form({ class: 'panel' }, [
    h('h2', {}, 'Display preferences'),
    h('p', { class: 'muted' }, 'These change how values are shown and compared. Nothing you have recorded is changed.'),
    h('div', { class: 'grid' },
      field('Distance', select('distanceUnit', [['km', 'Kilometres'], ['mi', 'Miles']], p.distanceUnit)),
      field('Fuel volume', select('volumeUnit', [['l', 'Litres'], ['gal_us', 'US gallons'], ['gal_imp', 'Imperial gallons']], p.volumeUnit)),
      field('Fuel economy', select('economyUnit', [['l_per_100km', 'L/100 km'], ['km_per_l', 'km/L'], ['mpg_us', 'mpg (US)'], ['mpg_imp', 'mpg (imperial)']], p.economyUnit)),
      field('Currency', select('currency', currencyOptions(p.currency), p.currency), 'Default for new vehicles, and the currency friend costs are compared in.')),
    h('button', { type: 'submit' }, 'Save preferences'),
  ], async (v) => {
    state.prefs = await put('/v1/preferences', v);
    return 'Preferences saved.';
  });
}

// ---------- profile ----------
function profile() {
  const a = state.account;
  return h('div', {},
    form({ class: 'panel' }, [
      h('h2', {}, 'Profile'),
      field('Email', h('input', { value: a.email, disabled: true }), a.emailVerified ? 'Verified.' : 'Not verified yet.'),
      field('Display name', h('input', { name: 'display_name', maxlength: 80, value: a.displayName ?? '' }), 'Shown to people you share vehicles with and to your friends.'),
      h('button', { type: 'submit' }, 'Save profile'),
    ], async (v) => {
      await patch('/v1/auth/account', { display_name: v.display_name });
      await refreshSession();
      return 'Profile saved.';
    }),
    h('section', { class: 'panel danger-zone' },
      h('h2', {}, 'Delete your account'),
      h('p', { class: 'muted' }, 'Transfer or archive the vehicles you own first. Records you entered on vehicles shared with you stay with those vehicles. This cannot be undone.'),
      (() => {
        const box = errorBox();
        return h('div', {}, box, h('button', { class: 'danger', onclick: async () => {
          if (!(await confirmDialog('Delete your account permanently? You will be signed out.', 'Delete account'))) return;
          try {
            await withFreshSignIn(() => del('/v1/auth/account'));
            state.account = null; setCsrf(null); go('#/signin');
            toast('Your account was deleted.');
          } catch (err) {
            showError(box, err.code === 'owns_vehicles' ? new Error('You still own vehicles. Transfer ownership from each vehicle\'s Members tab, then try again.') : err);
          }
        } }, 'Delete account'));
      })()));
}

// ---------- security ----------
const act = (label, fn, cls = 'secondary') => h('button', { class: cls, onclick: async (e) => {
  const btn = e.currentTarget; btn.disabled = true;
  try { const msg = await fn(); if (msg === false) { btn.disabled = false; return; } await refreshSession(); render(); if (typeof msg === 'string') toast(msg); }
  catch (err) { toast(err.message); btn.disabled = false; }
} }, label);

function passwordPanel(c) {
  return form({ class: 'panel' }, [
    h('h2', {}, 'Password'),
    c.password ? field('Current password', h('input', { name: 'current_password', type: 'password', autocomplete: 'current-password', required: true })) : h('p', { class: 'muted' }, 'You sign in without a password. You can add one.'),
    field('New password', h('input', { name: 'new_password', type: 'password', autocomplete: 'new-password', minlength: 12, required: true }), 'At least 12 characters. Changing it signs out your other sessions.'),
    h('div', { class: 'row' },
      h('button', { type: 'submit' }, c.password ? 'Change password' : 'Add password'),
      c.password ? act('Remove password', async () => {
        if (!(await confirmDialog('Remove your password? You will need a passkey or identity provider to sign in.', 'Remove'))) return false;
        await withFreshSignIn(() => del('/v1/auth/password'));
        return 'Password removed.';
      }) : null),
  ], async (v, el) => {
    await withFreshSignIn(() => put('/v1/auth/password', { current_password: v.current_password, new_password: v.new_password }));
    el.reset(); await refreshSession(); render();
    return 'Password saved.';
  });
}

function totpPanel(c) {
  const panel = h('section', { class: 'panel' }, h('h2', {}, 'Authenticator app'));
  if (c.totp) {
    panel.append(
      h('p', {}, 'Two-step sign-in is on. ', h('span', { class: 'muted' }, `${c.recoveryCodesRemaining} recovery codes left.`)),
      act('Turn off', async () => {
        if (!(await confirmDialog('Turn off two-step sign-in?', 'Turn off'))) return false;
        await withFreshSignIn(() => del('/v1/auth/totp'));
        return 'Two-step sign-in is off.';
      }));
    return panel;
  }
  const slot = h('div');
  panel.append(h('p', { class: 'muted' }, 'Ask for a code from an authenticator app after your password.'), slot,
    h('button', { onclick: async (e) => {
      e.currentTarget.hidden = true;
      try {
        const t = await withFreshSignIn(() => post('/v1/auth/totp'));
        slot.replaceChildren(
          h('p', {}, 'Add this key to your authenticator app, then enter the code it shows.'),
          h('p', {}, h('code', { class: 'secret' }, t.secret)),
          h('p', { class: 'small' }, h('a', { href: t.otpauth_uri }, 'Open in an authenticator app on this device')),
          form({}, [
            field('Code', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, required: true })),
            h('button', { type: 'submit' }, 'Turn on'),
          ], async (v) => {
            const out = await withFreshSignIn(() => post('/v1/auth/totp/confirm', { code: v.code.trim() }));
            await refreshSession();
            slot.replaceChildren(
              h('div', { class: 'notice' }, h('strong', {}, 'Save these recovery codes now.'), ' Each works once if you lose your authenticator. They will not be shown again.'),
              h('ul', { class: 'codes' }, out.recovery_codes.map((code) => h('li', {}, h('code', {}, code)))),
              h('button', { onclick: () => render() }, 'I saved them'));
            return 'Two-step sign-in is on.';
          }));
        slot.querySelector('input[name=code]')?.focus();
      } catch (err) { e.currentTarget.hidden = false; toast(err.message); }
    } }, 'Set up'));
  return panel;
}

function passkeyPanel(c) {
  return h('section', { class: 'panel' },
    h('h2', {}, 'Passkeys'),
    c.passkeys.length ? h('ul', { class: 'list' }, c.passkeys.map((k) => h('li', { class: 'row spread' },
      h('div', {}, h('strong', {}, k.label || 'Passkey'), h('div', { class: 'small muted' }, `Added ${dateTime(k.created_at)}`, k.last_used_at ? ` · last used ${dateTime(k.last_used_at)}` : '')),
      act('Remove', async () => {
        if (!(await confirmDialog(`Remove the passkey "${k.label || 'Passkey'}"?`, 'Remove'))) return false;
        await withFreshSignIn(() => del(`/v1/auth/passkeys/${k.id}`));
        return 'Passkey removed.';
      })))) : h('p', { class: 'muted' }, 'No passkeys yet.'),
    passkeysSupported()
      ? form({}, [
        h('div', { class: 'row' }, field('Name', h('input', { name: 'label', maxlength: 80, placeholder: 'Phone' })), h('button', { type: 'submit' }, 'Add a passkey')),
      ], async (v) => {
        const options = await withFreshSignIn(() => post('/v1/auth/passkeys/register/options'));
        await post('/v1/auth/passkeys/register/verify', { response: await createPasskey(options), label: v.label || 'Passkey' });
        await refreshSession(); render();
        return 'Passkey added.';
      })
      : h('p', { class: 'small muted' }, 'This browser does not support passkeys.'));
}

function oidcPanel(c) {
  if (!state.instance.oidc && !c.oidc.length) return null;
  return h('section', { class: 'panel' },
    h('h2', {}, 'Identity provider'),
    c.oidc.length ? h('ul', { class: 'list' }, c.oidc.map((i) => h('li', { class: 'row spread' },
      h('div', {}, h('strong', {}, i.email ?? 'Linked identity'), h('div', { class: 'small muted' }, i.issuer)),
      act('Unlink', async () => {
        if (!(await confirmDialog('Unlink this identity? You will no longer be able to sign in with it.', 'Unlink'))) return false;
        await withFreshSignIn(() => del(`/v1/auth/oidc/identities/${i.id}`));
        return 'Identity unlinked.';
      })))) : h('p', { class: 'muted' }, 'Not linked.'),
    state.instance.oidc ? act('Link an identity', async () => {
      const { authorization_url } = await withFreshSignIn(() => post('/v1/auth/oidc/start', { mode: 'link' }));
      location.assign(authorization_url);
      return false;
    }) : null);
}

async function sessionsPanel() {
  const { sessions } = await get('/v1/auth/sessions');
  return h('section', { class: 'panel' },
    h('div', { class: 'row spread' }, h('h2', {}, 'Signed-in devices'),
      sessions.length > 1 ? act('Sign out everywhere else', async () => {
        const r = await post('/v1/auth/sessions/revoke-others');
        return `Signed out ${r.revoked} other ${r.revoked === 1 ? 'session' : 'sessions'}.`;
      }) : null),
    h('ul', { class: 'list' }, sessions.map((s) => h('li', { class: 'row spread' },
      h('div', {}, h('strong', {}, s.user_agent ? shortAgent(s.user_agent) : 'Unknown device'), s.current ? h('span', { class: 'badge accent' }, ' This device') : null,
        h('div', { class: 'small muted' }, `Signed in ${dateTime(s.created_at)} · last active ${dateTime(s.last_seen_at)}`)),
      s.current ? null : act('Sign out', async () => { await del(`/v1/auth/sessions/${s.id}`); return 'Session signed out.'; })))));
}

function shortAgent(ua) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

async function security(query) {
  await refreshSession();
  const c = state.account.credentials;
  return h('div', {},
    query.get('linked') === '1' ? h('p', { class: 'notice' }, 'Your identity provider is linked.') : null,
    passwordPanel(c), totpPanel(c), passkeyPanel(c), oidcPanel(c), await sessionsPanel());
}

export async function settingsView(section, query) {
  // The identity-provider link flow returns to #/account?linked=1.
  if (query.get('linked') === '1') section = 'security';
  if (!SECTIONS.some(([k]) => k === section)) section = 'preferences';
  const body = section === 'security' ? await security(query) : section === 'profile' ? profile() : preferences();
  return h('div', {},
    h('h1', {}, 'Settings'),
    h('nav', { class: 'tabs', 'aria-label': 'Settings sections' }, SECTIONS.map(([k, label]) => h('a', { href: `#/settings/${k}`, 'aria-current': k === section ? 'page' : undefined }, label))),
    body);
}
