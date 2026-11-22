// Rasterises apps/web/icon.svg into the PNG icons the manifest and iOS need, using
// the Playwright Chromium already installed for the browser tests. Run by hand
// after changing icon.svg: node scripts/gen-icons.ts. The PNGs are committed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const svg = readFileSync(`${web}icon.svg`, 'utf8');
const BG = '#070b16'; // the icon's own tile colour
const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

// scale: share of the canvas the icon art covers; solid: fill the canvas edge to edge.
const targets = [
  { file: 'icons/icon-192.png', size: 192, scale: 1, solid: false },
  { file: 'icons/icon-512.png', size: 512, scale: 1, solid: false },
  // Maskable: art kept inside the central 80% safe zone on a full-bleed tile.
  { file: 'icons/icon-maskable-512.png', size: 512, scale: 0.7, solid: true },
  // iOS rounds the corners itself and renders transparency as black.
  { file: 'icons/apple-touch-icon.png', size: 180, scale: 1, solid: true },
];

mkdirSync(`${web}icons`, { recursive: true });
const browser = await chromium.launch();
try {
  for (const t of targets) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
    const art = Math.round(t.size * t.scale);
    await page.setContent(`<body style="margin:0;display:grid;place-items:center;width:${t.size}px;height:${t.size}px;background:${t.solid ? BG : 'transparent'}"><img src="${uri}" width="${art}" height="${art}"></body>`);
    await page.locator('img').evaluate((i) => (i as unknown as { decode(): Promise<void> }).decode());
    writeFileSync(`${web}${t.file}`, await page.screenshot({ omitBackground: !t.solid, type: 'png' }));
    await page.close();
  }
} finally { await browser.close(); }
console.log(`wrote ${targets.length} icons`);
