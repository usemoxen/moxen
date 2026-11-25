# Compatibility fixtures

Every file here was produced by running the **scrubbed TypeScript reference**
itself — the app at `moxen/local-017-moxen-finances-into-the`, tip `8aaad15b` —
against a throwaway database, never by hand and never with real data. They hold
only the reference's FICTIONAL demo seed (`src/core/seed.ts`), so nothing in
this folder belongs to anybody.

They exist so `tests/reference.rs` can prove, instead of assume, that the Rust
store reads and writes the same format:

| File | Made with (in the reference) | Used to check |
|---|---|---|
| `reference.sql` | `initializeDatabase(path)` then `sqlite3 <db> .dump` | a database the reference created opens here unchanged (schema, `user_version = 0`, every row), and the repository reads exactly `reference-state.json` |
| `reference-state.json` | `JSON.stringify(getAppState(db))` | the whole state the reference reads, row for row |
| `reference-backup.json` | `JSON.stringify(exportAll(db))` | the JSON backup restores here |
| `reference-subscriptions.csv` | `exportCsv(db, state, 'subscriptions', '2026-01-01', '2026-12-31')` | the export is byte for byte the reference's |
| `reference-movements.csv` | `exportCsv(db, state, 'movements', '2026-11-01', '2026-12-31')` | the projection sheet (amounts converted, real charges, statuses) |

## Regenerating

The generator is a one-off script that stays outside the repository:

```ts
// generate.ts — run with bun, from anywhere
const referenceRoot = '<path to the scrubbed reference checkout>';
const dbPath = '<a path in a fresh temp folder>/reference.db';
const { initializeDatabase } = await import(`${referenceRoot}/src/server/db.ts`);
const { exportAll, getAppState } = await import(`${referenceRoot}/src/server/repo.ts`);
const { exportCsv } = await import(`${referenceRoot}/src/server/export.ts`);

const db = initializeDatabase(dbPath);
const state = getAppState(db);
writeFileSync('reference-state.json', JSON.stringify(state));
writeFileSync('reference-backup.json', JSON.stringify(exportAll(db)));
writeFileSync('reference-subscriptions.csv', exportCsv(db, state, 'subscriptions', '2026-01-01', '2026-12-31'));
writeFileSync('reference-movements.csv', exportCsv(db, state, 'movements', '2026-11-01', '2026-12-31'));
db.close();
```

then `sqlite3 <that db> .dump > reference.sql`.

Two adjustments made afterwards, and only these:

- The two CSVs were written by the reference with `\r\n` line endings; they are
  stored here with `\n` so no git setting (Windows checkouts default to
  `core.autocrlf=true`) can rewrite them. The tests compare line endings
  normalized, and check the `\r\n` and the BOM against the export directly.
- Nothing else. The rows, the ids, the amounts and the dates are the
  reference's.
