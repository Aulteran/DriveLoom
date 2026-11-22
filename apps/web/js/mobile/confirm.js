// A confirmation as a small bottom sheet that names what will happen, with
// explicit buttons: the destructive one is never the only way out, and Cancel,
// the close button, a backdrop tap or Escape all answer no.
import { h } from '../ui.js';
import { openSheet } from './sheet.js';

/**
 * Resolves true once `action()` (optional, awaited while the button shows
 * progress) succeeds; false when cancelled. An error from `action` stays in the
 * sheet so the person can retry or cancel.
 */
export function confirmSheet({ title, message, confirmLabel, danger = true, action }) {
  return new Promise((resolve) => {
    let ok = false;
    const err = h('p', { class: 'm-confirm-err', role: 'alert', hidden: true });
    const yes = h('button', { type: 'button', class: danger ? 'danger' : '', onclick: async () => {
      err.hidden = true;
      yes.disabled = true;
      const label = yes.textContent;
      yes.textContent = 'Working…';
      try { await action?.(); ok = true; sheet.close(); } catch (e) { err.textContent = e?.message ?? String(e); err.hidden = false; } finally { yes.disabled = false; yes.textContent = label; }
    } }, confirmLabel);
    const no = h('button', { type: 'button', class: 'secondary', onclick: () => sheet.close() }, 'Cancel');
    const sheet = openSheet({
      title, className: 'm-confirm',
      content: [h('p', { class: 'm-confirm-text' }, message), err, h('div', { class: 'm-actions' }, no, yes)],
      onClose: () => resolve(ok),
    });
    no.focus();
  });
}
