# apps/marketing

Standalone coming-soon site. Zero dependencies; Node 22.

- `npm run build` builds `src/` into `dist/` (the Pages artifact path).
- `npm run check` validates `dist/`.
- `npm test` runs static smoke tests on `dist/`.
- `npm run test:browser` serves `dist/` under the base path and checks assets, overflow at 360/768/1440px, third-party requests and axe accessibility. It needs `npm ci` and `npx playwright install chromium`; set `CHROMIUM_PATH` to use an existing browser. Screenshots go to `test-results/`.
- `npm run dev` builds and serves on http://localhost:4321.

All public identity (name, tagline, description, URL, base path, follow link) lives in `site.config.json`. Values are placeholders until the public name is approved.

`indexable` in `site.config.json` controls the robots meta tag, `robots.txt` and `sitemap.xml` together. `npm run check` also scans `dist/` for secret and internal-note patterns.
