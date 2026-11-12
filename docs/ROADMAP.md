# Milestones and acceptance

Phase 0 is complete (2026-11-11). On 2026-11-12 the owner restarted the platform and had milestones 1.1 to 2.2 built in one autonomous run; they await owner review and a security review. Evidence against each criterion is in [verification](VERIFICATION.md#platform-evidence-autonomous-build-2026-11-12). Phase 3 (native clients) has not started. Criteria describe planning targets and assume review of the proposed defaults.

| ID | Deliverable | Acceptance evidence |
| --- | --- | --- |
| 0.1 | Scope, name, identity and copy | Owner records a publish/rename decision and public destination. Proposed copy and visual direction reviewed, including coming-soon language, CTA and asset rights. A neutral, private review may proceed while brand approval is pending. |
| 0.2 | Standalone build baseline | Fresh install and build succeed using the pinned toolchain from `apps/marketing`. Output is self-contained and renders from the project-site prefix. The rest of the platform is unnecessary for local preview or build. |
| 0.3 | Landing page | Hero, planned capabilities, self-hosted/open-source explanation and working follow link render on mobile and desktop. Status and CTA are clear. Accessibility, metadata, asset provenance and concept labels pass review. |
| 0.4 | Pages workflow and PR checks | PRs build and test without deploy rights. Default-branch release uploads only static output and uses the configured protected Pages environment. Workflow and prefix checks pass in GitHub Actions. |
| 0.5 | Launch and close | Owner approves public exposure and launch. Live HTTPS URL, prefixed assets, CTA, canonical/share metadata and network requests pass smoke checks. Release SHA and rollback path are recorded. Close Phase 0 and park the platform. |
| 1.1 | Contracts and persistence | Reviewed schema and versioned OpenAPI skeleton. Repeatable local bring-up and migration from empty plus a prior snapshot. Compatibility policy, decimal rules and test data documented. |
| 1.2 | Auth and recovery | Password plus optional admin SMTP verification, TOTP, multiple passkeys and optional OIDC coexist according to instance policy. Account enumeration, credential removal, recovery, OTP replay, OIDC linking and session revocation pass negative tests. |
| 1.3 | Vehicles and ownership | Members can act only within grants. Owner succession and admin recovery use the approved policy. Concurrent mutations preserve owner invariants and audit evidence. |
| 1.4 | Fuel, units and costs | Backdates, odometer validation, corrections, partial fills, duplicate records and unit round-trips pass fixtures. Comparison/display conversions leave originals intact. Approved currency policy and invalid interval behavior are covered. |
| 1.5 | Friends and aggregate comparison | Approved sharing flow supports opt-in, revocation and same-window comparisons. Unauthorized users cannot infer private logs or query other vehicles. Viewer units and currency guards pass. |
| 1.6 | Portability and deployment | Cross-instance CSV round trip and preview work. Full restore into an isolated instance preserves expected state and images. Upgrade, failed restore, CLI recovery and trusted proxy behavior are exercised. API contracts and authorization checks are green before Phase 2. |
| 2.1 | Cohesive web design and workflows | One Opus-led design system and UX implementation covers onboarding/sign-in, vehicles and memberships, fill-up log and analytics, preferences, friends, and portability/admin flows. Screens have responsive, loading, empty and error states. |
| 2.2 | End-to-end integration and release | Web/PWA behavior approved and tested against the real API. Offline semantics reviewed before caching or offline writes. Self-host deployment verified with documented reverse proxy, restore drill and accessible end-to-end flows. |
| 3.1 | Android client | Separate repo and owner-approved native stack/license. Supported server versions, user-specified server, secure sign-in/storage, core fuel flow and Android distribution test build pass. |
| 3.2 | iPhone client | Separate repo and owner-approved native stack/license. Supported server versions, user-specified server, secure sign-in/storage, core fuel flow and iOS distribution test build pass. |

Phases 1 and 2 release sequencing and dependency versions are reassessed when the platform restarts. Android and iOS may proceed independently after the supported API and native authentication contract are stable.
