//! The CSV sheets: the header and the values of each one, the quoting, the
//! comma-separated files the reference also accepts, and the rule that an
//! import only ever adds.

mod common;

use common::TestStore;
use moxen_finances_core::types::{Currency, ExpenseStatus, Frequency, IncomeStatus};
use moxen_finances_store::{CsvKind, ExpenseInput, IncomeInput, RateInput};

fn income(store: &mut TestStore, concept: &str) -> String {
    store
        .store
        .create_income(&IncomeInput {
            concept: concept.to_string(),
            amount_minor: 123_456,
            date: "2026-11-20".to_string(),
            time: Some("09:30".to_string()),
            frequency: Frequency::Monthly,
            end_date: Some("2027-11-20".to_string()),
            status: IncomeStatus::Received,
            paused: true,
            notes: "Nota con ; y \"comillas\"".to_string(),
            actual_amount_minor: Some(120_000),
            ..Default::default()
        })
        .expect("income")
        .id
}

#[test]
fn every_sheet_starts_with_its_header() {
    let test = TestStore::initialized();
    let expectations = [
        (CsvKind::Subscriptions, "id;nombre;descripcion;moneda"),
        (CsvKind::Incomes, "id;concepto;importe;moneda"),
        (CsvKind::Expenses, "id;concepto;categoria;importe"),
        (CsvKind::Rates, "id;desde;hasta;tipo"),
        (CsvKind::Movements, "fecha;tipo;origen;nombre"),
    ];
    for (kind, header) in expectations {
        let sheet = test
            .store
            .export_csv(kind, "2026-11-01", "2026-12-31")
            .expect("export");
        assert!(
            sheet.starts_with(&format!("\u{feff}{header}")),
            "{} starts with its header: {sheet:.60}",
            kind.as_str()
        );
    }
    // The names the API and the app use round-trip.
    for kind in [
        CsvKind::Subscriptions,
        CsvKind::Incomes,
        CsvKind::Expenses,
        CsvKind::Rates,
        CsvKind::Movements,
    ] {
        assert_eq!(CsvKind::from_name(kind.as_str()), Some(kind));
    }
    assert_eq!(CsvKind::from_name("nope"), None);
}

#[test]
fn a_field_with_separators_and_quotes_round_trips() {
    let mut test = TestStore::initialized();
    income(&mut test, "Juego \"del año\"; edición");
    let sheet = test
        .store
        .export_csv(CsvKind::Incomes, "2026-01-01", "2030-01-01")
        .expect("export");

    // The separator, the quotes and the newline rules of the reference's
    // `escapeCsv`: the field is quoted and its own quotes are doubled.
    assert!(
        sheet.contains("\"Juego \"\"del año\"\"; edición\""),
        "{sheet}"
    );

    let mut other = TestStore::empty();
    let summary = other
        .store
        .import_csv(CsvKind::Incomes, &sheet)
        .expect("import");
    assert_eq!(summary.created, 1);
    assert_eq!(summary.skipped, 0);
    let state = other.store.app_state().expect("state");
    assert_eq!(state.incomes[0].concept, "Juego \"del año\"; edición");
    assert_eq!(state.incomes[0].amount_minor, 123_456);
    assert_eq!(state.incomes[0].time.as_deref(), Some("09:30"));
    assert_eq!(state.incomes[0].end_date.as_deref(), Some("2027-11-20"));
    assert_eq!(state.incomes[0].status, IncomeStatus::Received);
    assert!(state.incomes[0].paused);
    assert_eq!(state.incomes[0].actual_amount_minor, Some(120_000));
    assert_eq!(state.incomes[0].notes, "Nota con ; y \"comillas\"");
}

#[test]
fn amounts_are_written_with_a_comma_and_read_back() {
    let mut test = TestStore::initialized();
    test.store
        .create_expense(&ExpenseInput {
            concept: "Cena".to_string(),
            category: "Ocio".to_string(),
            amount_minor: 4_550,
            date: "2026-11-21".to_string(),
            status: ExpenseStatus::Done,
            ..Default::default()
        })
        .expect("expense");
    let sheet = test
        .store
        .export_csv(CsvKind::Expenses, "2026-01-01", "2030-01-01")
        .expect("export");
    assert!(sheet.contains(";45,50;"), "{sheet}");

    let mut other = TestStore::empty();
    other
        .store
        .import_csv(CsvKind::Expenses, &sheet)
        .expect("import");
    let state = other.store.app_state().expect("state");
    assert_eq!(state.expenses[0].amount_minor, 4_550);
    assert_eq!(state.expenses[0].category, "Ocio");
    assert_eq!(state.expenses[0].status, ExpenseStatus::Done);
}

#[test]
fn a_comma_separated_file_is_read_too() {
    // The reference sniffs the separator from the header line; a file from a
    // spreadsheet set to commas must still import.
    let text = "\u{feff}concepto,importe,moneda,fecha,hora,frecuencia,fin,estado,notas,importe_real\r\n\
                Cena,45.50,EUR,21/11/2026,9:35,once,,realizado,Probando,\r\n";
    let mut test = TestStore::empty();
    let summary = test
        .store
        .import_csv(CsvKind::Expenses, text)
        .expect("import");
    assert_eq!(summary.created, 1);
    assert_eq!(summary.skipped, 0);
    let state = test.store.app_state().expect("state");
    assert_eq!(state.expenses[0].concept, "Cena");
    assert_eq!(state.expenses[0].amount_minor, 4_550);
    // The Spanish date is rewritten to ISO and the time padded.
    assert_eq!(state.expenses[0].date, "2026-11-21");
    assert_eq!(state.expenses[0].time.as_deref(), Some("09:35"));
    assert_eq!(state.expenses[0].status, ExpenseStatus::Done);
}

#[test]
fn importing_never_deletes_what_is_already_there() {
    let mut test = TestStore::initialized();
    let sheet = test
        .store
        .export_csv(CsvKind::Subscriptions, "2026-01-01", "2030-01-01")
        .expect("export");
    let before = test.store.app_state().expect("state").subscriptions.len();

    let summary = test
        .store
        .import_csv(CsvKind::Subscriptions, &sheet)
        .expect("import");
    assert_eq!(summary.created, before);

    let state = test.store.app_state().expect("state");
    assert_eq!(
        state.subscriptions.len(),
        before * 2,
        "appended, not replaced"
    );
    // The original demo rows keep their ids.
    assert!(
        state
            .subscriptions
            .iter()
            .any(|sub| sub.subscription.id == "seed-sub-1")
    );
}

#[test]
fn a_row_that_cannot_be_read_is_skipped_instead_of_failing_the_file() {
    let text = "\u{feff}concepto;importe;fecha;moneda;hora;frecuencia;fin;estado;notas;importe_real;\r\n\
                ;10,00;2026-11-20;EUR;;once;;expected;;\r\n\
                Sin importe;;2026-11-20;EUR;;once;;expected;;\r\n\
                Sin fecha;10,00;;EUR;;once;;expected;;\r\n\
                Buena;10,00;2026-11-20;EUR;;once;;expected;;\r\n";
    let mut test = TestStore::empty();
    let summary = test
        .store
        .import_csv(CsvKind::Incomes, text)
        .expect("import");
    assert_eq!(summary.created, 1);
    assert_eq!(summary.skipped, 3);
    assert_eq!(test.store.app_state().expect("state").incomes.len(), 1);
}

#[test]
fn the_sheets_carry_the_account_of_every_row() {
    // LOCAL-025: the trailing `cuenta` column. An income created without an
    // account lands on the first one, and the sheet says so.
    let mut test = TestStore::initialized();
    let created = income(&mut test, "Nómina");
    let _ = created;
    let sheet = test
        .store
        .export_csv(CsvKind::Incomes, "2026-01-01", "2030-01-01")
        .expect("export");
    assert!(sheet.contains("cuenta"), "the header carries the column");
    assert!(
        sheet.contains("seed-account-1"),
        "the row carries its account: {sheet}"
    );

    // Importing into another database that has the same account puts the row
    // back on that account.
    let mut other = TestStore::initialized();
    let summary = other
        .store
        .import_csv(CsvKind::Incomes, &sheet)
        .expect("import");
    assert_eq!(summary.created, 1);
    assert_eq!(summary.skipped, 0);
    let state = other.store.account_state("seed-account-1").expect("state");
    assert_eq!(
        state
            .as_ref()
            .expect("found")
            .incomes
            .iter()
            .filter(|income| income.concept == "Nómina")
            .count(),
        1
    );
    assert!(
        other
            .store
            .account_state("seed-account-2")
            .expect("state")
            .expect("found")
            .incomes
            .is_empty()
    );
}

#[test]
fn an_empty_or_single_line_file_imports_nothing() {
    let mut test = TestStore::empty();
    assert_eq!(
        test.store.import_csv(CsvKind::Incomes, "").expect("import"),
        moxen_finances_store::ImportSummary {
            created: 0,
            skipped: 0
        }
    );
    assert_eq!(
        test.store
            .import_csv(CsvKind::Expenses, "concepto;importe;fecha")
            .expect("import"),
        moxen_finances_store::ImportSummary {
            created: 0,
            skipped: 0
        }
    );
}

#[test]
fn the_movements_sheet_is_a_report_and_imports_nothing() {
    let mut test = TestStore::initialized();
    let sheet = test
        .store
        .export_csv(CsvKind::Movements, "2026-11-01", "2026-12-31")
        .expect("export");
    let summary = test
        .store
        .import_csv(CsvKind::Movements, &sheet)
        .expect("import");
    assert_eq!(summary.created, 0);
    assert_eq!(summary.skipped, 0);
    assert_eq!(
        test.store.app_state().expect("state").subscriptions.len(),
        10
    );
}

#[test]
fn rates_export_and_import_with_a_scaled_rate() {
    let mut test = TestStore::initialized();
    test.store
        .add_rate(&RateInput {
            from_currency: Currency::Eur,
            to_currency: Currency::Usd,
            rate_scaled: 1_175_000,
            effective_from: "2026-12-01".to_string(),
            source: Some("Manual".to_string()),
            note: Some("Fijado a mano".to_string()),
        })
        .expect("rate");
    let sheet = test
        .store
        .export_csv(CsvKind::Rates, "2026-01-01", "2030-01-01")
        .expect("export");
    assert!(
        sheet.contains(";1,175000;2026-12-01;Manual;Fijado a mano"),
        "{sheet}"
    );

    let mut other = TestStore::empty();
    let summary = other
        .store
        .import_csv(CsvKind::Rates, &sheet)
        .expect("import");
    assert_eq!(summary.created, 3);
    let rates = other.store.app_state().expect("state").rates;
    assert!(
        rates
            .iter()
            .any(|rate| rate.rate_scaled == 1_175_000 && rate.effective_from == "2026-12-01")
    );

    // A rate of zero or a pair with the same currency is skipped.
    let text = "\u{feff}desde;hasta;tipo;vigente_desde;fuente;notas;\r\n\
                EUR;EUR;1,10;2026-12-01;;;\r\n\
                EUR;USD;0;2026-12-01;;;\r\n";
    let mut empty = TestStore::empty();
    let summary = empty
        .store
        .import_csv(CsvKind::Rates, text)
        .expect("import");
    assert_eq!(summary.created, 0);
    assert_eq!(summary.skipped, 2);
}

#[test]
fn a_subscription_sheet_creates_subscriptions_with_their_first_price() {
    let text = "\u{feff}id;nombre;descripcion;moneda;precio;frecuencia;inicio;dia_cobro;fin;estado;plan;notas\r\n\
                x;Servicio;Descripción;USD;12,34;monthly;2026-11-18;7;;active;;Nota\r\n";
    let mut test = TestStore::empty();
    let summary = test
        .store
        .import_csv(CsvKind::Subscriptions, text)
        .expect("import");
    assert_eq!(summary.created, 1);
    let state = test.store.app_state().expect("state");
    let sub = &state.subscriptions[0];
    assert_eq!(sub.subscription.name, "Servicio");
    assert_eq!(sub.subscription.currency, Currency::Usd);
    assert_eq!(sub.subscription.price_minor, Some(1_234));
    assert_eq!(sub.subscription.billing_day, Some(7));
    assert_eq!(sub.subscription.start_date.as_deref(), Some("2026-11-18"));
    assert_eq!(sub.prices.len(), 1);
    assert_eq!(sub.prices[0].price_minor, 1_234);
    assert_eq!(
        sub.subscription.status,
        moxen_finances_core::types::SubscriptionStatus::Active
    );
}
