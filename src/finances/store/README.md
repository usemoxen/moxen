# Moxen Finances store

SQLite persistence for Moxen Finances: the schema and the migration runner,
the repository, CSV and JSON backup, and the fictional demo seed. See
`../README.md` for the workspace.

## Schema versions and the one-way step

| Version | What it is |
|---|---|
| 1 | The TypeScript reference's schema (`src/server/db.ts` at 8aaad15b), statement for statement. A database the reference created records no version and migrates here as a no-op. |
| 2 | LOCAL-025's several accounts: an `accounts` table (id, name, kind — checking, savings, credit card or cash —, currency, balance, opening balance, archived flag, sort order, notes), `account_id` columns on `subscriptions`, `incomes`, `expenses` and `subscription_charges`, and a `transfers` table for movements of money between two accounts. The single `account` row of version 1 becomes the first account, keeping its balance, opening balance and date; every existing row moves onto it. |

**Schema 2 is one-way.** The TypeScript reference has no `accounts` table and
no version check: it cannot open a database this build migrated or created,
and that is accepted (LOCAL-025). A database from a *newer* build is refused
before anything is written, which the reference could not do.

## The migration and its backup

Before migrating a database file to version 2, the runner copies the whole
file to `<name>.pre-v2.bak` next to it (SQLite's own backup API, so the
content of the WAL comes along), and **refuses to migrate when the copy
fails**. The migration itself then runs in a single transaction: `accounts`
is created and the first account inserted from the old `account` row, the
movement tables gain their `account_id` columns (every existing row set to
the first account), `transfers` is created, and only then `PRAGMA user_version`
records 2. A failure anywhere rolls everything back to exactly the schema the
file had. The backup is the schema-1 state of the file — for a database that
already recorded version 1 that is the file untouched, for a reference-created
one it is the same data with the version number set to 1 — and either way it
is a database the TypeScript app can still open and read.

## Accounts, scopes and transfers

- Every movement row names its account. A row created without one lands on the
  first account (what a single-account user has); an unknown account id is an
  error, never a silent reassignment.
- The repository offers the account operations: create, rename, archive,
  reorder, and delete — which is refused while the account still has
  movements, because archiving is the way to retire an account without losing
  its history.
- Read paths take an account scope: `app_state` (everything), `account_state`
  (one account's rows), and the total across accounts
  (`total_state`/`total_projection`), whose balances are converted to one
  currency with the effective-dated exchange rates, flagged approximate when a
  rate is missing. A transfer between two accounts is a movement of each
  account — outgoing, incoming — and never changes the total.
- CSV sheets carry the account of every row in a trailing `cuenta` column;
  files the reference exported (without it) import onto the first account.
- The JSON backup is at version 2 and carries `accounts` and `transfers`. A
  backup made at version 1 still restores into a schema 2 database **as the
  first account**: its single `account` becomes the one account, and its rows,
  which declare none, land on it.

## Testing

No test ever touches a real database: every test uses its own temporary folder
or the committed fictional fixtures under `tests/fixtures` (see their README),
which the reference itself produced.
