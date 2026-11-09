import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!existsSync(join(dist, 'index.html'))) fail('dist/index.html missing (run npm run build)');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
if (/\{\{/.test(html)) fail('unresolved template variable');
for (const re of [/<html lang="[^"]+"/, /<title>[^<]+<\/title>/, /<main id="main">/, /<h1>[^<]+<\/h1>/, /name="viewport"/])
  if (!re.test(html)) fail('missing ' + re);
if (!existsSync(join(dist, 'styles.css'))) fail('styles.css missing');
console.log('OK: dist checks passed');
