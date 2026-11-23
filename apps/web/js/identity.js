// Make and model inputs with optional suggestions. The inputs are plain text
// fields first: anything typed is saved exactly as typed ("Custom"), and when
// the suggestion call fails or is slow they behave as they always did.
// Choosing a suggestion just puts its display name in the field.
import { get } from './api.js';
import { h, field } from './ui.js';

let seq = 0;

/** The two labelled fields [make, model]; `v` supplies the current values when editing. */
export function makeModelFields(v = {}) {
  const n = ++seq;
  const makes = h('datalist', { id: `dl-make-${n}` });
  const models = h('datalist', { id: `dl-model-${n}` });
  const make = h('input', { name: 'make', maxlength: 80, value: v.make ?? '', list: makes.id, autocomplete: 'off' });
  const model = h('input', { name: 'model', maxlength: 80, value: v.model ?? '', list: models.id, autocomplete: 'off' });
  const fill = (dl, items) => dl.replaceChildren(...(items ?? []).map((s) => h('option', { value: s.name })));
  let latest = 0;
  // Best effort: a failed call leaves whatever was there and never shows an error.
  const load = async (path, apply) => {
    const mine = ++latest;
    try { const r = await get(path); if (mine === latest) apply(r); } catch { /* plain inputs keep working */ }
  };
  const q = (k, s) => `${k}=${encodeURIComponent(s.value.trim())}`;
  make.addEventListener('focus', () => load(`/v1/vehicle-identities?${q('make', make)}`, (r) => fill(makes, r.makes)));
  make.addEventListener('input', () => load(`/v1/vehicle-identities?${q('make', make)}`, (r) => fill(makes, r.makes)));
  const loadModels = () => load(`/v1/vehicle-identities?${q('make', make)}&${q('model', model)}`, (r) => fill(models, r.models));
  model.addEventListener('focus', loadModels);
  model.addEventListener('input', loadModels);
  return [
    field('Make', make, 'Suggestions are optional: type any make.'),
    h('span', { hidden: true }, makes, models),
    field('Model', model),
  ];
}
