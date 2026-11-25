# Moxen Finances

A local-first personal finance app: subscriptions, balance forecasts, budgets and, later, bank sync
through the user's own Enable Banking account. One Rust workspace, built once and shipped two ways:
a standalone app, and later a module bundled in `src/desktop`. It needs no Moxen Agent, no server and
no other Moxen product.

| Crate | What it holds |
|---|---|
| `core` | Pure domain logic (money in minor units, dates, recurrences, projections, statistics, exchange). No UI, no I/O. |
| `store` | SQLite, the repository, CSV and JSON backup, the demo seed. |
| `banking` | A read-only Enable Banking client: the user's own application and key, the key in the OS keychain, banks, balances and transactions. No payments, no store writes. |
| `ui` | GPUI views and the Moxen design tokens, shared by the app and the desktop. Reads through the `FinancesData` trait and writes through the plain-DTO `FinancesMutations` trait; it never links SQLite, so the desktop can bundle it. |
| `app` | The standalone app (`moxen-finances`). Its `StoreData` wires `store` + `core` behind both traits (LOCAL-030); `MOXEN_FINANCES_DEMO=1` swaps in the fictional `DemoData` for tests and the render harness. |
| `mcp` | An optional read-only MCP server over the same data, for any harness. |

The store keeps the database at `<platform data dir>/Moxen/Finances/finances.db` (the platform data
folder, so never a hardcoded home), which `MOXEN_FINANCES_DB` overrides and an explicit path bypasses.
The app opens it with `Store::initialize`, so a brand-new file gets the fictional demo seed and an
existing one is never reseeded. The window reads one account scope at a time — one account, or "all
accounts" converted to the first account's currency (flagged approximate when an exchange rate is
missing) — and every UI action (create/edit/pause/resume/cancel/delete subscriptions, add/confirm/edit/
delete movements, account management, transfers, JSON backup and CSV export) goes through
`FinancesMutations`, refreshing the view on success and showing a localized banner on failure.
Its schema grew out of the TypeScript reference's: version 1 was that schema, table for table, and
version 2 (LOCAL-025) adds several accounts and transfers. **Version 2 is one-way: the reference no
longer opens a database this build migrates or creates** — before migrating a file, the store copies
it to `<name>.pre-v2.bak` next to it and refuses to migrate if the copy fails (see `store/README.md`).
A new file gets the fictional demo seed, an existing one never does.

Rules: the repository is public, so no real personal data goes in it (demo data only, `data/` and `*.db`
are ignored). Nothing under `src/` in TypeScript imports this. `src/desktop` is not touched until the
bundling refactor is approved. Checks: `cargo fmt --check && cargo clippy && cargo test` in this folder.
