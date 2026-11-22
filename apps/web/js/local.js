// Per-person things the browser keeps that must not outlive a session: typed
// fill-up drafts (sessionStorage) and the route sign-in interrupted (localStorage).
// Shared by api.js (every sign-out, both shells) and the phone shell, which owns
// the details; nothing here imports a shell.

export const DRAFT_PREFIX = 'driveloom.fillup-draft.';
export const RETURN_KEY = 'driveloom.return-to';
/** The last account seen signed in here, so a saved return path is only given back to the same one. */
export const ACCOUNT_KEY = 'driveloom.return-account';

/** Forget every fill-up draft in this tab (sign-out, session end). */
export function clearFillUpDrafts() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch { /* storage unavailable: nothing was kept */ }
}

export function forgetReturn() { try { localStorage.removeItem(RETURN_KEY); } catch { /* nothing kept */ } }

/** A deliberate sign-out: drafts and the saved return path go. */
export function forgetSessionState() { clearFillUpDrafts(); forgetReturn(); }
