// API keys on the phone's Account and security screen: a list of keys, a sheet to create or edit one, a one-time
// token sheet, an activity sheet and the developer-access links. Rules, wording and requests come from
// ../api-keys.js (shared with the desktop); this file only supplies sheets and rows.
import { h, toast } from '../ui.js';
import { openSheet } from './sheet.js';
import { section, row, staticRow, action, confirmSheet, withFreshSignIn, pill } from './kit.js';
import * as ak from '../api-keys.js';

const WIDE = 'm-wide';

/** A sheet whose content may be swapped; `clear` of the current content runs when it closes. */
function keySheet(title, build, { onClose, size = 'full' } = {}) {
  const slot = h('div', {});
  let cleaners = [];
  const show = (built) => { cleaners = built.clear ? [built.clear] : []; slot.replaceChildren(built.el ?? built); };
  const s = openSheet({ title, size, content: slot, onClose: () => { for (const c of cleaners) c(); slot.replaceChildren(); onClose?.(); } });
  show(build(s.close, show));
  return s;
}

const showToken = (out, rotated, after) => keySheet(rotated ? 'New API key' : 'API key created',
  (close) => ak.tokenView({ token: out.token, name: out.name, rotated, onDone: close, wide: WIDE }), { onClose: after, size: 'medium' });

function openKeyForm(key, vehicles, after) {
  keySheet(key ? 'Edit API key' : 'Create an API key', (close) => ak.keyForm({
    key, vehicles, fresh: withFreshSignIn, wide: WIDE, onCancel: close,
    onSaved: (r) => {
      close();
      if (r.kind === 'created') showToken(r.key, false, after); else { toast('API key updated.'); after(); }
    },
  }));
}

function keySheetFor(k, vehicles, after) {
  const active = k.status === 'active';
  const s = openSheet({
    title: k.name, sub: `${ak.statusText(k)} · ${k.prefix}…`, size: 'medium',
    content: [
      h('dl', { class: 'm-group m-facts' },
        h('div', {}, h('dt', {}, 'Permissions'), h('dd', {}, ak.permissionSummary(k))),
        h('div', {}, h('dt', {}, 'Vehicles'), h('dd', {}, ak.modeSummary(k, vehicles))),
        h('div', {}, h('dt', {}, 'Created'), h('dd', {}, ak.datesText(k)))),
      h('div', { class: 'm-sheet-actions m-stack' },
        active ? action('Edit', async () => { s.close(); openKeyForm(k, vehicles, after); return false; }, { cls: `secondary ${WIDE}` }) : null,
        active ? action('Rotate', async () => {
          if (!(await confirmSheet({ title: `Rotate “${k.name}”?`, text: 'A new key is made and the current one stops working immediately.', confirm: 'Rotate', danger: false }))) return false;
          const out = await ak.rotateKey(withFreshSignIn, k.id);
          s.close(); showToken(out, true, after);
          return false;
        }, { cls: `secondary ${WIDE}` }) : null,
        action('Activity', async () => { s.close(); keySheet(`Activity: ${k.name}`, () => ak.activityView(k, vehicles, { wide: WIDE })); return false; }, { cls: `secondary ${WIDE}` }),
        active
          ? action('Revoke', async () => {
            if (!(await confirmSheet({ title: `Revoke “${k.name}”?`, text: 'Anything using it stops working immediately. This cannot be undone.', confirm: 'Revoke key' }))) return false;
            await ak.revokeKey(k.id); s.close(); await after(); return 'API key revoked.';
          }, { cls: `danger ${WIDE}` })
          : action('Remove from list', async () => {
            if (!(await confirmSheet({ title: `Remove “${k.name}”?`, text: 'It is taken off the list. Its activity history is kept.', confirm: 'Remove' }))) return false;
            await ak.revokeKey(k.id); s.close(); await after(); return 'API key removed.';
          }, { cls: `secondary ${WIDE}` })),
    ],
  });
}

/** The "API keys" and "Developer access" sections. `after` reloads the screen. */
export function apiKeySections(data, vehicles, after) {
  const active = data.items.filter((k) => k.status === 'active');
  const full = active.length >= data.maxActiveKeys;
  return [
    section('API keys', [
      ...data.items.map((k) => row({
        onclick: () => keySheetFor(k, vehicles, after), label: [k.name, ' ', pill(ak.statusText(k), k.status === 'active' ? 'good' : 'warn')],
        sub: `${k.prefix}… · ${ak.permissionSummary(k)} · ${ak.expiryText(k)}`,
      })),
      !data.apiKeysEnabled ? staticRow({ label: 'API keys are turned off', sub: ak.DISABLED_TEXT }) : null,
      h('li', {}, h('div', { class: 'm-pad m-stack-s' },
        action('Create API key', async () => { openKeyForm(null, vehicles, after); return false; }, { cls: `secondary ${WIDE}` }),
        active.length ? action('Revoke all keys', async () => {
          if (!(await confirmSheet({ title: `Revoke all ${active.length} active keys?`, text: 'Everything using them stops working immediately.', confirm: 'Revoke all' }))) return false;
          const r = await ak.revokeAllKeys(); await after();
          return `${r.revoked} API ${r.revoked === 1 ? 'key' : 'keys'} revoked.`;
        }, { cls: `danger ${WIDE}` }) : null)),
    ], { id: 'm-api-keys', note: `${active.length} of ${data.maxActiveKeys} active keys.${data.apiKeysEnabled && full ? ' Revoke one to create another.' : ''} Let a script read or write your data without your password; each key gets only the access you choose.` }),
    section('Developer access', [
      row({ href: '/docs', label: 'Interactive API documentation', sub: 'Served by this server', chevron: true }),
      row({ href: '/openapi.yaml', label: 'Download OpenAPI (YAML)', sub: 'Matches this server’s version', chevron: true }),
    ], { id: 'm-developer' }),
  ];
}
