# apps/marketing

Standalone project site with an interactive demo. Zero runtime dependencies; Node 22.

- `npm run build` builds `src/` into `dist/` (the Pages artifact path).
- `npm run check` validates `dist/`.
- `npm test` runs static smoke tests on `dist/`.
- `npm run test:browser` runs browser checks (needs `npm ci` and `npx playwright install chromium`).
- `npm run dev` builds and serves on http://localhost:4321.

Public identity lives in `site.config.json`. Every bundled asset needs a row in `ASSET-PROVENANCE.md`.
