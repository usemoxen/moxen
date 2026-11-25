//! The repository, checked test by test against the intent of the reference's
//! `tests/db.test.ts` (8aaad15b): the demo seed, a backup that does not lose
//! anything, price and plan changes that keep their history, the actions and
//! what they do to the projection, the audit trail of a deletion, and the
//! real charges.

mod common;

use moxen_finances_core::projection::{NextBillingForOptions, next_billing_for};
use moxen_finances_core::types::{
    Currency, ExpenseStatus, Frequency, IncomeStatus, SubscriptionStatus,
};

use common::TestStore;
use moxen_finances_store::{
    AccountPatch, ChargeInput, ExpenseInput, IncomeInput, PlanInput, PriceInput, Store,
    SubscriptionAction, SubscriptionInput, SubscriptionPatch,
};

fn by_name<'a>(
    state: &'a moxen_finances_core::types::AppState,
    name: &str,
) -> &'a moxen_finances_core::types::SubscriptionWithHistory {
    state
        .subscriptions
        .iter()
        .find(|sub| sub.subscription.name == name)
        .unwrap_or_else(|| panic!("no subscription named {name}"))
}

fn set_balance(store: &mut Store) {
    store
        .update_account(&AccountPatch {
            balance_minor: Some(100_000),
            balance_date: Some("2026-11-18".to_string()),
            balance_set: Some(true),
            ..Default::default()
        })
        .expect("set the balance");
}

#[test]
fn the_demo_seed_is_written_for_a_new_file_only() {
    let mut test = TestStore::initialized();
    let state = test.store.app_state().expect("state");
    assert_eq!(state.subscriptions.len(), 10);
    assert_eq!(state.rates.len(), 2);
    assert!(!state.account.balance_set);

    let mobility = by_name(&state, "Mobilidad urbana");
    assert_eq!(mobility.subscription.price_minor, None);
    assert_eq!(mobility.subscription.start_date, None);
    let cloud = by_name(&state, "Asistentes Cloud Go");
    assert_eq!(cloud.subscription.currency, Currency::Usd);
    assert_eq!(cloud.subscription.end_date.as_deref(), Some("2026-11-25"));

    // Deleting everything and reopening must not bring the demo back: the
    // file exists, so it is not a first run.
    for sub in state.subscriptions.iter() {
        test.store
            .delete_subscription(&sub.subscription.id)
            .expect("delete");
    }
    assert_eq!(
        test.store.app_state().expect("state").subscriptions.len(),
        0
    );

    let mut reopened = test.reopen();
    assert_eq!(
        reopened.app_state().expect("state").subscriptions.len(),
        0,
        "an existing database is never reseeded"
    );
    // It still opens normally and takes new work.
    reopened
        .create_income(&IncomeInput {
            concept: "Nómina".to_string(),
            amount_minor: 250_000,
            date: "2026-11-30".to_string(),
            frequency: Frequency::Monthly,
            status: IncomeStatus::Expected,
            ..Default::default()
        })
        .expect("income");
    assert_eq!(reopened.app_state().expect("state").incomes.len(), 1);
}

#[test]
fn an_empty_database_that_already_exists_is_not_seeded() {
    let test = TestStore::empty();
    assert_eq!(
        test.store.app_state().expect("state").subscriptions.len(),
        0
    );
    let reopened = test.reopen();
    assert_eq!(
        reopened.app_state().expect("state").subscriptions.len(),
        0,
        "only a file created by this open gets the demo"
    );
}

#[test]
fn a_backup_restores_the_previous_copy_without_losing_anything() {
    let mut test = TestStore::initialized();
    let before = test.store.export_all().expect("export");

    test.store
        .update_account(&AccountPatch {
            balance_minor: Some(123_456),
            balance_date: Some("2026-11-18".to_string()),
            balance_set: Some(true),
            ..Default::default()
        })
        .expect("account");
    test.store
        .create_income(&IncomeInput {
            concept: "Nómina".to_string(),
            amount_minor: 250_000,
            date: "2026-11-30".to_string(),
            frequency: Frequency::Monthly,
            status: IncomeStatus::Expected,
            ..Default::default()
        })
        .expect("income");
    test.store
        .create_expense(&ExpenseInput {
            concept: "Portátil".to_string(),
            category: "Tecnología".to_string(),
            amount_minor: 1_200_000,
            date: "2026-12-10".to_string(),
            frequency: Frequency::Once,
            status: ExpenseStatus::Planned,
            ..Default::default()
        })
        .expect("expense");

    let payload = test.store.export_all().expect("export");
    assert_eq!(payload.incomes.len(), 1);
    assert_eq!(payload.expenses.len(), 1);
    assert_eq!(payload.account.balance_minor, 123_456);

    // Restoring the copy from before the changes puts everything back.
    test.store.restore_all(&before).expect("restore");
    let restored = test.store.app_state().expect("state");
    assert_eq!(restored.account.balance_minor, 0);
    assert!(restored.incomes.is_empty());
    assert!(restored.expenses.is_empty());
    assert_eq!(restored.subscriptions.len(), before.subscriptions.len());
    assert_eq!(restored.rates.len(), before.rates.len());
}

#[test]
fn a_price_change_does_not_overwrite_the_history() {
    let mut test = TestStore::initialized();
    let state = test.store.app_state().expect("state");
    let correo = by_name(&state, "CorreoSeguro Pro").subscription.id.clone();
    let before = by_name(&state, "CorreoSeguro Pro").prices.len();

    test.store
        .add_price(
            &correo,
            &PriceInput {
                price_minor: 2499,
                currency: Currency::Eur,
                effective_from: "2026-12-01".to_string(),
                effective_to: None,
                note: Some("Subida".to_string()),
            },
        )
        .expect("price change");

    let updated = test
        .store
        .subscription(&correo)
        .expect("read")
        .expect("found");
    assert_eq!(updated.prices.len(), before + 1);
    // The history keeps its first price; the subscription's current one moves.
    assert_eq!(updated.prices[0].price_minor, 1899);
    assert_eq!(updated.subscription.price_minor, Some(2499));

    set_balance(&mut test.store);
    let result = test
        .store
        .projection("2026-11-01", "2027-01-31")
        .expect("projection");
    let amounts: Vec<(&str, i64)> = result
        .events
        .iter()
        .filter(|event| event.source_id == correo)
        .map(|event| (event.date.as_str(), event.amount_minor))
        .collect();
    assert!(amounts.contains(&("2026-11-23", 1899)), "{amounts:?}");
    assert!(amounts.contains(&("2026-12-23", 2499)), "{amounts:?}");
}

#[test]
fn pausing_resuming_and_cancelling_show_in_the_projection() {
    let mut test = TestStore::initialized();
    let state = test.store.app_state().expect("state");
    let correo = by_name(&state, "CorreoSeguro Pro").subscription.id.clone();

    test.store
        .apply_subscription_action(&correo, SubscriptionAction::Pause, "2026-12-01", "")
        .expect("pause");
    test.store
        .apply_subscription_action(&correo, SubscriptionAction::Resume, "2027-02-28", "")
        .expect("resume");
    test.store
        .apply_subscription_action(&correo, SubscriptionAction::Cancel, "2027-06-01", "")
        .expect("cancel");

    let current = test.store.app_state().expect("state");
    let updated = by_name(&current, "CorreoSeguro Pro");
    assert_eq!(updated.subscription.status, SubscriptionStatus::Cancelled);
    assert_eq!(updated.pauses[0].start_date, "2026-12-01");
    assert_eq!(updated.pauses[0].end_date.as_deref(), Some("2027-02-28"));
    assert_eq!(
        updated.subscription.cancelled_at.as_deref(),
        Some("2027-06-01")
    );

    set_balance(&mut test.store);
    let result = test
        .store
        .projection("2026-11-01", "2027-12-31")
        .expect("projection");
    let dates: Vec<&str> = result
        .events
        .iter()
        .filter(|event| event.source_id == correo)
        .map(|event| event.date.as_str())
        .collect();
    assert!(dates.contains(&"2026-11-23"), "{dates:?}");
    assert!(
        !dates.contains(&"2026-12-23"),
        "inside the pause: {dates:?}"
    );
    assert!(
        !dates.contains(&"2027-01-23"),
        "inside the pause: {dates:?}"
    );
    assert!(dates.contains(&"2027-03-23"), "after the resume: {dates:?}");
    assert!(
        dates.iter().all(|date| *date < "2027-06-01"),
        "nothing after the cancellation: {dates:?}"
    );
}

#[test]
fn deleting_movements_leaves_a_trace_in_the_audit_log() {
    let mut test = TestStore::initialized();
    let income = test
        .store
        .create_income(&IncomeInput {
            concept: "Beca".to_string(),
            amount_minor: 10_000,
            date: "2026-11-20".to_string(),
            status: IncomeStatus::Expected,
            ..Default::default()
        })
        .expect("income");
    test.store
        .update_income(
            &income.id,
            &IncomeInput {
                concept: "Beca".to_string(),
                amount_minor: 12_000,
                date: "2026-11-20".to_string(),
                status: IncomeStatus::Received,
                ..Default::default()
            },
        )
        .expect("update");
    assert!(test.store.delete_income(&income.id).expect("delete"));

    let expense = test
        .store
        .create_expense(&ExpenseInput {
            concept: "Cena".to_string(),
            category: "Ocio".to_string(),
            amount_minor: 4_500,
            date: "2026-11-21".to_string(),
            status: ExpenseStatus::Done,
            ..Default::default()
        })
        .expect("expense");
    assert!(test.store.delete_expense(&expense.id).expect("delete"));

    let state = test.store.app_state().expect("state");
    assert!(state.incomes.is_empty());
    assert!(state.expenses.is_empty());

    let audit = test.store.audit_log(100).expect("audit");
    assert!(
        audit
            .iter()
            .any(|entry| entry.action == "delete" && entry.entity == "income"),
        "the income deletion is recorded"
    );
    assert!(
        audit
            .iter()
            .any(|entry| entry.action == "delete" && entry.entity == "expense"),
        "the expense deletion is recorded"
    );
    assert!(
        audit
            .iter()
            .any(|entry| entry.action == "update" && entry.entity == "income"),
        "the income update is recorded"
    );
}

#[test]
fn deleting_something_that_is_not_there_reports_it() {
    let mut test = TestStore::initialized();
    assert!(!test.store.delete_income("nope").expect("delete"));
    assert!(!test.store.delete_expense("nope").expect("delete"));
    assert!(!test.store.delete_subscription("nope").expect("delete"));
    assert!(!test.store.delete_rate("nope").expect("delete"));
    assert!(!test.store.delete_charge("nope").expect("delete"));
    assert!(test.store.subscription("nope").expect("read").is_none());
    assert!(
        test.store
            .update_subscription("nope", &SubscriptionPatch::default())
            .expect("update")
            .is_none()
    );
    assert!(
        test.store
            .apply_subscription_action("nope", SubscriptionAction::Cancel, "2026-11-18", "")
            .expect("action")
            .is_none()
    );
}

#[test]
fn a_subscription_is_created_with_its_first_price_and_deleted() {
    let mut test = TestStore::initialized();
    let created = test
        .store
        .create_subscription(&SubscriptionInput {
            name: "Nuevo servicio".to_string(),
            description: Some("Prueba".to_string()),
            price_minor: Some(500),
            start_date: Some("2026-11-18".to_string()),
            ..SubscriptionInput::new("Nuevo servicio")
        })
        .expect("create");
    assert_eq!(created.prices.len(), 1);
    assert_eq!(created.prices[0].note, "Primer precio registrado.");
    assert_eq!(created.status_history.len(), 1);
    assert_eq!(created.billing_days.len(), 1);
    assert_eq!(created.subscription.billing_day, Some(18));
    // The default frequency and currency, like the reference.
    assert_eq!(created.subscription.frequency, Frequency::Monthly);
    assert_eq!(created.subscription.currency, Currency::Eur);
    assert_eq!(
        test.store.app_state().expect("state").subscriptions.len(),
        11
    );

    assert!(
        test.store
            .delete_subscription(&created.subscription.id)
            .expect("delete")
    );
    assert_eq!(
        test.store.app_state().expect("state").subscriptions.len(),
        10
    );
}

#[test]
fn a_plan_change_can_record_its_new_price() {
    let mut test = TestStore::initialized();
    let state = test.store.app_state().expect("state");
    let correo = by_name(&state, "CorreoSeguro Pro").subscription.id.clone();

    test.store
        .add_plan(
            &correo,
            &PlanInput {
                plan: "Plus".to_string(),
                effective_from: "2026-12-01".to_string(),
                note: Some("Cambio de plan".to_string()),
                price_minor: Some(2499),
                currency: Some(Currency::Eur),
            },
        )
        .expect("plan change");

    let updated = test
        .store
        .subscription(&correo)
        .expect("read")
        .expect("found");
    assert_eq!(updated.subscription.plan.as_deref(), Some("Plus"));
    assert_eq!(updated.subscription.price_minor, Some(2499));
    assert!(updated.prices.iter().any(|price| price.price_minor == 2499));
    assert!(updated.plans.iter().any(|plan| plan.plan == "Plus"));
    assert_eq!(updated.prices.last().unwrap().note, "Cambio de plan: Plus");
}

#[test]
fn finishing_stops_the_charges_even_with_another_end_date() {
    let mut test = TestStore::initialized();
    let state = test.store.app_state().expect("state");
    let support = by_name(&state, "Soporte de sobremesa")
        .subscription
        .id
        .clone();
    assert_eq!(
        by_name(&state, "Soporte de sobremesa")
            .subscription
            .end_date
            .as_deref(),
        Some("2027-01-10")
    );

    let finished = test
        .store
        .apply_subscription_action(
            &support,
            SubscriptionAction::Finish,
            "2026-11-18",
            "Fin anticipado",
        )
        .expect("finish")
        .expect("found");
    assert_eq!(finished.subscription.status, SubscriptionStatus::Finished);
    assert_eq!(
        finished.subscription.end_date.as_deref(),
        Some("2026-11-18")
    );
    assert_eq!(
        finished.status_history.last().unwrap().note,
        "Fin anticipado"
    );
}

#[test]
fn an_archived_subscription_proposes_no_next_charge() {
    let mut test = TestStore::initialized();
    let state = test.store.app_state().expect("state");
    let home = by_name(&state, "Seguridad Hogar").subscription.id.clone();

    let archived = test
        .store
        .apply_subscription_action(
            &home,
            SubscriptionAction::Archive,
            "2026-11-10",
            "Archivada",
        )
        .expect("archive")
        .expect("found");
    assert!(archived.subscription.archived);
    assert_eq!(
        archived.subscription.archived_at.as_deref(),
        Some("2026-11-10")
    );
    let next = next_billing_for(&NextBillingForOptions {
        sub: &archived,
        today: "2026-11-18",
        charged_dates: &[],
    })
    .expect("next billing");
    assert_eq!(next, None);

    // Unarchiving brings it back without touching its status.
    let restored = test
        .store
        .apply_subscription_action(&home, SubscriptionAction::Unarchive, "2026-11-19", "")
        .expect("unarchive")
        .expect("found");
    assert!(!restored.subscription.archived);
    assert_eq!(restored.subscription.archived_at, None);
    assert_eq!(restored.subscription.status, SubscriptionStatus::Active);
}

#[test]
fn a_real_charge_and_the_billing_day_survive_an_export() {
    let mut test = TestStore::initialized();
    let state = test.store.app_state().expect("state");
    let cloud = by_name(&state, "Asistentes Cloud Go")
        .subscription
        .id
        .clone();

    test.store
        .add_charge(&ChargeInput {
            subscription_id: cloud.clone(),
            charge_date: "2026-11-08".to_string(),
            time: None,
            amount_minor: 950,
            currency: Currency::Eur,
            rate_scaled: None,
            note: Some("Cambio del banco".to_string()),
        })
        .expect("charge");
    let changed = test
        .store
        .update_subscription(
            &cloud,
            &SubscriptionPatch {
                billing_day: Some(Some(7)),
                ..Default::default()
            },
        )
        .expect("update")
        .expect("found");
    assert_eq!(changed.subscription.billing_day, Some(7));

    let with_changes = test.store.app_state().expect("state");
    assert_eq!(with_changes.charges.len(), 1);
    assert_eq!(with_changes.charges[0].amount_minor, 950);
    let updated = by_name(&with_changes, "Asistentes Cloud Go");
    assert_eq!(
        updated.billing_days.last().unwrap().billing_day,
        7,
        "the change is recorded in the history"
    );
    assert_eq!(
        updated.billing_days.last().unwrap().note,
        "Cambio de la fecha habitual de cobro."
    );

    let payload = test.store.export_all().expect("export");
    test.store.restore_all(&payload).expect("restore");
    let restored = test.store.app_state().expect("state");
    assert_eq!(restored.charges.len(), 1);
    assert_eq!(restored.charges[0].note, "Cambio del banco");
    let restored_sub = by_name(&restored, "Asistentes Cloud Go");
    assert_eq!(restored_sub.billing_days.len(), updated.billing_days.len());
    assert_eq!(restored_sub.subscription.billing_day, Some(7));
}

#[test]
fn a_charge_can_be_edited_and_deleted() {
    let mut test = TestStore::initialized();
    let state = test.store.app_state().expect("state");
    let web = by_name(&state, "Web ejemplo.dev").subscription.id.clone();

    let charge = test
        .store
        .add_charge(&ChargeInput {
            subscription_id: web.clone(),
            charge_date: "2026-03-21".to_string(),
            time: Some("09:30".to_string()),
            amount_minor: 1_299,
            currency: Currency::Usd,
            rate_scaled: Some(1_100_000),
            note: None,
        })
        .expect("charge");
    let edited = test
        .store
        .update_charge(
            &charge.id,
            &ChargeInput {
                subscription_id: web.clone(),
                charge_date: "2026-03-22".to_string(),
                time: Some("10:00".to_string()),
                amount_minor: 1_350,
                currency: Currency::Usd,
                rate_scaled: None,
                note: Some("Cargo de corrección".to_string()),
            },
        )
        .expect("update")
        .expect("found");
    assert_eq!(edited.charge_date, "2026-03-22");
    assert_eq!(edited.amount_minor, 1_350);
    // The moment it was recorded does not change on an edit.
    assert_eq!(edited.created_at, charge.created_at);
    assert!(test.store.delete_charge(&charge.id).expect("delete"));
    assert!(test.store.app_state().expect("state").charges.is_empty());
}

#[test]
fn exchange_rates_can_be_added_and_removed() {
    let mut test = TestStore::initialized();
    let rate = test
        .store
        .add_rate(&moxen_finances_store::RateInput {
            from_currency: Currency::Eur,
            to_currency: Currency::Usd,
            rate_scaled: 1_175_000,
            effective_from: "2026-12-01".to_string(),
            source: Some("Manual".to_string()),
            note: None,
        })
        .expect("rate");
    assert_eq!(rate.rate_scaled, 1_175_000);
    assert_eq!(test.store.app_state().expect("state").rates.len(), 3);
    assert!(test.store.delete_rate(&rate.id).expect("delete"));
    assert_eq!(test.store.app_state().expect("state").rates.len(), 2);
}

#[test]
fn the_account_keeps_its_opening_balance() {
    let mut test = TestStore::initialized();
    let account = test
        .store
        .update_account(&AccountPatch {
            name: Some("Cuenta".to_string()),
            balance_minor: Some(200_000),
            balance_date: Some("2026-11-18".to_string()),
            balance_set: Some(true),
            opening_balance_minor: Some(50_000),
            opening_balance_date: Some(Some("2026-06-01".to_string())),
            opening_balance_set: Some(true),
            notes: Some("Nota".to_string()),
        })
        .expect("account");
    assert_eq!(account.opening_balance_minor, 50_000);
    assert_eq!(account.opening_balance_date.as_deref(), Some("2026-06-01"));
    assert!(account.opening_balance_set);

    // A patch that does not mention the opening balance leaves it alone...
    let kept = test
        .store
        .update_account(&AccountPatch {
            balance_minor: Some(210_000),
            ..Default::default()
        })
        .expect("account");
    assert_eq!(kept.opening_balance_date.as_deref(), Some("2026-06-01"));
    assert!(kept.opening_balance_set);
    assert_eq!(kept.balance_minor, 210_000);

    // ...and `Some(None)` clears the date.
    let cleared = test
        .store
        .update_account(&AccountPatch {
            opening_balance_date: Some(None),
            ..Default::default()
        })
        .expect("account");
    assert_eq!(cleared.opening_balance_date, None);

    // The projection walks back to the opening balance for earlier months.
    test.store
        .update_account(&AccountPatch {
            opening_balance_date: Some(Some("2026-06-01".to_string())),
            ..Default::default()
        })
        .expect("account");
    let anchor = test.store.anchor("2026-07-01").expect("anchor");
    assert_eq!(anchor.balance_minor, 50_000);
    assert_eq!(anchor.balance_date, "2026-06-01");

    // A range that starts before the real balance is projected from the
    // opening balance and then clipped: it begins with the balance the day
    // before, not with the opening balance itself.
    let june = test
        .store
        .projection("2026-06-01", "2026-11-30")
        .expect("projection");
    let july = test
        .store
        .projection("2026-07-01", "2026-11-30")
        .expect("projection");
    assert_eq!(june.start_date, "2026-06-01");
    assert_eq!(june.start_balance_minor, 50_000);
    assert_eq!(july.start_date, "2026-07-01");
    let close_of_june_30 = june
        .days
        .iter()
        .find(|day| day.date == "2026-06-30")
        .expect("a day of June")
        .balance_minor;
    assert_eq!(july.start_balance_minor, close_of_june_30);
    assert!(
        july.events
            .iter()
            .all(|event| event.date.as_str() >= "2026-07-01"),
        "nothing before the range"
    );
}

#[test]
fn settings_are_upserted_and_listed_by_key() {
    let mut test = TestStore::initialized();
    assert_eq!(
        test.store
            .settings()
            .expect("settings")
            .iter()
            .find(|setting| setting.key == "mainCurrency")
            .map(|setting| setting.value.as_str()),
        Some("EUR")
    );
    test.store
        .update_setting("mainCurrency", "USD")
        .expect("update");
    test.store
        .update_setting("newKey", "value")
        .expect("create");
    let settings = test.store.settings().expect("settings");
    assert_eq!(
        settings
            .iter()
            .find(|setting| setting.key == "mainCurrency")
            .map(|setting| setting.value.as_str()),
        Some("USD")
    );
    assert_eq!(settings.len(), 4);
    assert_eq!(test.store.app_state().expect("state").settings.len(), 4);
}
