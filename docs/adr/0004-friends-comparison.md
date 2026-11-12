# ADR 0004: Friends and aggregate comparison (milestone 1.5)

Status: decided during the autonomous build of 2026-11-12, for owner review.

## Decisions

- **Mutual friendship, explicit per-vehicle opt-in, aggregates only, visible window.** This is the behaviour the product specification recommends; it is implemented as written.
- **Only owners share.** A member of someone else's vehicle cannot expose it, and a friend never sees a vehicle through a mutual member.
- **Query-time grants, no cache.** Revocation is immediate because there is nothing to invalidate.
- **Vehicle description is shared.** Name, make, model and year cross with the aggregate, since a figure without knowing the car is not a comparison. Owners see this stated next to the opt-in switch.
- **One decimal for friends.** A coarser figure is enough to compare and makes it harder to reconstruct single purchases by watching the aggregate change. A friend who polls over time can still see that the aggregate moved; that is inherent in a live aggregate and accepted.
- **No minimum interval count.** A window with one complete interval still reports its economy. A ratio alone reveals neither distance nor volume.
- **Requests name a user by email and report an unknown address** (422), the same as adding a vehicle member. Any signed-in user of the instance can therefore learn whether an address has an account. Accepted because registration is closed or invite-based by default and members are people who know each other. Outstanding requests are capped at 50 per user.
- **Costs** are compared only in the viewer's currency, with no conversion, per the product rule on compatible reporting currencies.

## Not done

- Instance-wide benchmarking (out of scope for the first release).
- Blocking a user from sending further requests after a decline.
