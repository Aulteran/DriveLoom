// PWA plumbing: service worker registration, the update prompt, connection state
// and install state. UI lives elsewhere and builds on these exports. The worker is
// only registered in a secure context (HTTPS or localhost); over plain HTTP the app
// is an ordinary website. Updates are prompt-only: a new worker waits until
// applyUpdate() is called, and the page never reloads by itself.

const canWorker = () => 'serviceWorker' in navigator && window.isSecureContext;

let registration = null;
let waiting = null;
let applying = false;
const updateListeners = new Set();
const connectionListeners = new Set();
let installPrompt = null;
const installListeners = new Set();

function offerUpdate(worker) {
  // The very first install has no controller yet: nothing to update from.
  if (!worker || !navigator.serviceWorker.controller) return;
  waiting = worker;
  for (const cb of updateListeners) cb();
}

/** Registers /sw.js (secure contexts only). Resolves to the registration or null. */
export async function register() {
  if (!canWorker()) return null;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch { return null; }
  if (registration.waiting) offerUpdate(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => { if (worker.state === 'installed') offerUpdate(worker); });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (applying) location.reload(); });
  // Look for a new build when the app is reopened, not only on navigation.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') registration?.update().catch(() => undefined); });
  return registration;
}

/** Calls cb whenever a new version is waiting. Fires at once if one already is. Returns an unsubscribe. */
export function onUpdateAvailable(cb) {
  updateListeners.add(cb);
  if (waiting) cb();
  return () => updateListeners.delete(cb);
}

/** The user accepted the update: activate the waiting worker, then reload once it takes over. */
export function applyUpdate() {
  if (!waiting) return;
  applying = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

/** Deletes every service worker cache. Call on sign-out. Safe without a worker. */
export async function clearCaches() {
  try {
    const reg = registration ?? (canWorker() ? await navigator.serviceWorker.getRegistration('/') : null);
    (navigator.serviceWorker?.controller ?? reg?.active)?.postMessage({ type: 'CLEAR_CACHES' });
    if ('caches' in window) for (const key of await caches.keys()) await caches.delete(key);
  } catch { /* nothing cached, nothing to clear */ }
}

export const isOnline = () => navigator.onLine;

/** Calls cb(online) on every change. Returns an unsubscribe. */
export function onConnectionChange(cb) {
  if (!connectionListeners.size) {
    addEventListener('online', () => { for (const fn of connectionListeners) fn(true); });
    addEventListener('offline', () => { for (const fn of connectionListeners) fn(false); });
  }
  connectionListeners.add(cb);
  return () => connectionListeners.delete(cb);
}

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  for (const cb of installListeners) cb();
});
addEventListener('appinstalled', () => { installPrompt = null; for (const cb of installListeners) cb(); });

/** Calls cb when install state changes (the Android prompt becomes available, or the app was installed). */
export function onInstallChange(cb) { installListeners.add(cb); return () => installListeners.delete(cb); }

/** Shows the browser's own install prompt (Android/Chromium). Resolves to 'accepted', 'dismissed' or 'unavailable'. */
export async function promptInstall() {
  if (!installPrompt) return 'unavailable';
  const p = installPrompt;
  installPrompt = null;
  await p.prompt();
  const { outcome } = await p.userChoice;
  return outcome;
}

/**
 * { standalone, platform: 'ios'|'android'|'other', secure, canInstall, canPrompt }
 * standalone: already running as an installed app. secure: HTTPS or localhost; without it
 * a browser will not offer install (canInstall false). canPrompt: Android can show its
 * install dialog right now; on iOS the user must use Share > Add to Home Screen.
 */
export function installState() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const platform = ios ? 'ios' : /Android/i.test(ua) ? 'android' : 'other';
  const standalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  const secure = window.isSecureContext;
  return { standalone, platform, secure, canInstall: secure && !standalone, canPrompt: installPrompt !== null };
}

// Registration is wired once from boot.js after the page has loaded.
export function start() {
  if (document.readyState === 'complete') return register();
  return new Promise((resolve) => addEventListener('load', () => resolve(register()), { once: true }));
}
