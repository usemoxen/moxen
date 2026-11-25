//! The first-run seed: the reference's FICTIONAL demo data
//! (`src/core/seed.ts` at 8aaad15b), so the app opens with something to look
//! at. Names, amounts and dates here are invented and belong to nobody. One
//! subscription is deliberately left without an amount and without a start
//! date so the projection warns about it.
//!
//! LOCAL-025 gives the demo THREE fictional accounts (a checking account, a
//! savings account and a credit card), the subscriptions spread over them,
//! and a couple of transfers between them.
//!
//! Written only when the database is created empty (see
//! [`crate::Store::initialize`]); an existing database is never reseeded.

use std::collections::BTreeMap;

use moxen_finances_core::dates;
use moxen_finances_core::types::{
    Account, AccountKind, AppState, BillingDayEntry, Currency, ExchangeRate, Frequency,
    PriceHistoryEntry, StatusHistoryEntry, Subscription, SubscriptionStatus,
    SubscriptionWithHistory, Transfer,
};

/// The note the demo exchange rates carry, so nobody mistakes them for a
/// real quote.
pub const REFERENCE_RATE_NOTE: &str =
    "Tipo de cambio de ejemplo (1 EUR = 1,10 USD). No es el valor real.";

/// A price the demo subscription already went through.
struct SeedPrice {
    price_minor: i64,
    effective_from: &'static str,
    effective_to: Option<&'static str>,
    note: &'static str,
}

/// One demo subscription, before it is given ids and timestamps.
struct SeedSubscription {
    name: &'static str,
    description: &'static str,
    price_minor: Option<i64>,
    currency: Currency,
    frequency: Frequency,
    start: Option<&'static str>,
    end: Option<&'static str>,
    /// Billing day when it differs from the start date's day.
    billing_day: Option<i64>,
    /// Known history; when it is empty a single entry is made from
    /// `price_minor`.
    price_history: &'static [SeedPrice],
    /// LOCAL-025: the account that pays for it (`SEED_ACCOUNT_CHECKING` or
    /// `SEED_ACCOUNT_CARD`).
    account: &'static str,
}

macro_rules! seed_price {
    ($price:expr, $from:expr, $to:expr, $note:expr) => {
        SeedPrice {
            price_minor: $price,
            effective_from: $from,
            effective_to: $to,
            note: $note,
        }
    };
}

/// The ids of the three FICTIONAL demo accounts, so the assignments below can
/// name them.
pub const SEED_ACCOUNT_CHECKING: &str = "seed-account-1";
pub const SEED_ACCOUNT_SAVINGS: &str = "seed-account-2";
pub const SEED_ACCOUNT_CARD: &str = "seed-account-3";

const SEED_SUBSCRIPTIONS: &[SeedSubscription] = &[
    SeedSubscription {
        name: "Mobilidad urbana",
        description: "Desplazamientos por la ciudad.",
        price_minor: None,
        currency: Currency::Eur,
        frequency: Frequency::Monthly,
        start: None,
        end: None,
        billing_day: None,
        price_history: &[],
        account: SEED_ACCOUNT_CHECKING,
    },
    SeedSubscription {
        name: "CorreoSeguro Pro",
        description: "Buzón privado con gestor de claves.",
        price_minor: Some(1899),
        currency: Currency::Eur,
        frequency: Frequency::Monthly,
        start: Some("2026-04-23"),
        end: None,
        billing_day: None,
        price_history: &[],
        account: SEED_ACCOUNT_CHECKING,
    },
    SeedSubscription {
        name: "Conversador IA",
        description: "Chat de inteligencia artificial de pago.",
        price_minor: Some(2400),
        currency: Currency::Eur,
        frequency: Frequency::Monthly,
        start: Some("2026-09-30"),
        end: None,
        billing_day: None,
        price_history: &[],
        account: SEED_ACCOUNT_CHECKING,
    },
    SeedSubscription {
        name: "Asistentes Cloud Go",
        description: "Plan de pago para un catálogo de asistentes.",
        price_minor: Some(1200),
        currency: Currency::Usd,
        frequency: Frequency::Monthly,
        start: Some("2026-10-08"),
        end: Some("2026-11-25"),
        billing_day: None,
        price_history: &[],
        account: SEED_ACCOUNT_CHECKING,
    },
    SeedSubscription {
        name: "Web ejemplo.dev",
        description: "Un sitio de ejemplo.",
        price_minor: Some(1299),
        currency: Currency::Usd,
        frequency: Frequency::Annual,
        start: Some("2026-03-21"),
        end: None,
        billing_day: None,
        price_history: &[],
        account: SEED_ACCOUNT_CHECKING,
    },
    SeedSubscription {
        name: "Soporte de sobremesa",
        description: "Soporte articulado de sobremesa.",
        price_minor: Some(1750),
        currency: Currency::Eur,
        frequency: Frequency::Monthly,
        start: Some("2026-09-28"),
        end: Some("2027-01-10"),
        billing_day: None,
        price_history: &[],
        account: SEED_ACCOUNT_CARD,
    },
    SeedSubscription {
        name: "Canciones en streaming",
        description: "Reproducción de audio en línea.",
        price_minor: Some(1049),
        currency: Currency::Eur,
        frequency: Frequency::Monthly,
        start: Some("2025-04-17"),
        end: Some("2026-12-10"),
        billing_day: None,
        price_history: &[
            seed_price!(
                949,
                "2025-04-17",
                Some("2026-07-16"),
                "Importe inicial del plan."
            ),
            seed_price!(
                1049,
                "2026-07-17",
                None,
                "Importe tras la revisión de julio de 2026."
            ),
        ],
        account: SEED_ACCOUNT_CARD,
    },
    SeedSubscription {
        name: "Almacén Nube",
        description: "Copia de seguridad en la nube.",
        price_minor: Some(400),
        currency: Currency::Usd,
        frequency: Frequency::Monthly,
        start: Some("2026-07-26"),
        end: None,
        billing_day: None,
        price_history: &[],
        account: SEED_ACCOUNT_CARD,
    },
    SeedSubscription {
        name: "Nube 400 GB",
        description: "Espacio compartido de 400 GB.",
        price_minor: Some(549),
        currency: Currency::Eur,
        frequency: Frequency::Monthly,
        start: Some("2025-02-14"),
        end: None,
        billing_day: Some(24),
        price_history: &[
            seed_price!(
                849,
                "2025-02-14",
                Some("2026-05-23"),
                "Importe inicial del plan."
            ),
            seed_price!(
                549,
                "2026-05-24",
                None,
                "Importe tras la revisión de mayo de 2026."
            ),
        ],
        account: SEED_ACCOUNT_CHECKING,
    },
    SeedSubscription {
        name: "Seguridad Hogar",
        description: "Protección para todos los dispositivos de casa.",
        price_minor: Some(4499),
        currency: Currency::Eur,
        frequency: Frequency::Annual,
        start: Some("2022-10-10"),
        end: None,
        billing_day: None,
        price_history: &[],
        account: SEED_ACCOUNT_CHECKING,
    },
];

/// The day of the month of a `YYYY-MM-DD` date, like the reference's
/// `Number(start.slice(8, 10))`.
fn day_of(date: &str) -> Option<i64> {
    date.get(8..10)?.parse().ok()
}

/// One of the three demo accounts, before the seed gives it a balance date.
fn seed_account(
    id: &str,
    name: &'static str,
    kind: AccountKind,
    sort_order: i64,
    today: &str,
) -> Account {
    Account {
        id: id.to_string(),
        name: name.to_string(),
        kind,
        currency: Currency::Eur,
        balance_minor: 0,
        balance_date: today.to_string(),
        balance_set: false,
        opening_balance_minor: 0,
        opening_balance_date: None,
        opening_balance_set: false,
        archived: false,
        sort_order,
        notes: String::new(),
    }
}

/// The demo accounts: a checking account, a savings account and a credit
/// card, all EUR and all FICTIONAL.
fn seed_accounts(today: &str) -> Vec<Account> {
    vec![
        seed_account(
            "seed-account-1",
            "Cuenta corriente",
            AccountKind::Checking,
            0,
            today,
        ),
        seed_account("seed-account-2", "Ahorro", AccountKind::Savings, 1, today),
        seed_account(
            "seed-account-3",
            "Tarjeta de crédito",
            AccountKind::CreditCard,
            2,
            today,
        ),
    ]
}

/// A couple of demo transfers: a saving the checking account makes every
/// month, and the payment of the credit card. FICTIONAL, always.
fn seed_transfers(now_iso: &str, today: &str) -> Vec<Transfer> {
    vec![
        Transfer {
            id: "seed-transfer-1".to_string(),
            date: today.to_string(),
            time: None,
            // 200,00 EUR from checking to savings.
            amount_minor: 20_000,
            currency: Currency::Eur,
            from_account_id: "seed-account-1".to_string(),
            to_account_id: "seed-account-2".to_string(),
            note: "Aportación al ahorro de ejemplo.".to_string(),
            created_at: now_iso.to_string(),
        },
        Transfer {
            id: "seed-transfer-2".to_string(),
            date: today.to_string(),
            time: None,
            // 50,00 EUR from checking to the credit card.
            amount_minor: 5_000,
            currency: Currency::Eur,
            from_account_id: "seed-account-1".to_string(),
            to_account_id: "seed-account-3".to_string(),
            note: "Pago de ejemplo de la tarjeta.".to_string(),
            created_at: now_iso.to_string(),
        },
    ]
}

/// The demo state, with the timestamps and the account date given, so a test
/// can reproduce it exactly.
pub fn build_seed_state_at(now_iso: &str, today: &str) -> AppState {
    let accounts = seed_accounts(today);
    let account = accounts
        .first()
        .cloned()
        .expect("the demo always has its first account");
    let subscriptions = SEED_SUBSCRIPTIONS
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let id = format!("seed-sub-{}", index + 1);
            let has_price = item.price_minor.is_some() && item.start.is_some();
            let billing_day = item.billing_day.or_else(|| item.start.and_then(day_of));

            let prices = if !item.price_history.is_empty() {
                item.price_history
                    .iter()
                    .enumerate()
                    .map(|(price_index, entry)| PriceHistoryEntry {
                        id: format!("seed-price-{}-{}", index + 1, price_index + 1),
                        subscription_id: id.clone(),
                        price_minor: entry.price_minor,
                        currency: item.currency,
                        effective_from: entry.effective_from.to_string(),
                        effective_to: entry.effective_to.map(str::to_string),
                        note: entry.note.to_string(),
                        created_at: now_iso.to_string(),
                    })
                    .collect()
            } else if has_price {
                vec![PriceHistoryEntry {
                    id: format!("seed-price-{}", index + 1),
                    subscription_id: id.clone(),
                    price_minor: item.price_minor.unwrap_or_default(),
                    currency: item.currency,
                    effective_from: item.start.unwrap_or_default().to_string(),
                    effective_to: None,
                    note: "Importe inicial de ejemplo.".to_string(),
                    created_at: now_iso.to_string(),
                }]
            } else {
                Vec::new()
            };

            let billing_days = match (item.start, billing_day) {
                (Some(start), Some(day)) => vec![BillingDayEntry {
                    id: format!("seed-billing-{}", index + 1),
                    subscription_id: id.clone(),
                    billing_day: day,
                    effective_from: start.to_string(),
                    note: "Día fijado en el alta.".to_string(),
                    created_at: now_iso.to_string(),
                }],
                _ => Vec::new(),
            };

            let status_history = match item.start {
                Some(start) => vec![StatusHistoryEntry {
                    id: format!("seed-status-{}", index + 1),
                    subscription_id: id.clone(),
                    status: SubscriptionStatus::Active,
                    date: start.to_string(),
                    note: "Alta inicial.".to_string(),
                    created_at: now_iso.to_string(),
                }],
                None => Vec::new(),
            };

            SubscriptionWithHistory {
                subscription: Subscription {
                    id,
                    name: item.name.to_string(),
                    description: item.description.to_string(),
                    currency: item.currency,
                    price_minor: item.price_minor,
                    frequency: item.frequency,
                    start_date: item.start.map(str::to_string),
                    billing_day,
                    next_billing_override: None,
                    end_date: item.end.map(str::to_string),
                    status: SubscriptionStatus::Active,
                    cancelled_at: None,
                    plan: None,
                    notes: String::new(),
                    external_payment: false,
                    account_id: item.account.to_string(),
                    archived: false,
                    archived_at: None,
                    created_at: now_iso.to_string(),
                    updated_at: now_iso.to_string(),
                },
                prices,
                plans: Vec::new(),
                pauses: Vec::new(),
                status_history,
                billing_days,
            }
        })
        .collect();

    let mut settings = BTreeMap::new();
    settings.insert("mainCurrency".to_string(), "EUR".to_string());
    settings.insert(
        "referenceRateNote".to_string(),
        REFERENCE_RATE_NOTE.to_string(),
    );
    settings.insert("lastBackupAt".to_string(), String::new());

    AppState {
        account,
        accounts,
        subscriptions,
        incomes: Vec::new(),
        expenses: Vec::new(),
        charges: Vec::new(),
        transfers: seed_transfers(now_iso, today),
        rates: vec![
            ExchangeRate {
                id: "seed-rate-eur-usd".to_string(),
                from_currency: Currency::Eur,
                to_currency: Currency::Usd,
                rate_scaled: 1_100_000,
                effective_from: "2026-11-01".to_string(),
                source: "Ejemplo".to_string(),
                note: REFERENCE_RATE_NOTE.to_string(),
                created_at: now_iso.to_string(),
            },
            ExchangeRate {
                id: "seed-rate-usd-eur".to_string(),
                from_currency: Currency::Usd,
                to_currency: Currency::Eur,
                rate_scaled: 909_091,
                effective_from: "2026-11-01".to_string(),
                source: "Ejemplo".to_string(),
                note: REFERENCE_RATE_NOTE.to_string(),
                created_at: now_iso.to_string(),
            },
        ],
        settings,
    }
}

/// The demo state for first run, stamped with the current clock.
pub fn build_seed_state() -> AppState {
    build_seed_state_at(&dates::now_utc_iso(), &dates::today_madrid_now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AppState {
        build_seed_state_at("2026-11-18T09:00:00.000Z", "2026-11-18")
    }

    #[test]
    fn the_demo_has_three_accounts_two_transfers_and_ten_subscriptions() {
        let state = state();
        assert_eq!(state.subscriptions.len(), 10);
        assert_eq!(state.rates.len(), 2);
        assert_eq!(state.transfers.len(), 2);
        // The first account is the checking one.
        assert_eq!(state.account.id, SEED_ACCOUNT_CHECKING);
        assert_eq!(state.account.balance_date, "2026-11-18");
        assert!(!state.account.balance_set);
        assert_eq!(
            state
                .accounts
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Cuenta corriente", "Ahorro", "Tarjeta de crédito"]
        );
        assert_eq!(
            state.accounts.iter().map(|a| a.kind).collect::<Vec<_>>(),
            vec![
                AccountKind::Checking,
                AccountKind::Savings,
                AccountKind::CreditCard
            ]
        );
        assert!(state.incomes.is_empty());
        assert!(state.expenses.is_empty());
        assert!(state.charges.is_empty());
        assert_eq!(state.settings.get("mainCurrency"), Some(&"EUR".to_string()));

        // Both transfers leave the checking account.
        assert!(
            state
                .transfers
                .iter()
                .all(|t| t.from_account_id == SEED_ACCOUNT_CHECKING)
        );
        assert!(
            state
                .transfers
                .iter()
                .any(|t| t.to_account_id == SEED_ACCOUNT_SAVINGS)
        );
        assert!(
            state
                .transfers
                .iter()
                .any(|t| t.to_account_id == SEED_ACCOUNT_CARD)
        );
    }

    #[test]
    fn the_demo_subscriptions_belong_to_their_paying_account() {
        let state = state();
        let when = |name: &str| {
            state
                .subscriptions
                .iter()
                .find(|sub| sub.subscription.name == name)
                .unwrap_or_else(|| panic!("no subscription named {name}"))
                .subscription
                .account_id
                .clone()
        };
        assert_eq!(when("CorreoSeguro Pro"), SEED_ACCOUNT_CHECKING);
        assert_eq!(when("Seguridad Hogar"), SEED_ACCOUNT_CHECKING);
        // The card pays three of them.
        assert_eq!(when("Soporte de sobremesa"), SEED_ACCOUNT_CARD);
        assert_eq!(when("Canciones en streaming"), SEED_ACCOUNT_CARD);
        assert_eq!(when("Almacén Nube"), SEED_ACCOUNT_CARD);
    }

    #[test]
    fn the_unfinished_demo_subscription_has_neither_price_nor_start() {
        let state = state();
        let mobility = state
            .subscriptions
            .iter()
            .find(|sub| sub.subscription.name == "Mobilidad urbana")
            .unwrap();
        assert_eq!(mobility.subscription.price_minor, None);
        assert_eq!(mobility.subscription.start_date, None);
        assert_eq!(mobility.subscription.billing_day, None);
        assert!(mobility.prices.is_empty());
        assert!(mobility.billing_days.is_empty());
        assert!(mobility.status_history.is_empty());
    }

    #[test]
    fn history_and_billing_days_match_the_reference_seed() {
        let state = state();
        let cloud = state
            .subscriptions
            .iter()
            .find(|sub| sub.subscription.name == "Asistentes Cloud Go")
            .unwrap();
        assert_eq!(cloud.subscription.currency, Currency::Usd);
        assert_eq!(cloud.subscription.end_date.as_deref(), Some("2026-11-25"));
        assert_eq!(cloud.subscription.billing_day, Some(8));
        assert_eq!(cloud.prices.len(), 1);
        assert_eq!(cloud.prices[0].note, "Importe inicial de ejemplo.");

        let storage = state
            .subscriptions
            .iter()
            .find(|sub| sub.subscription.name == "Nube 400 GB")
            .unwrap();
        // The billing day differs from the start date's day on purpose.
        assert_eq!(storage.subscription.billing_day, Some(24));
        assert_eq!(storage.prices.len(), 2);
        assert_eq!(storage.prices[0].price_minor, 849);
        assert_eq!(
            storage.prices[0].effective_to.as_deref(),
            Some("2026-05-23")
        );
        assert_eq!(storage.prices[1].price_minor, 549);
        assert_eq!(storage.billing_days[0].billing_day, 24);
        assert_eq!(storage.billing_days[0].effective_from, "2025-02-14");
        assert_eq!(storage.status_history[0].date, "2025-02-14");
        assert_eq!(storage.status_history[0].status, SubscriptionStatus::Active);
    }

    #[test]
    fn ids_follow_the_reference_scheme() {
        let state = state();
        // The first demo subscription has no start date, so it has no history
        // rows at all; the ids below come from the second.
        assert_eq!(state.subscriptions[0].subscription.id, "seed-sub-1");
        assert!(state.subscriptions[0].billing_days.is_empty());
        assert_eq!(state.subscriptions[1].subscription.id, "seed-sub-2");
        assert_eq!(state.subscriptions[1].billing_days[0].id, "seed-billing-2");
        assert_eq!(state.subscriptions[1].status_history[0].id, "seed-status-2");
        assert_eq!(state.subscriptions[1].prices[0].id, "seed-price-2");
        // A history keeps one id per entry.
        let storage = &state.subscriptions[8];
        assert_eq!(storage.prices[0].id, "seed-price-9-1");
        assert_eq!(storage.prices[1].id, "seed-price-9-2");
    }
}
