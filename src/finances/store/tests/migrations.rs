//! The migration runner: a fresh file, a reopen, a database from a newer
//! build, a migration that fails halfway, and a database the TypeScript
//! reference created (which records no version at all).

mod common;

use std::path::Path;

use common::{TestStore, fixture};
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
        },
    ];
    {
        let connection = Connection::open(&path).expect("open");
        let error =
            schema::migrate_with(&connection, &migrations, 2).expect_err("the migration fails");
        assert!(matches!(error, StoreError::Database(_)), "{error:?}");
    }

    // Neither the table the failed migration created nor its version survived.
    assert_eq!(user_version(&path), 1);
    assert_eq!(object_names(&path), before);
    // And the file still opens as a normal database.
    let store = Store::open(&path).expect("open after the failure");
    assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
}

#[test]
fn a_reference_database_records_no_version_and_migrates_as_a_no_op() {
    let dir = tempfile::tempdir().expect("temporary folder");
    let path = dir.path().join("reference.db");
    {
        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch(&fixture("reference.sql"))
            .expect("load the reference's dump");
    }
    assert_eq!(user_version(&path), 0);
    let before = object_names(&path);

    let store = Store::open(&path).expect("open");
    assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
    // The tables and indices are exactly the ones the reference made: version
    // 1 is that schema, so migrating it adds nothing.
    assert_eq!(
        object_names(&path),
        before,
        "the reference's own schema is what version 1 writes"
    );
    assert!(store.app_state().expect("state").subscriptions.len() == 10);
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
