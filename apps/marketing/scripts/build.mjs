import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const basePath = cfg.basePath.endsWith('/') ? cfg.basePath : cfg.basePath + '/';
const vars = {
  ...Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, esc(v)])),
  basePath,
  year: new Date().getUTCFullYear(),
  followLink: cfg.followUrl ? `<p><a href="${esc(cfg.followUrl)}">Follow progress</a></p>` : '',
};

const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'src'), out, { recursive: true });
const page = readFileSync(join(out, 'index.html'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => {
  if (!(k in vars)) throw new Error(`Unknown template variable: ${k}`);
  return vars[k];
});
writeFileSync(join(out, 'index.html'), page);
console.log('Built dist/');
