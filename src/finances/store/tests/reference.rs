//! Compatibility with the TypeScript reference, checked against files the
//! reference itself produced (`tests/fixtures`, see its README): a database it
//! created, the state it reads from it, a JSON backup, and two CSV sheets.

mod common;

use std::path::Path;

use common::{TestStore, fixture, normalized};
use moxen_finances_core::types::AppState;
use moxen_finances_store::{CsvKind, Store, csv::export_csv};
use rusqlite::Connection;

fn reference_state() -> AppState {
    serde_json::from_str(&fixture("reference-state.json")).expect("the reference's state")
}

/// `sqlite_master` as SQLite stored it: type, name and the statement text.
fn schema_rows(path: &Path) -> Vec<(String, String, String)> {
    let connection = Connection::open(path).expect("open for inspection");
    let mut statement = connection
        .prepare("SELECT type, name, coalesce(sql, '') FROM sqlite_master ORDER BY type, name")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .map(std::result::Result::unwrap)
        .collect()
}

#[test]
fn a_database_the_reference_created_opens_unchanged() {
    let dir = tempfile::tempdir().expect("temporary folder");
    let path = dir.path().join("reference.db");
    {
        let connection = Connection::open(&path).expect("open the fixture");
        connection
            .execute_batch(&fixture("reference.sql"))
            .expect("load the reference's dump");
        // The reference records no schema version at all.
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("user_version");
        assert_eq!(version, 0);
    }

    let store = Store::open(&path).expect("the Rust store opens it");
    assert_eq!(store.schema_version().expect("version"), 1);

    let state = store.app_state().expect("read the state");
    let expected = reference_state();
    assert_eq!(state, expected, "the state the reference reads");
    assert_eq!(state.subscriptions.len(), 10);
    assert_eq!(state.rates.len(), 2);
    assert!(!state.account.balance_set);
}

#[test]
fn the_schema_the_reference_created_is_the_schema_this_crate_writes() {
    // Load the reference's dump into one file and create another from
    // scratch; SQLite keeps the statement text in `sqlite_master`, so equal
    // rows mean a database either side can open the other's.
    let reference_dir = tempfile::tempdir().expect("temporary folder");
    let reference_path = reference_dir.path().join("reference.db");
    {
        let connection = Connection::open(&reference_path).expect("open the fixture");
        connection
            .execute_batch(&fixture("reference.sql"))
            .expect("load the reference's dump");
    }
    let reference_store = Store::open(&reference_path).expect("open the reference database");

    let ours_dir = tempfile::tempdir().expect("temporary folder");
    let ours_path = ours_dir.path().join("finances.db");
    let ours = Store::open(&ours_path).expect("create a fresh database");

    assert_eq!(
        schema_rows(reference_store.path().expect("file")),
        schema_rows(ours.path().expect("file"))
    );
    // 13 tables and the 8 named indices the schema declares; SQLite adds one
    // automatic index per `TEXT PRIMARY KEY`, on both sides.
    let rows = schema_rows(&ours_path);
    assert_eq!(rows.iter().filter(|row| row.0 == "table").count(), 13);
    assert_eq!(
        rows.iter()
            .filter(|row| row.0 == "index" && !row.1.starts_with("sqlite_autoindex_"))
            .count(),
        8
    );
    assert_eq!(rows.iter().filter(|row| row.0 == "index").count(), 21);
}

#[test]
fn the_subscriptions_sheet_is_byte_for_byte_the_reference_s() {
    let state = reference_state();
    let sheet =
        export_csv(&state, CsvKind::Subscriptions, "2026-01-01", "2026-12-31").expect("export");

    // The format itself: a BOM, `;` between fields, CRLF, no trailing newline
    // and amounts with a comma decimal separator.
    assert!(sheet.starts_with('\u{feff}'), "the BOM comes first");
    assert!(sheet.contains("\r\n"), "lines end with CRLF");
    assert!(!sheet.ends_with('\n'), "no newline after the last row");
    assert!(sheet.contains(";18,99;"), "decimal comma, not a point");
    assert!(!sheet.contains("18.99"), "no decimal point");

    assert_eq!(
        normalized(&sheet),
        normalized(&fixture("reference-subscriptions.csv"))
    );
}

#[test]
fn the_movements_sheet_is_byte_for_byte_the_reference_s() {
    let state = reference_state();
    let sheet = export_csv(&state, CsvKind::Movements, "2026-11-01", "2026-12-31").expect("export");
    assert_eq!(
        normalized(&sheet),
        normalized(&fixture("reference-movements.csv"))
    );
}

#[test]
fn a_backup_made_by_the_reference_restores_here() {
    let mut test = TestStore::empty();
    test.store
        .restore_json(&fixture("reference-backup.json"))
        .expect("restore the reference's backup");

    let expected = reference_state();
    assert_eq!(test.store.app_state().expect("state"), expected);

    // Exporting again produces the same data (the version and the moment of
    // the export aside), so a database can go back and forth between the two
    // implementations.
    let exported = test.store.export_all().expect("export");
    assert_eq!(exported.version, 1);
    assert_eq!(sorted(exported.state()), sorted(expected));
}

#[test]
fn a_sheet_the_reference_exported_imports_here() {
    let mut test = TestStore::empty();
    let summary = test
        .store
        .import_csv(
            CsvKind::Subscriptions,
            &fixture("reference-subscriptions.csv"),
        )
        .expect("import the reference's sheet");
    assert_eq!(summary.created, 10);
    assert_eq!(summary.skipped, 0);

    let state = test.store.app_state().expect("state");
    let reference = reference_state();
    assert_eq!(state.subscriptions.len(), 10);
    for (imported, original) in state
        .subscriptions
        .iter()
        .zip(reference.subscriptions.iter())
    {
        // Import creates new ids (the sheet's id column is not the key it
        // restores); everything the sheet carries must survive.
        assert_eq!(imported.subscription.name, original.subscription.name);
        assert_eq!(
            imported.subscription.price_minor,
            original.subscription.price_minor
        );
        assert_eq!(
            imported.subscription.currency,
            original.subscription.currency
        );
        assert_eq!(
            imported.subscription.frequency,
            original.subscription.frequency
        );
        assert_eq!(
            imported.subscription.start_date,
            original.subscription.start_date
        );
        assert_eq!(
            imported.subscription.billing_day,
            original.subscription.billing_day
        );
        assert_eq!(
            imported.subscription.end_date,
            original.subscription.end_date
        );
        assert_eq!(
            imported.subscription.description,
            original.subscription.description
        );
    }
}

/// The restore writes `sort_order = 0` for every row, like the reference's
/// `importAll`, so compare subscriptions by id rather than by the order that
/// tie leaves.
fn sorted(mut state: AppState) -> AppState {
    state
        .subscriptions
        .sort_by(|a, b| a.subscription.id.cmp(&b.subscription.id));
    state
}
