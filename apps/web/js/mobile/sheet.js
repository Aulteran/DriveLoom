// Bottom sheet for the phone shell, built on a native modal <dialog>: focus
// moves in, the page behind is inert and Escape closes it, all from the
// browser. Focus returns to the control that opened it.
import { h } from '../ui.js';
import { icon } from '../icons.js';

const open = new Set();

/**
 * Open a sheet. `content` is a node or an array of nodes; `onClose` runs once
 * after it has closed, however it was closed. Optional:
 *   - `sub`: a line under the title.
 *   - `footer`: a node pinned below the scrolling body (a save bar).
 *   - `guard()`: asked before the close button, a backdrop tap or Escape
 *     closes the sheet; resolve false to keep it open. close() skips it.
 *   - `className`: extra classes on the dialog.
 * Returns { dialog, close, requestClose }; requestClose() asks the guard first.
 */
export function openSheet({ title, content, size = 'medium', label, onClose, sub, footer, guard, className }) {
  const back = document.activeElement;
  const id = `sheet-${Math.random().toString(36).slice(2, 9)}`;
  let asking = false;
  const requestClose = async () => {
    if (asking) return;
    if (guard) {
      asking = true;
      try { if (!(await guard())) return; } finally { asking = false; }
    }
    d.close();
  };
  const d = h('dialog', { class: `m-sheet m-sheet-${size}${className ? ` ${className}` : ''}`, 'aria-labelledby': `${id}-t` },
    h('div', { class: 'm-sheet-inner' },
      h('div', { class: 'm-grab', 'aria-hidden': 'true' }),
      h('div', { class: 'm-sheet-head' },
        h('div', { class: 'm-sheet-titles' },
          h('h2', { id: `${id}-t` }, title),
          sub ? h('p', { class: 'm-sheet-subtitle' }, sub) : null),
        h('button', { type: 'button', class: 'm-icon-btn', 'aria-label': label ?? 'Close', onclick: requestClose }, icon('close'))),
      h('div', { class: 'm-sheet-body' }, content)),
    footer ?? null);
  // A tap on the backdrop lands on the dialog itself; the inner box covers the rest.
  d.addEventListener('click', (e) => { if (e.target === d) requestClose(); });
  // A cancel the browser will not let the page refuse (repeated Escape, a back
  // gesture) closes the sheet as asked; the guard is only consulted when it can.
  if (guard) d.addEventListener('cancel', (e) => { if (!e.cancelable) return; e.preventDefault(); requestClose(); });
  d.addEventListener('close', () => {
    open.delete(d);
    d.remove();
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    onClose?.();
  }, { once: true });
  document.body.append(d);
  open.add(d);
  d.showModal();
  return { dialog: d, close: () => d.close(), requestClose };
}

/** Close every open sheet (used when the route changes underneath them). */
export function closeSheets() { for (const d of [...open]) d.close(); }
export const sheetOpen = () => open.size > 0;
