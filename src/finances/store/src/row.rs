//! Reading a row the way the reference does, and the plumbing every write
//! needs: ids, timestamps and the audit entry.
//!
//! `asString`, `asInt`, `asNullableInt` and `asBool` in `repo.ts` fall back to
//! a default when the stored value is not the type they expect, instead of
//! failing. The helpers here do the same by inspecting SQLite's storage class,
//! so a database holding an unexpected value (an old import, a hand-edited
//! row) still opens.

use rusqlite::types::ValueRef;
use rusqlite::{Connection, Row, params};
use serde::Serialize;

use moxen_finances_core::dates::now_utc_iso;
use moxen_finances_core::types::{
    Account, AccountKind, ActualCharge, BillingDayEntry, Currency, ExchangeRate, Expense,
    ExpenseStatus, Frequency, Income, IncomeStatus, PauseEntry, PlanHistoryEntry,
    PriceHistoryEntry, StatusHistoryEntry, Subscription, SubscriptionStatus, Transfer,
};

use crate::error::Result;

/// The reference's `asString(value, fallback)`.
pub(crate) fn text(row: &Row<'_>, column: &str, fallback: &str) -> String {
    match row.get_ref(column) {
        Ok(ValueRef::Text(bytes)) => String::from_utf8_lossy(bytes).into_owned(),
        _ => fallback.to_owned(),
    }
}

/// The reference's `asNullableString(value)`.
fn optional_text(row: &Row<'_>, column: &str) -> Option<String> {
    match row.get_ref(column) {
        Ok(ValueRef::Text(bytes)) => Some(String::from_utf8_lossy(bytes).into_owned()),
        _ => None,
    }
}

/// The reference's `asInt(value, fallback)`.
fn integer(row: &Row<'_>, column: &str, fallback: i64) -> i64 {
    match row.get_ref(column) {
        Ok(ValueRef::Integer(value)) => value,
        Ok(ValueRef::Real(value)) if value.fract() == 0.0 => value as i64,
        _ => fallback,
    }
}

/// The reference's `asNullableInt(value)`.
fn optional_integer(row: &Row<'_>, column: &str) -> Option<i64> {
    match row.get_ref(column) {
        Ok(ValueRef::Integer(value)) => Some(value),
        Ok(ValueRef::Real(value)) if value.fract() == 0.0 => Some(value as i64),
        _ => None,
    }
}

/// The reference's `asBool(value)`: true only for SQLite's `1` (and the real
/// `1.0`, which JavaScript's `value === 1` also accepts).
fn boolean(row: &Row<'_>, column: &str) -> bool {
    match row.get_ref(column) {
        Ok(ValueRef::Integer(1)) => true,
        Ok(ValueRef::Real(value)) => value == 1.0,
        _ => false,
    }
}

fn currency(row: &Row<'_>, column: &str, fallback: Currency) -> Currency {
    match optional_text(row, column).as_deref() {
        Some("EUR") => Currency::Eur,
        Some("USD") => Currency::Usd,
        _ => fallback,
    }
}

fn frequency(row: &Row<'_>, column: &str, fallback: Frequency) -> Frequency {
    match optional_text(row, column).as_deref() {
        Some("once") => Frequency::Once,
        Some("weekly") => Frequency::Weekly,
        Some("monthly") => Frequency::Monthly,
        Some("quarterly") => Frequency::Quarterly,
        Some("annual") => Frequency::Annual,
        _ => fallback,
    }
}

/// The status of a subscription or of a status-history row.
pub(crate) fn subscription_status(
    row: &Row<'_>,
    column: &str,
    fallback: SubscriptionStatus,
) -> SubscriptionStatus {
    match optional_text(row, column).as_deref() {
        Some("active") => SubscriptionStatus::Active,
        Some("paused") => SubscriptionStatus::Paused,
        Some("cancelled") => SubscriptionStatus::Cancelled,
        Some("finished") => SubscriptionStatus::Finished,
        _ => fallback,
    }
}

fn income_status(row: &Row<'_>, column: &str) -> IncomeStatus {
    match optional_text(row, column).as_deref() {
        Some("received") => IncomeStatus::Received,
        _ => IncomeStatus::Expected,
    }
}

fn expense_status(row: &Row<'_>, column: &str) -> ExpenseStatus {
    match optional_text(row, column).as_deref() {
        Some("pending") => ExpenseStatus::Pending,
        Some("done") => ExpenseStatus::Done,
        // The reference's fallback is 'planned', not 'done'.
        _ => ExpenseStatus::Planned,
    }
}

/// The kind of an account row; an unknown value reads as checking.
fn account_kind(row: &Row<'_>, column: &str) -> AccountKind {
    match optional_text(row, column).as_deref() {
        Some("savings") => AccountKind::Savings,
        Some("credit-card") => AccountKind::CreditCard,
        Some("cash") => AccountKind::Cash,
        _ => AccountKind::Checking,
    }
}

pub(crate) fn map_account(row: &Row<'_>) -> Account {
    Account {
        id: text(row, "id", ""),
        name: text(row, "name", "Cuenta principal"),
        kind: account_kind(row, "kind"),
        currency: currency(row, "currency", Currency::Eur),
        balance_minor: integer(row, "balance_minor", 0),
        balance_date: text(row, "balance_date", ""),
        balance_set: boolean(row, "balance_set"),
        opening_balance_minor: integer(row, "opening_balance_minor", 0),
        opening_balance_date: optional_text(row, "opening_balance_date"),
        opening_balance_set: boolean(row, "opening_balance_set"),
        archived: boolean(row, "archived"),
        sort_order: integer(row, "sort_order", 0),
        notes: text(row, "notes", ""),
    }
}

pub(crate) fn map_transfer(row: &Row<'_>) -> Transfer {
    Transfer {
        id: text(row, "id", ""),
        date: text(row, "date", ""),
        time: optional_text(row, "time"),
        amount_minor: integer(row, "amount_minor", 0),
        currency: currency(row, "currency", Currency::Eur),
        from_account_id: text(row, "from_account_id", ""),
        to_account_id: text(row, "to_account_id", ""),
        note: text(row, "note", ""),
        created_at: text(row, "created_at", ""),
    }
}

pub(crate) fn map_subscription(row: &Row<'_>) -> Subscription {
    Subscription {
        id: text(row, "id", ""),
        name: text(row, "name", ""),
        description: text(row, "description", ""),
        currency: currency(row, "currency", Currency::Eur),
        price_minor: optional_integer(row, "price_minor"),
        frequency: frequency(row, "frequency", Frequency::Monthly),
        start_date: optional_text(row, "start_date"),
        billing_day: optional_integer(row, "billing_day"),
        next_billing_override: optional_text(row, "next_billing_override"),
        end_date: optional_text(row, "end_date"),
        status: subscription_status(row, "status", SubscriptionStatus::Active),
        cancelled_at: optional_text(row, "cancelled_at"),
        plan: optional_text(row, "plan"),
        notes: text(row, "notes", ""),
        external_payment: boolean(row, "external_payment"),
        account_id: text(row, "account_id", ""),
        archived: boolean(row, "archived"),
        archived_at: optional_text(row, "archived_at"),
        created_at: text(row, "created_at", ""),
        updated_at: text(row, "updated_at", ""),
    }
}

pub(crate) fn map_price(row: &Row<'_>) -> PriceHistoryEntry {
    PriceHistoryEntry {
        id: text(row, "id", ""),
        subscription_id: text(row, "subscription_id", ""),
        price_minor: integer(row, "price_minor", 0),
        currency: currency(row, "currency", Currency::Eur),
        effective_from: text(row, "effective_from", ""),
        effective_to: optional_text(row, "effective_to"),
        note: text(row, "note", ""),
        created_at: text(row, "created_at", ""),
    }
}

pub(crate) fn map_plan(row: &Row<'_>) -> PlanHistoryEntry {
    PlanHistoryEntry {
        id: text(row, "id", ""),
        subscription_id: text(row, "subscription_id", ""),
        plan: text(row, "plan", ""),
        effective_from: text(row, "effective_from", ""),
        note: text(row, "note", ""),
        created_at: text(row, "created_at", ""),
    }
}

pub(crate) fn map_pause(row: &Row<'_>) -> PauseEntry {
    PauseEntry {
        id: text(row, "id", ""),
        subscription_id: text(row, "subscription_id", ""),
        start_date: text(row, "start_date", ""),
        end_date: optional_text(row, "end_date"),
        note: text(row, "note", ""),
        created_at: text(row, "created_at", ""),
    }
}

pub(crate) fn map_billing_day(row: &Row<'_>) -> BillingDayEntry {
    BillingDayEntry {
        id: text(row, "id", ""),
        subscription_id: text(row, "subscription_id", ""),
        billing_day: integer(row, "billing_day", 1),
        effective_from: text(row, "effective_from", ""),
        note: text(row, "note", ""),
        created_at: text(row, "created_at", ""),
    }
}

pub(crate) fn map_status_history(row: &Row<'_>) -> StatusHistoryEntry {
    // The reference casts whatever is stored, with no fallback.
    StatusHistoryEntry {
        id: text(row, "id", ""),
        subscription_id: text(row, "subscription_id", ""),
        status: subscription_status(row, "status", SubscriptionStatus::Active),
        date: text(row, "date", ""),
        note: text(row, "note", ""),
        created_at: text(row, "created_at", ""),
    }
}

pub(crate) fn map_income(row: &Row<'_>) -> Income {
    Income {
        id: text(row, "id", ""),
        concept: text(row, "concept", ""),
        amount_minor: integer(row, "amount_minor", 0),
        currency: currency(row, "currency", Currency::Eur),
        date: text(row, "date", ""),
        time: optional_text(row, "time"),
        frequency: frequency(row, "frequency", Frequency::Once),
        end_date: optional_text(row, "end_date"),
        status: income_status(row, "status"),
        paused: boolean(row, "paused"),
        notes: text(row, "notes", ""),
        actual_amount_minor: optional_integer(row, "actual_amount_minor"),
        account_id: text(row, "account_id", ""),
        created_at: text(row, "created_at", ""),
    }
}

pub(crate) fn map_expense(row: &Row<'_>) -> Expense {
    Expense {
        id: text(row, "id", ""),
        concept: text(row, "concept", ""),
        category: text(row, "category", "Otros"),
        amount_minor: integer(row, "amount_minor", 0),
        currency: currency(row, "currency", Currency::Eur),
        date: text(row, "date", ""),
        time: optional_text(row, "time"),
        frequency: frequency(row, "frequency", Frequency::Once),
        end_date: optional_text(row, "end_date"),
        status: expense_status(row, "status"),
        notes: text(row, "notes", ""),
        actual_amount_minor: optional_integer(row, "actual_amount_minor"),
        account_id: text(row, "account_id", ""),
        created_at: text(row, "created_at", ""),
    }
}

pub(crate) fn map_charge(row: &Row<'_>) -> ActualCharge {
    ActualCharge {
        id: text(row, "id", ""),
        subscription_id: text(row, "subscription_id", ""),
        charge_date: text(row, "charge_date", ""),
        time: optional_text(row, "time"),
        amount_minor: integer(row, "amount_minor", 0),
        currency: currency(row, "currency", Currency::Eur),
        rate_scaled: optional_integer(row, "rate_scaled"),
        note: text(row, "note", ""),
        account_id: text(row, "account_id", ""),
        created_at: text(row, "created_at", ""),
    }
}

pub(crate) fn map_rate(row: &Row<'_>) -> ExchangeRate {
    ExchangeRate {
        id: text(row, "id", ""),
        from_currency: currency(row, "from_currency", Currency::Eur),
        to_currency: currency(row, "to_currency", Currency::Usd),
        rate_scaled: integer(row, "rate_scaled", 0),
        effective_from: text(row, "effective_from", ""),
        source: text(row, "source", ""),
        note: text(row, "note", ""),
        created_at: text(row, "created_at", ""),
    }
}

/// An audit row. The reference returns the raw row; this is the same data,
/// typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub entity: String,
    pub entity_id: String,
    pub action: String,
    /// The JSON the reference wrote with `JSON.stringify`.
    pub payload: String,
    pub created_at: String,
}

pub(crate) fn map_audit(row: &Row<'_>) -> AuditEntry {
    AuditEntry {
        id: text(row, "id", ""),
        entity: text(row, "entity", ""),
        entity_id: text(row, "entity_id", ""),
        action: text(row, "action", ""),
        payload: text(row, "payload", ""),
        created_at: text(row, "created_at", ""),
    }
}

/// A fresh `randomUUID()`-shaped id: UUID v4, lowercase.
///
/// The randomness comes from SQLite's `randomblob`, so no UUID crate (and no
/// entropy dependency) is needed; the version and variant bits are set here.
pub(crate) fn new_id(conn: &Connection) -> Result<String> {
    let bytes: Vec<u8> = conn.query_row("SELECT randomblob(16)", [], |row| row.get(0))?;
    Ok(uuid_v4(&bytes))
}

fn uuid_v4(bytes: &[u8]) -> String {
    let mut raw = [0_u8; 16];
    // `cycle` rather than an index: a short blob cannot panic here.
    for (slot, value) in raw.iter_mut().zip(bytes.iter().cycle()) {
        *slot = *value;
    }
    raw[6] = (raw[6] & 0x0f) | 0x40;
    raw[8] = (raw[8] & 0x3f) | 0x80;
    let hex: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `new Date().toISOString()`, via core's clock.
pub(crate) fn now() -> String {
    now_utc_iso()
}

/// `logAudit`: one row per change, with `JSON.stringify(payload ?? {})`.
pub(crate) fn log_audit(
    conn: &Connection,
    entity: &str,
    entity_id: &str,
    action: &str,
    payload: &impl Serialize,
    created_at: &str,
) -> Result<()> {
    let payload = serde_json::to_string(payload)?;
    conn.execute(
        "INSERT INTO audit_log (id, entity, entity_id, action, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            new_id(conn)?,
            entity,
            entity_id,
            action,
            payload,
            created_at
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_lowercase_uuid_v4() {
        let connection = Connection::open_in_memory().unwrap();
        let id = new_id(&connection).unwrap();
        assert_eq!(id.len(), 36);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|part| part.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(parts[2].starts_with('4'), "{id}");
        assert!(
            matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'),
            "{id}"
        );
        assert!(
            id.chars()
                .all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c)),
            "{id}"
        );
        assert_ne!(id, new_id(&connection).unwrap());
    }

    #[test]
    fn a_short_random_blob_still_builds_a_uuid() {
        let id = uuid_v4(&[7]);
        assert_eq!(id.len(), 36);
        assert!(!id.contains(' '));
    }
}
