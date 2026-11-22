// Sign-in, registration, recovery and second factor on the phone: full screen,
// no tab bar. The forms and their submit logic are views/auth.js's own, so
// behaviour is identical to the desktop; this only lays them out for a phone
// (passkey and single sign-on first on the sign-in screen, the server's
// address shown) and remembers where the person was going.
//
// Return path: when sign-in interrupts a protected route (#/friends, say), the
// route is kept in localStorage for 15 minutes; landing signed in on #/ (which
// is where password, passkey and the identity provider's redirect all arrive)
// goes back to it. localStorage, not sessionStorage, because an identity
// provider may return in a new tab.
import { h } from '../ui.js';
import { PUBLIC } from '../core.js';
import { authView } from '../views/auth.js';

const KEY = 'driveloom.return-to';
const TTL = 15 * 60 * 1000;

/** Remember the protected route the sign-in screen is standing in for. */
export function rememberReturn(hash) {
  const first = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (!first || PUBLIC.has(first) || first === 'fill') return;
  try { localStorage.setItem(KEY, JSON.stringify({ hash, at: Date.now() })); } catch { /* not remembered */ }
}

/** The remembered route, once: null when there is none or it is stale. */
export function takeReturn() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const { hash, at } = JSON.parse(raw);
    return typeof hash === 'string' && hash.startsWith('#/') && Date.now() - at < TTL ? hash : null;
  } catch { return null; }
}

export function forgetReturn() { try { localStorage.removeItem(KEY); } catch { /* nothing kept */ } }

/** The desktop auth view, arranged for a phone. */
export async function phoneAuthView(kind, query) {
  const view = await authView(kind, query);
  view.classList.add('m-authv');
  const panel = view.querySelector(':scope > .panel');
  if (!panel) return view;
  // Which server this is, so people know where they are signing in.
  panel.querySelector(':scope > h1')?.after(h('p', { class: 'm-server' }, h('span', { class: 'm-server-dot', 'aria-hidden': 'true' }), h('span', { class: 'm-vh' }, 'Server: '), location.host));
  if (kind === 'signin') {
    const alt = panel.querySelector(':scope > .stack');
    const pw = panel.querySelector(':scope > form');
    if (alt && pw) {
      pw.before(alt);
      alt.classList.add('m-auth-alt');
      pw.before(h('p', { class: 'm-or' }, h('span', {}, 'or use your password')));
      // The password button becomes the secondary action once the passkey leads.
      pw.querySelector('button[type=submit]')?.classList.add('secondary');
    }
  }
  for (const p of panel.querySelectorAll(':scope > p.small')) {
    p.classList.add('m-auth-links');
    // The desktop's " · " separators become gaps between full-size link targets.
    for (const n of [...p.childNodes]) if (n.nodeType === Node.TEXT_NODE && n.textContent.trim() === '·') n.remove();
  }
  return view;
}

