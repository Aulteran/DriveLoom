# Private · Durable checkpoint

## Initial state · 2026-11-08

- Scope — Phase 0 handoff ready. Phases 1–3 paused.
- Gate 0.1 — Open. Exact-name collision documented. Publish identity and URL awaiting owner decision.
- GitHub repo, base branch/SHA, cloud environment, runtime — Pending setup.
- Implementation branches, PRs, CI, release — Pending.
- Next action — Owner selects staging repo. Coordinator verifies access and starts private baseline and name decision.

## Update at each merge, pause or release

Record timestamp and coordinator/owner, approved scope, owner decisions and open gates, repo/base branch/current SHA, each task ID and state, worker/session link, branch/head SHA and PR, checks run with results, blockers, and the next action with an owner. For release, include public URL, workflow run, deployed commit, smoke evidence and known-good rollback target. Use the private Library or approved private storage.

## Resume safely

1. Retrieve the last checkpoint and subsequent owner messages. Refresh repository default branch, open PRs, checks and latest Pages deployment. If records disagree, verify against the actual branch and environment and update the checkpoint.
2. Reuse the existing worker or PR if possible. Verify its remote head SHA and clean checkout before changing code. If a session expired, re-clone its pushed branch and continue from the recorded SHA, with a new session linked in the checkpoint. If edits were never pushed, reconstruct only the missing work and check the PR for duplicates.
3. Never overwrite someone else's work or force-push a shared branch. If the base moved, review overlap and update with the repository's normal merge procedure. Re-run relevant tests on the actual candidate. Retry only steps that remain necessary.
4. Resume the first authorized unblocked task. If the site shipped, keep the platform parked until explicit restart. If the public identity or release is still gated, work privately. Capture the new checkpoint before the next pause.
