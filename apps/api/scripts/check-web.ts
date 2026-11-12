// The web client has no build step, so nothing else would notice a typo in an
// import. Checks every module parses and every named import is exported.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../web/', import.meta.url));
const files: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
walk(path.join(root, 'js'));

const exportsOf = new Map<string, Set<string>>();
const exported = (file: string) => {
  let set = exportsOf.get(file);
  if (!set) {
    const src = readFileSync(file, 'utf8');
    set = new Set([...src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!));
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1]!.split(',')) { const name = n.trim().split(/\s+as\s+/).pop(); if (name) set.add(name); }
    exportsOf.set(file, set);
  }
  return set;
};

const errors: string[] = [];
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { errors.push(`${f}: ${(e as { stderr: Buffer }).stderr.toString().split('\n').slice(0, 5).join(' ')}`); continue; }
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const target = path.resolve(path.dirname(f), m[2]!);
    if (!existsSync(target)) { errors.push(`${path.relative(root, f)}: imports missing ${m[2]}`); continue; }
    for (const n of m[1]!.split(',')) {
      const name = n.trim().split(/\s+as\s+/)[0];
      if (name && !exported(target).has(name)) errors.push(`${path.relative(root, f)}: ${m[2]} does not export ${name}`);
    }
  }
}
const index = readFileSync(path.join(root, 'index.html'), 'utf8');
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(index) || /\son[a-z]+=/i.test(index) || /\sstyle=/i.test(index)) errors.push('index.html: inline script, handler or style would be blocked by the CSP');

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`web: ok (${files.length} modules)`);
