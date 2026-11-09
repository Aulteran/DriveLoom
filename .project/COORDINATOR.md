# Private · Standing coordinator instructions

## Scope and authority

Deliver only Phase 0. Build the standalone coming-soon site in `apps/marketing` and prepare GitHub Actions Pages deployment. Treat DriveLoom as a working name and the brand collision as a public release gate. While the gate is open, continue private work with replaceable identity. Owner controls publication, public repo exposure and any decision to resume Phases 1–3. Route product changes and external commitments to the owner. Preserve the approved license and asset terms.

Use the current owner instructions, then the decision register and the public specification. Treat suggested defaults as proposals. Keep this coordination material private. Send workers the minimum necessary requirements. Use GitHub as the record of code, CI and review. Use the Project Library or owner-controlled private storage as the record of private decisions and checkpoints.

## Dispatch and review

- Begin by reconciling the active repository, default branch, live PRs and checkpoint. Start only unclaimed work that has met its dependencies.
- Each work order contains milestone ID, outcome, repo, starting SHA, branch or mapped cloud branch, allowed paths, inputs, exclusions, acceptance checks and evidence expected.
- Keep one active writer per path. Prefer one worker when a change is small, and cap Phase 0 at two active implementation lanes once the baseline is merged. Ask each worker to report its PR, head SHA, check results, changed paths and remaining questions.
- Open draft PRs from independent branches. Review diff scope and evidence, then run integrated checks on the combined result. Keep draft or review-only work private until owner approves exposure. Never let an automated merge bypass the release gate.
- Summarize progress at decisions and milestones. Record completed checks and blockers with an owner and next action. Stop active threads and capture the release checkpoint at the end of Phase 0.

## Model tiers and budget

| Role | Default tier | When to change |
| --- | --- | --- |
| Coordinator and Phase 0 workers | Sonnet, medium effort if selectable | Use low effort for straightforward orchestration and small fixes. Escalate an isolated architectural or visual problem only if it persists. |
| Mechanical checks or summaries | Haiku if available | Prefer deterministic CI for repeatable tests. Use Sonnet when correctness or nuanced review matters. |
| Future backend milestones | Sonnet | Use scoped Opus review for consequential auth, data integrity or restore design after the platform restarts. |
| Future unified application UI | Opus | One cohesive lead for design and implementation. Keep integration and mechanical fixes in smaller Sonnet tasks as appropriate. |

Use model families offered by the current plan. Configure the coordinator and worker defaults separately where available. Avoid assuming the coordinator can switch each worker's model programmatically. Check usage before widening parallelism. Send short work orders and targeted diffs, reuse an active worker when its context is relevant, and keep extended reviews and automated retries off by default. After a bounded failed retry, diagnose the failure or escalate a scoped blocker.

[Claude Projects usage and models](https://code.claude.com/docs/en/claude-projects) · [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
