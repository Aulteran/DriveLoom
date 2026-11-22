// "Would a reload throw something away?" Shared by boot.js (a shell switch) and the
// phone's update banner. Plain DOM only: no shell code is imported, so the desktop
// entry point can use it.

const touched = new WeakSet(); // forms typed into since they were drawn (phone update hold)

/** Phone shell: note typing in a form; a reset or a redraw clears it. */
export function trackTouched() {
  const mark = (e) => { const f = e.target?.form ?? e.target?.closest?.('form'); if (f) touched.add(f); };
  document.addEventListener('input', mark, true);
  document.addEventListener('change', mark, true);
  document.addEventListener('reset', (e) => touched.delete(e.target), true);
}

/** A form the person typed into that is still on screen. */
export function touchedFormOpen() {
  for (const f of document.forms) if (touched.has(f) && f.isConnected) return true;
  return false;
}


/** A form control whose value differs from what the page drew it with. */
export function hasEditedControl() {
  for (const el of document.querySelectorAll('input, textarea, select')) {
    // Hidden fields are the page's own (tokens, ids), not typing.
    if (el.disabled || el.type === 'hidden') continue;
    if (el instanceof HTMLSelectElement) {
      // A single select with no default option shows its first one: that is not an edit.
      const first = !el.multiple && el.size <= 1 && ![...el.options].some((o) => o.defaultSelected) ? el.options[0] : null;
      if ([...el.options].some((o) => o.selected !== (o.defaultSelected || o === first))) return true;
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) return true;
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked !== el.defaultChecked) return true;
    } else if (el.type === 'file') {
      if (el.files?.length) return true;
    } else if (el.type !== 'button' && el.type !== 'submit' && el.type !== 'reset' && el.type !== 'image') {
      if (el.value !== el.defaultValue) return true;
    }
  }
  return false;
}

/** What the phone's update banner waits for: an open sheet or dialog, or a form typed into. */
export function updateHeld() {
  return !!document.querySelector('dialog[open]') || touchedFormOpen();
}

/** Anything a reload would lose: the update hold above, or any control edited away from its default. */
export function hasUnsavedInput() {
  return updateHeld() || hasEditedControl();
}
