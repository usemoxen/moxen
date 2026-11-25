//! The view-model boundary: plain structs the views read through the
//! [`FinancesData`] trait. Money stays in integer minor units (cents). The
//! `core` and `store` crates will implement this trait later without the
//! views changing.

use crate::language;
use chrono::NaiveDate;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Currency {
    Eur,
    Usd,
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

/// Everything the views need, behind one trait.
pub trait FinancesData {
    fn today(&self) -> NaiveDate;
    /// The real balance of the account, with the date it refers to.
    fn balance(&self) -> Money;
    fn balance_date(&self) -> NaiveDate;
    /// The expected balance at the end of the month.
    fn month_end_forecast(&self) -> Money;
    fn month_summary(&self) -> MonthSummary;
    /// Charges expected soon, soonest first.
    fn upcoming_charges(&self) -> &[UpcomingCharge];
    fn subscriptions(&self) -> &[Subscription];
    /// Past balances for the dashboard chart, oldest first.
    fn balance_history(&self) -> &[BalancePoint];
    /// The account's currency; every total the views show is in it.
    fn account_currency(&self) -> Currency {
        Currency::Eur
    }
    /// The rate used to convert `from` into `to`: `1 from = rate to`.
    /// Must return 1.0 when both currencies are the same.
    fn exchange_rate(&self, from: Currency, to: Currency) -> f64;
    /// All recorded movements: incomes, expenses and real charges.
    fn movements(&self) -> &[Movement];
    /// False while the data is still loading; the pages show skeletons.
    fn is_ready(&self) -> bool {
        true
    }
}
