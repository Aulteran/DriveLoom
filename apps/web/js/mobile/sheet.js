// Bottom sheet for the phone shell, built on a native modal <dialog>: focus
// moves in, the page behind is inert and Escape closes it, all from the
// browser. Focus returns to the control that opened it.
import { h } from '../ui.js';
import { icon } from '../icons.js';

const open = new Set();

/**
 * Open a sheet. `content` is a node or an array of nodes; `onClose` runs once
 * after it has closed, however it was closed. Returns { dialog, close }.
 */
export function openSheet({ title, content, size = 'medium', label, onClose }) {
  const back = document.activeElement;
  const id = `sheet-${Math.random().toString(36).slice(2, 9)}`;
  const d = h('dialog', { class: `m-sheet m-sheet-${size}`, 'aria-labelledby': `${id}-t` },
    h('div', { class: 'm-sheet-inner' },
      h('div', { class: 'm-grab', 'aria-hidden': 'true' }),
      h('div', { class: 'm-sheet-head' },
        h('h2', { id: `${id}-t` }, title),
        h('button', { type: 'button', class: 'm-icon-btn', 'aria-label': label ?? 'Close', onclick: () => d.close() }, icon('close'))),
      h('div', { class: 'm-sheet-body' }, content)));
  // A tap on the backdrop lands on the dialog itself; the inner box covers the rest.
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.addEventListener('close', () => {
    open.delete(d);
    d.remove();
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    onClose?.();
  }, { once: true });
  document.body.append(d);
  open.add(d);
  d.showModal();
  return { dialog: d, close: () => d.close() };
}

/** Close every open sheet (used when the route changes underneath them). */
export function closeSheets() { for (const d of [...open]) d.close(); }
export const sheetOpen = () => open.size > 0;
