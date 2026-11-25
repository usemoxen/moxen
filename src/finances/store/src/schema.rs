//! The schema and a forward-only migration runner.
//!
//! ## Versions
//!
//! - **Version 1** is the TypeScript reference's schema (8aaad15b), copied
//!   statement for statement, so a database the reference created — which
//!   records no version at all — migrates to `user_version = 1` as a no-op.
//! - **Version 2** (LOCAL-025) adds several accounts: an `accounts` table,
//!   `account_id` columns on the movement tables, and a `transfers` table.
//!   The single `account` row becomes the first account, keeping its
//!   balance, its opening balance and its date.
//!
//! ### Schema 2 is one-way
//!
//! The TypeScript reference does not know the `accounts` table and cannot
//! read schema 2; that is accepted (see the crate's README). Before migrating
//! a database file, migration 2 copies the whole file to `<name>.pre-v2.bak`
//! next to it, and refuses to migrate when the copy fails, so the
//! pre-migration state always survives somewhere.
//!
//! `PRAGMA user_version` rather than a version table keeps version 1's table
//! list exactly the reference's, and version 2 has nowhere to go but
//! forward: a database from a *newer* build is refused before anything is
//! written, which the reference could not do.

use std::path::Path;

use rusqlite::Connection;

use crate::error::{Result, StoreError};

/// The schema this build writes and the newest it can open.
pub const SCHEMA_VERSION: i64 = 2;

/// Version 1: the reference's schema, copied statement for statement
/// (statement text included, so `sqlite_master` matches a database the
/// reference created). The `PRAGMA journal_mode` / `PRAGMA foreign_keys`
/// lines the reference puts in the same string are set on open instead — see
/// [`crate::Store::open`].
pub const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  balance_minor INTEGER NOT NULL DEFAULT 0,
  balance_date TEXT NOT NULL,
  balance_set INTEGER NOT NULL DEFAULT 0,
  opening_balance_minor INTEGER NOT NULL DEFAULT 0,
  opening_balance_date TEXT,
  opening_balance_set INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'EUR',
  price_minor INTEGER,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  start_date TEXT,
  billing_day INTEGER,
  next_billing_override TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  cancelled_at TEXT,
  plan TEXT,
  notes TEXT NOT NULL DEFAULT '',
  external_payment INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_prices (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_billing_days (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  billing_day INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_pauses (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_status_history (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incomes (
  id TEXT PRIMARY KEY,
  concept TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  date TEXT NOT NULL,
  time TEXT,
  frequency TEXT NOT NULL DEFAULT 'once',
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'expected',
  paused INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  actual_amount_minor INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  concept TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Otros',
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  date TEXT NOT NULL,
  time TEXT,
  frequency TEXT NOT NULL DEFAULT 'once',
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  notes TEXT NOT NULL DEFAULT '',
  actual_amount_minor INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_charges (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  charge_date TEXT NOT NULL,
  time TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  rate_scaled INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id TEXT PRIMARY KEY,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate_scaled INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prices_sub ON subscription_prices(subscription_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_pauses_sub ON subscription_pauses(subscription_id, start_date);
CREATE INDEX IF NOT EXISTS idx_billing_days_sub ON subscription_billing_days(subscription_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_status_sub ON subscription_status_history(subscription_id, date);
CREATE INDEX IF NOT EXISTS idx_incomes_date ON incomes(date);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_rates_pair ON exchange_rates(from_currency, to_currency, effective_from);
CREATE INDEX IF NOT EXISTS idx_charges_sub ON subscription_charges(subscription_id, charge_date);
"#;

/// Version 2 (LOCAL-025): several accounts. The old `account` table, its row
/// copied into `accounts` as the first account, is dropped; every movement
/// table gains `account_id`, defaulting to that first account; `transfers`
/// holds the movements of money between two accounts. The TypeScript
/// reference cannot open a version 2 database (see the module's docs).
pub const SCHEMA_V2: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'checking',
  currency TEXT NOT NULL DEFAULT 'EUR',
  balance_minor INTEGER NOT NULL DEFAULT 0,
  balance_date TEXT NOT NULL,
  balance_set INTEGER NOT NULL DEFAULT 0,
  opening_balance_minor INTEGER NOT NULL DEFAULT 0,
  opening_balance_date TEXT,
  opening_balance_set INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  from_account_id TEXT NOT NULL DEFAULT '',
  to_account_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transfers_date ON transfers(date);
"#;

/// The columns `openDatabase` adds to databases created before they existed
/// (`ensureColumn` in the reference), with the same definitions.
const ADDED_COLUMNS: [(&str, &str, &str); 7] = [
    (
        "account",
        "opening_balance_minor",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    ("account", "opening_balance_date", "TEXT"),
    (
        "account",
        "opening_balance_set",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    ("incomes", "time", "TEXT"),
    ("expenses", "time", "TEXT"),
    ("subscription_charges", "time", "TEXT"),
    (
        "subscriptions",
        "external_payment",
        "INTEGER NOT NULL DEFAULT 0",
    ),
];

/// Version 1 also re-adds the columns the reference adds on open, so a very
/// old database (of a build from before `opening_balance_*`) is completed the
/// same way instead of failing to read.
fn migration_1(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA_V1)?;
    for (table, column, definition) in ADDED_COLUMNS {
        ensure_column(conn, table, column, definition)?;
    }
    Ok(())
}

/// The `.pre-v2.bak` copy of the database file, made **before** the
/// transaction starts changing anything: if it fails, the migration is
/// refused (see [`Migration::prepare`]). SQLite's own backup API makes the
/// copy, so the WAL content and a consistent page snapshot come with it.
pub fn backup_before_migration(conn: &Connection, path: &Path) -> Result<std::path::PathBuf> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "finances.db".to_string());
    let backup_path = path.with_file_name(format!("{name}.pre-v2.bak"));
    let copy = |source: std::io::Error| StoreError::MigrationBackup {
        from: path.to_path_buf(),
        to: backup_path.clone(),
        source,
    };
    let mut destination =
        Connection::open(&backup_path).map_err(|error| copy(std::io::Error::other(error)))?;
    let backup = rusqlite::backup::Backup::new(conn, &mut destination)
        .map_err(|error| copy(std::io::Error::other(error)))?;
    backup
        .run_to_completion(64, std::time::Duration::ZERO, None)
        .map_err(|error| copy(std::io::Error::other(error)))?;
    Ok(backup_path)
}

fn prepare_v2_file_backup(conn: &Connection, path: &Path) -> Result<()> {
    backup_before_migration(conn, path)?;
    Ok(())
}

/// Version 2, all of it in the one transaction the runner provides: the
/// `accounts` and `transfers` tables, the `account_id` columns of the
/// movement tables, every existing row moved onto the first account, and
/// the old single `account` row copied over and its table dropped. A failure
/// anywhere rolls the database back to version 1 exactly as it was.
fn migration_2(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA_V2)?;
    // The first account keeps the old row's balance, opening balance, date
    // and notes; its kind defaults to checking (the reference had no kind),
    // it is not archived and it sorts first.
    conn.execute_batch(
        "INSERT INTO accounts (id, name, kind, currency, balance_minor, balance_date, balance_set,
                               opening_balance_minor, opening_balance_date, opening_balance_set,
                               archived, sort_order, notes)
         SELECT COALESCE(NULLIF(id, ''), 'account-primary'),
                COALESCE(NULLIF(name, ''), 'Cuenta principal'),
                'checking',
                COALESCE(NULLIF(currency, ''), 'EUR'),
                COALESCE(balance_minor, 0),
                COALESCE(NULLIF(balance_date, ''), '1970-01-01'),
                COALESCE(balance_set, 0),
                COALESCE(opening_balance_minor, 0),
                opening_balance_date,
                COALESCE(opening_balance_set, 0),
                0, 0,
                COALESCE(notes, '')
         FROM account;",
    )?;
    // The `account_id` columns, defaulting every existing row to the first
    // account. `COALESCE` keeps a database whose account table was empty
    // (and so has no first account) migratable: its rows keep `''`.
    for table in [
        "subscriptions",
        "incomes",
        "expenses",
        "subscription_charges",
    ] {
        ensure_column(conn, table, "account_id", "TEXT NOT NULL DEFAULT ''")?;
        conn.execute_batch(&format!(
            "UPDATE {table} SET account_id = COALESCE(
               (SELECT id FROM accounts ORDER BY sort_order ASC, rowid ASC LIMIT 1), '')"
        ))?;
    }
    // The reference's single-account table ends here: its row lives on as the
    // first account, and nothing else reads it.
    conn.execute_batch("DROP TABLE account;")?;
    Ok(())
}

/// `ensureColumn` of the reference: adds the column only when
/// `PRAGMA table_info` does not list it, so it is safe to run on every open.
fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    if table_has_column(conn, table, column)? {
        return Ok(());
    }
    // The identifiers come from this module's constants, never from input.
    conn.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {definition}"
    ))?;
    Ok(())
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    // `PRAGMA table_info(t)` cannot be parameterised; the table name is one of
    // this module's constants.
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        if crate::row::text(row, "name", "") == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// One forward migration: the version it produces, how to get there, and an
/// optional step that runs on the *file* before the migration's transaction
/// begins. A `prepare` step is where a migration copies the database file —
/// it must not run inside the transaction the copy is meant to protect, and
/// a failing `prepare` refuses the migration before anything is written.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub apply: fn(&Connection) -> Result<()>,
    /// The step before the transaction, with the database's file path. It is
    /// skipped for an in-memory database (there is no file to copy), and a
    /// failure refuses the migration.
    pub prepare: Option<fn(&Connection, &Path) -> Result<()>>,
}

/// Every migration this build carries, oldest first.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        apply: migration_1,
        prepare: None,
    },
    Migration {
        version: 2,
        apply: migration_2,
        prepare: Some(prepare_v2_file_backup),
    },
];

/// The schema version the database records, `0` when it records none (which
/// is what the reference leaves behind).
pub fn schema_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

/// Bring the database up to [`SCHEMA_VERSION`], one transaction per
/// migration: a migration that fails leaves `user_version` and the tables
/// exactly as they were, and a `prepare` step that fails refuses the
/// migration before anything is written.
///
/// Refuses a database whose recorded version is newer than this build, before
/// writing anything.
///
/// `path` is the database's file, used by the `prepare` steps; `None` means
/// an in-memory database, which has no file to copy.
pub fn migrate(conn: &Connection, path: Option<&Path>) -> Result<i64> {
    migrate_with(conn, MIGRATIONS, SCHEMA_VERSION, path)
}

/// [`migrate`] with an explicit list, so a test can hand it a migration that
/// fails halfway and check the rollback.
pub fn migrate_with(
    conn: &Connection,
    migrations: &[Migration],
    supported: i64,
    path: Option<&Path>,
) -> Result<i64> {
    let mut version = schema_version(conn)?;
    if version > supported {
        return Err(StoreError::NewerSchema {
            found: version,
            supported,
        });
    }
    for migration in migrations {
        if migration.version <= version {
            continue;
        }
        if migration.version > supported {
            return Err(StoreError::NewerSchema {
                found: migration.version,
                supported,
            });
        }
        // The step before the transaction: the schema-2 file backup, without
        // which the migration refuses to run. An in-memory database has no
        // file, so there is nothing to copy (and nothing to lose).
        if let (Some(prepare), Some(path)) = (migration.prepare, path) {
            prepare(conn, path)?;
        }
        // The connection takes its write lock up front (`BEGIN IMMEDIATE`,
        // set in `Store::open`), so two processes cannot migrate the same
        // file at once.
        let transaction = conn.unchecked_transaction()?;
        (migration.apply)(&transaction)?;
        // `PRAGMA user_version` takes no bind parameters; the value is this
        // module's own constant.
        transaction.execute_batch(&format!("PRAGMA user_version = {}", migration.version))?;
        transaction.commit()?;
        version = migration.version;
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        conn
    }

    #[test]
    fn a_fresh_database_reaches_the_current_version_and_has_every_table() {
        let conn = connection();
        assert_eq!(schema_version(&conn).unwrap(), 0);
        assert_eq!(migrate(&conn, None).unwrap(), SCHEMA_VERSION);
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);

        let mut statement = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap();
        let tables: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(std::result::Result::unwrap)
            .collect();
        assert_eq!(
            tables,
            vec![
                "accounts",
                "audit_log",
                "exchange_rates",
                "expenses",
                "incomes",
                "settings",
                "subscription_billing_days",
                "subscription_charges",
                "subscription_pauses",
                "subscription_plans",
                "subscription_prices",
                "subscription_status_history",
                "subscriptions",
                "transfers",
            ]
        );
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let conn = connection();
        migrate(&conn, None).unwrap();
        let first: Vec<String> = schema_rows(&conn);
        assert_eq!(migrate(&conn, None).unwrap(), SCHEMA_VERSION);
        assert_eq!(schema_rows(&conn), first);
    }

    #[test]
    fn a_newer_database_is_refused_before_anything_is_written() {
        let conn = connection();
        conn.execute_batch("PRAGMA user_version = 7").unwrap();
        let error = migrate(&conn, None).unwrap_err();
        assert!(matches!(
            error,
            StoreError::NewerSchema {
                found: 7,
                supported: SCHEMA_VERSION
            }
        ));
        assert_eq!(schema_rows(&conn), Vec::<String>::new());
        assert_eq!(schema_version(&conn).unwrap(), 7);
    }

    #[test]
    fn a_failing_migration_rolls_back_with_its_version() {
        fn broken(conn: &Connection) -> Result<()> {
            conn.execute_batch("CREATE TABLE half_done (id TEXT PRIMARY KEY);")?;
            // The second statement fails: `nope` is not SQL.
            conn.execute_batch("TSQL nope")?;
            Ok(())
        }

        let conn = connection();
        migrate(&conn, None).unwrap();
        let before = schema_rows(&conn);
        let migrations = [
            MIGRATIONS[0],
            Migration {
                version: 3,
                apply: broken,
                prepare: None,
            },
        ];
        let error = migrate_with(&conn, &migrations, 3, None).unwrap_err();
        assert!(matches!(error, StoreError::Database(_)), "{error:?}");
        // Neither the table nor the version survived the failure.
        assert_eq!(schema_rows(&conn), before);
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
    }

    /// Version 1 of a small database, ready to migrate to 2.
    fn version_1(conn: &Connection) {
        conn.execute_batch(SCHEMA_V1).unwrap();
        for (table, column, definition) in ADDED_COLUMNS {
            ensure_column(conn, table, column, definition).unwrap();
        }
        conn.execute_batch("PRAGMA user_version = 1").unwrap();
    }

    #[test]
    fn migration_2_moves_the_single_account_over_untouched() {
        let conn = connection();
        version_1(&conn);
        conn.execute_batch(
            "INSERT INTO account (id, name, currency, balance_minor, balance_date, balance_set,
                                   opening_balance_minor, opening_balance_date, opening_balance_set, notes)
             VALUES ('c1', 'Cuenta', 'EUR', 264000, '2026-11-18', 1,
                     50000, '2026-06-01', 1, 'Nota');
             INSERT INTO incomes (id, concept, amount_minor, date, created_at)
             VALUES ('i1', 'Nómina', 250000, '2026-11-30', '2026-11-18T09:00:00.000Z');
             INSERT INTO expenses (id, concept, amount_minor, date, created_at)
             VALUES ('e1', 'Cena', 4500, '2026-11-21', '2026-11-18T09:00:00.000Z');",
        )
        .unwrap();

        migrate(&conn, None).unwrap();

        let account: (String, String, i64, String, i64, String, i64, String) = conn
            .query_row(
                "SELECT id, name, balance_minor, balance_date, opening_balance_minor,
                        COALESCE(opening_balance_date, ''), opening_balance_set, kind
                 FROM accounts",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            account,
            (
                "c1".to_string(),
                "Cuenta".to_string(),
                264_000,
                "2026-11-18".to_string(),
                50_000,
                "2026-06-01".to_string(),
                1,
                // The kind defaults to checking: the reference had no kind.
                "checking".to_string()
            )
        );
        // Every existing row now belongs to that first account.
        let income_account: String = conn
            .query_row(
                "SELECT account_id FROM incomes WHERE id = 'i1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let expense_account: String = conn
            .query_row(
                "SELECT account_id FROM expenses WHERE id = 'e1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            (income_account.as_str(), expense_account.as_str()),
            ("c1", "c1")
        );
        // The closed single-account table is gone.
        let account_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'account'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(account_table, 0);
    }

    #[test]
    fn an_empty_account_table_still_migrates_and_its_rows_belong_to_no_account() {
        let conn = connection();
        version_1(&conn);
        migrate(&conn, None).unwrap();
        let accounts: i64 = conn
            .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(accounts, 0);
        conn.execute_batch(
            "INSERT INTO incomes (id, concept, amount_minor, date, created_at)
             VALUES ('i1', 'Nómina', 250000, '2026-11-30', '2026-11-18T09:00:00.000Z');",
        )
        .unwrap();
        let income_account: String = conn
            .query_row(
                "SELECT account_id FROM incomes WHERE id = 'i1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(income_account, "");
    }

    fn schema_rows(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT type || ' ' || name FROM sqlite_master ORDER BY type, name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(std::result::Result::unwrap)
            .collect()
    }
}
