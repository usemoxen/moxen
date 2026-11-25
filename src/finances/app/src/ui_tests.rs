//! Render tests over the REAL `StoreData` on a temp SQLite database: the
//! window renders every page, account switching works live, and a mutation
//! through the shell's command path shows up in the next frame — with the
//! error banner, never a panic, when the store refuses.
//!
//! These run under plain `cargo test --workspace`: the dev-dependency on
//! `gpui` with `test-support` turns the test build into a headless GPUI app.

use crate::store_data::StoreData;
use gpui::{Entity, TestAppContext, VisualTestContext};
use moxen_finances_ui::commands::{FinancesMutations, MovementDraft, SubscriptionAction};
use moxen_finances_ui::data::{
    AccountSelection, Currency, FinancesData, Frequency, MovementKind, MovementStatus,
    SubscriptionStatus,
};
use moxen_finances_ui::language::Language;
use moxen_finances_ui::shell::{FinancesApp, Page};
use std::rc::Rc;

/// Draws a frame, so `debug_bounds` sees the rendered elements.
fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

/// A window over a real, seeded `StoreData` on a temp database, with the same
/// object shared as the read and the write side, like `main` does.
fn store_window(
    cx: &mut TestAppContext,
) -> (
    Entity<FinancesApp>,
    &mut VisualTestContext,
    Rc<StoreData>,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().expect("temp dir");
    let shared =
        Rc::new(StoreData::initialize(dir.path().join("finances.db")).expect("seeded store"));
    let reads: Rc<dyn FinancesData> = shared.clone();
    let writes: Rc<dyn FinancesMutations> = shared.clone();
    let (app, cx) =
        cx.add_window_view(|_window, _cx| FinancesApp::new(reads, Some("en"), Some(writes)));
    (app, cx, shared, dir)
}

#[gpui::test]
fn every_page_renders_over_the_real_store(cx: &mut TestAppContext) {
    let (app, cx, _shared, _dir) = store_window(cx);
    cx.run_until_parked();
    draw(cx);
    #[cfg(debug_assertions)]
    {
        assert!(cx.debug_bounds("nav").is_some());
        assert!(cx.debug_bounds("account-selector").is_some());
        assert!(cx.debug_bounds("dashboard").is_some());
    }
    // The seeded store shows its three accounts in the selector.
    cx.update(|_, cx| assert_eq!(app.read(cx).data.accounts().len(), 3));
    for page in Page::ALL {
        cx.update(|_, cx| {
            app.update(cx, |app, cx| app.set_page(page, cx));
        });
        cx.run_until_parked();
        draw(cx);
        #[cfg(debug_assertions)]
        assert!(
            cx.debug_bounds(page.id()).is_some(),
            "page {} did not render over the store",
            page.id()
        );
        // Spanish renders too.
        cx.update(|_, cx| {
            app.update(cx, |app, cx| app.set_language(Language::Spanish, cx));
        });
        cx.run_until_parked();
        draw(cx);
        cx.update(|_, cx| {
            app.update(cx, |app, cx| app.set_language(Language::English, cx));
        });
    }
    // The settings page shows the database path and accepts commands.
    cx.update(|_, cx| {
        app.update(cx, |app, cx| app.set_page(Page::Settings, cx));
    });
    cx.run_until_parked();
    cx.update(|_, cx| {
        let app = app.read(cx);
        assert!(
            app.data
                .database_path()
                .is_some_and(|path| path.ends_with("finances.db"))
        );
        assert!(app.can_mutate());
    });
}

#[gpui::test]
fn account_switching_and_a_live_mutation_repaint_the_window(cx: &mut TestAppContext) {
    let (app, cx, _shared, _dir) = store_window(cx);
    cx.run_until_parked();

    // Switch to the second account: the reads scope to it immediately.
    let savings = cx.update(|_, cx| {
        let accounts = app.read(cx).data.accounts();
        accounts.get(1).expect("second account").id.clone()
    });
    cx.update(|_, cx| {
        app.update(cx, |app, cx| {
            app.select_account(AccountSelection::One(savings.clone()), cx)
        });
    });
    cx.run_until_parked();
    draw(cx);
    cx.update(|_, cx| {
        let app = app.read(cx);
        assert_eq!(app.account, AccountSelection::One(savings.clone()));
        assert!(app.error.is_none());
        // The scoped view holds fewer subscriptions than the aggregate.
        assert!(app.data.subscriptions().len() < 10);
    });
    #[cfg(debug_assertions)]
    assert!(cx.debug_bounds("account-selector").is_some());

    // Back to all accounts, then pause a subscription through the shell's
    // command path: the snapshot refreshes and the next frame shows it.
    cx.update(|_, cx| {
        app.update(cx, |app, cx| app.select_account(AccountSelection::All, cx));
    });
    cx.run_until_parked();
    let sub_id = cx.update(|_, cx| app.read(cx).data.subscriptions()[0].id.clone());
    cx.update(|_, cx| {
        app.update(cx, |app, cx| {
            app.subscription_action(&sub_id, SubscriptionAction::Pause, cx);
        });
    });
    cx.run_until_parked();
    draw(cx);
    cx.update(|_, cx| {
        let app = app.read(cx);
        assert!(app.error.is_none());
        let subscriptions = app.data.subscriptions();
        let sub = subscriptions
            .iter()
            .find(|s| s.id == sub_id)
            .expect("subscription still listed");
        assert_eq!(sub.status, SubscriptionStatus::Paused);
    });

    // A refused command (deleting an account that has movements) surfaces as
    // a banner, not a panic.
    let checking = cx.update(|_, cx| app.read(cx).data.accounts()[0].id.clone());
    cx.update(|_, cx| {
        app.update(cx, |app, cx| {
            app.run_mutation(cx, |m| m.delete_account(&checking));
        });
    });
    cx.run_until_parked();
    draw(cx);
    cx.update(|_, cx| {
        let app = app.read(cx);
        assert!(app.error.is_some(), "the refusal became a banner");
        assert_eq!(app.data.accounts().len(), 3, "nothing was deleted");
    });
    #[cfg(debug_assertions)]
    assert!(cx.debug_bounds("feedback").is_some());
}

#[gpui::test]
fn a_movement_created_through_the_command_path_appears_in_the_list(cx: &mut TestAppContext) {
    let (app, cx, _shared, _dir) = store_window(cx);
    cx.run_until_parked();
    cx.update(|_, cx| {
        app.update(cx, |app, cx| app.set_page(Page::Movements, cx));
    });
    cx.run_until_parked();
    let (before, today) = cx.update(|_, cx| {
        let app = app.read(cx);
        (app.data.movements().len(), app.data.today())
    });
    cx.update(|_, cx| {
        app.update(cx, |app, cx| {
            app.run_mutation(cx, |m| {
                m.create_movement(&MovementDraft {
                    id: None,
                    kind: MovementKind::Expense,
                    name: "Compra de prueba".into(),
                    subscription_id: None,
                    category: Some("Compras".into()),
                    amount_minor: 4_200,
                    currency: Currency::Eur,
                    date: today,
                    time: None,
                    frequency: Frequency::Once,
                    end_date: None,
                    status: MovementStatus::Pending,
                    notes: None,
                })
            });
        });
    });
    cx.run_until_parked();
    draw(cx);
    cx.update(|_, cx| {
        let app = app.read(cx);
        assert!(app.error.is_none());
        let movements = app.data.movements();
        assert_eq!(movements.len(), before + 1);
        assert!(
            movements
                .iter()
                .any(|m| m.name == "Compra de prueba" && m.status == MovementStatus::Pending)
        );
    });
    #[cfg(debug_assertions)]
    assert!(cx.debug_bounds("movements").is_some());
}
