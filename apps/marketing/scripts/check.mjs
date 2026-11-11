import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const cfg = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8'));
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const read = (f) => readFileSync(join(dist, f), 'utf8');

if (!existsSync(join(dist, 'index.html'))) fail('dist/index.html missing (run npm run build)');
const html = read('index.html');
if (/\{\{/.test(html)) fail('unresolved template variable');
for (const re of [/<html lang="[^"]+"/, /<title>[^<]+<\/title>/, /<main id="main">/, /<h1>[^<]+<\/h1>/, /name="viewport"/,
  /<link rel="canonical" href="https?:\/\/[^"]+"/, /property="og:title"/, /property="og:url"/, /name="twitter:card" content="summary_large_image"/, /property="og:image" content="https?:\/\/[^"]+\/og-image\.png"/, /name="twitter:image" content="https?:\/\/[^"]+\/og-image\.png"/])
  if (!re.test(html)) fail('missing ' + re);
if (!existsSync(join(dist, 'og-image.png'))) fail('og-image.png missing');
if (!existsSync(join(dist, 'styles.css'))) fail('styles.css missing');

// Discovery policy: meta robots, robots.txt and sitemap must agree.
const noindex = /<meta name="robots" content="noindex">/.test(html);
if (noindex === Boolean(cfg.indexable)) fail('robots meta disagrees with "indexable" in site.config.json');
if (!existsSync(join(dist, 'robots.txt'))) fail('robots.txt missing');
const hasSitemap = existsSync(join(dist, 'sitemap.xml'));
if (noindex && hasSitemap) fail('sitemap.xml must not be published while the site is noindex');
if (!noindex && !hasSitemap) fail('sitemap.xml missing for an indexable site');
if (/^\s*Disallow:\s*\/\s*$/m.test(read('robots.txt'))) fail('robots.txt must not block crawlers from reading the robots meta tag');

// Artifact hygiene: public output only, no secrets or internal notes.
const secretPatterns = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/sk-[A-Za-z0-9]{20,}/, 'API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/(?:password|secret|api[_-]?key|token)\s*[:=]\s*["'][^"']{8,}["']/i, 'credential assignment'],
];
const internalPatterns = [/\bTODO\b/, /\bFIXME\b/, /coordinator/i, /handoff/i, /\.project\//, /NAMING\.md/, /"_note"/];
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const f of walk(dist)) {
  const text = readFileSync(f, 'utf8');
  for (const [re, label] of secretPatterns) if (re.test(text)) fail(`${label} pattern found in ${f}`);
  for (const re of internalPatterns) if (re.test(text)) fail(`internal note pattern ${re} found in ${f}`);
}
console.log('OK: dist checks passed');
