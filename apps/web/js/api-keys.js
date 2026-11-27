// API keys, shared by the desktop settings page and the phone's security screen. The shells own the dialogs,
// sheets and lists; this file owns the vocabulary, the create/edit form, the one-time token view and the activity
// list, so both behave identically. The token exists only in a closure and in the DOM of the token view: it is
// never put in storage, a URL or a cache, and `clear()` empties both when the dialog closes.
import { get, post, patch, del } from './api.js';
import { h, form, field } from './ui.js';
import { date, dateTime, vehicleLabel } from './format.js';

/** Mirrors SUPPORTED_LEVELS in src/auth/api-key-policy.ts (a test keeps the two equal): only these levels are offered. */
export const MODULES = [
  { id: 'vehicle_info', label: 'Vehicle details', help: 'Name, make, model and basic facts of the vehicles.', levels: ['none', 'read'] },
  { id: 'vehicle_settings', label: 'Vehicle settings', help: 'Edit a vehicle’s details and settings.', levels: ['none', 'read_write', 'full'] },
  { id: 'fuel', label: 'Fuel', help: 'Fill-ups.', levels: ['none', 'read', 'read_write', 'full'] },
  { id: 'service', label: 'Service', help: 'Service visits, items and receipts.', levels: ['none', 'read', 'read_write', 'full'] },
  { id: 'maintenance', label: 'Maintenance', help: 'Maintenance tasks and their status.', levels: ['none', 'read', 'read_write', 'full'] },
  { id: 'notifications', label: 'Reminder settings', help: 'Who is reminded and how.', levels: ['none', 'read', 'read_write'] },
  { id: 'statistics', label: 'Statistics', help: 'Economy and cost summaries.', levels: ['none', 'read'] },
];
export const LEVEL_LABEL = { none: 'No access', read: 'Read', read_write: 'Read & write', full: 'Full' };
export const EXPIRY = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', '1 year'], ['never', 'Never expires']];
export const DEFAULT_EXPIRY = '30d';
export const MODES = [
  ['selected', 'Selected vehicles', 'Only the vehicles you tick below.'],
  ['all_current', 'All my vehicles today', 'Every vehicle you can access right now. Vehicles you get later are not included.'],
  ['all_current_future', 'All my vehicles, now and in the future', 'Also every vehicle you create or are added to later.'],
];
const MODE_LABEL = { selected: 'Selected vehicles', all_current: 'All vehicles today', all_current_future: 'All vehicles, now and future' };

const ACTIONS = {
  created: 'Key created', updated: 'Key changed', rotated: 'Key rotated', revoked: 'Key revoked', revoked_all: 'Revoked with all keys', removed: 'Key removed',
};
/** "fill_up.created" -> "Fill up created". Text only, so an unexpected action name cannot do harm. */
export function activityLabel(action) {
  if (ACTIONS[action]) return ACTIONS[action];
  const t = String(action).replace(/[._]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Activity';
}

export const listKeys = () => get('/v1/auth/api-keys');
export const listVehicles = async () => (await get('/v1/vehicles?includeArchived=true')).items ?? [];

export function permissionSummary(key) {
  const parts = MODULES.filter((m) => key.permissions?.[m.id] && key.permissions[m.id] !== 'none').map((m) => `${m.label}: ${LEVEL_LABEL[key.permissions[m.id]].toLowerCase()}`);
  if (key.vehicleCreate) parts.push('can create vehicles');
  return parts.length ? parts.join(' · ') : 'No permissions';
}
export function modeSummary(key, vehicles) {
  if (key.vehicleMode !== 'selected') return MODE_LABEL[key.vehicleMode] ?? key.vehicleMode;
  const names = key.vehicleIds.map((id) => vehicles.find((v) => v.id === id)).map((v) => (v ? vehicleLabel(v) : null)).filter(Boolean);
  const gone = key.vehicleIds.length - names.length;
  if (!key.vehicleIds.length) return 'No vehicles selected';
  return `${names.join(', ')}${gone ? `${names.length ? ' and ' : ''}${gone} other ${gone === 1 ? 'vehicle' : 'vehicles'}` : ''}`;
}
export const expiryText = (key) => (key.expiresAt ? `${key.status === 'expired' ? 'Expired' : 'Expires'} ${date(key.expiresAt)}` : 'Never expires');
export const statusText = (key) => ({ active: 'Active', expired: 'Expired', revoked: 'Revoked' })[key.status] ?? key.status;
export const datesText = (key) => [`Created ${date(key.createdAt)}`, key.lastUsedAt ? `last used ${dateTime(key.lastUsedAt)}` : 'never used', expiryText(key)].join(' · ');

export const DISABLED_TEXT = 'An administrator has turned API keys off on this server. Keys cannot be used, created or rotated, but you can still review and revoke them.';
export const LEVELS_HELP = 'Read lets a key look at data. Read & write also adds new records and edits existing ones. Full also lets it delete. Deletion is always a separate step up, never part of read & write.';

/**
 * The create/edit form. `fresh` is the shell's withFreshSignIn. `key` null creates; otherwise it edits that key.
 * `onSaved({ kind, key, token? })` runs after the server accepted it.
 */
export function keyForm({ key = null, vehicles, fresh, onSaved, onCancel, wide = '' }) {
  const editing = !!key;
  const chosen = new Set(key?.vehicleIds ?? []);
  const mode0 = key?.vehicleMode ?? 'selected';
  const warn = h('div', { class: 'notice ak-warn', role: 'status', hidden: true });
  const neverWarn = h('p', { class: 'hint ak-never', role: 'status', hidden: true }, 'A key that never expires stays valid until you revoke it. Prefer a short life, and rotate or revoke it when you are done.');
  const list = h('div', { class: 'ak-vehicles', role: 'group', 'aria-label': 'Vehicles this key may use' },
    vehicles.length ? vehicles.map((v) => h('label', { class: 'check ak-check' }, h('input', { type: 'checkbox', name: 'vehicleIds', value: v.id, checked: chosen.has(v.id) }), vehicleLabel(v), v.archived ? ' (archived)' : ''))
      : h('p', { class: 'muted' }, 'You have no vehicles yet.'));
  const expiry = h('select', { name: 'expiresIn' },
    editing ? h('option', { value: '' }, `Keep current (${expiryText(key).toLowerCase()})`) : null,
    EXPIRY.map(([v, l]) => h('option', { value: v, selected: !editing && v === DEFAULT_EXPIRY }, l)));
  const matrix = h('div', { class: 'ak-matrix' }, MODULES.map((m) => {
    const id = `ak-perm-${m.id}`;
    return h('div', { class: 'ak-row' },
      h('div', { class: 'ak-row-text' }, h('label', { for: id }, m.label), h('div', { class: 'hint' }, m.help)),
      h('select', { id, name: `perm-${m.id}` }, m.levels.map((l) => h('option', { value: l, selected: (key?.permissions?.[m.id] ?? 'none') === l }, LEVEL_LABEL[l]))));
  }));
  const f = form({ class: 'ak-form' }, [
    field('Name', h('input', { name: 'name', required: true, maxlength: 60, value: key?.name ?? '', autocomplete: 'off', placeholder: 'e.g. Home Assistant' }), 'Shown in the list and the activity log. Do not put the key itself here.'),
    field('Expires', expiry),
    neverWarn,
    h('fieldset', { class: 'ak-fieldset' },
      h('legend', {}, 'Vehicles'),
      MODES.map(([v, l, d]) => h('label', { class: 'check ak-check ak-mode' }, h('input', { type: 'radio', name: 'vehicleMode', value: v, checked: v === mode0 }), h('span', {}, h('strong', {}, l), h('span', { class: 'hint' }, d)))),
      list),
    h('fieldset', { class: 'ak-fieldset' },
      h('legend', {}, 'Permissions'),
      h('p', { class: 'hint' }, LEVELS_HELP),
      matrix,
      h('label', { class: 'check ak-check' }, h('input', { type: 'checkbox', name: 'vehicleCreate', checked: !!key?.vehicleCreate }), h('span', {}, h('strong', {}, 'Allow creating vehicles'), h('span', { class: 'hint' }, 'The key can add new vehicles to your account. Nothing else about vehicles is implied.')))),
    warn,
    h('div', { class: `row ak-actions ${wide}` },
      h('button', { type: 'submit', class: wide }, editing ? 'Save changes' : 'Create key'),
      onCancel ? h('button', { type: 'button', class: `secondary ${wide}`, onclick: onCancel }, 'Cancel') : null),
  ], async (_v, el) => {
    const fd = new FormData(el);
    const mode = fd.get('vehicleMode');
    const vehicleIds = fd.getAll('vehicleIds');
    const permissions = {};
    for (const m of MODULES) { const l = fd.get(`perm-${m.id}`); if (l && l !== 'none') permissions[m.id] = l; }
    const vehicleCreate = fd.get('vehicleCreate') === 'on';
    if (mode === 'selected' && !vehicleIds.length && !vehicleCreate) throw new Error('Choose at least one vehicle, or another vehicle mode.');
    const body = { name: String(fd.get('name') ?? '').trim(), permissions, vehicleCreate };
    if (!editing || mode !== key.vehicleMode) body.vehicleMode = mode;
    if (mode === 'selected') body.vehicleIds = vehicleIds;
    const exp = fd.get('expiresIn');
    if (exp) body.expiresIn = exp;
    if (editing) onSaved({ kind: 'updated', key: await fresh(() => patch(`/v1/auth/api-keys/${key.id}`, body)) });
    else { const out = await fresh(() => post('/v1/auth/api-keys', body)); onSaved({ kind: 'created', key: out, token: out.token }); }
  });
  /** Show only the warnings that apply to what is selected right now. */
  const sync = () => {
    const fd = new FormData(f);
    const mode = fd.get('vehicleMode');
    list.hidden = mode !== 'selected';
    neverWarn.hidden = fd.get('expiresIn') !== 'never';
    const msgs = [];
    if (mode === 'all_current_future') msgs.push('This key will also reach every vehicle you create or are added to in the future, without you being asked again.');
    const full = MODULES.filter((m) => fd.get(`perm-${m.id}`) === 'full').map((m) => m.label.toLowerCase());
    if (full.length) msgs.push(`Full access lets this key delete data: ${full.join(', ')}.`);
    if (fd.get('vehicleCreate') === 'on') msgs.push('This key can create vehicles.');
    warn.hidden = !msgs.length;
    warn.replaceChildren(...msgs.map((m) => h('p', {}, m)));
  };
  f.addEventListener('change', sync); sync();
  return f;
}

/**
 * The one-time token view. Returns { el, clear }: `clear()` removes the secret from the DOM and the closure; call it
 * when the surrounding dialog closes. Nothing here writes to storage or the URL.
 */
export function tokenView({ token, name, rotated = false, onDone, wide = '' }) {
  let secret = token;
  const out = h('textarea', { class: 'ak-token', readonly: true, rows: 3, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'API key', 'data-ak-token': '' });
  out.value = secret;
  out.addEventListener('focus', () => out.select());
  const note = h('p', { class: 'hint', role: 'status' });
  const copy = h('button', { type: 'button', class: `secondary ${wide}`, onclick: async () => {
    try { await navigator.clipboard.writeText(secret ?? ''); note.textContent = 'Copied to the clipboard.'; }
    catch { out.focus(); out.select(); note.textContent = 'Selected. Use your device’s copy command.'; }
  } }, 'Copy key');
  const el = h('div', { class: 'ak-token-view' },
    h('div', { class: 'notice' }, h('strong', {}, rotated ? 'Here is the new key for ' : 'Here is the key for ', name, '.'), ' It is shown only once. Closing this window removes it from the page, and nobody, including you, can see it again.'),
    out,
    h('div', { class: `row ak-actions ${wide}` }, copy, h('button', { type: 'button', class: wide, onclick: () => onDone() }, 'I have stored it')),
    note,
    h('p', { class: 'hint' }, 'Store it in a password manager or secret store, or an environment variable such as DRIVELOOM_API_KEY. Do not paste it into chats, notes, tickets or source code.'),
    rotated ? h('p', { class: 'hint' }, 'The previous key stopped working the moment this one was made.') : null);
  return { el, clear() { secret = null; out.value = ''; el.replaceChildren(); } };
}

/** A paginated activity list for one key (newest first). `vehicles` turns ids into names; unknown ones stay generic. */
export function activityView(key, vehicles, { wide = '' } = {}) {
  const ul = h('ul', { class: 'ak-activity list' });
  const status = h('p', { class: 'muted', role: 'status' }, 'Loading…');
  const more = h('button', { type: 'button', class: `secondary ${wide}`, hidden: true });
  let before = null;
  const load = async () => {
    more.disabled = true;
    try {
      const r = await get(`/v1/auth/api-keys/${key.id}/activity?limit=25${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      for (const a of r.items) {
        const v = a.redacted ? null : vehicles.find((x) => x.id === a.vehicleId);
        ul.append(h('li', { class: 'ak-act' },
          h('strong', {}, activityLabel(a.action)),
          h('span', { class: 'hint' }, ` ${dateTime(a.occurredAt)}`),
          a.redacted ? h('div', { class: 'hint' }, 'A vehicle you no longer have access to')
            : a.vehicleId ? h('div', { class: 'hint' }, `Vehicle: ${v ? vehicleLabel(v) : 'another vehicle'}`) : null,
          a.requestId ? h('div', { class: 'hint' }, `Request ${a.requestId}`) : null));
      }
      before = r.nextBefore; more.hidden = !before;
      status.textContent = ul.children.length ? '' : 'No activity yet. Reads are not logged; changes made with this key appear here.';
      status.hidden = !status.textContent;
    } catch (err) { status.hidden = false; status.textContent = err.message; }
    more.disabled = false;
  };
  more.textContent = 'Load older activity';
  more.addEventListener('click', load);
  load();
  return h('div', { class: 'ak-activity-view' }, status, ul, more);
}

export const rotateKey = (fresh, id) => fresh(() => post(`/v1/auth/api-keys/${id}/rotate`));
export const revokeKey = (id) => del(`/v1/auth/api-keys/${id}`);
export const revokeAllKeys = () => post('/v1/auth/api-keys/revoke-all');
