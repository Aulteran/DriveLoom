// Loading, empty and error states for phone screens. Plain functions that
// return DOM nodes; style lives in mobile-system.css (classes m-skel, m-empty,
// m-err). Any phone screen can adopt them:
//
//   skeleton({ label, rows, kind })   Placeholder blocks shaped like the final
//       layout. kind 'list' (rows of avatar + two lines, the default) or
//       'cards' (stat tiles). It stays invisible for 300 ms so fast loads never
//       flash, pulses gently (not under reduced motion) and announces
//       "Loading <label>" to screen readers.
//   emptyState({ title, text, action, icon, level })   One clear next step:
//       a heading (h2, or h1 with level 1), a line of help and an optional
//       action node (a link or button).
//   errorState({ error, title, text, onRetry, level })   What went wrong in
//       plain words, a Try again button when onRetry is given, and a folded
//       "Details for your admin" with the status and code. title and text
//       default to friendlyError(error).
//   friendlyError(error) -> { title, text, offline }   Wording for an ApiError
//       or a failed fetch: offline, server unreachable (network error, 502-504),
//       server error (5xx), or the server's own message.
//   loadInto(slot, load, fill, { label, rows, kind })   Shows a skeleton in
//       `slot`, awaits load(), then replaces it with fill(data); on failure an
//       errorState whose Try again runs the whole thing again (and, offline,
//       runs it by itself when the connection returns). Returns a promise.
import { h } from '../ui.js';
import { icon } from '../icons.js';

const isNetwork = (err) => err instanceof TypeError || err?.name === 'TypeError';

export function friendlyError(err) {
  const host = location.host;
  if (navigator.onLine === false) return { offline: true, title: 'You’re offline', text: 'This screen needs a connection to load. It will try again when you’re back online.' };
  if (isNetwork(err) || [502, 503, 504].includes(err?.status)) {
    return { title: `Can’t reach ${host}`, text: 'The server didn’t answer. Check your connection, or that the DriveLoom server is running. Nothing you typed was sent.' };
  }
  if (err?.status >= 500) return { title: 'The server had a problem', text: 'Something went wrong on the server. Try again in a moment; if it keeps happening, tell whoever runs this instance.' };
  if (err?.status === 404) return { title: 'Not found', text: err.message || 'This page does not exist, or you no longer have access to it.' };
  return { title: 'Something went wrong', text: err?.message || 'The request did not complete.' };
}

export function skeleton({ label = 'content', rows = 4, kind = 'list' } = {}) {
  const blocks = kind === 'cards'
    ? [h('div', { class: 'm-skel-card m-skel-hero' }, h('span', { class: 'm-skel-line m-skel-w40' }), h('span', { class: 'm-skel-big' }), h('span', { class: 'm-skel-line m-skel-w70' })),
      h('div', { class: 'm-skel-tiles' }, Array.from({ length: Math.max(2, rows) }, () => h('div', { class: 'm-skel-card' }, h('span', { class: 'm-skel-line m-skel-w50' }), h('span', { class: 'm-skel-line m-skel-w70 m-skel-thick' }))))]
    : [h('div', { class: 'm-skel-card m-skel-list' }, Array.from({ length: rows }, (_, i) => h('div', { class: 'm-skel-row' },
      h('span', { class: 'm-skel-dot' }),
      h('span', { class: 'm-skel-lines' }, h('span', { class: `m-skel-line ${i % 2 ? 'm-skel-w50' : 'm-skel-w70'}` }), h('span', { class: 'm-skel-line m-skel-w40 m-skel-thin' })))))];
  return h('div', { class: 'm-skel', role: 'status', 'aria-busy': 'true' },
    h('span', { class: 'm-vh' }, `Loading ${label}…`),
    h('div', { class: 'm-skel-body', 'aria-hidden': 'true' }, blocks));
}

export function emptyState({ title, text, action, icon: ic = null, level = 2 } = {}) {
  return h('div', { class: 'm-empty' },
    ic ? h('span', { class: 'm-empty-icon' }, icon(ic)) : null,
    h(level === 1 ? 'h1' : 'h2', { class: 'm-empty-title' }, title),
    text ? h('p', { class: 'm-empty-text' }, text) : null,
    action ?? null);
}

export function errorState({ error, title, text, onRetry, level = 2 } = {}) {
  const f = friendlyError(error);
  const details = [
    error?.status ? `HTTP ${error.status}${error.code && error.code !== 'error' ? ` · ${error.code}` : ''}` : isNetwork(error) ? 'No response (network error)' : null,
    new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    matchMedia('(display-mode: standalone)').matches ? 'Installed app' : 'Browser',
  ].filter(Boolean);
  let retry = null;
  if (onRetry) {
    retry = h('button', { type: 'button', class: 'm-wide', onclick: async () => {
      retry.disabled = true;
      try { await onRetry(); } finally { if (retry.isConnected) retry.disabled = false; }
    } }, icon('refresh'), 'Try again');
  }
  return h('div', { class: 'm-err', role: 'alert' },
    h('span', { class: 'm-empty-icon m-err-icon' }, icon(f.offline ? 'wifi' : 'alert')),
    h(level === 1 ? 'h1' : 'h2', { class: 'm-empty-title' }, title ?? f.title),
    h('p', { class: 'm-empty-text' }, text ?? f.text),
    retry,
    error ? h('details', { class: 'm-err-details' }, h('summary', {}, 'Details for your admin'), h('p', {}, details.join(' · '))) : null);
}

export async function loadInto(slot, load, fill, { label, rows, kind } = {}) {
  slot.replaceChildren(skeleton({ label, rows, kind }));
  try {
    const data = await load();
    slot.replaceChildren(fill(data));
  } catch (err) {
    slot.replaceChildren(errorState({ error: err, onRetry: () => loadInto(slot, load, fill, { label, rows, kind }) }));
    if (navigator.onLine === false) addEventListener('online', () => { if (slot.isConnected) loadInto(slot, load, fill, { label, rows, kind }); }, { once: true });
  }
}
