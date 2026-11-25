//! Writing a whole state into an empty database: what the first-run seed and
//! the JSON restore both do.

use std::collections::BTreeMap;

use rusqlite::{Connection, params};

use moxen_finances_core::types::{
    Account, ActualCharge, AppState, ExchangeRate, Expense, Income, SubscriptionWithHistory,
};

use crate::error::Result;

/// Write every row of `state`, in the reference's order.
///
/// `by_position` sets each subscription's `sort_order` to its position in the
/// list, which is what the seed does so the demo keeps its order; the
/// reference's `importAll` writes `0` for every row instead, and a restore
/// does the same.
pub(crate) fn insert_state(conn: &Connection, state: &AppState, by_position: bool) -> Result<()> {
    insert_account(conn, &state.account)?;
    for (index, item) in state.subscriptions.iter().enumerate() {
        insert_subscription(conn, item, if by_position { index as i64 } else { 0 })?;
    }
    for income in &state.incomes {
        insert_income(conn, income)?;
    }
    for expense in &state.expenses {
        insert_expense(conn, expense)?;
    }
    for charge in &state.charges {
        insert_charge(conn, charge)?;
    }
    for rate in &state.rates {
        insert_rate(conn, rate)?;
    }
    insert_settings(conn, &state.settings)?;
    Ok(())
}

fn insert_account(conn: &Connection, account: &Account) -> Result<()> {
    conn.execute(
        "INSERT INTO account
          (id, name, currency, balance_minor, balance_date, balance_set,
           opening_balance_minor, opening_balance_date, opening_balance_set, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            account.id,
            account.name,
            account.currency.as_str(),
            account.balance_minor,
            account.balance_date,
            account.balance_set,
            account.opening_balance_minor,
            account.opening_balance_date,
            account.opening_balance_set,
            account.notes
        ],
    )?;
    Ok(())
}

fn insert_subscription(
    conn: &Connection,
    item: &SubscriptionWithHistory,
    sort_order: i64,
) -> Result<()> {
    let sub = &item.subscription;
    conn.execute(
        "INSERT INTO subscriptions
          (id, name, description, currency, price_minor, frequency, start_date, billing_day,
           next_billing_override, end_date, status, cancelled_at, plan, notes, external_payment,
           archived, archived_at, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            sub.id,
            sub.name,
            sub.description,
            sub.currency.as_str(),
            sub.price_minor,
            sub.frequency.as_str(),
            sub.start_date,
            sub.billing_day,
            sub.next_billing_override,
            sub.end_date,
            sub.status.as_str(),
            sub.cancelled_at,
            sub.plan,
            sub.notes,
            sub.external_payment,
            sub.archived,
            sub.archived_at,
            sort_order,
            sub.created_at,
            sub.updated_at
        ],
    )?;

    for price in &item.prices {
        conn.execute(
            "INSERT INTO subscription_prices
              (id, subscription_id, price_minor, currency, effective_from, effective_to, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                price.id,
                sub.id,
                price.price_minor,
                price.currency.as_str(),
                price.effective_from,
                price.effective_to,
                price.note,
                price.created_at
            ],
        )?;
    }

    for plan in &item.plans {
        conn.execute(
            "INSERT INTO subscription_plans (id, subscription_id, plan, effective_from, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                plan.id,
                sub.id,
                plan.plan,
                plan.effective_from,
                plan.note,
                plan.created_at
            ],
        )?;
    }

    for pause in &item.pauses {
        conn.execute(
            "INSERT INTO subscription_pauses (id, subscription_id, start_date, end_date, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                pause.id,
                sub.id,
                pause.start_date,
                pause.end_date,
                pause.note,
                pause.created_at
            ],
        )?;
    }

    for entry in &item.status_history {
        conn.execute(
            "INSERT INTO subscription_status_history (id, subscription_id, status, date, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                entry.id,
                sub.id,
                entry.status.as_str(),
                entry.date,
                entry.note,
                entry.created_at
            ],
        )?;
    }

    for entry in &item.billing_days {
        conn.execute(
            "INSERT INTO subscription_billing_days
              (id, subscription_id, billing_day, effective_from, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                entry.id,
                sub.id,
                entry.billing_day,
                entry.effective_from,
                entry.note,
                entry.created_at
            ],
        )?;
    }

    Ok(())
}

fn insert_income(conn: &Connection, income: &Income) -> Result<()> {
    conn.execute(
        "INSERT INTO incomes
          (id, concept, amount_minor, currency, date, time, frequency, end_date, status, paused,
           notes, actual_amount_minor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            income.id,
            income.concept,
            income.amount_minor,
            income.currency.as_str(),
            income.date,
            income.time,
            income.frequency.as_str(),
            income.end_date,
            income.status.as_str(),
            income.paused,
            income.notes,
            income.actual_amount_minor,
            income.created_at
        ],
    )?;
    Ok(())
}

fn insert_expense(conn: &Connection, expense: &Expense) -> Result<()> {
    conn.execute(
        "INSERT INTO expenses
          (id, concept, category, amount_minor, currency, date, time, frequency, end_date,
           status, notes, actual_amount_minor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            expense.id,
            expense.concept,
            expense.category,
            expense.amount_minor,
            expense.currency.as_str(),
            expense.date,
            expense.time,
            expense.frequency.as_str(),
            expense.end_date,
            expense.status.as_str(),
            expense.notes,
            expense.actual_amount_minor,
            expense.created_at
        ],
    )?;
    Ok(())
}

fn insert_charge(conn: &Connection, charge: &ActualCharge) -> Result<()> {
    conn.execute(
        "INSERT INTO subscription_charges
          (id, subscription_id, charge_date, time, amount_minor, currency, rate_scaled, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            charge.id,
            charge.subscription_id,
            charge.charge_date,
            charge.time,
            charge.amount_minor,
            charge.currency.as_str(),
            charge.rate_scaled,
            charge.note,
            charge.created_at
        ],
    )?;
    Ok(())
}

fn insert_rate(conn: &Connection, rate: &ExchangeRate) -> Result<()> {
    conn.execute(
        "INSERT INTO exchange_rates
          (id, from_currency, to_currency, rate_scaled, effective_from, source, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            rate.id,
            rate.from_currency.as_str(),
            rate.to_currency.as_str(),
            rate.rate_scaled,
            rate.effective_from,
            rate.source,
            rate.note,
            rate.created_at
        ],
    )?;
    Ok(())
}

fn insert_settings(conn: &Connection, settings: &BTreeMap<String, String>) -> Result<()> {
    for (key, value) in settings {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            params![key, value],
        )?;
    }
    Ok(())
}
