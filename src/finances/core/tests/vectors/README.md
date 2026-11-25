# Golden test vectors

These are the exact inputs and outputs of the **TypeScript reference**
(`src/core/` of the scrubbed `finances` app, branch
`moxen/local-017-moxen-finances-into-the`, commit `8aaad15b`), captured so
the Rust port in `moxen-finances-core` must behave identically. The
integration test (`tests/vectors.rs`) deserializes each file, runs the
same function over the same input and asserts exact equality — a change
here means a behavior change, and the only way to move them is to move the
reference first, then re-generate.

Data note: every subscription, income, expense, charge and rate in these
files comes from the reference's fictional demo seed
(`buildSeedState` at the fixed instant `2026-11-18T12:00:00Z`) or from
invented fixtures around it. There is no real personal data in any vector.

## Files

| File | What it pins |
|---|---|
| `money.json` | `convertMinor` (integer rounding, negatives, half cases, invalid rates), `formatCurrency` / `formatMinor` / `formatRate` (`es-ES` Intl output, including the no-break space before `€`/`US$` and grouping from 10 000), `parseAmountToMinor`, `parseRateToScaled`. |
| `dates.json` | `daysInMonth`, leap years, `addDaysISO`/`addMonthsISO`/`addYearsISO` (month-end clamps, 29-Feb resolution), `diffDays`, validation, `startOfMonth`/`endOfMonth`, `todayMadrid` around the 2026 DST transitions, month grid, and the `es-ES` date/month/weekday formatting. |
| `recurrence.json` | `generateOccurrences` for every frequency (day 29/30/31 clamps, leap day, billing-day overrides, occurrence caps), pause intervals, `canChargeOn` (end/cancel/archive/pause, inclusive bounds) and `nextBillingDate` (override, charged dates, pauses, archive). |
| `exchange.json` | `findRateAt` (direct pair in force, inverse, latest-effective ties, approximate fallback, none) and `convertToAccountCurrency` (same currency, approximate, missing rates). |
| `projection.json` | `priceAt` (effective windows, same-date ties decided by `createdAt`), `collectEvents` (warnings, sort order), `nextBillingFor`, and 21 `projectBalance` scenarios over the seed state: real charges replacing estimates (exact date, ±7-day window, grouped charges, 0-charge cycles, unmatched charges), external payments, end/cancel dates, missing prices/rates, approximate rates, incomes (paused, actual amounts, USD), recurring expenses, first negative day, and a ten-year projection. Days are compact rows `[date, balanceMinor, incomeMinor, expenseMinor, [event ids]]`; events and warnings are complete objects. |
| `stats.json` | `totalsForEvents`/`totalsForMonth`, `distributionByCategory` (stable ordering), `monthlyEquivalentMinor`/`annualizedMinor` (all frequencies, rounding half cases), `normalizedMonthlyCost` (paused/finished excluded), `savingsFromInactive`, `subscriptionCostRanking`, `subscriptionCostEvolution`, `monthRange`. |
| `accounts.json` | LOCAL-025's multi-account specification (see below): `totalBalanceMinor` (same currency, a converted USD account, a missing rate flagged approximate), the account scope of `collectEvents` (transfers out/in as expense/income events, transfers never emitted under the all-accounts scope, rows of other accounts out of scope, a subscription belonging to its paying account, missing/approximate transfer rates) and scoped `projectBalance`. |

## Where `accounts.json` comes from

Every file above is captured from the TypeScript reference, which has **no
multi-account support**: one `account` row, one currency, and an
"paid from another account" flag. LOCAL-025 changes that, so `accounts.json`
is a **hand-written new specification**, not a reference capture. The
scenarios were derived from the issue's design (movement rows carry an
`accountId`; the account scope picks one account or all; a transfer between
two accounts is a movement of each account and never changes the total; the
all-accounts total converts through the effective-dated rates of
`exchange.json`, flagged approximate when a rate is missing), and the
expected values were computed by hand from those rules and then checked
against the implementation. The single-account guarantee is pinned by the
other files: they deserialize without any account data (the new fields all
default) and must keep passing byte for byte.

## Regenerating

The generator is not kept in this repo (it is a one-off against a private
worktree). See LOCAL-019 in Linear for how it ran: a Bun script importing
the reference modules from a checkout of the reference branch at git tip
`8aaad15b`, calling them on the fixtures of the reference's own tests
(`tests/money-dates.test.ts`, `tests/recurrence.test.ts`,
`tests/projection.test.ts`, `tests/helpers.ts`) plus the edge cases above,
and writing these JSON files back here. To regenerate after changing the
reference, reproduce that script against the new reference commit, update
the commit hash in this README, and update `tests/vectors.rs` if the
schema changed.
