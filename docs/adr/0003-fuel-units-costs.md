# ADR 0003: Fuel, units and costs (milestone 1.4)

Status: decided during the autonomous build of 2026-11-12, for owner review.

## Decisions

- **Decimal arithmetic without a dependency.** `src/decimal.ts` is an exact rational over `bigint` (about 70 lines). Inputs are decimal strings, PostgreSQL columns are `numeric`, and rounding happens once at display, half away from zero. A decimal library was not needed for add, multiply, divide and compare.
- **Entered values are kept verbatim.** `odometer_input` and `volume_input` are unconstrained `numeric`, which keeps the entered scale ("45.00" stays "45.00"), beside the unit. Limits: three decimals for odometer and volume, four for money, ten for an exchange rate.
- **The physical odometer unit belongs to the vehicle.** Entries may still use either unit; readings are displayed in the vehicle's unit so they match the dashboard. Distance, volume and economy follow the viewer's preferences.
- **Chronology is time first.** Records order by time, then odometer. Rejecting a reading that contradicts its neighbours catches typos at entry instead of producing negative distances later.
- **Duplicates** are defined narrowly (same vehicle, instant and odometer) and enforced by a unique constraint, so concurrent submissions cannot both succeed.
- **Missed purchases are explicit.** `missedPrevious` voids only the interval it falls in. Nothing is estimated.
- **Derived values are not stored.** A vehicle has at most a few thousand purchases, so intervals are recomputed per read. This removes a whole class of stale-cache bugs after edits. Revisit if a vehicle's history ever makes this slow.
- **Currency.** One reporting currency per vehicle, ISO 4217 codes validated against the runtime's list. Foreign purchases need an explicit rate or reporting amount. When only a rate is given, the reporting amount is rounded to the reporting currency's minor units when derived. No exchange-rate feed.
- **Reporting currency is locked once costs exist.** Changing it needs an explicit migration policy, which is deferred.
- **Concurrency.** Every write takes the vehicle row lock already used by membership changes, so fuel writes, transfers and archiving serialise per vehicle.

## Not done

- Per-fill fuel grade, station, or tank capacity.
- Trip or maintenance tracking (out of scope for the first release).
- Editing the reporting currency after costs exist.
