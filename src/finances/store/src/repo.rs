//! The repository for the account, subscriptions and the whole state:
//! `getAppState`, `updateAccount` and the subscription operations of the
//! reference's `src/server/repo.ts` (8aaad15b), as methods on [`Store`].
//!
//! The column names, the defaults applied to unexpected values, the `ORDER BY`
//! of every list, the notes written on each history row and the audit entries
//! all match the reference, so the same data and the same history come out of
//! either implementation. Every write that touches more than one row (a
//! subscription with its price, its status history and its billing day; a row
//! plus its audit entry) runs in one transaction here, which the reference
//! only did for some of them.

use std::collections::BTreeMap;

use rusqlite::{Connection, params};
use serde::Serialize;

use moxen_finances_core::dates::{compare_iso_dates, today_madrid_now};
use moxen_finances_core::types::{
    Account, AppState, BillingDayEntry, Currency, Frequency, PauseEntry, PlanHistoryEntry,
    PriceHistoryEntry, Setting, StatusHistoryEntry, Subscription, SubscriptionStatus,
    SubscriptionWithHistory,
};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::row::{
    AuditEntry, log_audit, map_account, map_audit, map_billing_day, map_charge, map_expense,
    map_income, map_pause, map_plan, map_price, map_rate, map_status_history, map_subscription,
    new_id, now, text,
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// The effective-dated history of one subscription.
struct SubscriptionParts {
    prices: Vec<PriceHistoryEntry>,
    plans: Vec<PlanHistoryEntry>,
    pauses: Vec<PauseEntry>,
    status_history: Vec<StatusHistoryEntry>,
    billing_days: Vec<BillingDayEntry>,
}

fn subscription_parts(conn: &Connection, subscription_id: &str) -> Result<SubscriptionParts> {
    let mut statement = conn.prepare(
        "SELECT * FROM subscription_prices WHERE subscription_id = ?
         ORDER BY effective_from ASC, created_at ASC",
    )?;
    let mut rows = statement.query([subscription_id])?;
    let mut prices = Vec::new();
    while let Some(row) = rows.next()? {
        prices.push(map_price(row));
    }

    let mut statement = conn.prepare(
        "SELECT * FROM subscription_plans WHERE subscription_id = ?
         ORDER BY effective_from ASC, created_at ASC",
    )?;
    let mut rows = statement.query([subscription_id])?;
    let mut plans = Vec::new();
    while let Some(row) = rows.next()? {
        plans.push(map_plan(row));
    }

    let mut statement = conn.prepare(
        "SELECT * FROM subscription_pauses WHERE subscription_id = ?
         ORDER BY start_date ASC, created_at ASC",
    )?;
    let mut rows = statement.query([subscription_id])?;
    let mut pauses = Vec::new();
    while let Some(row) = rows.next()? {
        pauses.push(map_pause(row));
    }

    let mut statement = conn.prepare(
        "SELECT * FROM subscription_status_history WHERE subscription_id = ?
         ORDER BY date ASC, created_at ASC",
    )?;
    let mut rows = statement.query([subscription_id])?;
    let mut status_history = Vec::new();
    while let Some(row) = rows.next()? {
        status_history.push(map_status_history(row));
    }

    let mut statement = conn.prepare(
        "SELECT * FROM subscription_billing_days WHERE subscription_id = ?
         ORDER BY effective_from ASC, created_at ASC",
    )?;
    let mut rows = statement.query([subscription_id])?;
    let mut billing_days = Vec::new();
    while let Some(row) = rows.next()? {
        billing_days.push(map_billing_day(row));
    }

    Ok(SubscriptionParts {
        prices,
        plans,
        pauses,
        status_history,
        billing_days,
    })
}

/// A subscription with everything its history tables hold.
pub(crate) fn with_history(
    conn: &Connection,
    subscription: Subscription,
) -> Result<SubscriptionWithHistory> {
    let parts = subscription_parts(conn, &subscription.id)?;
    Ok(SubscriptionWithHistory {
        subscription,
        prices: parts.prices,
        plans: parts.plans,
        pauses: parts.pauses,
        status_history: parts.status_history,
        billing_days: parts.billing_days,
    })
}

/// The account, or the reference's empty one when the table has no row.
pub(crate) fn read_account(conn: &Connection) -> Result<Account> {
    let mut statement = conn.prepare("SELECT * FROM account ORDER BY rowid ASC LIMIT 1")?;
    let mut rows = statement.query([])?;
    match rows.next()? {
        Some(row) => Ok(map_account(row)),
        None => Ok(Account {
            id: "account-primary".to_string(),
            name: "Cuenta principal".to_string(),
            currency: Currency::Eur,
            balance_minor: 0,
            balance_date: "1970-01-01".to_string(),
            balance_set: false,
            opening_balance_minor: 0,
            opening_balance_date: None,
            opening_balance_set: false,
            notes: String::new(),
        }),
    }
}

pub(crate) fn read_subscription_row(conn: &Connection, id: &str) -> Result<Option<Subscription>> {
    let mut statement = conn.prepare("SELECT * FROM subscriptions WHERE id = ?")?;
    let mut rows = statement.query([id])?;
    Ok(rows.next()?.map(map_subscription))
}

/// `getAppState`: everything the views read, in the reference's order.
pub fn app_state(conn: &Connection) -> Result<AppState> {
    let account = read_account(conn)?;

    let mut statement =
        conn.prepare("SELECT * FROM subscriptions ORDER BY sort_order ASC, created_at ASC")?;
    let mut rows = statement.query([])?;
    let mut subscriptions = Vec::new();
    while let Some(row) = rows.next()? {
        subscriptions.push(with_history(conn, map_subscription(row))?);
    }

    let mut statement = conn.prepare("SELECT * FROM incomes ORDER BY date ASC, created_at ASC")?;
    let mut rows = statement.query([])?;
    let mut incomes = Vec::new();
    while let Some(row) = rows.next()? {
        incomes.push(map_income(row));
    }

    let mut statement = conn.prepare("SELECT * FROM expenses ORDER BY date ASC, created_at ASC")?;
    let mut rows = statement.query([])?;
    let mut expenses = Vec::new();
    while let Some(row) = rows.next()? {
        expenses.push(map_expense(row));
    }

    let mut statement =
        conn.prepare("SELECT * FROM exchange_rates ORDER BY effective_from ASC, created_at ASC")?;
    let mut rows = statement.query([])?;
    let mut rates = Vec::new();
    while let Some(row) = rows.next()? {
        rates.push(map_rate(row));
    }

    let mut statement = conn
        .prepare("SELECT * FROM subscription_charges ORDER BY charge_date ASC, created_at ASC")?;
    let mut rows = statement.query([])?;
    let mut charges = Vec::new();
    while let Some(row) = rows.next()? {
        charges.push(map_charge(row));
    }

    let mut statement = conn.prepare("SELECT * FROM settings")?;
    let mut rows = statement.query([])?;
    let mut settings = BTreeMap::new();
    while let Some(row) = rows.next()? {
        settings.insert(text(row, "key", ""), text(row, "value", ""));
    }

    Ok(AppState {
        account,
        subscriptions,
        incomes,
        expenses,
        rates,
        charges,
        settings,
    })
}

pub(crate) fn read_settings(conn: &Connection) -> Result<Vec<Setting>> {
    let mut statement = conn.prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
    let mut rows = statement.query([])?;
    let mut settings = Vec::new();
    while let Some(row) = rows.next()? {
        settings.push(Setting {
            key: text(row, "key", ""),
            value: text(row, "value", ""),
        });
    }
    Ok(settings)
}

pub(crate) fn read_audit(conn: &Connection, limit: usize) -> Result<Vec<AuditEntry>> {
    let mut statement = conn.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?")?;
    let mut rows = statement.query([limit as i64])?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next()? {
        entries.push(map_audit(row));
    }
    Ok(entries)
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/// `AccountPatch`: absent fields leave the current value alone. The nested
/// `Option` on `opening_balance_date` is the reference's `undefined` (leave)
/// versus `null` (clear).
#[derive(Debug, Clone, Default)]
pub struct AccountPatch {
    pub name: Option<String>,
    pub balance_minor: Option<i64>,
    pub balance_date: Option<String>,
    pub balance_set: Option<bool>,
    pub opening_balance_minor: Option<i64>,
    pub opening_balance_date: Option<Option<String>>,
    pub opening_balance_set: Option<bool>,
    pub notes: Option<String>,
}

/// `updateAccount`: the account is the one row the whole app balances from,
/// created by the seed and only ever updated. The opening balance is what
/// lets the projection cover months before the current balance was taken.
pub(crate) fn update_account(conn: &Connection, patch: &AccountPatch) -> Result<Account> {
    let current = read_account(conn)?;
    let next = Account {
        id: current.id.clone(),
        name: patch.name.clone().unwrap_or(current.name),
        currency: current.currency,
        balance_minor: patch.balance_minor.unwrap_or(current.balance_minor),
        balance_date: patch.balance_date.clone().unwrap_or(current.balance_date),
        balance_set: patch.balance_set.unwrap_or(current.balance_set),
        opening_balance_minor: patch
            .opening_balance_minor
            .unwrap_or(current.opening_balance_minor),
        opening_balance_date: match &patch.opening_balance_date {
            Some(date) => date.clone(),
            None => current.opening_balance_date,
        },
        opening_balance_set: patch
            .opening_balance_set
            .unwrap_or(current.opening_balance_set),
        notes: patch.notes.clone().unwrap_or(current.notes),
    };

    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "UPDATE account SET name = ?, balance_minor = ?, balance_date = ?, balance_set = ?,
           opening_balance_minor = ?, opening_balance_date = ?, opening_balance_set = ?, notes = ?
         WHERE id = ?",
        params![
            next.name,
            next.balance_minor,
            next.balance_date,
            next.balance_set,
            next.opening_balance_minor,
            next.opening_balance_date,
            next.opening_balance_set,
            next.notes,
            next.id
        ],
    )?;
    log_audit(&transaction, "account", &next.id, "update", &next, &stamped)?;
    transaction.commit()?;
    Ok(next)
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/// `SubscriptionInput`: what the form sends to create one. Absent fields take
/// the reference's defaults (monthly, EUR, active, no price, no start date).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInput {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<Currency>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_minor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency: Option<Frequency>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub billing_day: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_billing_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_payment: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<SubscriptionStatus>,
}

impl SubscriptionInput {
    /// A subscription with only a name; everything else takes the
    /// reference's defaults.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: None,
            currency: None,
            price_minor: None,
            frequency: None,
            start_date: None,
            billing_day: None,
            next_billing_override: None,
            end_date: None,
            plan: None,
            notes: None,
            external_payment: None,
            status: None,
        }
    }
}

/// `updateSubscription`'s patch: every field optional, and the nullable ones
/// nested so "leave it" (`None`) and "clear it" (`Some(None)`) are different,
/// exactly like `undefined` versus `null` in the reference.
#[derive(Debug, Clone, Default)]
pub struct SubscriptionPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub currency: Option<Currency>,
    pub price_minor: Option<Option<i64>>,
    pub frequency: Option<Frequency>,
    pub start_date: Option<Option<String>>,
    pub billing_day: Option<Option<i64>>,
    pub next_billing_override: Option<Option<String>>,
    pub end_date: Option<Option<String>>,
    pub plan: Option<Option<String>>,
    pub notes: Option<String>,
    pub external_payment: Option<bool>,
    pub status: Option<SubscriptionStatus>,
    pub cancelled_at: Option<Option<String>>,
    pub archived: Option<bool>,
    pub archived_at: Option<Option<String>>,
}

/// `patch !== undefined ? patch : current` for a nullable field.
fn applied<T: Clone>(patch: &Option<Option<T>>, current: Option<T>) -> Option<T> {
    match patch {
        Some(value) => value.clone(),
        None => current,
    }
}

/// The day of the month of a `YYYY-MM-DD` date, like the reference's
/// `Number(startDate.slice(8, 10))`.
fn day_of(date: &str) -> Option<i64> {
    date.get(8..10)?.parse().ok()
}

pub(crate) fn create_subscription(
    conn: &Connection,
    input: &SubscriptionInput,
) -> Result<SubscriptionWithHistory> {
    let stamped = now();
    let id = new_id(conn)?;
    let frequency = input.frequency.unwrap_or(Frequency::Monthly);
    let currency = input.currency.unwrap_or(Currency::Eur);
    let status = input.status.unwrap_or(SubscriptionStatus::Active);
    let billing_day = input
        .billing_day
        .or_else(|| input.start_date.as_deref().and_then(day_of));

    let transaction = conn.unchecked_transaction()?;
    let sort_order: i64 =
        transaction.query_row("SELECT COUNT(*) AS count FROM subscriptions", [], |row| {
            row.get(0)
        })?;
    transaction.execute(
        "INSERT INTO subscriptions
          (id, name, description, currency, price_minor, frequency, start_date, billing_day,
           next_billing_override, end_date, status, cancelled_at, plan, notes, external_payment,
           archived, archived_at, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            input.name,
            input.description.as_deref().unwrap_or(""),
            currency.as_str(),
            input.price_minor,
            frequency.as_str(),
            input.start_date,
            billing_day,
            input.next_billing_override,
            input.end_date,
            status.as_str(),
            None::<String>,
            input.plan,
            input.notes.as_deref().unwrap_or(""),
            input.external_payment.unwrap_or(false),
            false,
            None::<String>,
            sort_order,
            stamped,
            stamped
        ],
    )?;

    if let (Some(price_minor), Some(start_date)) = (input.price_minor, input.start_date.as_ref()) {
        transaction.execute(
            "INSERT INTO subscription_prices
              (id, subscription_id, price_minor, currency, effective_from, effective_to, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                new_id(&transaction)?,
                id,
                price_minor,
                currency.as_str(),
                start_date,
                None::<String>,
                "Primer precio registrado.",
                stamped
            ],
        )?;
    }

    let status_date = input.start_date.clone().unwrap_or_else(today_madrid_now);
    transaction.execute(
        "INSERT INTO subscription_status_history
          (id, subscription_id, status, date, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            new_id(&transaction)?,
            id,
            status.as_str(),
            status_date,
            "Suscripción creada.",
            stamped
        ],
    )?;

    if let Some(billing_day) = billing_day {
        transaction.execute(
            "INSERT INTO subscription_billing_days
              (id, subscription_id, billing_day, effective_from, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                new_id(&transaction)?,
                id,
                billing_day,
                input.start_date.clone().unwrap_or_else(today_madrid_now),
                "Día de cobro inicial.",
                stamped
            ],
        )?;
    }

    log_audit(&transaction, "subscription", &id, "create", input, &stamped)?;
    transaction.commit()?;

    match read_subscription_row(conn, &id)? {
        Some(subscription) => Ok(with_history(conn, subscription)?),
        None => Err(StoreError::NotFound {
            entity: "suscripción",
            id,
        }),
    }
}

pub(crate) fn update_subscription(
    conn: &Connection,
    id: &str,
    patch: &SubscriptionPatch,
) -> Result<Option<SubscriptionWithHistory>> {
    let Some(current) = read_subscription_row(conn, id)? else {
        return Ok(None);
    };
    let stamped = now();

    let next = Subscription {
        id: current.id.clone(),
        name: patch.name.clone().unwrap_or(current.name),
        description: patch.description.clone().unwrap_or(current.description),
        currency: patch.currency.unwrap_or(current.currency),
        price_minor: applied(&patch.price_minor, current.price_minor),
        frequency: patch.frequency.unwrap_or(current.frequency),
        start_date: applied(&patch.start_date, current.start_date),
        billing_day: applied(&patch.billing_day, current.billing_day),
        next_billing_override: applied(&patch.next_billing_override, current.next_billing_override),
        end_date: applied(&patch.end_date, current.end_date),
        status: patch.status.unwrap_or(current.status),
        cancelled_at: applied(&patch.cancelled_at, current.cancelled_at),
        plan: applied(&patch.plan, current.plan),
        notes: patch.notes.clone().unwrap_or(current.notes),
        external_payment: patch.external_payment.unwrap_or(current.external_payment),
        archived: patch.archived.unwrap_or(current.archived),
        archived_at: applied(&patch.archived_at, current.archived_at),
        updated_at: stamped.clone(),
        created_at: current.created_at.clone(),
    };

    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "UPDATE subscriptions SET
           name = ?, description = ?, currency = ?, price_minor = ?, frequency = ?,
           start_date = ?, billing_day = ?, next_billing_override = ?, end_date = ?,
           status = ?, cancelled_at = ?, plan = ?, notes = ?, external_payment = ?, archived = ?,
           archived_at = ?, updated_at = ?
         WHERE id = ?",
        params![
            next.name,
            next.description,
            next.currency.as_str(),
            next.price_minor,
            next.frequency.as_str(),
            next.start_date,
            next.billing_day,
            next.next_billing_override,
            next.end_date,
            next.status.as_str(),
            next.cancelled_at,
            next.plan,
            next.notes,
            next.external_payment,
            next.archived,
            next.archived_at,
            next.updated_at,
            id
        ],
    )?;

    if next.billing_day.is_some() && next.billing_day != current.billing_day {
        transaction.execute(
            "INSERT INTO subscription_billing_days
              (id, subscription_id, billing_day, effective_from, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                new_id(&transaction)?,
                id,
                next.billing_day,
                today_madrid_now(),
                "Cambio de la fecha habitual de cobro.",
                stamped
            ],
        )?;
    }

    log_audit(&transaction, "subscription", id, "update", &next, &stamped)?;
    transaction.commit()?;

    match read_subscription_row(conn, id)? {
        Some(subscription) => Ok(Some(with_history(conn, subscription)?)),
        None => Ok(None),
    }
}

/// `addPrice`: a new effective-dated price, without touching the history that
/// came before it. The subscription's current price follows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceInput {
    pub price_minor: i64,
    pub currency: Currency,
    pub effective_from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub(crate) fn add_price(
    conn: &Connection,
    subscription_id: &str,
    entry: &PriceInput,
) -> Result<PriceHistoryEntry> {
    let stamped = now();
    let id = new_id(conn)?;
    let note = entry.note.clone().unwrap_or_default();

    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO subscription_prices
          (id, subscription_id, price_minor, currency, effective_from, effective_to, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            subscription_id,
            entry.price_minor,
            entry.currency.as_str(),
            entry.effective_from,
            entry.effective_to,
            note,
            stamped
        ],
    )?;
    transaction.execute(
        "UPDATE subscriptions SET price_minor = ?, currency = ?, updated_at = ? WHERE id = ?",
        params![
            entry.price_minor,
            entry.currency.as_str(),
            stamped,
            subscription_id
        ],
    )?;
    log_audit(
        &transaction,
        "subscription",
        subscription_id,
        "price-change",
        entry,
        &stamped,
    )?;
    transaction.commit()?;

    Ok(PriceHistoryEntry {
        id,
        subscription_id: subscription_id.to_string(),
        price_minor: entry.price_minor,
        currency: entry.currency,
        effective_from: entry.effective_from.clone(),
        effective_to: entry.effective_to.clone(),
        note,
        created_at: stamped,
    })
}

/// `addPlan`: a plan change, optionally with the new price that came with it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    pub plan: String,
    pub effective_from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_minor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<Currency>,
}

pub(crate) fn add_plan(
    conn: &Connection,
    subscription_id: &str,
    entry: &PlanInput,
) -> Result<PlanHistoryEntry> {
    let Some(current) = read_subscription_row(conn, subscription_id)? else {
        return Err(StoreError::NotFound {
            entity: "suscripción",
            id: subscription_id.to_string(),
        });
    };
    let stamped = now();
    let id = new_id(conn)?;
    let note = entry.note.clone().unwrap_or_default();

    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO subscription_plans (id, subscription_id, plan, effective_from, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            id,
            subscription_id,
            entry.plan,
            entry.effective_from,
            note,
            stamped
        ],
    )?;

    match entry.price_minor {
        Some(price_minor) => {
            let currency = entry.currency.unwrap_or(current.currency);
            let plan_note = format!("Cambio de plan: {}", entry.plan);
            transaction.execute(
                "INSERT INTO subscription_prices
                  (id, subscription_id, price_minor, currency, effective_from, effective_to, note, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    new_id(&transaction)?,
                    subscription_id,
                    price_minor,
                    currency.as_str(),
                    entry.effective_from,
                    None::<String>,
                    plan_note,
                    stamped
                ],
            )?;
            transaction.execute(
                "UPDATE subscriptions SET plan = ?, price_minor = ?, currency = ?, updated_at = ? WHERE id = ?",
                params![entry.plan, price_minor, currency.as_str(), stamped, subscription_id],
            )?;
            log_audit(
                &transaction,
                "subscription",
                subscription_id,
                "price-change",
                &PriceInput {
                    price_minor,
                    currency,
                    effective_from: entry.effective_from.clone(),
                    effective_to: None,
                    note: Some(plan_note),
                },
                &stamped,
            )?;
        }
        None => {
            transaction.execute(
                "UPDATE subscriptions SET plan = ?, updated_at = ? WHERE id = ?",
                params![entry.plan, stamped, subscription_id],
            )?;
        }
    }
    log_audit(
        &transaction,
        "subscription",
        subscription_id,
        "plan-change",
        entry,
        &stamped,
    )?;
    transaction.commit()?;

    Ok(PlanHistoryEntry {
        id,
        subscription_id: subscription_id.to_string(),
        plan: entry.plan.clone(),
        effective_from: entry.effective_from.clone(),
        note,
        created_at: stamped,
    })
}

/// The actions the subscription screen offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SubscriptionAction {
    Pause,
    Resume,
    Cancel,
    Finish,
    Archive,
    Unarchive,
    Reactivate,
}

impl SubscriptionAction {
    /// The action name, as the audit log and the API spell it.
    pub fn as_str(&self) -> &'static str {
        match self {
            SubscriptionAction::Pause => "pause",
            SubscriptionAction::Resume => "resume",
            SubscriptionAction::Cancel => "cancel",
            SubscriptionAction::Finish => "finish",
            SubscriptionAction::Archive => "archive",
            SubscriptionAction::Unarchive => "unarchive",
            SubscriptionAction::Reactivate => "reactivate",
        }
    }
}

fn log_status_history(
    conn: &Connection,
    subscription_id: &str,
    status: SubscriptionStatus,
    date: &str,
    note: &str,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO subscription_status_history (id, subscription_id, status, date, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            new_id(conn)?,
            subscription_id,
            status.as_str(),
            date,
            note,
            created_at
        ],
    )?;
    Ok(())
}

/// `applySubscriptionAction`: pause, resume, cancel, finish, archive,
/// unarchive and reactivate, each with the status-history row the reference
/// records for it.
pub(crate) fn apply_subscription_action(
    conn: &Connection,
    id: &str,
    action: SubscriptionAction,
    date: &str,
    note: &str,
) -> Result<Option<SubscriptionWithHistory>> {
    let Some(current) = read_subscription_row(conn, id)? else {
        return Ok(None);
    };
    let open_pause = subscription_parts(conn, id)?
        .pauses
        .into_iter()
        .find(|pause| pause.end_date.is_none());
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;

    let mut status = current.status;
    let mut cancelled_at = current.cancelled_at.clone();
    let mut end_date = current.end_date.clone();
    let mut archived = current.archived;
    let mut archived_at = current.archived_at.clone();
    let default_note = |text: &'static str| -> String {
        if note.is_empty() {
            text.to_string()
        } else {
            note.to_string()
        }
    };

    match action {
        SubscriptionAction::Pause => {
            transaction.execute(
                "INSERT INTO subscription_pauses (id, subscription_id, start_date, end_date, note, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![
                    new_id(&transaction)?,
                    id,
                    date,
                    None::<String>,
                    default_note("Pausa"),
                    stamped
                ],
            )?;
            status = SubscriptionStatus::Paused;
            log_status_history(
                &transaction,
                id,
                SubscriptionStatus::Paused,
                date,
                &default_note("Pausada"),
                &stamped,
            )?;
        }
        SubscriptionAction::Resume => {
            if let Some(open) = &open_pause {
                transaction.execute(
                    "UPDATE subscription_pauses SET end_date = ? WHERE id = ?",
                    params![date, open.id],
                )?;
            }
            status = SubscriptionStatus::Active;
            log_status_history(
                &transaction,
                id,
                SubscriptionStatus::Active,
                date,
                &default_note("Reanudada"),
                &stamped,
            )?;
        }
        SubscriptionAction::Cancel => {
            status = SubscriptionStatus::Cancelled;
            cancelled_at = Some(date.to_string());
            log_status_history(
                &transaction,
                id,
                SubscriptionStatus::Cancelled,
                date,
                &default_note("Cancelada"),
                &stamped,
            )?;
        }
        SubscriptionAction::Finish => {
            // Finishing stops the charges on the chosen date even when another
            // end date was planned.
            status = SubscriptionStatus::Finished;
            end_date = Some(date.to_string());
            log_status_history(
                &transaction,
                id,
                SubscriptionStatus::Finished,
                date,
                &default_note("Finalizada"),
                &stamped,
            )?;
        }
        SubscriptionAction::Archive => {
            archived = true;
            archived_at = Some(date.to_string());
        }
        SubscriptionAction::Unarchive => {
            archived = false;
            archived_at = None;
        }
        SubscriptionAction::Reactivate => {
            let today = today_madrid_now();
            if let Some(open) = &open_pause {
                transaction.execute(
                    "UPDATE subscription_pauses SET end_date = ? WHERE id = ?",
                    params![today, open.id],
                )?;
            }
            // An end date already gone must not stop it charging again.
            let expired_end = current
                .end_date
                .as_deref()
                .is_some_and(|end| compare_iso_dates(end, &today) != std::cmp::Ordering::Greater);
            status = SubscriptionStatus::Active;
            cancelled_at = None;
            end_date = if expired_end {
                None
            } else {
                current.end_date.clone()
            };
            archived = false;
            archived_at = None;
            log_status_history(
                &transaction,
                id,
                SubscriptionStatus::Active,
                date,
                &default_note("Reactivada"),
                &stamped,
            )?;
        }
    }

    transaction.execute(
        "UPDATE subscriptions SET status = ?, cancelled_at = ?, end_date = ?, archived = ?,
           archived_at = ?, updated_at = ? WHERE id = ?",
        params![
            status.as_str(),
            cancelled_at,
            end_date,
            archived,
            archived_at,
            stamped,
            id
        ],
    )?;

    log_audit(
        &transaction,
        "subscription",
        id,
        action.as_str(),
        &AuditAction { date, note },
        &stamped,
    )?;
    transaction.commit()?;

    match read_subscription_row(conn, id)? {
        Some(subscription) => Ok(Some(with_history(conn, subscription)?)),
        None => Ok(None),
    }
}

/// The payload the reference writes for an action: `{ date, note }`.
#[derive(Debug, Clone, Serialize)]
struct AuditAction<'a> {
    date: &'a str,
    note: &'a str,
}

pub(crate) fn delete_subscription(conn: &Connection, id: &str) -> Result<bool> {
    let Some(current) = read_subscription_row(conn, id)? else {
        return Ok(false);
    };
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    log_audit(
        &transaction,
        "subscription",
        id,
        "delete",
        &current,
        &stamped,
    )?;
    // ON DELETE CASCADE takes the price, plan, pause, status and billing-day
    // rows with it, which is why foreign keys must be on.
    transaction.execute("DELETE FROM subscriptions WHERE id = ?", [id])?;
    transaction.commit()?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Settings and the audit log
// ---------------------------------------------------------------------------

pub(crate) fn update_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The public API: the same operations, as methods on Store
// ---------------------------------------------------------------------------

impl Store {
    /// Everything the views read.
    pub fn app_state(&self) -> Result<AppState> {
        app_state(self.connection())
    }

    /// The account, even when the table has no row yet.
    pub fn account(&self) -> Result<Account> {
        read_account(self.connection())
    }

    /// A subscription with its whole history, `None` when the id is gone.
    pub fn subscription(&self, id: &str) -> Result<Option<SubscriptionWithHistory>> {
        match read_subscription_row(self.connection(), id)? {
            Some(subscription) => Ok(Some(with_history(self.connection(), subscription)?)),
            None => Ok(None),
        }
    }

    /// Every setting, ordered by key.
    pub fn settings(&self) -> Result<Vec<Setting>> {
        read_settings(self.connection())
    }

    /// The newest audit entries, newest first.
    pub fn audit_log(&self, limit: usize) -> Result<Vec<AuditEntry>> {
        read_audit(self.connection(), limit)
    }

    /// Change the account: its name, its balance, its opening balance or its
    /// notes. Absent fields keep their value.
    pub fn update_account(&mut self, patch: &AccountPatch) -> Result<Account> {
        update_account(self.connection(), patch)
    }

    /// Set one setting, creating it when it is new.
    pub fn update_setting(&mut self, key: &str, value: &str) -> Result<()> {
        update_setting(self.connection(), key, value)
    }

    pub fn create_subscription(
        &mut self,
        input: &SubscriptionInput,
    ) -> Result<SubscriptionWithHistory> {
        create_subscription(self.connection(), input)
    }

    pub fn update_subscription(
        &mut self,
        id: &str,
        patch: &SubscriptionPatch,
    ) -> Result<Option<SubscriptionWithHistory>> {
        update_subscription(self.connection(), id, patch)
    }

    /// A new price from an effective date, keeping the previous ones.
    pub fn add_price(
        &mut self,
        subscription_id: &str,
        entry: &PriceInput,
    ) -> Result<PriceHistoryEntry> {
        add_price(self.connection(), subscription_id, entry)
    }

    /// A plan change from an effective date, optionally with its new price.
    pub fn add_plan(
        &mut self,
        subscription_id: &str,
        entry: &PlanInput,
    ) -> Result<PlanHistoryEntry> {
        add_plan(self.connection(), subscription_id, entry)
    }

    /// Pause, resume, cancel, finish, archive, unarchive or reactivate.
    pub fn apply_subscription_action(
        &mut self,
        id: &str,
        action: SubscriptionAction,
        date: &str,
        note: &str,
    ) -> Result<Option<SubscriptionWithHistory>> {
        apply_subscription_action(self.connection(), id, action, date, note)
    }

    /// Remove a subscription and its history (the foreign keys cascade).
    pub fn delete_subscription(&mut self, id: &str) -> Result<bool> {
        delete_subscription(self.connection(), id)
    }

    /// The open connection, for this crate's other modules. Kept out of the
    /// public API on purpose: callers use the operations above, never SQL.
    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }
}
