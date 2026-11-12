# apps/marketing

Standalone project site with an interactive demo of the web app. Zero runtime dependencies; Node 22.

The page uses the web client's "Loom HUD" design system ([docs/DESIGN.md](../../docs/DESIGN.md)): the same tokens, the self-hosted Space Grotesk and JetBrains Mono fonts (latin subsets, copied from `apps/web/fonts`) and the app icon. `src/demo.js` renders the tour (vehicles, fuel log, statistics, members, friends, import and export) from sample data in memory. It makes no network requests and uses no storage or cookies; `npm run check` and `npm test` enforce that. Without JavaScript the rest of the page still works.

- `npm run build` builds `src/` into `dist/` (the Pages artifact path).
- `npm run check` validates `dist/`.
- `npm test` runs static smoke tests on `dist/`.
- `npm run test:browser` serves `dist/` under the base path and checks assets, overflow at 360/768/1440px, third-party requests, axe accessibility in both themes, keyboard access, every demo screen, and reduced motion. It needs `npm ci` and `npx playwright install chromium`; set `CHROMIUM_PATH` to use an existing browser. Screenshots go to `test-results/`.
- `npm run dev` builds and serves on http://localhost:4321.

All public identity (name, tagline, description, URL, base path, follow link) lives in `site.config.json`. After editing `assets/og-image.svg`, run `node scripts/render-og.mjs` to regenerate `src/og-image.png`.

`indexable` in `site.config.json` controls the robots meta tag, `robots.txt` and `sitemap.xml` together. `npm run check` also scans `dist/` for secret and internal-note patterns.
