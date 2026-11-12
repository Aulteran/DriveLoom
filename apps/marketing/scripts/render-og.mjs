// Regenerates src/og-image.png from assets/og-image.svg (1200x630) with the
// site's self-hosted fonts embedded. Run manually: node scripts/render-og.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const font = (family, file, weight) => `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(join(root, 'src/fonts', file)).toString('base64')}) format("woff2")}`;
const css = font('Space Grotesk', 'space-grotesk-latin-wght-normal.woff2', '300 700') + font('JetBrains Mono', 'jetbrains-mono-latin-wght-normal.woff2', '100 800');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(`<style>${css} body{margin:0}</style><body>${readFileSync(join(root, 'assets/og-image.svg'), 'utf8')}</body>`);
await page.evaluate(() => document.fonts.ready);
writeFileSync(join(root, 'src/og-image.png'), await page.screenshot({ type: 'png' }));
await browser.close();
