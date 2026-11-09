# Verification and release

## Phase 0 checks

| Check | Method and pass condition |
| --- | --- |
| Build and isolation | On a clean Linux runner, use the Node version in the marketing .nvmrc and build from `apps/marketing`, and inspect the uploaded artifact. Only public output is present. Scan for unresolved template variables, secrets and internal notes. |
| Project Pages URL | Serve under a simulated `/<repo>/` prefix as well as root. Visit the landing page directly and reload. Assert successful document, CSS, images, icons, manifest if present and all internal links. Use CI browser smoke testing against the artifact. |
| UX | Review at approximately 360, 768 and 1440 CSS px. Confirm readable hero, usable navigation and no horizontal scroll. Check one mobile browser and one desktop browser. Capture screenshots as PR evidence. |
| Accessibility | Use automated accessibility checks for the landing page, plus manual keyboard traversal, focus visibility, heading order, meaningful alt text, contrast, zoom and reduced-motion behavior where applicable. Target WCAG 2.2 AA as a proposed implementation standard. |
| Status, discovery and rights | Verify the coming-soon statement, approved copy, CTA destination, title, description, canonical URL, social image and robots/sitemap policy. Ensure all bundled assets have a provenance row. Verify the public site only makes approved third-party requests. |
| Release and rollback | Confirm PR events cannot deploy. From a reviewed commit, verify Pages environment and permissions, green build/deploy, artifact SHA association, HTTPS and live smoke checks. Record the URL, commit, run and evidence. If smoke fails, revert the release commit and redeploy the last known-good state through the same workflow. For an initial bad publish, remove public exposure using owner-controlled Pages settings while fixing the build. |

Before the approved first publish, keep the site in access-controlled staging or use private CI artifacts. Avoid relying on robots or noindex to protect previews.

## Future test matrix

- Unit fixtures cover exact decimal conversions, both gallon types, expense rounding and boundary examples. A candidate full-to-full fixture uses 500 km, 20 L partial plus 30 L closing, giving 10 L/100 km. Exclude the starting fill. Assert incomplete intervals are unavailable and a backdate repairs the neighboring intervals. Test invalid readings, duplicate timestamps and concurrent updates.
- Integration tests exercise the real database for membership roles, ownership transfer, account removal, migration/rollback policy and concurrent mutations. Use separate actors to test cross-account and cross-vehicle access. Check friend opt-in and revocation, aggregate-only API responses and mismatched currency behavior.
- Auth tests cover SMTP misconfiguration, expired or reused codes, TOTP replay, login enumeration, passkey origin/RP binding, OIDC state/nonce/linking, last-credential removal, rate limits and session invalidation. Test a spoofed forwarding header from an untrusted peer.
- Portability tests cover malformed/oversized imports, duplicate files, dry-run without writes, CSV spreadsheet formula injection on export, and cross-instance round trips. Restore a verified backup into a disposable instance, compare expected users/vehicles/images, and exercise invalid archive, unsupported version and failure recovery paths.
- Contract and end-to-end tests verify documented API shapes and authorization errors. Exercise the major web journeys and a Compose deployment behind the trusted HTTPS proxy. Native phases test real sign-in, OS secure storage, connectivity failures and supported server versions.

[WCAG 2.2](https://www.w3.org/TR/WCAG22/)
