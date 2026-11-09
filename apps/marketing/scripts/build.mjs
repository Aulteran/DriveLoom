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
  robotsContent: cfg.indexable ? 'index,follow' : 'noindex',
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

// robots.txt and sitemap.xml must agree with the robots meta tag.
// While the site is noindex, crawlers must still be allowed to fetch it so they can see that tag,
// and no sitemap is published. Set "indexable": true in site.config.json to publish both.
const siteUrl = cfg.siteUrl.endsWith('/') ? cfg.siteUrl : cfg.siteUrl + '/';
if (cfg.indexable) {
  writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`);
  writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${esc(siteUrl)}</loc></url>\n</urlset>\n`);
} else {
  writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');
}
console.log('Built dist/');
