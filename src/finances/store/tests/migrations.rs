//! The migration runner: a fresh file, a reopen, a database from a newer
//! build, a migration that fails halfway, the schema-2 file backup, and the
//! database the TypeScript reference created (which records no version at
//! all) migrating to schema 2 without losing a row.

mod common;

use std::path::Path;

use common::{TestStore, fixture};
use moxen_finances_core::types::AppState;
use moxen_finances_store::schema::{self, MIGRATIONS, Migration, SCHEMA_VERSION};
use moxen_finances_store::{Store, StoreError};
use rusqlite::Connection;

fn user_version(path: &Path) -> i64 {
    let connection = Connection::open(path).expect("open");
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("user_version")
}

fn object_names(path: &Path) -> Vec<String> {
    let connection = Connection::open(path).expect("open");
    let mut statement = connection
        .prepare("SELECT type || ' ' || name FROM sqlite_master ORDER BY type, name")
        .expect("prepare");
    statement
        .query_map([], |row| row.get(0))
        .expect("query")
        .map(std::result::Result::unwrap)
        .collect()
}

#[test]
fn a_fresh_file_starts_at_the_current_version() {
    let test = TestStore::empty();
    assert_eq!(
        test.store.schema_version().expect("version"),
        SCHEMA_VERSION
    );
    assert_eq!(user_version(&test.path()), SCHEMA_VERSION);
}

#[test]
fn reopening_keeps_the_version_and_the_data() {
    let mut test = TestStore::initialized();
    test.store
        .create_expense(&moxen_finances_store::ExpenseInput {
            concept: "Cena".to_string(),
            category: "Ocio".to_string(),
            amount_minor: 4_500,
            date: "2026-11-21".to_string(),
            status: moxen_finances_core::types::ExpenseStatus::Done,
            ..Default::default()
        })
        .expect("expense");
    let before = object_names(&test.path());

    let reopened = test.reopen();
    assert_eq!(reopened.schema_version().expect("version"), SCHEMA_VERSION);
    let state = reopened.app_state().expect("state");
    assert_eq!(state.expenses.len(), 1);
    assert_eq!(state.subscriptions.len(), 10);
    // Running the migrations again changed no object.
    assert_eq!(object_names(&test.path()), before);
}

#[test]
fn a_database_from_a_newer_build_is_refused_before_anything_is_written() {
    let test = TestStore::initialized();
    let path = test.path();
    // Pretend a later build migrated it further.
    {
        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch("PRAGMA user_version = 9")
            .expect("bump the version");
    }
    let before = object_names(&path);

    let error = match Store::open(&path) {
        Ok(_) => panic!("a newer schema must be refused"),
        Err(error) => error,
    };
    match error {
        StoreError::NewerSchema { found, supported } => {
            assert_eq!(found, 9);
            assert_eq!(supported, SCHEMA_VERSION);
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(object_names(&path), before, "nothing was written");
    assert_eq!(user_version(&path), 9);
}

#[test]
fn a_migration_that_fails_halfway_rolls_back() {
    fn broken(conn: &Connection) -> moxen_finances_store::Result<()> {
        conn.execute_batch("CREATE TABLE half_done (id TEXT PRIMARY KEY);")?;
        conn.execute_batch("THIS IS NOT SQL")?;
        Ok(())
    }

    let dir = tempfile::tempdir().expect("temporary folder");
    let path = dir.path().join("finances.db");
    {
        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch(schema::SCHEMA_V1)
            .expect("the version 1 schema");
        connection
            .execute_batch("PRAGMA user_version = 1")
            .expect("record version 1");
    }
    let before = object_names(&path);

    let migrations = [
        MIGRATIONS[0],
        Migration {
            version: 2,
            apply: broken,
            prepare: None,
        },
    ];
    {
        let connection = Connection::open(&path).expect("open");
        let error = schema::migrate_with(&connection, &migrations, 2, Some(&path))
            .expect_err("the migration fails");
        assert!(matches!(error, StoreError::Database(_)), "{error:?}");
    }

    // Neither the table the failed migration created nor its version survived.
    assert_eq!(user_version(&path), 1);
    assert_eq!(object_names(&path), before);
    // And the file still opens as a normal database.
    let store = Store::open(&path).expect("open after the failure");
    assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
}

/// A fresh temp folder holding the reference's committed dump, the state it
/// reads, and the `.pre-v2.bak` name the migration is going to use.
fn reference_database(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("temporary folder");
    let path = dir.path().join(name);
    {
        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch(&fixture("reference.sql"))
            .expect("load the reference's dump");
    }
    (dir, path)
}

/// The state exactly as the reference reads its own dump, with the account
/// every row gains: the state after the migration has to equal it.
fn reference_state_on_first_account() -> AppState {
    let mut expected: AppState =
        serde_json::from_str(&fixture("reference-state.json")).expect("the reference's state");
    let account_id = expected.account.id.clone();
    for subscription in &mut expected.subscriptions {
        subscription.subscription.account_id = account_id.clone();
    }
    for income in &mut expected.incomes {
        income.account_id = account_id.clone();
    }
    for expense in &mut expected.expenses {
        expense.account_id = account_id.clone();
    }
    for charge in &mut expected.charges {
        charge.account_id = account_id.clone();
    }
    expected.accounts = vec![expected.account.clone()];
    expected
}

#[test]
fn a_reference_database_migrates_to_schema_2_without_losing_a_row() {
    let (_dir, path) = reference_database("reference.db");
    assert_eq!(user_version(&path), 0);

    // The computed state of the first account **before** the migration, from
    // the pre-migration state the reference reads, through the same pure
    // functions. (The reference-state rows carry no account; the state above
    // is them with the migration's assignment, so this is the same data the
    // store will return — the vectors pin that the account-less original
    // projects identically under the all-accounts scope.)
    let expected = reference_state_on_first_account();
    let before_projection =
        moxen_finances_store::derive::projection_for(&expected, "2026-11-01", "2027-01-31", &[])
            .expect("the before projection");
    let before_events =
        moxen_finances_store::derive::events_for(&expected, "2026-11-01", "2026-12-31")
            .expect("the before events")
            .events;
    let before_stats =
        moxen_finances_core::stats::totals_for_events(&before_events, "2026-11-01", "2026-12-31");

    let store = Store::open(&path).expect("open");
    assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);

    // Nothing changed in the rows or the computed state of the first account.
    let state = store.app_state().expect("state");
    assert_eq!(
        state, expected,
        "every row of the reference's database survives, on the first account"
    );
    assert_eq!(
        store
            .projection("2026-11-01", "2027-01-31")
            .expect("the after projection"),
        before_projection,
        "the projection of the first account is unchanged"
    );
    let after_events = store
        .events("2026-11-01", "2026-12-31")
        .expect("the after events")
        .events;
    let after_stats =
        moxen_finances_core::stats::totals_for_events(&after_events, "2026-11-01", "2026-12-31");
    assert_eq!(after_stats, before_stats, "the statistics are unchanged");
}

#[test]
fn the_migration_copies_the_file_before_touching_it() {
    let (dir, path) = reference_database("reference.db");
    let store = Store::open(&path).expect("open the reference database");
    let _ = store.app_state().expect("state readable");

    let backup = dir.path().join("reference.db.pre-v2.bak");
    assert!(backup.exists(), "the copy sits next to the database");
    // The copy is the schema-1 database (migration 1, a no-op for the
    // reference's own schema that only records the version, has already run
    // — that is the state migration 2 protects). It remains exactly what the
    // TypeScript app opens.
    let connection = Connection::open(&backup).expect("open the backup");
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("version");
    assert_eq!(version, 1, "the copy is the pre-schema-2 state");
    let subscriptions: i64 = connection
        .query_row("SELECT COUNT(*) FROM subscriptions", [], |row| row.get(0))
        .expect("the rows of the copy");
    assert_eq!(subscriptions, 10);
    let account_rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM account", [], |row| row.get(0))
        .expect("the single-account table of the copy");
    assert_eq!(account_rows, 1);
}

#[test]
fn a_migration_whose_copy_fails_is_refused_and_touches_nothing() {
    // A database already at version 1, like one the previous build made: its
    // only pending migration is the schema-2 one, whose copy must come
    // first.
    let (_dir, path) = reference_database("reference.db");
    {
        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch("PRAGMA user_version = 1")
            .expect("a schema-1 database");
    }
    let before = object_names(&path);
    // A directory where the backup file has to go: the copy cannot be made,
    // on every platform, without any permission trickery.
    std::fs::create_dir(path.with_file_name("reference.db.pre-v2.bak"))
        .expect("occupy the backup's name");

    let error = match Store::open(&path) {
        Ok(_) => panic!("the migration must be refused without its backup"),
        Err(error) => error,
    };
    assert!(
        matches!(error, StoreError::MigrationBackup { .. }),
        "{error:?}"
    );
    // The database is exactly as it was, and still migrates once the way is
    // clear.
    assert_eq!(user_version(&path), 1);
    assert_eq!(object_names(&path), before);
    std::fs::remove_dir(path.with_file_name("reference.db.pre-v2.bak")).expect("clear the way");
    let store = Store::open(&path).expect("open the reference database");
    assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
    assert_eq!(store.app_state().expect("state").subscriptions.len(), 10);
}

#[test]
fn a_very_old_database_gains_the_columns_the_reference_adds_on_open() {
    // A build from before the opening balance existed: the account table
    // without its three columns and incomes without its time column.
    let dir = tempfile::tempdir().expect("temporary folder");
    let path = dir.path().join("old.db");
    {
        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch(
                "CREATE TABLE account (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   currency TEXT NOT NULL DEFAULT 'EUR',
                   balance_minor INTEGER NOT NULL DEFAULT 0,
                   balance_date TEXT NOT NULL,
                   balance_set INTEGER NOT NULL DEFAULT 0,
                   notes TEXT NOT NULL DEFAULT ''
                 );
                 CREATE TABLE incomes (
                   id TEXT PRIMARY KEY,
                   concept TEXT NOT NULL,
                   amount_minor INTEGER NOT NULL,
                   currency TEXT NOT NULL DEFAULT 'EUR',
                   date TEXT NOT NULL,
                   frequency TEXT NOT NULL DEFAULT 'once',
                   end_date TEXT,
                   status TEXT NOT NULL DEFAULT 'expected',
                   paused INTEGER NOT NULL DEFAULT 0,
                   notes TEXT NOT NULL DEFAULT '',
                   actual_amount_minor INTEGER,
                   created_at TEXT NOT NULL
                 );
                 INSERT INTO account (id, name, balance_date, balance_set)
                   VALUES ('account-primary', 'Cuenta', '2026-01-01', 0);",
            )
            .expect("the old schema");
    }

    let store = Store::open(&path).expect("open the old database");
    let state = store.app_state().expect("state");
    assert_eq!(state.account.name, "Cuenta");
    assert_eq!(state.account.opening_balance_minor, 0);
    assert!(!state.account.opening_balance_set);
    assert_eq!(state.account.opening_balance_date, None);
    assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
}
