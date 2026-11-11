# Phase 0 release record

| Item | Value |
| --- | --- |
| Live URL | https://aulteran.github.io/DriveLoom/ |
| Released commit | `1640b6e8c80bedd09ee484a8d907a493382e768e` (`main`) |
| Deploy run | [Actions run 42567065230](https://github.com/Aulteran/DriveLoom/actions/runs/42567065230): build, browser checks, deploy and live smoke test passed |
| Released | 2026-11-09 |
| Known-good rollback target | `8d10b71` (previous release, same site content without the indexing and metadata changes; [run 42566292455](https://github.com/Aulteran/DriveLoom/actions/runs/42566292455)) |
| Name decision | The owner accepted the DriveLoom name collision on 2026-11-11. |

## Rollback

The Pages workflow deploys the head of `main`, so a rollback is a change to `main`.

1. Revert the release commit: `git revert 1640b6e`, then push to `main` (or open a PR). The workflow rebuilds, tests and redeploys automatically.
2. To restore an exact earlier state, revert the commits after that SHA. Do not force-push `main`.
3. To take the site offline while fixing a bad build, unpublish it in the repository's Settings > Pages (owner-controlled).

After any rollback, confirm the workflow run is green and the live URL loads.
