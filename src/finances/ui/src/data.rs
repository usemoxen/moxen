//! The view-model boundary: plain structs the views read through the
//! [`FinancesData`] trait. Money stays in integer minor units (cents). The
//! `core` and `store` crates plug in behind this trait (through the app's
//! `StoreData` adapter, LOCAL-030) without the views changing: this module
//! knows nothing about SQLite, rusqlite or the store's own types. Writes go
//! through the plain-DTO commands of [`crate::commands`].

use crate::language;
use chrono::NaiveDate;
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Currency {
    Eur,
    Usd,
}

impl Currency {
    /// The ISO code, as shown next to an account's name.
    pub fn code(self) -> &'static str {
        match self {
            Currency::Eur => "EUR",
            Currency::Usd => "USD",
        }
    }

    /// Every currency the UI can offer, in picker order.
    pub const ALL: [Currency; 2] = [Currency::Eur, Currency::Usd];
}

/// An amount in minor units of its currency (cents).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Money {
    pub minor: i64,
    pub currency: Currency,
}

impl Money {
    pub const fn eur(minor: i64) -> Self {
        Money {
            minor,
            currency: Currency::Eur,
        }
    }

    pub const fn usd(minor: i64) -> Self {
        Money {
            minor,
            currency: Currency::Usd,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frequency {
    Once,
    Weekly,
    Monthly,
    Quarterly,
    Annual,
}

impl Frequency {
    pub fn key(self) -> &'static str {
        match self {
            Frequency::Once => "freq.once",
            Frequency::Weekly => "freq.weekly",
            Frequency::Monthly => "freq.monthly",
            Frequency::Quarterly => "freq.quarterly",
            Frequency::Annual => "freq.annual",
        }
    }

    /// Every frequency the forms offer, in picker order.
    pub const ALL: [Frequency; 5] = [
        Frequency::Once,
        Frequency::Weekly,
        Frequency::Monthly,
        Frequency::Quarterly,
        Frequency::Annual,
    ];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubscriptionStatus {
    Active,
    Paused,
    Cancelled,
    Finished,
}

impl SubscriptionStatus {
    pub fn key(self) -> &'static str {
        match self {
            SubscriptionStatus::Active => "sub.status.active",
            SubscriptionStatus::Paused => "sub.status.paused",
            SubscriptionStatus::Cancelled => "sub.status.cancelled",
            SubscriptionStatus::Finished => "sub.status.finished",
        }
    }

    /// The token color the status chip uses.
    pub fn token(self) -> &'static str {
        match self {
            SubscriptionStatus::Active => "added",
            SubscriptionStatus::Paused => "held",
            SubscriptionStatus::Cancelled => "broken",
            SubscriptionStatus::Finished => "label-8",
        }
    }
}

/// A piece of demo text that exists in both interface languages.
#[derive(Clone, Copy, Debug)]
pub struct LocalizedText {
    pub en: &'static str,
    pub es: &'static str,
}

impl LocalizedText {
    pub fn get(&self) -> &'static str {
        if language::spanish() {
            self.es
        } else {
            self.en
        }
    }
}

#[derive(Clone, Debug)]
pub struct Subscription {
    pub id: String,
    pub name: String,
    pub description: LocalizedText,
    /// Current price; `None` while it is pending confirmation.
    pub price: Option<Money>,
    pub frequency: Frequency,
    pub status: SubscriptionStatus,
    pub next_charge: Option<NaiveDate>,
    /// First day the subscription no longer charges (exclusive), if known.
    pub end_date: Option<NaiveDate>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MovementKind {
    Income,
    Expense,
    /// A real charge recorded for a subscription's billing day.
    Charge,
}

impl MovementKind {
    pub fn key(self) -> &'static str {
        match self {
            MovementKind::Income => "mov.kind.income",
            MovementKind::Expense => "mov.kind.expense",
            MovementKind::Charge => "mov.kind.charge",
        }
    }
}

/// Income: expected/received. Expense: planned/pending/done. A charge is a
/// real record; `NotCharged` marks a real charge of 0 (the cycle was not
/// billed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MovementStatus {
    Expected,
    Received,
    Planned,
    Pending,
    Done,
    NotCharged,
}

impl MovementStatus {
    pub fn key(self) -> &'static str {
        match self {
            MovementStatus::Expected => "mov.status.expected",
            MovementStatus::Received => "mov.status.received",
            MovementStatus::Planned => "mov.status.planned",
            MovementStatus::Pending => "mov.status.pending",
            MovementStatus::Done => "mov.status.done",
            MovementStatus::NotCharged => "mov.status.notcharged",
        }
    }

    /// The token color the status dot uses.
    pub fn token(self) -> &'static str {
        match self {
            MovementStatus::Expected | MovementStatus::Planned => "label-8",
            MovementStatus::Pending => "held",
            MovementStatus::Received | MovementStatus::Done => "added",
            MovementStatus::NotCharged => "label-8",
        }
    }
}

/// One recorded movement: an income, an expense or a real charge of a
/// subscription. Recurring ones (`frequency` != `Once`) repeat until
/// `end_date` (exclusive).
#[derive(Clone, Debug)]
pub struct Movement {
    pub id: String,
    pub kind: MovementKind,
    /// The concept; for charges, the subscription's name.
    pub name: String,
    pub subscription_id: Option<String>,
    pub category: Option<LocalizedText>,
    pub amount: Money,
    pub date: NaiveDate,
    /// Optional local time (HH:mm), only to order movements of the same day.
    pub time: Option<String>,
    pub frequency: Frequency,
    pub end_date: Option<NaiveDate>,
    pub status: MovementStatus,
    /// A paused recurring income stops projecting until resumed.
    pub paused: bool,
    pub notes: Option<LocalizedText>,
}

/// The kind of account, as the account row stores it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountKind {
    Checking,
    Savings,
    CreditCard,
    Cash,
}

impl AccountKind {
    pub fn key(self) -> &'static str {
        match self {
            AccountKind::Checking => "account.kind.checking",
            AccountKind::Savings => "account.kind.savings",
            AccountKind::CreditCard => "account.kind.credit-card",
            AccountKind::Cash => "account.kind.cash",
        }
    }

    /// Every kind the account form offers, in picker order.
    pub const ALL: [AccountKind; 4] = [
        AccountKind::Checking,
        AccountKind::Savings,
        AccountKind::CreditCard,
        AccountKind::Cash,
    ];
}

/// What the account selector shows for one account. The balance is in the
/// account's own currency, so it never needs a conversion.
#[derive(Clone, Debug)]
pub struct AccountInfo {
    pub id: String,
    pub name: String,
    pub kind: AccountKind,
    pub currency: Currency,
    pub archived: bool,
    pub balance: Money,
}

/// Which account the pages are looking at: one of them, or the aggregate
/// "all accounts" view (whose totals are converted, and flagged approximate
/// when an exchange rate is missing).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountSelection {
    All,
    One(String),
}

impl AccountSelection {
    pub fn is_all(&self) -> bool {
        matches!(self, AccountSelection::All)
    }
}

/// Interns a string once, so user-entered text can live in a
/// `&'static str` field without leaking on every render.
fn intern(text: &str) -> &'static str {
    use std::sync::{LazyLock, Mutex};
    static CACHE: LazyLock<Mutex<std::collections::HashMap<String, &'static str>>> =
        LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
    let mut cache = CACHE.lock().expect("category intern cache");
    cache
        .entry(text.to_string())
        .or_insert_with(|| Box::leak(text.to_string().into_boxed_str()))
}

/// User-entered text (a note, a description) shown as-is in both interface
/// languages.
pub fn passthrough_localized(text: &str) -> LocalizedText {
    let passthrough = intern(text);
    LocalizedText {
        en: passthrough,
        es: passthrough,
    }
}

/// A category the store keeps as plain text (the reference's categories are
/// Spanish) turned into the pair the interface shows in either language.
/// Unknown categories pass through unchanged, in both languages.
pub fn category_localized(stored: &str) -> LocalizedText {
    let known: &[(&str, &str, &str)] = &[
        ("Nómina", "Salary", "Nómina"),
        ("Ayudas", "Grants", "Ayudas"),
        ("Autónomo", "Freelance", "Autónomo"),
        ("Devoluciones", "Refunds", "Devoluciones"),
        ("Hogar", "Home", "Hogar"),
        ("Transporte", "Transport", "Transporte"),
        ("Compras", "Groceries", "Compras"),
        ("Ocio", "Leisure", "Ocio"),
        ("Salud", "Health", "Salud"),
        ("Educación", "Education", "Educación"),
        ("Regalos", "Gifts", "Regalos"),
        ("Suscripciones", "Subscriptions", "Suscripciones"),
        ("Otros", "Other", "Otros"),
    ];
    for (stored_name, en, es) in known {
        if stored == *stored_name {
            return LocalizedText { en, es };
        }
    }
    let passthrough = intern(stored);
    LocalizedText {
        en: passthrough,
        es: passthrough,
    }
}

#[derive(Clone, Debug)]
pub struct UpcomingCharge {
    pub subscription_id: String,
    pub name: String,
    /// `None` when the subscription's price is still pending.
    pub amount: Option<Money>,
    pub date: NaiveDate,
}

#[derive(Clone, Debug)]
pub struct BalancePoint {
    pub date: NaiveDate,
    pub balance: Money,
}

#[derive(Clone, Debug)]
pub struct MonthSummary {
    pub year: i32,
    pub month: u32,
    pub spent: Money,
    pub recurring: Money,
    pub upcoming: usize,
}

/// Everything the views need, behind one trait. The collections come back as
/// shared slices, so a store-backed implementation can swap its snapshot
/// after a write and the next render reads the fresh one.
pub trait FinancesData {
    fn today(&self) -> NaiveDate;
    /// The real balance of the selected account, with the date it refers to.
    fn balance(&self) -> Money;
    fn balance_date(&self) -> NaiveDate;
    /// The expected balance at the end of the month.
    fn month_end_forecast(&self) -> Money;
    fn month_summary(&self) -> MonthSummary;
    /// Charges expected soon, soonest first.
    fn upcoming_charges(&self) -> Rc<[UpcomingCharge]>;
    fn subscriptions(&self) -> Rc<[Subscription]>;
    /// Past balances for the dashboard chart, oldest first.
    fn balance_history(&self) -> Rc<[BalancePoint]>;
    /// The selected account's currency; every total the views show is in it.
    fn account_currency(&self) -> Currency {
        Currency::Eur
    }
    /// The rate used to convert `from` into `to`: `1 from = rate to`.
    /// Must return 1.0 when both currencies are the same, and when no rate is
    /// known (the unconverted amount is then shown and flagged approximate).
    fn exchange_rate(&self, from: Currency, to: Currency) -> f64;
    /// All recorded movements of the selected scope: incomes, expenses and
    /// real charges (plus the transfers of one account, as movements).
    fn movements(&self) -> Rc<[Movement]>;
    /// False while the data is still loading; the pages show skeletons.
    fn is_ready(&self) -> bool {
        true
    }
    // -- LOCAL-030: multi-account and store wiring ---------------------------
    /// Every account, in the user's order (archived ones included, so the
    /// settings page can offer them).
    fn accounts(&self) -> Rc<[AccountInfo]> {
        Rc::from([])
    }
    /// True when the "all accounts" total had to fall back without an
    /// exchange rate: the badge the selector shows next to the total.
    fn total_approximate(&self) -> bool {
        false
    }
    /// The database file behind the data, when there is one (the Settings
    /// page shows it). `None` for the demo data.
    fn database_path(&self) -> Option<String> {
        None
    }
}
