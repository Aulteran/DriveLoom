// Regenerates src/og-image.png from assets/og-image.svg (1200x630). Run manually: node scripts/render-og.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(`<body style="margin:0">${readFileSync(join(root, 'assets/og-image.svg'), 'utf8')}</body>`);
writeFileSync(join(root, 'src/og-image.png'), await page.screenshot({ type: 'png' }));
await browser.close();
