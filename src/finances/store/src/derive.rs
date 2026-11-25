//! State assembly: turning the stored state into what the views show,
//! ported from the reference's `src/web/lib/derive.ts` (8aaad15b).
//!
//! The piece worth keeping out of the views is the **opening-balance
//! reconstruction**: the account has one real balance with its date, and
//! optionally an opening balance with an earlier date. Asking for a projection
//! that starts before the real balance has to walk back to the opening balance,
//! or the first days of the range would look like free money.
//!
//! [`anchor_for`] is the rule; [`projection_for`] applies it and clips the
//! result to the requested range, keeping the closing balance of the day
//! before.

use std::cmp::Ordering;

use moxen_finances_core::dates::compare_iso_dates;
use moxen_finances_core::projection::{
    CollectedEvents, DailyPoint, EventCollectionInput, ProjectionEvent, ProjectionInput,
    ProjectionResult, collect_events, project_balance,
};
use moxen_finances_core::types::{Account, AppState};

use crate::Store;
use crate::error::Result;

/// The account a projection should start from: when an opening balance exists
/// and the range starts before the current balance's date, the opening balance
/// is the anchor and the projection walks forward from there.
pub fn anchor_for(account: &Account, from: &str) -> Account {
    if account.opening_balance_set
        && account.opening_balance_date.is_some()
        && compare_iso_dates(from, &account.balance_date) == Ordering::Less
    {
        let mut anchor = account.clone();
        anchor.balance_minor = account.opening_balance_minor;
        if let Some(date) = &account.opening_balance_date {
            anchor.balance_date.clone_from(date);
        }
        return anchor;
    }
    account.clone()
}

/// Cut a projection down to `from`, keeping the balance the day before as the
/// starting balance (so the first day of the range is not counted twice).
pub fn clip_projection(mut result: ProjectionResult, from: &str) -> ProjectionResult {
    let days: Vec<DailyPoint> = result
        .days
        .iter()
        .filter(|day| compare_iso_dates(&day.date, from) != Ordering::Less)
        .cloned()
        .collect();
    let events: Vec<ProjectionEvent> = result
        .events
        .iter()
        .filter(|event| compare_iso_dates(&event.date, from) != Ordering::Less)
        .cloned()
        .collect();

    let Some(first) = days.first() else {
        result.start_date = from.to_string();
        result.days = days;
        result.events = events;
        return result;
    };

    let mut min_balance_minor = first.balance_minor;
    let mut min_balance_date = Some(first.date.clone());
    let mut first_negative_date: Option<String> = None;
    let mut first_negative_deficit_minor: Option<i64> = None;
    let mut total_income_minor = 0;
    let mut total_expense_minor = 0;
    for day in &days {
        total_income_minor += day.income_minor;
        total_expense_minor += day.expense_minor;
        if day.balance_minor < min_balance_minor {
            min_balance_minor = day.balance_minor;
            min_balance_date = Some(day.date.clone());
        }
        if first_negative_date.is_none() && day.balance_minor < 0 {
            first_negative_date = Some(day.date.clone());
            first_negative_deficit_minor = Some(-day.balance_minor);
        }
    }

    result.start_date = from.to_string();
    result.start_balance_minor = first.balance_minor - first.income_minor + first.expense_minor;
    result.days = days;
    result.events = events;
    result.total_income_minor = total_income_minor;
    result.total_expense_minor = total_expense_minor;
    result.net_minor = total_income_minor - total_expense_minor;
    result.min_balance_minor = min_balance_minor;
    result.min_balance_date = min_balance_date;
    result.first_negative_date = first_negative_date;
    result.first_negative_deficit_minor = first_negative_deficit_minor;
    result
}

/// The movements of a range, without a balance walk.
pub fn events_for(state: &AppState, from: &str, to: &str) -> Result<CollectedEvents> {
    Ok(collect_events(&EventCollectionInput {
        account_currency: state.account.currency,
        subscriptions: &state.subscriptions,
        incomes: &state.incomes,
        expenses: &state.expenses,
        rates: &state.rates,
        charges: &state.charges,
        from_date: from,
        to_date: to,
        extra_events: &[],
    })?)
}

/// The balance walk for a range, anchored on the opening balance when the
/// range starts before the current balance.
pub fn projection_for(
    state: &AppState,
    from: &str,
    to: &str,
    extra_events: &[ProjectionEvent],
) -> Result<ProjectionResult> {
    let anchor = anchor_for(&state.account, from);
    // Project from the anchor (even when it is earlier than the range) and
    // clip afterwards, so the starting balance includes every movement in
    // between.
    let start = if compare_iso_dates(&anchor.balance_date, from) == Ordering::Less {
        anchor.balance_date.clone()
    } else {
        from.to_string()
    };
    let result = project_balance(&ProjectionInput {
        account: &anchor,
        events: EventCollectionInput {
            account_currency: anchor.currency,
            subscriptions: &state.subscriptions,
            incomes: &state.incomes,
            expenses: &state.expenses,
            rates: &state.rates,
            charges: &state.charges,
            from_date: &start,
            to_date: to,
            extra_events,
        },
    })?;
    if compare_iso_dates(from, &start) == Ordering::Greater {
        Ok(clip_projection(result, from))
    } else {
        Ok(result)
    }
}

impl Store {
    /// The projection of the stored state, closing balance included.
    pub fn projection(&self, from: &str, to: &str) -> Result<ProjectionResult> {
        let state = self.app_state()?;
        projection_for(&state, from, to, &[])
    }

    /// The movements of a range.
    pub fn events(&self, from: &str, to: &str) -> Result<CollectedEvents> {
        let state = self.app_state()?;
        events_for(&state, from, to)
    }

    /// The account a projection starting at `from` has to anchor on.
    pub fn anchor(&self, from: &str) -> Result<Account> {
        Ok(anchor_for(&self.account()?, from))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moxen_finances_core::types::{Currency, Expense, ExpenseStatus, Frequency};

    fn account() -> Account {
        Account {
            id: "account-primary".to_string(),
            name: "Demo".to_string(),
            currency: Currency::Eur,
            balance_minor: 100_000,
            balance_date: "2026-11-18".to_string(),
            balance_set: true,
            opening_balance_minor: 50_000,
            opening_balance_date: Some("2026-06-01".to_string()),
            opening_balance_set: true,
            notes: String::new(),
        }
    }

    #[test]
    fn a_range_before_the_balance_anchors_on_the_opening_balance() {
        let anchor = anchor_for(&account(), "2026-07-01");
        assert_eq!(anchor.balance_minor, 50_000);
        assert_eq!(anchor.balance_date, "2026-06-01");
        // The current balance wins for a range that starts on or after it.
        let anchor = anchor_for(&account(), "2026-11-18");
        assert_eq!(anchor.balance_minor, 100_000);
        assert_eq!(anchor.balance_date, "2026-11-18");
    }

    #[test]
    fn without_an_opening_balance_or_its_flag_nothing_is_reconstructed() {
        let mut unset = account();
        unset.opening_balance_set = false;
        assert_eq!(anchor_for(&unset, "2026-07-01").balance_minor, 100_000);

        let mut undated = account();
        undated.opening_balance_date = None;
        assert_eq!(anchor_for(&undated, "2026-07-01").balance_minor, 100_000);
    }

    #[test]
    fn a_projection_before_the_balance_starts_from_the_opening_balance() {
        let state = AppState {
            account: account(),
            subscriptions: Vec::new(),
            incomes: Vec::new(),
            expenses: vec![Expense {
                id: "e1".to_string(),
                concept: "Compra".to_string(),
                category: "Otros".to_string(),
                amount_minor: 10_000,
                currency: Currency::Eur,
                date: "2026-07-10".to_string(),
                time: None,
                frequency: Frequency::Once,
                end_date: None,
                status: ExpenseStatus::Planned,
                notes: String::new(),
                actual_amount_minor: None,
                created_at: "2026-06-01T00:00:00.000Z".to_string(),
            }],
            rates: Vec::new(),
            charges: Vec::new(),
            settings: Default::default(),
        };
        let result = projection_for(&state, "2026-07-05", "2026-07-15", &[]).unwrap();
        // The opening balance minus the expense of the 10th, and the range
        // starts on the 5th with the opening balance as its base.
        assert_eq!(result.start_date, "2026-07-05");
        assert_eq!(result.start_balance_minor, 50_000);
        assert_eq!(result.end_balance_minor, 40_000);
        assert_eq!(result.events.len(), 1);
    }

    #[test]
    fn clipping_keeps_the_balance_of_the_day_before() {
        let state = AppState {
            account: account(),
            subscriptions: Vec::new(),
            incomes: Vec::new(),
            expenses: vec![Expense {
                id: "e1".to_string(),
                concept: "Compra".to_string(),
                category: "Otros".to_string(),
                amount_minor: 10_000,
                currency: Currency::Eur,
                date: "2026-11-10".to_string(),
                time: None,
                frequency: Frequency::Once,
                end_date: None,
                status: ExpenseStatus::Planned,
                notes: String::new(),
                actual_amount_minor: None,
                created_at: "2026-11-01T00:00:00.000Z".to_string(),
            }],
            rates: Vec::new(),
            charges: Vec::new(),
            settings: Default::default(),
        };
        // The balance is from the 18th (after the expense), so the walk back
        // to the 1st must not lose it.
        let result = projection_for(&state, "2026-11-12", "2026-11-20", &[]).unwrap();
        assert_eq!(result.start_date, "2026-11-12");
        assert_eq!(result.days.first().unwrap().date, "2026-11-12");
        assert_eq!(result.events.len(), 0);
    }
}
