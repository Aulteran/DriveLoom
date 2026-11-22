// Shell-independent session state, hash routing helpers and the selected-vehicle
// memory. Views and every shell import this module; it imports no shell, so
// shells and views never import each other. A shell registers its renderer with
// setRenderer() at start-up.
import { get, setCsrf } from './api.js';

export const state = { account: null, prefs: null, instance: null, vehicles: [] };

let renderer = async () => {};
/** Register the active shell's render pipeline. */
export function setRenderer(fn) { renderer = fn; }
/** Render the current route with the registered shell renderer. */
export function render() { return renderer(); }

/** Load (or reload) the signed-in account. Returns false when signed out. */
export async function refreshSession() {
  try {
    const s = await get('/v1/auth/session', { quiet: true });
    setCsrf(s.csrf_token);
    state.account = s.account;
    state.prefs = await get('/v1/preferences');
    return true;
  } catch { state.account = null; setCsrf(null); return false; }
}

export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

export const PUBLIC = new Set(['signin', 'register', 'recover', 'mfa']);

export function parse() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { parts: (path ?? '').split('/').filter(Boolean), query: new URLSearchParams(qs ?? '') };
}

// ---------- selected vehicle ----------
// The URL is the source of truth; storage only answers "which vehicle does #/ open?".
const lastKey = () => `driveloom.vehicle.${state.account?.id ?? ''}`;
export function rememberVehicle(id) { try { localStorage.setItem(lastKey(), id); } catch { /* not remembered */ } }
export function recalledVehicle() { try { return localStorage.getItem(lastKey()); } catch { return null; } }

export function defaultVehicle() {
  const active = state.vehicles.filter((v) => !v.archived);
  return active.find((v) => v.id === recalledVehicle()) ?? active[0] ?? null;
}
