# DriveLoom repository instructions

DriveLoom is a planned self-hosted fuel tracker. Phase 0 is the only active scope. The standalone coming-soon site lives in `apps/marketing/` and deploys to GitHub Pages through GitHub Actions. Application development and native Android and iOS clients are paused.

Before planning or assigning work, read [product scope](docs/PRODUCT.md), [architecture](docs/ARCHITECTURE.md), [milestones](docs/ROADMAP.md), and [verification](docs/VERIFICATION.md). Treat deferred architecture choices as proposals. Check the current branch, recent changes and CI before assigning any work.

Use Node 22. From `apps/marketing/`, run `npm run build`, `npm run check`, and `npm test` in that order. Review `site.config.json` for public identity, project base path, and URL.

Work in scoped branches and PRs. Keep private coordinator material in the Claude Project Library. Check owner approval for the public name and release, and verify the GitHub Pages environment before triggering a deployment. Report evidence against the roadmap acceptance criteria.
