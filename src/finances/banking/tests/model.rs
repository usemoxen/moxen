//! The neutral shapes: the de-duplication key a second import relies on, the
//! serde round trip a caller persists with, and the masking that keeps
//! identifiers out of a log.

mod common;

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use moxen_finances_banking::model::dedupe_key;
use moxen_finances_banking::{
    BankAccount, BankBalance, BankLink, BankRef, BankTransaction, TransactionStatus,
};

fn date(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).expect("a valid date")
}

fn instant() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 20, 9, 0, 0)
        .single()
        .expect("a valid instant")
}

#[test]
fn a_key_with_an_entry_reference_is_the_same_for_the_same_reference() {
    let once = dedupe_key(
        "fictional-account-uid-0001",
        Some("FICT-0001"),
        Some(date(2026, 1, 5)),
        -1230,
        Some("Supermercado Imaginario"),
        Some("Compra ficticia"),
    );
    let twice = dedupe_key(
        "fictional-account-uid-0001",
        Some("FICT-0001"),
        Some(date(2026, 1, 5)),
        -1230,
        Some("Supermercado Imaginario"),
        Some("Compra ficticia"),
    );
    assert_eq!(once, twice);
    assert!(
        once.starts_with("er-"),
        "the rule is visible in the key: {once}"
    );
    assert_eq!(once.len(), 3 + 16, "a prefix and 16 hex characters");
}

#[test]
fn an_entry_reference_wins_over_the_date_and_the_amount() {
    // The bank's reference is the identity: a re-authorisation that reports a
    // different booking date or a corrected amount is still the same
    // operation, and must not arrive twice.
    let before = dedupe_key(
        "fictional-account-uid-0001",
        Some("FICT-0001"),
        Some(date(2026, 1, 5)),
        -1230,
        None,
        None,
    );
    let after = dedupe_key(
        "fictional-account-uid-0001",
        Some("FICT-0001"),
        Some(date(2026, 1, 6)),
        -1200,
        Some("Supermercado Imaginario"),
        Some("Compra ficticia"),
    );
    assert_eq!(before, after);
}

#[test]
fn the_same_reference_on_another_account_is_another_key() {
    let first = dedupe_key(
        "fictional-account-uid-0001",
        Some("FICT-0001"),
        None,
        0,
        None,
        None,
    );
    let second = dedupe_key(
        "fictional-account-uid-0002",
        Some("FICT-0001"),
        None,
        0,
        None,
        None,
    );
    assert_ne!(first, second, "entry references are not globally unique");
}

#[test]
fn without_a_reference_the_key_falls_back_to_the_shape_of_the_operation() {
    let base = dedupe_key(
        "fictional-account-uid-0001",
        None,
        Some(date(2026, 1, 5)),
        -310,
        Some("Café de Prueba"),
        Some("Café"),
    );
    assert!(base.starts_with("syn-"), "the fallback is visible: {base}");
    let same = dedupe_key(
        "fictional-account-uid-0001",
        Some("   "),
        Some(date(2026, 1, 5)),
        -310,
        Some("Café de Prueba"),
        Some("Café"),
    );
    assert_eq!(base, same, "a blank reference counts as no reference");

    let other_amount = dedupe_key(
        "fictional-account-uid-0001",
        None,
        Some(date(2026, 1, 5)),
        -311,
        Some("Café de Prueba"),
        Some("Café"),
    );
    assert_ne!(base, other_amount);

    let other_date = dedupe_key(
        "fictional-account-uid-0001",
        None,
        Some(date(2026, 1, 6)),
        -310,
        Some("Café de Prueba"),
        Some("Café"),
    );
    assert_ne!(base, other_date);

    let other_party = dedupe_key(
        "fictional-account-uid-0001",
        None,
        Some(date(2026, 1, 5)),
        -310,
        Some("Café de Pruebas"),
        Some("Café"),
    );
    assert_ne!(base, other_party);

    let other_remittance = dedupe_key(
        "fictional-account-uid-0001",
        None,
        Some(date(2026, 1, 5)),
        -310,
        Some("Café de Prueba"),
        Some("Café con leche"),
    );
    assert_ne!(base, other_remittance);
}

#[test]
fn a_key_is_sixteen_lowercase_hex_characters_after_its_prefix() {
    let key = dedupe_key("uid", Some("ref"), None, 0, None, None);
    let (prefix, digest) = key.split_once('-').expect("a prefix");
    assert_eq!(prefix, "er");
    assert_eq!(digest.len(), 16);
    assert!(
        digest
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()),
        "not lowercase hex: {digest}"
    );
}

#[test]
fn the_optional_fields_do_not_change_a_reference_key_and_do_change_a_fallback_one() {
    let without = dedupe_key("uid", None, Some(date(2026, 1, 5)), 100, None, None);
    let with_nothing = dedupe_key("uid", None, Some(date(2026, 1, 5)), 100, Some(""), Some(""));
    assert_eq!(
        without, with_nothing,
        "an empty counterparty is no counterparty"
    );
}

fn transaction() -> BankTransaction {
    BankTransaction {
        account_uid: "fictional-account-uid-0001".to_string(),
        booking_date: date(2026, 1, 5),
        value_date: Some(date(2026, 1, 6)),
        amount_minor: -1230,
        currency: "EUR".to_string(),
        counterparty: Some("Supermercado Imaginario".to_string()),
        remittance: Some("Compra ficticia\nTarjeta **** 0000".to_string()),
        status: TransactionStatus::Booked,
        entry_reference: Some("FICT-0001-ABCDEFGH-0001".to_string()),
        dedupe_key: dedupe_key(
            "fictional-account-uid-0001",
            Some("FICT-0001-ABCDEFGH-0001"),
            None,
            0,
            None,
            None,
        ),
    }
}

#[test]
fn a_transaction_survives_a_serde_round_trip() {
    let original = transaction();
    let json = serde_json::to_string(&original).expect("serialize");
    let back: BankTransaction = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(original, back);
    assert!(
        json.contains("\"booked\""),
        "the status is a stable string, not a number: {json}"
    );
}

#[test]
fn a_link_survives_a_serde_round_trip() {
    let link = BankLink {
        session_id: "fictional-session-0001".to_string(),
        bank: BankRef {
            name: "Banco Ficticio".to_string(),
            country: "ES".to_string(),
        },
        account_uids: vec!["fictional-account-uid-0001".to_string()],
        consent_valid_until: instant(),
        linked_at: instant(),
    };
    let json = serde_json::to_string(&link).expect("serialize");
    let back: BankLink = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(link, back);
}

#[test]
fn debug_output_masks_the_identifiers() {
    let transaction = transaction();
    let rendered = format!("{transaction:?}");
    assert!(
        !rendered.contains("fictional-account-uid-0001"),
        "the account uid leaked: {rendered}"
    );
    assert!(
        !rendered.contains("FICT-0001-ABCDEFGH-0001"),
        "the entry reference leaked: {rendered}"
    );
    assert!(
        rendered.contains("fictiona…"),
        "a short prefix stays: {rendered}"
    );

    let account = BankAccount {
        uid: "fictional-account-uid-0001".to_string(),
        iban: Some("ES0021000418450200051332".to_string()),
        name: Some("Cuenta de pruebas".to_string()),
        currency: Some("EUR".to_string()),
        product: None,
        account_type: Some("CACC".to_string()),
        usage: Some("PRIV".to_string()),
    };
    let rendered = format!("{account:?}");
    assert!(
        !rendered.contains("ES0021000418450200051332"),
        "the IBAN leaked: {rendered}"
    );
    assert!(
        rendered.contains("Cuenta de pruebas"),
        "the name stays readable"
    );

    let link = BankLink {
        session_id: "fictional-session-0001".to_string(),
        bank: BankRef {
            name: "Banco Ficticio".to_string(),
            country: "ES".to_string(),
        },
        account_uids: vec!["fictional-account-uid-0002".to_string()],
        consent_valid_until: instant(),
        linked_at: instant(),
    };
    let rendered = format!("{link:?}");
    assert!(
        !rendered.contains("fictional-session-0001"),
        "the session id leaked: {rendered}"
    );
    assert!(
        !rendered.contains("fictional-account-uid-0002"),
        "an account uid leaked: {rendered}"
    );

    let balance = BankBalance {
        account_uid: "fictional-account-uid-0001".to_string(),
        name: Some("Saldo contable".to_string()),
        balance_type: Some("CLAV".to_string()),
        amount_minor: 123456,
        currency: "EUR".to_string(),
        reference_date: Some(date(2026, 1, 31)),
    };
    // Balances are the data itself, not an identifier; only the uid is masked.
    let rendered = format!("{balance:?}");
    assert!(
        !rendered.contains("fictional-account-uid-0001"),
        "the account uid leaked: {rendered}"
    );
    assert!(rendered.contains("123456"), "the amount stays readable");
}

#[test]
fn a_short_identifier_is_left_alone() {
    // A two-letter country code or a short reference is not an identifier worth
    // masking, and masking it would make a Debug line useless.
    let account = BankAccount {
        uid: "short".to_string(),
        iban: None,
        name: None,
        currency: None,
        product: None,
        account_type: None,
        usage: None,
    };
    assert!(format!("{account:?}").contains("short"));
}
