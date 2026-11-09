# Product specification

## Phase 0 · Coming-soon website

**Audience and intent.** Drivers who want to understand fuel economy and self-hosters who want control over their vehicle data. The page should let a visitor understand the product, its status and how to follow its progress.

**Experience.** Use a premium automotive look with precise typography, an electric-blue accent and analytics-inspired graphics. Suggested order: hero with visible coming-soon status and one follow CTA, planned capabilities, open-source and self-hosted rationale, then a source link and credits. Treat light and dark presentation as design direction. Define and test the selected themes. Label any concept visual as illustrative. Use original or vetted artwork.

**Copy.** Candidate lines include “Every mile tells a story” and “Your vehicle. Your data. Your server.” Final tagline and copy are open. Refer to fill-up logging, economy, units and shared vehicles as planned features. Avoid availability, install and date claims. Recommended follow action is a live GitHub repository link. Signup and analytics are optional owner decisions with a separate privacy and provider review if selected.

## Future platform · Paused

| Area | Requirements and intended behavior |
| --- | --- |
| Accounts | Password login. Instance-admin-configurable email codes after password login when SMTP is configured. Authenticator-app TOTP, passkeys and optional OIDC. Users can enroll multiple methods and choose an eligible sign-in path. Password verification factors and primary sign-in paths have distinct roles. |
| Vehicles | Multi-user shared vehicles with permissioned access, fuel and odometer history, vehicle images and analytics. Vehicle membership and friend comparison access are separate. |
| Measurement | Miles and kilometers, liters and gallons, explicit unit selection at entry and account-wide display preferences for viewing and comparing. Keep the physical odometer unit separate. Handle rounding, backdated records, invalid odometer readings and partial-fill boundaries. |
| Comparisons | Users on the same instance can compare their vehicles’ efficiency in the viewer’s chosen units. Recommended behavior is mutual friendship and explicit opt-in per vehicle, aggregate-only exposure and visible time window. |
| Portability | Vehicle-level export and import across instances, including CSV. JSON is a candidate companion format. Instance administrators can back up and restore the complete instance, including stored images and data. Built-in backup encryption is deferred. |
| Hosting | Self-hosted and trusted reverse-proxy compatible, with Nginx Proxy Manager as a documented example. External TLS terminates at the operator's proxy. Cloudflare Tunnel is outside the bundled deployment scope. |
| Clients and license | Web first with PWA capability as planned direction. Native Android and iPhone clients later in separate repositories and able to connect to the user's chosen server. Main platform AGPL-3.0-only. Mobile framework, store distribution and mobile licenses are future decisions. |

**Proposed rules for future confirmation.** One owner per active vehicle, explicit transfer and audited administrator recovery. Invite-first registration and optional public registration. For comparisons, share aggregates only and revoke access immediately on opt-out. Use one reporting currency per vehicle and preserve source currency and amount. Require an explicit rate or reporting equivalent for foreign purchases. Compare costs only in compatible reporting currencies and periods. Keep currency feeds, maintenance tracking and instance-wide benchmarking outside the first release.
