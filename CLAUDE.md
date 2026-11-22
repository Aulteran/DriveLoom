# DriveLoom repository instructions

DriveLoom is a self-hosted fuel tracker (working name). Layout: `apps/api` (Node 22, TypeScript, PostgreSQL 16), `apps/web` (web client, no build step), `apps/marketing` (project site on GitHub Pages), `deploy/` (Docker Compose, proxy examples). The native Android client lives in `Aulteran/DriveLoom-Android`.

## Source of truth

Project status, design, aims and aspirations live in the owner's Notion AI HQ, not in this repo. Check there before planning work.

- DriveLoom project page: https://app.notion.com/p/41eab8277cf78132a882fa77424db1a8
- Handoff doc: https://app.notion.com/p/41eab8277cf78184baa6ffb429e3e36a
- Android page: https://app.notion.com/p/41eab8277cf781a5b3b5c67438fc9c05

Do not add status, roadmap, design or planning documents to this repo. Keep `LICENSE`, `apps/marketing/ASSET-PROVENANCE.md` and any licence or asset-terms files. The API contract is `apps/api/openapi/openapi.yaml`; decimals are strings.

## Commands

Use Node 22. From `apps/marketing/`: `npm run build`, `npm run check`, `npm test` in that order. From `apps/api/`, with `DATABASE_URL` set: `npm run check`, `npm test`, `npm run test:browser`. Public site identity is in `apps/marketing/site.config.json`.

## Branches

- `dev` is the default branch; all work happens there.
- `main` is the release branch: merging `dev` into `main` publishes the Docker image to ghcr.io and deploys the marketing site. Never push feature work to `main`, and do not merge to `main` without the owner's approval.
- Always start work on a new, descriptively named branch (for example `feature/instance-default-units`), never a generic or auto-generated name.
- When the work is done and its checks pass, open the PR into `dev` yourself and merge it once CI is green. This standing approval covers PRs into `dev` only.
- Never commit secrets, `deploy/.env` or local overrides.
