// Receipts and invoices on service visits (PDF, JPEG, PNG; 10 files of up to
// 10 MB per visit, mirroring api/src/service/attachment-limits.ts). Shared by the
// desktop page and the phone sheet. Files are fetched with the session cookie
// into blob URLs, never linked directly, so nothing private sits in a URL.
import { upload, fetchBlob, patch, del, ApiError } from './api.js';
import { h, toast, confirmDialog, download } from './ui.js';
import { icon } from './icons.js';

export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_FILES = 10;
const ACCEPT = 'application/pdf,image/jpeg,image/png';
const OK_TYPES = ACCEPT.split(',');

export const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const base = (v, visitId) => `/v1/vehicles/${v.id}/service-visits/${visitId}/attachments`;

/** A message the person can act on, or null when the file looks fine. Only a type the browser reports is judged; the server checks the bytes. */
export function precheck(file, existingCount) {
  if (existingCount >= ATTACH_MAX_FILES) return `A visit allows at most ${ATTACH_MAX_FILES} attachments.`;
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > ATTACH_MAX_BYTES) return `"${file.name}" is ${fileSize(file.size)}; the limit is ${fileSize(ATTACH_MAX_BYTES)}.`;
  if (file.type && !OK_TYPES.includes(file.type)) return `"${file.name}" is not a PDF, JPEG or PNG file.`;
  return null;
}
const explain = (e, name) => (e instanceof ApiError && e.status === 413 ? `"${name}" is larger than ${fileSize(ATTACH_MAX_BYTES)}.` : e?.message ?? String(e));

/** Two buttons (camera is only offered on phones) feeding `onFiles(File[])`. */
function picker(label, phone, onFiles) {
  const mk = (attrs) => {
    const input = h('input', { type: 'file', hidden: true, tabindex: '-1', 'aria-hidden': 'true', ...attrs });
    input.addEventListener('change', () => { const files = [...input.files]; input.value = ''; if (files.length) onFiles(files); });
    return input;
  };
  const files = mk({ accept: ACCEPT, multiple: true });
  const camera = phone ? mk({ accept: 'image/jpeg,image/png', capture: 'environment' }) : null;
  return h('div', { class: 'row att-pick' }, files, camera,
    camera ? h('button', { type: 'button', class: 'secondary', 'aria-label': `Take photo to attach to ${label}`, onclick: () => camera.click() }, icon('camera'), 'Take photo') : null,
    h('button', { type: 'button', class: 'secondary', 'aria-label': `Choose files to attach to ${label}`, onclick: () => files.click() }, icon('plus'), 'Choose files'));
}

function previewDialog(name, url, type) {
  const d = h('dialog', { class: 'att-preview', 'aria-label': `Preview of ${name}` },
    h('img', { src: url, alt: name }),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: () => d.close() }, 'Close')));
  d.addEventListener('close', () => { d.remove(); URL.revokeObjectURL(url); });
  document.body.append(d); d.showModal();
}

async function open(v, visitId, a) {
  const path = `${base(v, visitId)}/${a.id}`;
  if (a.contentType === 'application/pdf') {
    // Open the tab inside the click so a popup blocker allows it; fall back to a download.
    const tab = window.open('', '_blank');
    try {
      const blob = await fetchBlob(`${path}?inline=1`);
      const url = URL.createObjectURL(blob);
      if (tab) { tab.opener = null; tab.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 300000); } else { download(a.fileName, blob); URL.revokeObjectURL(url); }
    } catch (e) { tab?.close(); throw e; }
    return;
  }
  const blob = await fetchBlob(`${path}?inline=1`);
  previewDialog(a.fileName, URL.createObjectURL(blob), a.contentType);
}

/**
 * Attachments of a saved visit: list with preview, download, rename and remove,
 * and (when `mayChange`) renaming and removing. Adding files is offered only when
 * `canAdd` is set, which is the edit form; the history view passes false. Changes
 * go to the server at once.
 */
export function attachmentsPanel(v, visit, { mayChange, canAdd = false, phone = false, heading = true } = {}) {
  const label = 'this service visit';
  const list = h('ul', { class: 'att-list', 'aria-label': 'Attachments' });
  const status = h('ul', { class: 'att-status small', 'aria-live': 'polite' });
  const errors = h('div', { class: 'error', role: 'alert', hidden: true });
  const root = h('section', { class: 'att', 'aria-label': 'Attachments' });
  const busy = (fn) => async (...args) => { try { errors.hidden = true; await fn(...args); } catch (e) { errors.textContent = e?.message ?? String(e); errors.hidden = false; } };

  const draw = () => {
    list.replaceChildren(...visit.attachments.map(row));
    list.hidden = !visit.attachments.length;
    note.textContent = canAdd ? `PDF, JPEG or PNG, up to ${fileSize(ATTACH_MAX_BYTES)} each, ${visit.attachments.length} of ${ATTACH_MAX_FILES} used.` : '';
  };
  const row = (a) => {
    const name = h('span', { class: 'att-name' }, a.fileName);
    const li = h('li', { class: 'att-item' }, icon(a.contentType === 'application/pdf' ? 'file' : 'image'), name, h('span', { class: 'muted small' }, fileSize(a.sizeBytes)),
      h('button', { type: 'button', class: 'ghost', 'aria-label': `${a.contentType === 'application/pdf' ? 'Open' : 'Preview'} ${a.fileName}`, onclick: busy(() => open(v, visit.id, a)) }, a.contentType === 'application/pdf' ? 'Open' : 'Preview'),
      h('button', { type: 'button', class: 'ghost', 'aria-label': `Download ${a.fileName}`, onclick: busy(async () => download(a.fileName, await fetchBlob(`${base(v, visit.id)}/${a.id}`))) }, 'Download'),
      mayChange ? h('button', { type: 'button', class: 'ghost', 'aria-label': `Rename ${a.fileName}`, onclick: () => rename(a, li) }, 'Rename') : null,
      mayChange ? h('button', { type: 'button', class: 'ghost', 'aria-label': `Remove ${a.fileName}`, onclick: busy(() => remove(a)) }, 'Remove') : null);
    return li;
  };
  const rename = (a, li) => {
    const input = h('input', { 'aria-label': `New name for ${a.fileName}`, value: a.fileName, maxlength: 200 });
    const save = busy(async () => {
      const r = await patch(`${base(v, visit.id)}/${a.id}`, { fileName: input.value });
      a.fileName = r.fileName; draw(); toast('Attachment renamed.');
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') { e.stopPropagation(); draw(); } });
    li.replaceChildren(input, h('button', { type: 'button', onclick: save }, 'Save name'), h('button', { type: 'button', class: 'secondary', onclick: draw }, 'Cancel'));
    input.focus(); input.select();
  };
  const remove = async (a) => {
    const text = `Remove "${a.fileName}" from this service visit? It is deleted for everyone with access.`;
    const gone = phone
      ? await (await import('./mobile/confirm.js')).confirmSheet({ title: 'Remove this attachment?', message: text, confirmLabel: 'Remove', action: () => del(`${base(v, visit.id)}/${a.id}`) })
      : (await confirmDialog(text, 'Remove')) && (await del(`${base(v, visit.id)}/${a.id}`), true);
    if (!gone) return;
    visit.attachments = visit.attachments.filter((x) => x.id !== a.id); draw(); toast('Attachment removed.');
  };
  const add = async (files) => {
    errors.hidden = true;
    for (const file of files) {
      const item = h('li', {}, `${file.name}: `, h('span', {}, 'checking…'));
      const text = item.lastChild;
      status.append(item);
      const bad = precheck(file, visit.attachments.length);
      if (bad) { text.textContent = bad; item.classList.add('att-bad'); continue; }
      text.textContent = 'uploading…';
      try {
        visit.attachments = [...visit.attachments, await upload(`${base(v, visit.id)}?fileName=${encodeURIComponent(file.name)}`, file)];
        text.textContent = 'added'; draw();
      } catch (e) { text.textContent = explain(e, file.name); item.classList.add('att-bad'); }
    }
    setTimeout(() => { for (const li of [...status.children]) if (!li.classList.contains('att-bad')) li.remove(); }, 4000);
  };
  const note = h('p', { class: 'small muted' });
  root.append(heading ? h('h3', { class: 'att-h' }, 'Attachments') : null, list, canAdd ? picker(label, phone, add) : null, canAdd ? note : null, status, errors);
  visit.attachments ??= [];
  draw();
  return root;
}

/** Files chosen while adding a new visit; uploaded by `uploadStaged` once the visit exists. */
export function stagedAttachments({ phone = false } = {}) {
  const files = [];
  const list = h('ul', { class: 'att-list', 'aria-label': 'Files to attach' });
  const errors = h('div', { class: 'error', role: 'alert', hidden: true });
  const draw = () => {
    list.replaceChildren(...files.map((f) => h('li', { class: 'att-item' }, icon(f.type === 'application/pdf' ? 'file' : 'image'), h('span', { class: 'att-name' }, f.name), h('span', { class: 'muted small' }, fileSize(f.size)),
      h('button', { type: 'button', class: 'ghost', 'aria-label': `Remove ${f.name}`, onclick: () => { files.splice(files.indexOf(f), 1); draw(); } }, 'Remove'))));
    list.hidden = !files.length;
  };
  const add = (picked) => {
    const msgs = [];
    for (const f of picked) { const bad = precheck(f, files.length); if (bad) msgs.push(bad); else files.push(f); }
    errors.hidden = !msgs.length; errors.textContent = msgs.join(' ');
    draw();
  };
  draw();
  const el = h('section', { class: 'att', 'aria-label': 'Attachments' }, h('h3', { class: 'att-h' }, 'Attachments'), list,
    picker('this service visit', phone, add), h('p', { class: 'small muted' }, `Optional receipts or invoices: PDF, JPEG or PNG, up to ${fileSize(ATTACH_MAX_BYTES)} each, ${ATTACH_MAX_FILES} per visit. They are uploaded when you save.`), errors);
  return { el, files };
}

/** Upload staged files to a just-saved visit. Returns the messages for files that failed. */
export async function uploadStaged(v, visitId, files) {
  const failed = [];
  for (const f of files) {
    try { await upload(`${base(v, visitId)}?fileName=${encodeURIComponent(f.name)}`, f); } catch (e) { failed.push(explain(e, f.name)); }
  }
  return failed;
}
