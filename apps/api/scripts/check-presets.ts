// Validates every maintenance preset file and checks the id is globally unique.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePresetText } from '../src/service/preset-schema.ts';

const root = fileURLToPath(new URL('../maintenance-presets/', import.meta.url));
async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const errors: string[] = [];
const ids = new Set<string>();
let count = 0;
for await (const file of walk(root)) {
  const rel = relative(root, file).split(sep).join('/');
  if (rel === 'README.md' || rel === 'preset.schema.json') continue;
  if (!rel.endsWith('.json')) { errors.push(`${rel}: only .json preset files are allowed`); continue; }
  count++;
  const { preset, errors: errs } = validatePresetText(await readFile(file, 'utf8'), rel);
  for (const e of errs) errors.push(`${rel}: ${e}`);
  const id = (preset as { id?: string } | null)?.id;
  if (id) { if (ids.has(id)) errors.push(`${rel}: duplicate preset id "${id}"`); ids.add(id); }
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`presets: ok (${count} files)`);
