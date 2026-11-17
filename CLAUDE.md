# DriveLoom repository instructions

DriveLoom is a self-hosted fuel tracker. Phase 0 (the coming-soon site in `apps/marketing/`, deployed to GitHub Pages through GitHub Actions) is complete. The platform (`apps/api`, `apps/web`, `deploy/`) was built on 2026-11-12 and awaits owner and security review; see the roadmap. Native Android and iOS clients are not started.

Before planning or assigning work, read [product scope](docs/PRODUCT.md), [architecture](docs/ARCHITECTURE.md), [milestones](docs/ROADMAP.md), and [verification](docs/VERIFICATION.md). Treat deferred architecture choices as proposals. Check the current branch, recent changes and CI before assigning any work.

Use Node 22. From `apps/marketing/`, run `npm run build`, `npm run check`, and `npm test` in that order. From `apps/api/`, with `DATABASE_URL` set, run `npm run check`, `npm test` and `npm run test:browser`. Review `site.config.json` for public identity, project base path, and URL.

Always start work on a new branch with a descriptive, task-specific name (for example `feature/instance-default-units`, never a generic or auto-generated name). When the work is done and its checks pass, open the PR into `dev` yourself and merge it yourself once CI is green; do not wait for the owner's authorization. This standing approval covers PRs into `dev` only, not releases to `main`.

Work in scoped branches and PRs into `dev`, the default branch. `main` is the release branch: merging `dev` into `main` publishes the image to ghcr.io and deploys the marketing site. Never push feature work to `main`. Keep private coordinator material in the Claude Project Library. Check owner approval for the public name and release, and verify the GitHub Pages environment before triggering a deployment. Report evidence against the roadmap acceptance criteria.
