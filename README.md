# DriveLoom

DriveLoom is an open-source, self-hosted fuel tracker for recording fill-ups, understanding fuel economy, and sharing vehicles with other users on an instance.

- `apps/api`: the server (Node 22, TypeScript, PostgreSQL 16). It serves the API under `/v1` and the web client.
- `apps/web`: the web client, an installable web app with no build step.
- `apps/marketing`: the project website with an interactive demo, published to GitHub Pages from `main`.
- `deploy/`: Docker Compose and reverse-proxy examples. Start with the [self-hosting guide](docs/DEPLOYMENT.md).

The platform was built on 2026-11-12 and is in review: it has not had a security review or a release yet. DriveLoom is the working name.

- [Product and scope](docs/PRODUCT.md)
- [Architecture and dependencies](docs/ARCHITECTURE.md)
- [Milestones and acceptance criteria](docs/ROADMAP.md)
- [Verification and release checklist](docs/VERIFICATION.md)
- [Contracts](docs/CONTRACTS.md) and [decision records](docs/adr/)
- [Self-hosting](docs/DEPLOYMENT.md)
- [Repository layout and contributions](CONTRIBUTING.md)

## Branches and releases

All work happens on `dev`, the default branch. `main` is the release branch: merging `dev` into `main` publishes the Docker image to `ghcr.io/aulteran/driveloom` (see [Self-hosting](docs/DEPLOYMENT.md#run-the-published-image)).

## Local development launcher (Windows)

Double-click `dev-up.cmd` in the repository root. It needs only Git and Docker Desktop, and shows a menu: start, stop, logs, restart and apply updates, wipe and start fresh, quit.

- Copy `deploy/.env.example` to `deploy/.env` and fill it in first. The script reads that file and never changes it.
- To layer on local settings (for example a Tailscale IP or hostname), create `deploy/compose.override.yml`. It is picked up automatically and is git-ignored.
- "Restart and apply updates" runs `git pull --ff-only` on whichever branch you have checked out, only when it has an upstream and no uncommitted changes to tracked files, and prints one line about the result. It then pulls images and rebuilds quietly (the log shows only if something fails), and shows Docker Compose's own progress as it starts the containers and waits until they are healthy. It prints the address but does not open a browser, so hard refresh with Ctrl+F5. While no account exists yet, it also prints the first-run setup token from `deploy\.env`, on screen only, and says nothing about it afterwards.
- "Wipe everything" deletes the database and photos, and asks you to type `YES` first.

The platform is licensed under [AGPL-3.0-only](LICENSE). Bundled third-party assets retain their applicable terms. See the [marketing asset register](apps/marketing/ASSET-PROVENANCE.md).
