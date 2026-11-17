// Light / dark / system theme. The choice is a per-device convenience kept in
// localStorage; without it (or with storage blocked) the OS setting wins.
import { h } from './ui.js';
import { icon } from './icons.js';

const KEY = 'driveloom.theme';
const COLORS = { light: '#edf1f8', dark: '#05070e' };
const MODES = [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']];
const controls = new Set();

export function getTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

function syncMeta(mode) {
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = /dark/.test(m.media) ? 'dark' : 'light';
    m.content = COLORS[mode === 'system' ? scheme : mode];
  }
}

export function setTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  try { if (mode === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch { /* not persisted */ }
  syncMeta(mode);
  for (const c of controls) update(c);
}

function update(group) {
  const mode = getTheme();
  for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
}

/** A three-way segmented control: System, Light, Dark. */
export function themeControl(compact = false) {
  const group = h('div', { class: `theme-toggle${compact ? ' compact' : ''}`, role: 'group', 'aria-label': 'Colour theme' },
    MODES.map(([mode, label, ic]) => h('button', {
      type: 'button', class: 'ghost', dataset: { mode }, title: `${label} theme`,
      'aria-label': compact ? `${label} theme` : undefined, onclick: () => setTheme(mode),
    }, icon(ic), compact ? null : h('span', {}, label))));
  // Drop controls that left the page so the set does not grow forever.
  for (const c of controls) if (!c.isConnected) controls.delete(c);
  controls.add(group);
  update(group);
  return group;
}

syncMeta(getTheme());
