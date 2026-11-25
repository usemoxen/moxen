//! The JSON backup and restore: a round trip that loses nothing, the formats
//! the reference writes, and a typed refusal for anything that is not a
//! backup — never a panic.

mod common;

use common::{TestStore, fixture};
use moxen_finances_core::types::{Currency, ExpenseStatus, Frequency, IncomeStatus};
use moxen_finances_store::{Backup, ExpenseInput, IncomeInput, StoreError};

fn json_error(text: &str) -> StoreError {
    match Backup::from_json(text) {
        Ok(backup) => panic!("accepted a document that is not a backup: {backup:?}"),
        Err(error) => error,
    }
}

#[test]
fn a_backup_round_trips_through_its_json() {
    let mut test = TestStore::initialized();
    test.store
        .create_income(&IncomeInput {
            concept: "Nómina".to_string(),
            amount_minor: 250_000,
            date: "2026-11-30".to_string(),
            frequency: Frequency::Monthly,
            status: IncomeStatus::Received,
            notes: "Con acentos y «comillas»".to_string(),
            actual_amount_minor: Some(251_000),
            ..Default::default()
        })
        .expect("income");
    test.store
        .create_expense(&ExpenseInput {
            concept: "Portátil".to_string(),
            category: "Tecnología".to_string(),
            amount_minor: 1_200_000,
            date: "2026-12-10".to_string(),
            status: ExpenseStatus::Planned,
            ..Default::default()
        })
        .expect("expense");

    let before = test.store.export_all().expect("export");
    let text = before.to_json().expect("to JSON");
    let parsed = Backup::from_json(&text).expect("from JSON");
    assert_eq!(parsed.state(), before.state());

    // Restoring into another empty database reproduces the state exactly.
    let mut other = TestStore::empty();
    other.store.restore_json(&text).expect("restore");
    assert_eq!(other.store.app_state().expect("state"), before.state());
}

#[test]
fn the_export_is_the_reference_payload() {
    let test = TestStore::initialized();
    let json = test.store.export_json().expect("export");

    // Compact JSON, the reference's keys in the reference's order, with
    // LOCAL-025's `accounts` and `transfers` after the single `account`.
    assert!(
        json.starts_with("{\"version\":2,\"exportedAt\":\""),
        "{json:.80}"
    );
    for key in [
        "\"account\":",
        "\"accounts\":",
        "\"transfers\":",
        "\"subscriptions\":",
        "\"incomes\":",
        "\"expenses\":",
        "\"rates\":",
        "\"charges\":",
        "\"settings\":",
    ] {
        assert!(json.contains(key), "missing {key}");
    }
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
    assert_eq!(parsed["version"], 2);
    assert_eq!(parsed["accounts"].as_array().unwrap().len(), 3);
    assert_eq!(parsed["transfers"].as_array().unwrap().len(), 2);
    assert_eq!(parsed["subscriptions"].as_array().unwrap().len(), 10);
    // The subscription's history sits next to its fields, flattened like the
    // reference's `SubscriptionWithHistory`.
    let first = &parsed["subscriptions"][0];
    assert!(first.get("prices").is_some());
    assert!(first.get("billingDays").is_some());
    assert!(first.get("statusHistory").is_some());
    assert!(first.get("name").is_some());
}

#[test]
fn a_file_that_is_not_json_is_a_typed_error() {
    let error = json_error("this is not JSON at all");
    assert!(matches!(error, StoreError::MalformedBackup(_)), "{error:?}");

    let error = json_error("");
    assert!(matches!(error, StoreError::MalformedBackup(_)), "{error:?}");
}

#[test]
fn json_that_is_not_a_backup_is_a_typed_error() {
    // Valid JSON, no account: the reference's API refuses this too.
    let error = json_error("{\"hello\":\"world\"}");
    assert!(matches!(error, StoreError::MalformedBackup(_)), "{error:?}");

    // An account but nothing else is not enough either.
    let error = json_error("{\"account\":42}");
    assert!(matches!(error, StoreError::MalformedBackup(_)), "{error:?}");
}

#[test]
fn a_backup_from_a_newer_version_is_refused_and_changes_nothing() {
    let mut test = TestStore::initialized();
    let before = test.store.app_state().expect("state");

    let mut backup = test.store.export_all().expect("export");
    backup.version = 7;
    let path = test.path();
    let error = test
        .store
        .restore_all(&backup)
        .expect_err("a newer backup is refused");
    match error {
        StoreError::NewerBackup { found, supported } => {
            assert_eq!(found, 7);
            assert_eq!(supported, 2);
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(test.store.app_state().expect("state"), before);
    assert!(path.exists());
}

#[test]
fn a_backup_without_a_version_is_taken_as_version_one() {
    // The reference's payload always carries it, but a hand-edited copy that
    // lost the key is still the same shape.
    let mut test = TestStore::empty();
    let mut backup = TestStore::initialized().store.export_all().expect("export");
    backup.version = 1;
    let mut value: serde_json::Value =
        serde_json::from_str(&backup.to_json().expect("json")).expect("value");
    value.as_object_mut().unwrap().remove("version");
    test.store
        .restore_json(&serde_json::to_string(&value).expect("json"))
        .expect("restore");
    assert_eq!(
        test.store.app_state().expect("state").subscriptions.len(),
        10
    );
}

#[test]
fn a_backup_whose_version_is_zero_is_refused() {
    let mut test = TestStore::empty();
    let mut backup = TestStore::initialized().store.export_all().expect("export");
    backup.version = 0;
    let error = test.store.restore_all(&backup).expect_err("refused");
    assert!(matches!(error, StoreError::MalformedBackup(_)), "{error:?}");
}

#[test]
fn restoring_replaces_the_data_and_keeps_the_audit_history() {
    let mut test = TestStore::initialized();
    let before = test.store.export_all().expect("export");
    test.store
        .create_income(&IncomeInput {
            concept: "Extra".to_string(),
            amount_minor: 10_000,
            date: "2026-11-20".to_string(),
            currency: Currency::Eur,
            ..Default::default()
        })
        .expect("income");
    assert_eq!(test.store.app_state().expect("state").incomes.len(), 1);

    let audit_before = test.store.audit_log(200).expect("audit").len();
    test.store.restore_all(&before).expect("restore");
    let state = test.store.app_state().expect("state");
    assert!(state.incomes.is_empty());

    let audit = test.store.audit_log(200).expect("audit");
    assert_eq!(audit.len(), audit_before + 1);
    assert_eq!(audit[0].entity, "database");
    assert_eq!(audit[0].action, "import");
}

#[test]
fn the_reference_s_backup_restores_as_the_first_account() {
    let mut test = TestStore::empty();
    // A backup made at schema 1: one `account`, no `accounts`, no
    // `transfers`, and rows that declare no account.
    test.store
        .restore_json(&fixture("reference-backup.json"))
        .expect("restore");

    let state = test.store.app_state().expect("state");
    assert_eq!(state.accounts.len(), 1, "the single account of the payload");
    assert_eq!(state.account.id, "account-primary");
    assert_eq!(state.transfers, Vec::new());
    // Every row restored onto that first account.
    for subscription in &state.subscriptions {
        assert_eq!(
            subscription.subscription.account_id, "account-primary",
            "{}",
            subscription.subscription.name
        );
    }

    // Exporting the restored database now writes a version 2 payload.
    let json = test.store.export_json().expect("export");
    let backup = Backup::from_json(&json).expect("parse");
    assert_eq!(backup.version, 2);
    assert_eq!(backup.accounts.len(), 1);
    assert_eq!(backup.account.id, "account-primary");
    assert_eq!(backup.subscriptions.len(), 10);
    assert_eq!(backup.rates.len(), 2);
    assert!(backup.incomes.is_empty());
    assert_eq!(
        backup.settings.get("mainCurrency").map(String::as_str),
        Some("EUR")
    );
}

#[test]
fn a_version_2_backup_round_trips_accounts_and_transfers() {
    let test = TestStore::initialized();
    let before = test.store.export_all().expect("export");
    assert_eq!(before.version, 2);
    assert_eq!(before.accounts.len(), 3);
    assert_eq!(before.transfers.len(), 2);

    let text = before.to_json().expect("to JSON");
    let parsed = Backup::from_json(&text).expect("from JSON");
    assert_eq!(parsed.state(), before.state());

    // Restoring into another empty database reproduces every account, the
    // transfers and the account of every row.
    let mut other = TestStore::empty();
    other.store.restore_json(&text).expect("restore");
    assert_eq!(other.store.app_state().expect("state"), before.state());
}
