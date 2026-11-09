# Private · Branches and handoffs

Each row is a work order boundary. Branch names are suggested. If Projects assigns a branch, record the actual name against the ID. Each code lane opens one scoped PR against the default branch. Align file ownership with the actual tree before dispatch.

| ID | Suggested branch or action | Owns | Depends on |
| --- | --- | --- | --- |
| 0.1 | Private decision task | Naming report, copy choices, CTA, rights evidence and release approval. No code branch required. | Can run alongside the private baseline. |
| 0.2 | `phase0/marketing-baseline` | Build config, lockfile, developer commands and neutral site shell. | Owner selects staging repo. Merge before branching 0.3 and 0.4. |
| 0.3 | `phase0/marketing-landing` | Landing source, styling, assets, content and provenance. Keeps to frozen baseline commands and artifact path. | 0.2 merged. Use swappable private branding until 0.1 clears. |
| 0.4 | `phase0/marketing-ci-pages` | Workflows and smoke harness under `apps/marketing/tests/`. Uses stable checks against landing shell or build output. | 0.2 merged. Runs in parallel with 0.3. Owner gates deployment. |
| 0.5 | Owner release action, `phase0/marketing-release` only if changes are needed | Final approved URL, integrated verification and release record. | 0.1 cleared and 0.3/0.4 merged. |

If the landing lane needs a build contract change, resolve it in the baseline before the parallel lanes proceed. Keep selectors in the smoke harness focused on the agreed semantic page landmarks. Once both lanes merge, rerun full checks from the current default branch and record production smoke separately.

## Future work opportunities · parked

After explicit Phase 1 restart, establish OpenAPI, common identifiers, migration ownership and test infrastructure in 1.1. Then Sonnet can work on `phase1/auth` and `phase1/vehicles` independently with agreed user identity and authorization interfaces. Isolate decimal/unit fixtures for `phase1/fuel-units`, then integrate fuel persistence after the vehicle contract. Portability planning can run alongside these lanes, with implementation gated on stable schema and image storage. Friend comparisons depend on membership and metrics. Use one integration owner for overlapping migrations, generated contracts and permission policies. After the API is stable, reserve the web UX for the single Opus-led Phase 2 stream. Once native auth and API compatibility are stable and Phase 3 is approved, Android and iOS can use separate repositories, branches and PRs concurrently.

## Pull request evidence

Use a PR summary with milestone ID, base and head SHA, owned paths, acceptance criteria and outcomes, exact commands or CI run links, any known failures, screenshots if relevant and release/rollback impact. Keep discussion of private naming or internal prompts in the coordinator checkpoint.
