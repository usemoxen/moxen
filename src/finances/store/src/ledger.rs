//! Incomes, expenses, exchange rates and real charges: the ledger
//! operations of the reference's `src/server/repo.ts` (8aaad15b), as methods
//! on [`Store`]. Each write records its audit entry in the same transaction,
//! so a change and its trace cannot come apart.

use rusqlite::{Connection, params};
use serde::Serialize;

use moxen_finances_core::types::{
    ActualCharge, Currency, ExchangeRate, Expense, ExpenseStatus, Frequency, Income, IncomeStatus,
};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::row::{log_audit, map_charge, map_expense, map_income, map_rate, new_id, now};

fn read_income_row(conn: &Connection, id: &str) -> Result<Option<Income>> {
    let mut statement = conn.prepare("SELECT * FROM incomes WHERE id = ?")?;
    let mut rows = statement.query([id])?;
    Ok(rows.next()?.map(map_income))
}

fn read_expense_row(conn: &Connection, id: &str) -> Result<Option<Expense>> {
    let mut statement = conn.prepare("SELECT * FROM expenses WHERE id = ?")?;
    let mut rows = statement.query([id])?;
    Ok(rows.next()?.map(map_expense))
}

fn read_charge_row(conn: &Connection, id: &str) -> Result<Option<ActualCharge>> {
    let mut statement = conn.prepare("SELECT * FROM subscription_charges WHERE id = ?")?;
    let mut rows = statement.query([id])?;
    Ok(rows.next()?.map(map_charge))
}

fn read_rate_row(conn: &Connection, id: &str) -> Result<Option<ExchangeRate>> {
    let mut statement = conn.prepare("SELECT * FROM exchange_rates WHERE id = ?")?;
    let mut rows = statement.query([id])?;
    Ok(rows.next()?.map(map_rate))
}

// ---------------------------------------------------------------------------
// Incomes
// ---------------------------------------------------------------------------

/// What the income form sends; `create_income` and `update_income` both take
/// it whole, like the reference.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeInput {
    pub concept: String,
    pub amount_minor: i64,
    pub currency: Currency,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    pub frequency: Frequency,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    pub status: IncomeStatus,
    pub paused: bool,
    pub notes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_amount_minor: Option<i64>,
}

impl Default for IncomeInput {
    fn default() -> Self {
        Self {
            concept: String::new(),
            amount_minor: 0,
            currency: Currency::Eur,
            date: String::new(),
            time: None,
            frequency: Frequency::Once,
            end_date: None,
            status: IncomeStatus::Expected,
            paused: false,
            notes: String::new(),
            actual_amount_minor: None,
        }
    }
}

pub(crate) fn create_income(conn: &Connection, input: &IncomeInput) -> Result<Income> {
    let id = new_id(conn)?;
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO incomes
          (id, concept, amount_minor, currency, date, time, frequency, end_date, status, paused, notes,
           actual_amount_minor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            input.concept,
            input.amount_minor,
            input.currency.as_str(),
            input.date,
            input.time,
            input.frequency.as_str(),
            input.end_date,
            input.status.as_str(),
            input.paused,
            input.notes,
            input.actual_amount_minor,
            stamped
        ],
    )?;
    log_audit(&transaction, "income", &id, "create", input, &stamped)?;
    transaction.commit()?;
    match read_income_row(conn, &id)? {
        Some(income) => Ok(income),
        None => Err(StoreError::NotFound {
            entity: "ingreso",
            id,
        }),
    }
}

pub(crate) fn update_income(
    conn: &Connection,
    id: &str,
    input: &IncomeInput,
) -> Result<Option<Income>> {
    let Some(current) = read_income_row(conn, id)? else {
        return Ok(None);
    };
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "UPDATE incomes SET concept = ?, amount_minor = ?, currency = ?, date = ?, time = ?,
           frequency = ?, end_date = ?, status = ?, paused = ?, notes = ?, actual_amount_minor = ?
         WHERE id = ?",
        params![
            input.concept,
            input.amount_minor,
            input.currency.as_str(),
            input.date,
            input.time,
            input.frequency.as_str(),
            input.end_date,
            input.status.as_str(),
            input.paused,
            input.notes,
            input.actual_amount_minor,
            id
        ],
    )?;
    // The reference audits the row it started from, which is the only place
    // the previous amount is still readable.
    log_audit(&transaction, "income", id, "update", &current, &stamped)?;
    transaction.commit()?;
    read_income_row(conn, id)
}

pub(crate) fn delete_income(conn: &Connection, id: &str) -> Result<bool> {
    let Some(current) = read_income_row(conn, id)? else {
        return Ok(false);
    };
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    log_audit(&transaction, "income", id, "delete", &current, &stamped)?;
    transaction.execute("DELETE FROM incomes WHERE id = ?", [id])?;
    transaction.commit()?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

/// What the expense form sends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseInput {
    pub concept: String,
    pub category: String,
    pub amount_minor: i64,
    pub currency: Currency,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    pub frequency: Frequency,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    pub status: ExpenseStatus,
    pub notes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_amount_minor: Option<i64>,
}

impl Default for ExpenseInput {
    fn default() -> Self {
        Self {
            concept: String::new(),
            category: "Otros".to_string(),
            amount_minor: 0,
            currency: Currency::Eur,
            date: String::new(),
            time: None,
            frequency: Frequency::Once,
            end_date: None,
            status: ExpenseStatus::Planned,
            notes: String::new(),
            actual_amount_minor: None,
        }
    }
}

pub(crate) fn create_expense(conn: &Connection, input: &ExpenseInput) -> Result<Expense> {
    let id = new_id(conn)?;
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO expenses
          (id, concept, category, amount_minor, currency, date, time, frequency, end_date, status,
           notes, actual_amount_minor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            input.concept,
            input.category,
            input.amount_minor,
            input.currency.as_str(),
            input.date,
            input.time,
            input.frequency.as_str(),
            input.end_date,
            input.status.as_str(),
            input.notes,
            input.actual_amount_minor,
            stamped
        ],
    )?;
    log_audit(&transaction, "expense", &id, "create", input, &stamped)?;
    transaction.commit()?;
    match read_expense_row(conn, &id)? {
        Some(expense) => Ok(expense),
        None => Err(StoreError::NotFound {
            entity: "gasto",
            id,
        }),
    }
}

pub(crate) fn update_expense(
    conn: &Connection,
    id: &str,
    input: &ExpenseInput,
) -> Result<Option<Expense>> {
    let Some(current) = read_expense_row(conn, id)? else {
        return Ok(None);
    };
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "UPDATE expenses SET concept = ?, category = ?, amount_minor = ?, currency = ?, date = ?,
           time = ?, frequency = ?, end_date = ?, status = ?, notes = ?, actual_amount_minor = ?
         WHERE id = ?",
        params![
            input.concept,
            input.category,
            input.amount_minor,
            input.currency.as_str(),
            input.date,
            input.time,
            input.frequency.as_str(),
            input.end_date,
            input.status.as_str(),
            input.notes,
            input.actual_amount_minor,
            id
        ],
    )?;
    log_audit(&transaction, "expense", id, "update", &current, &stamped)?;
    transaction.commit()?;
    read_expense_row(conn, id)
}

pub(crate) fn delete_expense(conn: &Connection, id: &str) -> Result<bool> {
    let Some(current) = read_expense_row(conn, id)? else {
        return Ok(false);
    };
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    log_audit(&transaction, "expense", id, "delete", &current, &stamped)?;
    transaction.execute("DELETE FROM expenses WHERE id = ?", [id])?;
    transaction.commit()?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Exchange rates
// ---------------------------------------------------------------------------

/// A currency pair's rate from a date.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateInput {
    pub from_currency: Currency,
    pub to_currency: Currency,
    pub rate_scaled: i64,
    pub effective_from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub(crate) fn add_rate(conn: &Connection, input: &RateInput) -> Result<ExchangeRate> {
    let id = new_id(conn)?;
    let stamped = now();
    let source = input.source.clone().unwrap_or_default();
    let note = input.note.clone().unwrap_or_default();
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO exchange_rates
          (id, from_currency, to_currency, rate_scaled, effective_from, source, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            input.from_currency.as_str(),
            input.to_currency.as_str(),
            input.rate_scaled,
            input.effective_from,
            source,
            note,
            stamped
        ],
    )?;
    log_audit(&transaction, "rate", &id, "create", input, &stamped)?;
    transaction.commit()?;

    Ok(ExchangeRate {
        id,
        from_currency: input.from_currency,
        to_currency: input.to_currency,
        rate_scaled: input.rate_scaled,
        effective_from: input.effective_from.clone(),
        source,
        note,
        created_at: stamped,
    })
}

pub(crate) fn delete_rate(conn: &Connection, id: &str) -> Result<bool> {
    let Some(current) = read_rate_row(conn, id)? else {
        return Ok(false);
    };
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    log_audit(&transaction, "rate", id, "delete", &current, &stamped)?;
    transaction.execute("DELETE FROM exchange_rates WHERE id = ?", [id])?;
    transaction.commit()?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Real charges
// ---------------------------------------------------------------------------

/// What the bank actually took for one subscription charge, which can differ
/// from the price (fees, a different rate on the day).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChargeInput {
    pub subscription_id: String,
    pub charge_date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    pub amount_minor: i64,
    pub currency: Currency,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_scaled: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub(crate) fn add_charge(conn: &Connection, input: &ChargeInput) -> Result<ActualCharge> {
    let id = new_id(conn)?;
    let stamped = now();
    let note = input.note.clone().unwrap_or_default();
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO subscription_charges
          (id, subscription_id, charge_date, time, amount_minor, currency, rate_scaled, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            input.subscription_id,
            input.charge_date,
            input.time,
            input.amount_minor,
            input.currency.as_str(),
            input.rate_scaled,
            note,
            stamped
        ],
    )?;
    log_audit(
        &transaction,
        "subscription",
        &input.subscription_id,
        "actual-charge",
        input,
        &stamped,
    )?;
    transaction.commit()?;

    Ok(ActualCharge {
        id,
        subscription_id: input.subscription_id.clone(),
        charge_date: input.charge_date.clone(),
        time: input.time.clone(),
        amount_minor: input.amount_minor,
        currency: input.currency,
        rate_scaled: input.rate_scaled,
        note,
        created_at: stamped,
    })
}

pub(crate) fn update_charge(
    conn: &Connection,
    id: &str,
    patch: &ChargeInput,
) -> Result<Option<ActualCharge>> {
    let Some(current) = read_charge_row(conn, id)? else {
        return Ok(None);
    };
    let stamped = now();
    let note = patch.note.clone().unwrap_or_default();
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "UPDATE subscription_charges SET subscription_id = ?, charge_date = ?, time = ?,
           amount_minor = ?, currency = ?, rate_scaled = ?, note = ? WHERE id = ?",
        params![
            patch.subscription_id,
            patch.charge_date,
            patch.time,
            patch.amount_minor,
            patch.currency.as_str(),
            patch.rate_scaled,
            note,
            id
        ],
    )?;
    log_audit(
        &transaction,
        "subscription",
        &patch.subscription_id,
        "actual-charge-update",
        patch,
        &stamped,
    )?;
    transaction.commit()?;

    // `created_at` is not touched by an update, exactly like the reference.
    Ok(Some(ActualCharge {
        id: id.to_string(),
        subscription_id: patch.subscription_id.clone(),
        charge_date: patch.charge_date.clone(),
        time: patch.time.clone(),
        amount_minor: patch.amount_minor,
        currency: patch.currency,
        rate_scaled: patch.rate_scaled,
        note,
        created_at: current.created_at,
    }))
}

pub(crate) fn delete_charge(conn: &Connection, id: &str) -> Result<bool> {
    let Some(current) = read_charge_row(conn, id)? else {
        return Ok(false);
    };
    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    log_audit(
        &transaction,
        "subscription",
        &current.subscription_id,
        "actual-charge-delete",
        &current,
        &stamped,
    )?;
    transaction.execute("DELETE FROM subscription_charges WHERE id = ?", [id])?;
    transaction.commit()?;
    Ok(true)
}

impl Store {
    pub fn income(&self, id: &str) -> Result<Option<Income>> {
        read_income_row(self.connection(), id)
    }

    pub fn expense(&self, id: &str) -> Result<Option<Expense>> {
        read_expense_row(self.connection(), id)
    }

    pub fn create_income(&mut self, input: &IncomeInput) -> Result<Income> {
        create_income(self.connection(), input)
    }

    pub fn update_income(&mut self, id: &str, input: &IncomeInput) -> Result<Option<Income>> {
        update_income(self.connection(), id, input)
    }

    pub fn delete_income(&mut self, id: &str) -> Result<bool> {
        delete_income(self.connection(), id)
    }

    pub fn create_expense(&mut self, input: &ExpenseInput) -> Result<Expense> {
        create_expense(self.connection(), input)
    }

    pub fn update_expense(&mut self, id: &str, input: &ExpenseInput) -> Result<Option<Expense>> {
        update_expense(self.connection(), id, input)
    }

    pub fn delete_expense(&mut self, id: &str) -> Result<bool> {
        delete_expense(self.connection(), id)
    }

    pub fn add_rate(&mut self, input: &RateInput) -> Result<ExchangeRate> {
        add_rate(self.connection(), input)
    }

    pub fn delete_rate(&mut self, id: &str) -> Result<bool> {
        delete_rate(self.connection(), id)
    }

    pub fn add_charge(&mut self, input: &ChargeInput) -> Result<ActualCharge> {
        add_charge(self.connection(), input)
    }

    pub fn update_charge(&mut self, id: &str, patch: &ChargeInput) -> Result<Option<ActualCharge>> {
        update_charge(self.connection(), id, patch)
    }

    pub fn delete_charge(&mut self, id: &str) -> Result<bool> {
        delete_charge(self.connection(), id)
    }
}
