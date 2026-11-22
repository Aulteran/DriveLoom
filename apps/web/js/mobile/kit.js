// Small building blocks shared by the phone's More, Friends, Settings, Account
// and Administration screens: grouped list rows, explicit action buttons that
// refuse to write offline, confirm and re-authentication sheets, and a
// copyable read-only value. Business rules stay in the shared views and the API.
import { post } from '../api.js';
import { h, form, field, errorBox, showError, toast } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../core.js';
import { withFreshSignIn as fresh } from '../views/settings.js';
import { openSheet } from './sheet.js';

export const OFFLINE_SAVE = 'You’re offline. Saving needs a connection; try again when you’re back online.';

/** A screen: back link, one h1, optional lede and the rest. */
export function page({ back = ['#/more', 'More'], title, lede, action }, ...body) {
  return h('div', { class: 'm-screen m-page' },
    back ? h('div', { class: 'm-page-top' }, h('a', { class: 'm-back', href: back[0] }, icon('back'), back[1]), action ?? null) : null,
    h('h1', {}, title),
    lede ? h('p', { class: 'm-lede' }, lede) : null,
    ...body);
}

/** A titled group of rows. `items` are <li> nodes (see row(), staticRow()). */
export function section(title, items, { note, id } = {}) {
  const hid = id ?? `m-s-${Math.random().toString(36).slice(2, 8)}`;
  return h('section', { class: 'm-sec', 'aria-labelledby': hid },
    h('h2', { class: 'm-label', id: hid }, title),
    items === null ? null : h('ul', { class: 'm-group m-list' }, items),
    note ? h('p', { class: 'm-note' }, note) : null);
}

/** A row that is a link or a button; `trail` sits before the chevron. */
export function row({ href, onclick, icon: ic, avatar: av, label, sub, trail, chevron = true, tone, current }) {
  const inner = [
    av ?? (ic ? icon(ic) : null),
    h('span', { class: 'm-row-label' }, label, sub ? h('span', { class: 'm-row-sub' }, sub) : null),
    trail ?? null,
    chevron ? icon('next', 'icon m-row-next') : null,
  ];
  const cls = `m-row${tone ? ` m-row-${tone}` : ''}`;
  return h('li', {}, href
    ? h('a', { class: cls, href, 'aria-current': current ? 'page' : undefined }, inner)
    : h('button', { type: 'button', class: `${cls} m-row-btn`, onclick }, inner));
}

/** A row that only shows facts, with optional controls at the end. */
export function staticRow({ label, sub, trail, avatar }) {
  return h('li', {}, h('div', { class: 'm-row m-row-static' },
    avatar ?? null,
    h('span', { class: 'm-row-label' }, label, sub ? h('span', { class: 'm-row-sub' }, sub) : null),
    trail ?? null));
}

export const initials = (text) => (text ?? '').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
export const avatar = (text, tone) => h('span', { class: 'm-avatar', 'aria-hidden': 'true', dataset: tone ? { tone: String(tone) } : undefined }, initials(text));
export const pill = (text, tone = '') => h('span', { class: `m-pill${tone ? ` m-pill-${tone}` : ''}` }, text);

/**
 * An explicit action button: disabled while running, refuses to run offline,
 * toasts a returned string and reports errors in a toast. `fn` may return
 * false to say "nothing happened" (a cancelled confirm).
 */
export function action(label, fn, { cls = 'secondary', icon: ic, done, error = (e) => e.message } = {}) {
  const b = h('button', { type: 'button', class: cls, onclick: async () => {
    if (navigator.onLine === false) { toast(OFFLINE_SAVE); return; }
    b.disabled = true;
    try {
      const msg = await fn();
      if (msg !== false) { if (typeof msg === 'string') toast(msg); await done?.(); }
    } catch (err) { if (err.message !== 'Confirmation cancelled.') toast(error(err)); }
    finally { if (b.isConnected) b.disabled = false; }
  } }, ic ? icon(ic) : null, label);
  return b;
}

/** A sheet that asks before something destructive, naming the item. Resolves true to go ahead. */
export function confirmSheet({ title, text, confirm = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    let ok = false;
    const s = openSheet({
      title, size: 'medium', className: 'm-confirm',
      content: [
        text ? h('p', { class: 'm-sheet-text' }, text) : null,
        h('div', { class: 'm-sheet-actions m-stack' },
          h('button', { type: 'button', class: danger ? 'm-danger-solid m-wide' : 'm-wide', onclick: () => { ok = true; s.close(); } }, confirm),
          h('button', { type: 'button', class: 'secondary m-wide', onclick: () => s.close() }, 'Cancel')),
      ],
      onClose: () => resolve(ok),
    });
  });
}

/** Re-authentication as a sheet: password or authenticator code, then POST /v1/auth/reauth. */
export function reauthSheet() {
  const creds = state.account?.credentials ?? {};
  return new Promise((resolve) => {
    if (!creds.password && !creds.totp) {
      toast('Please sign out and sign in again to confirm this change.');
      resolve(false); return;
    }
    let ok = false;
    const box = errorBox();
    const f = h('form', { class: 'm-form' },
      box,
      creds.password ? field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', enterkeyhint: 'done' })) : null,
      creds.totp ? field(creds.password ? 'Or an authenticator code' : 'Authenticator code', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, enterkeyhint: 'done' })) : null,
      h('button', { type: 'submit', class: 'm-wide' }, 'Confirm'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      try {
        await post('/v1/auth/reauth', v.password ? { password: v.password } : { code: (v.code ?? '').trim() });
        ok = true; s.close();
      } catch (err) { showError(box, err); }
    });
    const s = openSheet({ title: 'Confirm it’s you', sub: 'This change needs a recent sign-in.', content: f, onClose: () => resolve(ok) });
    f.querySelector('input')?.focus();
  });
}

/** The desktop's fresh-sign-in rule, asking with the phone's sheet. */
export const withFreshSignIn = (fn) => fresh(fn, reauthSheet);

/**
 * A form inside a sheet (or a page) using the shared form() wiring: errors show
 * in the form, buttons disable while it runs. `fn(values, el)` returning a
 * string toasts it.
 */
export const sheetForm = (children, fn, attrs = {}) => form({ class: 'm-form', ...attrs }, children, fn);

/**
 * A read-only value with a Copy button. Without the Clipboard API (plain HTTP)
 * focusing the field selects it, so the system's own copy menu works.
 */
export function copyField(label, value, { hint } = {}) {
  // A read-only textarea so a long value (an invitation link) wraps instead of hiding its end.
  const input = h('textarea', { readonly: true, class: 'm-copy-input', rows: Math.min(4, Math.ceil(value.length / 30)), spellcheck: 'false', autocapitalize: 'none', autocorrect: 'off' });
  input.value = value;
  input.addEventListener('focus', () => input.select());
  const canCopy = !!navigator.clipboard?.writeText;
  const btn = h('button', { type: 'button', class: 'secondary m-copy-btn', onclick: async () => {
    if (canCopy) {
      try { await navigator.clipboard.writeText(value); toast('Copied.'); return; } catch { /* fall through */ }
    }
    input.focus(); input.select();
    toast('Selected. Use your phone’s Copy option.');
  } }, icon('copy'), canCopy ? 'Copy' : 'Select');
  const id = `m-copy-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h('div', { class: 'field m-copy' },
    h('label', { for: id }, label),
    h('div', { class: 'm-copy-box' }, input, btn),
    hint ? h('div', { class: 'hint' }, hint) : null);
}
