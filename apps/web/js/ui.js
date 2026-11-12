// DOM helpers. Every piece of user data goes through text nodes or
// attributes, never innerHTML, so stored text cannot become markup.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    // CSSOM, not the style attribute: the CSP (style-src 'self') blocks the latter.
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

export function mount(node, title) {
  const main = document.getElementById('main');
  main.replaceChildren(node);
  if (title) document.title = `${title} · DriveLoom`;
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

let toastTimer;
export function toast(message) {
  const t = document.getElementById('toast');
  t.textContent = message; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

export const errorBox = () => h('div', { class: 'error', role: 'alert', hidden: true });
export function showError(box, err) {
  box.hidden = false;
  box.textContent = err?.message ?? String(err);
}

/**
 * Wire a form: collects values, disables while submitting, shows errors.
 * `fn(values)` may return a message to toast.
 */
export function form(attrs, children, fn) {
  const box = errorBox();
  const el = h('form', { ...attrs, novalidate: false }, box, children);
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    box.hidden = true;
    const buttons = [...el.querySelectorAll('button')];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const msg = await fn(Object.fromEntries(new FormData(el)), el, e.submitter);
      if (typeof msg === 'string') toast(msg);
    } catch (err) { showError(box, err); }
    finally { buttons.forEach((b) => { b.disabled = false; }); }
  });
  return el;
}

export function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}

export const select = (name, options, value, attrs = {}) =>
  h('select', { name, ...attrs }, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));

/** Modal confirmation; resolves true when confirmed. */
export function confirmDialog(message, confirmLabel = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    const d = h('dialog', {},
      h('p', {}, message),
      h('div', { class: 'row' },
        h('button', { class: danger ? 'danger' : '', onclick: () => { d.close(); resolve(true); } }, confirmLabel),
        h('button', { class: 'secondary', onclick: () => { d.close(); resolve(false); } }, 'Cancel')));
    d.addEventListener('close', () => { d.remove(); resolve(false); });
    document.body.append(d); d.showModal();
  });
}

export function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const loading = () => h('p', { class: 'loading', role: 'status' }, 'Loading…');
