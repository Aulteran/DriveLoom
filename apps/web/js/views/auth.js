// Setup, sign-in (password, passkey, OIDC), second factor, registration and recovery.
import { get, post, setCsrf, passkeysSupported, getPasskey } from '../api.js';
import { h, form, field } from '../ui.js';
import { go, refreshSession, state } from '../main.js';

const ERRORS = {
  oidc_link_required: 'An account with this email already exists. Sign in with your password, then link your identity provider under Settings → Security.',
  registration_closed: 'Registration is closed on this instance. Ask an administrator for an invitation.',
};

// Which second step the pending sign-in needs; kept in memory only.
let mfaMethod = 'totp';

async function signedIn(result) {
  setCsrf(result.csrf_token);
  if (result.state === 'mfa_required') { mfaMethod = result.mfa_method ?? 'totp'; go('#/mfa'); return; }
  await refreshSession();
  go('#/');
}

function shell(title, subtitle, ...body) {
  return h('div', { class: 'narrow' },
    h('div', { class: 'auth-brand' }, h('img', { src: '/icon.svg', alt: '', width: 52, height: 52 }), h('div', {}, h('strong', {}, 'DriveLoom'), h('span', {}, 'Self-hosted fuel tracker'))),
    h('div', { class: 'panel' }, h('h1', {}, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null, ...body));
}

export async function authView(kind, query) {
  const info = state.instance ?? {};
  if (kind === 'register') return registerView(info, query);
  if (kind === 'recover') return recoverView(info);
  if (kind === 'mfa') return mfaView();
  return signInView(info, query);
}

function signInView(info, query) {
  const err = query.get('error');
  const alt = [];
  if (passkeysSupported()) {
    alt.push(form({}, h('button', { class: 'secondary', type: 'submit', style: 'width:100%;justify-content:center' }, 'Sign in with a passkey'), async () => {
      const options = await post('/v1/auth/passkeys/login/options');
      await signedIn(await post('/v1/auth/passkeys/login/verify', { response: await getPasskey(options) }));
    }));
  }
  if (info.oidc) {
    alt.push(form({}, h('button', { class: 'secondary', type: 'submit', style: 'width:100%;justify-content:center' }, 'Sign in with your identity provider'), async () => {
      location.assign((await post('/v1/auth/oidc/start', { mode: 'login' })).authorization_url);
    }));
  }
  return shell('Sign in', null,
    err ? h('div', { class: 'error', role: 'alert' }, ERRORS[err] ?? `Sign-in did not complete (${err}).`) : null,
    info.password_login !== false ? form({}, [
      field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      h('button', { type: 'submit', style: 'width:100%;justify-content:center' }, 'Sign in'),
    ], async (v) => signedIn(await post('/v1/auth/login', { email: v.email, password: v.password }))) : null,
    alt.length ? h('div', { class: 'stack', style: 'margin-top:16px' }, alt) : null,
    h('p', { class: 'small', style: 'margin-top:16px' },
      info.email_recovery ? h('a', { href: '#/recover' }, 'Forgot your password?') : h('span', { class: 'muted' }, 'Lost access? Ask your administrator to reset your password.'),
      ' · ', h('a', { href: '#/register' }, info.registration === 'open' ? 'Create an account' : 'Have an invitation?')));
}

function registerView(info, query) {
  const setup = info.needs_setup;
  const invite = query.get('invite') ?? '';
  return shell(setup ? 'Set up this instance' : 'Create your account',
    setup ? 'No account exists yet. The account you create now is the administrator.' : info.registration === 'open' ? null : 'Registration is by invitation on this instance.',
    form({}, [
      field('Name', h('input', { name: 'display_name', autocomplete: 'name', maxlength: 80 })),
      field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: 12 }), 'At least 12 characters. A passphrase works well.'),
      info.setup_token_required ? field('Setup token', h('input', { name: 'setup_token', required: true, autocomplete: 'off' }), 'Set by the operator in DRIVELOOM_SETUP_TOKEN.') : null,
      !setup && info.registration !== 'open' ? field('Invitation code', h('input', { name: 'invite_token', required: true, value: invite, autocomplete: 'off' })) : null,
      h('button', { type: 'submit', style: 'width:100%;justify-content:center' }, setup ? 'Create administrator account' : 'Create account'),
    ], async (v, el) => {
      const body = { email: v.email, password: v.password, display_name: v.display_name || undefined, setup_token: v.setup_token || undefined, invite_token: v.invite_token || undefined };
      const r = await post('/v1/auth/register', body);
      state.instance = await get('/v1/auth/instance');
      if (r.status === 'verification_sent') {
        el.replaceWith(verifyForm(v.email));
        return;
      }
      await signedIn(await post('/v1/auth/login', { email: v.email, password: v.password }));
    }),
    h('p', { class: 'small', style: 'margin-top:16px' }, h('a', { href: '#/signin' }, 'Already have an account? Sign in')));
}

function verifyForm(email) {
  return form({}, [
    h('div', { class: 'notice' }, `If ${email} can receive mail, a code is on its way. Enter it to finish.`),
    field('Code', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true })),
    h('button', { type: 'submit' }, 'Verify email'),
  ], async (v) => { await post('/v1/auth/verify-email', { email, code: v.code }); go('#/signin'); return 'Email verified. You can sign in now.'; });
}

function mfaView() {
  const again = h('p', { class: 'small' }, h('a', { href: '#/signin' }, 'Start sign-in again'));
  if (mfaMethod === 'email') {
    return shell('Check your email', 'We sent an 8-digit sign-in code to your email address. It expires in 15 minutes.',
      form({}, [
        field('Sign-in code', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, autofocus: true, maxlength: 8 })),
        h('button', { type: 'submit' }, 'Continue'),
      ], async (v) => signedIn(await post('/v1/auth/mfa/email', { code: v.code.trim() }))),
      again);
  }
  let recovery = false;
  const input = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, autofocus: true });
  const label = h('label', { for: 'mfa-code' }, 'Authenticator code');
  input.id = 'mfa-code';
  const toggle = h('button', { type: 'button', class: 'ghost', onclick: () => {
    recovery = !recovery;
    label.textContent = recovery ? 'Recovery code' : 'Authenticator code';
    input.inputMode = recovery ? 'text' : 'numeric';
    toggle.textContent = recovery ? 'Use the authenticator app instead' : 'Use a recovery code instead';
  } }, 'Use a recovery code instead');
  return shell('Two-step verification', 'Enter the code from your authenticator app.',
    form({}, [h('div', { class: 'field' }, label, input), h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Continue'), toggle)],
      async (v) => signedIn(await post('/v1/auth/mfa/totp', recovery ? { recovery_code: v.code } : { code: v.code }))),
    again);
}

function recoverView(info) {
  if (!info.email_recovery) return shell('Recover your account', 'This instance has no email delivery. An administrator can reset your password from the server command line.', h('a', { href: '#/signin' }, 'Back to sign in'));
  const second = form({ hidden: true }, [
    field('Recovery code', h('input', { name: 'code', inputmode: 'numeric', required: true, autocomplete: 'one-time-code' })),
    field('New password', h('input', { name: 'new_password', type: 'password', minlength: 12, required: true, autocomplete: 'new-password' })),
    h('button', { type: 'submit' }, 'Set new password'),
  ], async (v) => { await post('/v1/auth/recovery/complete', { email: emailInput.value, code: v.code, new_password: v.new_password }); go('#/signin'); return 'Password changed. Every session was signed out.'; });
  const emailInput = h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' });
  const first = form({}, [field('Email', emailInput), h('button', { type: 'submit' }, 'Email me a code')], async () => {
    await post('/v1/auth/recovery/request', { email: emailInput.value });
    second.hidden = false; emailInput.readOnly = true;
    return 'If that address has an account, a code is on its way.';
  });
  return shell('Recover your account', 'We will email a one-time code.', first, second, h('p', { class: 'small' }, h('a', { href: '#/signin' }, 'Back to sign in')));
}
