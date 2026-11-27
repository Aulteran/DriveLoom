// Self-hosted API reference. No dependencies, no build step, no third-party requests: it reads the instance's own
// /openapi.json (the same contract file the server is checked against) and draws it with text nodes only, so
// nothing in the contract can become markup. It never asks for or stores a credential; the curl examples carry
// a ${DRIVELOOM_API_KEY} placeholder for you to fill from your own shell.
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Follow a local `$ref` ("#/components/schemas/X"). */
function deref(spec, node, seen = 0) {
  if (node && typeof node === 'object' && typeof node.$ref === 'string' && seen < 8) {
    const target = node.$ref.replace(/^#\//, '').split('/').reduce((n, k) => n?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    return deref(spec, target, seen + 1) ?? node;
  }
  return node;
}

/** A compact one-line type for a schema: "string", "array of Vehicle", "enum a | b", "object". */
function typeOf(spec, schema) {
  if (!schema) return '';
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.enum) return `enum ${schema.enum.join(' | ')}`;
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map((s) => typeOf(spec, s)).join(' or ');
  if (schema.type === 'array') return `array of ${typeOf(spec, schema.items) || 'any'}`;
  const t = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type ?? 'object';
  return schema.format ? `${t} (${schema.format})` : t;
}

/** Properties of an object schema as table rows: name, type, required, description. */
function propertiesOf(spec, schema) {
  const s = deref(spec, schema);
  const props = s?.properties ?? {};
  const req = new Set(s?.required ?? []);
  return Object.entries(props).map(([name, p]) => ({ name, type: typeOf(spec, p), required: req.has(name), description: deref(spec, p)?.description ?? '' }));
}

function paragraphs(text) {
  return String(text ?? '').split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).map((p) => h('p', {}, p));
}

function table(head, rows) {
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((c) => h('th', { scope: 'col' }, c)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))));
}

function curlFor(method, path, op, origin) {
  const url = `${origin}${path.replace(/\{([^}]+)\}/g, '<$1>')}`;
  const lines = [`curl --fail-with-body -X ${method.toUpperCase()} '${url}'`, `  -H "Authorization: Bearer \${DRIVELOOM_API_KEY}"`];
  if (op.requestBody) lines.push("  -H 'Content-Type: application/json'", "  -d '{ ... }'");
  return lines.join(' \\\n');
}

function authChips(op, spec) {
  const sec = op.security ?? spec.security ?? [];
  const names = new Set(sec.flatMap((s) => Object.keys(s)));
  if (!sec.length) return [h('span', { class: 'chip' }, 'Public: no sign-in')];
  const out = [h('span', { class: 'chip sess' }, 'Session cookie')];
  if (names.has('apiKey')) out.push(h('span', { class: 'chip key' }, 'API key'));
  else out.push(h('span', { class: 'chip sess' }, 'Session only: keys are refused'));
  return out;
}

function operation(spec, method, path, op, origin) {
  const pol = op['x-driveloom-key-policy'];
  const params = (op.parameters ?? []).map((p) => deref(spec, p));
  const body = deref(spec, op.requestBody)?.content?.['application/json']?.schema;
  const bodyProps = body ? propertiesOf(spec, body) : [];
  return h('details', { class: 'op', id: op.operationId },
    h('summary', {}, h('span', { class: `method m-${method}` }, method.toUpperCase()), h('span', { class: 'path' }, path), op.summary ? h('span', { class: 'sum' }, op.summary) : null),
    h('div', { class: 'op-body' },
      h('div', { class: 'chips' }, authChips(op, spec),
        pol ? (pol.requires.length ? pol.requires.map((r) => h('span', { class: 'chip' }, `needs ${r}`)) : h('span', { class: 'chip' }, 'needs no permission')) : null),
      h('div', { class: 'desc' }, paragraphs(op.description)),
      params.length ? [h('h3', {}, 'Parameters'), table(['Name', 'In', 'Type', 'Required', 'Description'], params.map((p) => [h('code', {}, p.name), p.in, typeOf(spec, p.schema), p.required ? 'yes' : 'no', p.description ?? '']))] : null,
      op.requestBody ? [h('h3', {}, 'Request body'), bodyProps.length
        ? table(['Field', 'Type', 'Required', 'Description'], bodyProps.map((p) => [h('code', {}, p.name), p.type, p.required ? 'yes' : 'no', p.description]))
        : h('p', { class: 'muted' }, body ? typeOf(spec, body) : 'JSON or raw bytes; see the contract.')] : null,
      h('h3', {}, 'Responses'),
      table(['Status', 'Meaning'], Object.entries(op.responses ?? {}).map(([code, r]) => [h('code', { class: /^[45]/.test(code) ? 'err' : '' }, code), deref(spec, r)?.description ?? ''])),
      h('h3', {}, 'Example'),
      h('pre', {}, h('code', {}, curlFor(method, path, op, origin)))));
}

function render(spec) {
  const origin = location.origin;
  const groups = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const tag = op.tags?.[0] ?? 'general';
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push([m, path, op]);
    }
  }
  document.title = `${spec.info.title} ${spec.info.version} · DriveLoom`;
  const keys = [...groups.values()].flat().filter(([, , op]) => op.security?.some((s) => 'apiKey' in s)).length;
  const doc = document.getElementById('doc');
  doc.replaceChildren(
    h('p', { class: 'lede' }, `Version ${spec.info.version} · ${keys} operations accept an API key · this page and the contract are served by this instance (${origin}) and make no third-party requests.`),
    h('section', { class: 'intro', 'aria-labelledby': 'auth-h' },
      h('h2', { id: 'auth-h' }, 'Authentication'),
      paragraphs(spec.info.description),
      h('p', {}, 'Create a key under Account and security, then keep it in a secret store or an environment variable, never in code, chats or notes:'),
      h('pre', {}, h('code', {}, `export DRIVELOOM_API_KEY='dlk_...'\ncurl --fail-with-body -H "Authorization: Bearer \${DRIVELOOM_API_KEY}" ${origin}/v1/me`))),
    h('nav', { 'aria-label': 'API groups' }, h('p', {}, 'Groups: ', [...groups.keys()].map((t, i) => [i ? ', ' : '', h('a', { href: `#tag-${t}` }, t)]))),
    ...[...groups].map(([tag, ops]) => h('section', { 'aria-labelledby': `tag-${tag}` },
      h('h2', { id: `tag-${tag}` }, tag),
      ops.map(([m, p, op]) => operation(spec, m, p, op, origin)))));
  document.getElementById('status').remove();
  const hash = decodeURIComponent(location.hash.slice(1));
  const target = hash && document.getElementById(hash);
  if (target) { if (target.tagName === 'DETAILS') target.open = true; target.scrollIntoView(); }
}

try {
  const res = await fetch('/openapi.json', { credentials: 'omit', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  render(await res.json());
} catch {
  document.getElementById('status').textContent = 'The API contract could not be loaded. You can still download it from /openapi.yaml.';
}
