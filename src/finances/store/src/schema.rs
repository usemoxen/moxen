//! The schema of the TypeScript reference and a forward-only migration
//! runner.
//!
//! ## Why `PRAGMA user_version`
//!
//! The reference records no schema version: `openDatabase` runs
//! `CREATE TABLE IF NOT EXISTS ...` and then `ensureColumn` (an idempotent
//! `ALTER TABLE ... ADD COLUMN` when `PRAGMA table_info` does not list the
//! column), so every open upgrades an old database by trying the statements
//! again (`src/server/db.ts` at 8aaad15b). Version 1 below *is* that schema,
//! byte for byte, so:
//!
//! - a database created by the reference sits at `user_version = 0` and
//!   migrates forward as a no-op (the statements are all `IF NOT EXISTS` or
//!   checks);
//! - a database created here records `user_version = 1` and the reference
//!   still opens it, because it ignores the pragma and the 13 tables are
//!   identical;
//! - a database from a *newer* build is refused before anything is written,
//!   which the reference could not do.
//!
//! `PRAGMA user_version` rather than a version table keeps the table list
//! exactly the reference's 13, so no dump or `.tables` output gains a table
//! the other side does not know.

use rusqlite::Connection;

use crate::error::{Result, StoreError};

/// The schema this build writes and the newest it can open.
pub const SCHEMA_VERSION: i64 = 1;

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

/// One forward migration: the version it produces and how to get there.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub apply: fn(&Connection) -> Result<()>,
}

/// Every migration this build carries, oldest first.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    apply: migration_1,
}];

/// The schema version the database records, `0` when it records none (which
/// is what the reference leaves behind).
pub fn schema_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

/// Bring the database up to [`SCHEMA_VERSION`], one transaction per
/// migration: a migration that fails leaves `user_version` and the tables
/// exactly as they were.
///
/// Refuses a database whose recorded version is newer than this build, before
/// writing anything.
pub fn migrate(conn: &Connection) -> Result<i64> {
    migrate_with(conn, MIGRATIONS, SCHEMA_VERSION)
}

/// [`migrate`] with an explicit list, so a test can hand it a migration that
/// fails halfway and check the rollback.
pub fn migrate_with(conn: &Connection, migrations: &[Migration], supported: i64) -> Result<i64> {
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
        assert_eq!(migrate(&conn).unwrap(), SCHEMA_VERSION);
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
                "account",
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
            ]
        );
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let conn = connection();
        migrate(&conn).unwrap();
        let first: Vec<String> = schema_rows(&conn);
        assert_eq!(migrate(&conn).unwrap(), SCHEMA_VERSION);
        assert_eq!(schema_rows(&conn), first);
    }

    #[test]
    fn a_newer_database_is_refused_before_anything_is_written() {
        let conn = connection();
        conn.execute_batch("PRAGMA user_version = 7").unwrap();
        let error = migrate(&conn).unwrap_err();
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
        migrate(&conn).unwrap();
        let before = schema_rows(&conn);
        let migrations = [
            MIGRATIONS[0],
            Migration {
                version: 2,
                apply: broken,
            },
        ];
        let error = migrate_with(&conn, &migrations, 2).unwrap_err();
        assert!(matches!(error, StoreError::Database(_)), "{error:?}");
        // Neither the table nor the version survived the failure.
        assert_eq!(schema_rows(&conn), before);
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
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
