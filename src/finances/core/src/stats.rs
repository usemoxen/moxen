//! Statistics over projection events: period totals, category
//! distribution, the normalized monthly cost of subscriptions and the
//! ranking by monthly-equivalent cost. Ported from the reference's
//! `src/core/stats.ts` (8aaad15b).

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::dates::{
    IsoDateParts, YearMonth, add_months_iso, compare_iso_dates, days_in_month, parse_iso_date,
    start_of_month, to_iso_date,
};
use crate::exchange::convert_to_account_currency;
use crate::projection::{EventSource, ProjectionEvent, monthly_equivalent_minor, price_at};
use crate::recurrence::can_charge_on;
use crate::types::{Currency, ExchangeRate, SubscriptionWithHistory};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PeriodTotals {
    pub income_minor: i64,
    pub expense_minor: i64,
    pub net_minor: i64,
    pub subscription_expense_minor: i64,
    pub other_expense_minor: i64,
    pub count: i64,
}

pub fn empty_totals() -> PeriodTotals {
    PeriodTotals::default()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySlice {
    pub category: String,
    pub amount_minor: i64,
    pub count: i64,
}

/// The income and expense totals of the events within `[from, to]`.
pub fn totals_for_events(
    events: &[ProjectionEvent],
    from_date: &str,
    to_date: &str,
) -> PeriodTotals {
    let mut totals = empty_totals();
    for event in events {
        if compare_iso_dates(&event.date, from_date) == Ordering::Less
            || compare_iso_dates(&event.date, to_date) == Ordering::Greater
        {
            continue;
        }
        totals.count += 1;
        if event.kind == crate::projection::EventKind::Income {
            totals.income_minor += event.amount_minor;
        } else {
            totals.expense_minor += event.amount_minor;
            if event.source == EventSource::Subscription {
                totals.subscription_expense_minor += event.amount_minor;
            } else {
                totals.other_expense_minor += event.amount_minor;
            }
        }
    }
    totals.net_minor = totals.income_minor - totals.expense_minor;
    totals
}

pub fn totals_for_month(events: &[ProjectionEvent], year: i64, month: i64) -> PeriodTotals {
    let from = to_iso_date(IsoDateParts {
        year,
        month,
        day: 1,
    });
    let to = to_iso_date(IsoDateParts {
        year,
        month,
        day: days_in_month(year, month),
    });
    totals_for_events(events, &from, &to)
}

pub fn totals_for_year(events: &[ProjectionEvent], year: i64) -> PeriodTotals {
    totals_for_events(events, &format!("{year}-01-01"), &format!("{year}-12-31"))
}

/// Expenses by category, biggest first; categories keep first-seen order
/// when amounts tie (the reference's stable sort over an insertion-ordered
/// map). An empty category is reported as `Sin categoría`.
pub fn distribution_by_category(
    events: &[ProjectionEvent],
    from_date: &str,
    to_date: &str,
) -> Vec<CategorySlice> {
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, CategorySlice> =
        std::collections::HashMap::new();
    for event in events {
        if event.kind != crate::projection::EventKind::Expense {
            continue;
        }
        if compare_iso_dates(&event.date, from_date) == Ordering::Less
            || compare_iso_dates(&event.date, to_date) == Ordering::Greater
        {
            continue;
        }
        let category = if event.category.as_deref().is_none_or(|c| c.is_empty()) {
            "Sin categoría"
        } else {
            event.category.as_deref().unwrap_or_default()
        };
        let slice = map.entry(category.to_string()).or_insert_with(|| {
            order.push(category.to_string());
            CategorySlice {
                category: category.to_string(),
                amount_minor: 0,
                count: 0,
            }
        });
        slice.amount_minor += event.amount_minor;
        slice.count += 1;
    }
    let mut slices: Vec<CategorySlice> = order
        .into_iter()
        .map(|category| map.remove(&category).expect("category seen above"))
        .collect();
    slices.sort_by_key(|a| std::cmp::Reverse(a.amount_minor));
    slices
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionCostPoint {
    pub year: i64,
    pub month: i64,
    /// Cobros reales proyectados que caen en el mes.
    pub actual_minor: i64,
    /// Coste normalizado si todas las suscripciones activas se repartieran
    /// en 12 meses.
    pub normalized_minor: i64,
}

/// The monthly evolution of subscription cost: what is actually charged in
/// the month versus the normalized monthly cost of the active ones on day 1.
pub fn subscription_cost_evolution(
    subscriptions: &[SubscriptionWithHistory],
    events: &[ProjectionEvent],
    rates: &[ExchangeRate],
    account_currency: Currency,
    months: &[YearMonth],
) -> Vec<SubscriptionCostPoint> {
    months
        .iter()
        .map(|&YearMonth { year, month }| {
            let from = to_iso_date(IsoDateParts {
                year,
                month,
                day: 1,
            });
            let to = to_iso_date(IsoDateParts {
                year,
                month,
                day: days_in_month(year, month),
            });
            let subscription_events: Vec<ProjectionEvent> = events
                .iter()
                .filter(|e| e.source == EventSource::Subscription)
                .cloned()
                .collect();
            let totals = totals_for_events(&subscription_events, &from, &to);
            SubscriptionCostPoint {
                year,
                month,
                actual_minor: totals.expense_minor,
                normalized_minor: normalized_monthly_cost(
                    subscriptions,
                    &from,
                    rates,
                    account_currency,
                ),
            }
        })
        .collect()
}

/// The equivalent monthly cost of the subscriptions that can charge on
/// `date`: only active, non-archived ones count.
pub fn normalized_monthly_cost(
    subscriptions: &[SubscriptionWithHistory],
    date: &str,
    rates: &[ExchangeRate],
    account_currency: Currency,
) -> i64 {
    let mut total: i64 = 0;
    for sub in subscriptions {
        let Some(start_date) = sub.subscription.start_date.as_deref() else {
            continue;
        };
        if sub.subscription.status != crate::types::SubscriptionStatus::Active
            || sub.subscription.archived
        {
            continue;
        }
        if !can_charge_on(
            date,
            &crate::recurrence::CanChargeOptions {
                status: sub.subscription.status,
                end_date: sub.subscription.end_date.as_deref(),
                cancelled_at: sub.subscription.cancelled_at.as_deref(),
                pauses: &sub.pauses,
                start_date: Some(start_date),
                archived_at: sub.subscription.archived_at.as_deref(),
            },
        ) {
            continue;
        }
        let Some(price) = price_at(sub, date) else {
            continue;
        };
        let converted = convert_to_account_currency(
            price.price_minor,
            price.currency,
            account_currency,
            date,
            rates,
        );
        if converted.rate_scaled.is_none() {
            continue;
        }
        total += monthly_equivalent_minor(converted.amount_minor, sub.subscription.frequency);
    }
    total
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionCostRow {
    pub subscription: SubscriptionWithHistory,
    pub monthly_equivalent_minor: Option<i64>,
    pub annualized_minor: Option<i64>,
    pub next_billing: Option<String>,
}

/// The subscriptions ranked by equivalent monthly cost, biggest first.
pub fn subscription_cost_ranking(
    subscriptions: &[SubscriptionWithHistory],
    date: &str,
    rates: &[ExchangeRate],
    account_currency: Currency,
) -> Vec<SubscriptionCostRow> {
    let mut rows: Vec<SubscriptionCostRow> = subscriptions
        .iter()
        .map(|sub| {
            let price = if sub.subscription.start_date.is_some() {
                price_at(sub, date)
            } else {
                None
            };
            let Some(price) = price else {
                return SubscriptionCostRow {
                    subscription: sub.clone(),
                    monthly_equivalent_minor: None,
                    annualized_minor: None,
                    next_billing: None,
                };
            };
            let converted = convert_to_account_currency(
                price.price_minor,
                price.currency,
                account_currency,
                date,
                rates,
            );
            if converted.rate_scaled.is_none() {
                return SubscriptionCostRow {
                    subscription: sub.clone(),
                    monthly_equivalent_minor: None,
                    annualized_minor: None,
                    next_billing: None,
                };
            }
            let monthly =
                monthly_equivalent_minor(converted.amount_minor, sub.subscription.frequency);
            SubscriptionCostRow {
                subscription: sub.clone(),
                monthly_equivalent_minor: Some(monthly),
                // Anualizar el coste equivalente mensual, no el precio bruto.
                annualized_minor: Some(monthly * 12),
                next_billing: None,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        let a = a.monthly_equivalent_minor.unwrap_or(0);
        let b = b.monthly_equivalent_minor.unwrap_or(0);
        b.cmp(&a)
    });
    rows
}

/// The monthly saving that cancelled or finished subscriptions represent.
pub fn savings_from_inactive(
    subscriptions: &[SubscriptionWithHistory],
    date: &str,
    rates: &[ExchangeRate],
    account_currency: Currency,
) -> i64 {
    let mut total: i64 = 0;
    for sub in subscriptions {
        if sub.subscription.status != crate::types::SubscriptionStatus::Cancelled
            && sub.subscription.status != crate::types::SubscriptionStatus::Finished
        {
            continue;
        }
        let price = if sub.subscription.start_date.is_some() {
            price_at(sub, date)
        } else {
            None
        };
        let Some(price) = price else {
            continue;
        };
        let converted = convert_to_account_currency(
            price.price_minor,
            price.currency,
            account_currency,
            date,
            rates,
        );
        if converted.rate_scaled.is_none() {
            continue;
        }
        total += monthly_equivalent_minor(converted.amount_minor, sub.subscription.frequency);
    }
    total
}

/// The months between two dates (inclusive), for evolution charts. Invalid
/// dates produce an empty list, like the reference.
pub fn month_range(from_date: &str, to_date: &str) -> Vec<YearMonth> {
    if parse_iso_date(from_date).is_none() || parse_iso_date(to_date).is_none() {
        return Vec::new();
    }
    let Ok(mut cursor) = start_of_month(from_date) else {
        return Vec::new();
    };
    let mut result: Vec<YearMonth> = Vec::new();
    while compare_iso_dates(&cursor, to_date) != Ordering::Greater {
        match parse_iso_date(&cursor) {
            Some(parts) => result.push(YearMonth {
                year: parts.year,
                month: parts.month,
            }),
            None => return result,
        }
        match add_months_iso(&cursor, 1) {
            Ok(next) => cursor = next,
            Err(_) => return result,
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projection::{EventKind, EventSource, ProjectionEvent};

    fn event(date: &str, kind: EventKind, amount: i64, category: Option<&str>) -> ProjectionEvent {
        ProjectionEvent {
            id: format!("{date}-{}-{}", kind == EventKind::Income, amount),
            date: date.into(),
            kind,
            source: if kind == EventKind::Income {
                EventSource::Income
            } else {
                EventSource::Expense
            },
            source_id: "x".into(),
            name: "N".into(),
            detail: String::new(),
            amount_minor: amount,
            original_amount_minor: None,
            original_currency: None,
            rate_scaled: None,
            estimated: true,
            status: None,
            category: category.map(|c| c.into()),
            affects_balance: None,
            account_id: String::new(),
        }
    }

    fn subscription_event(date: &str, amount: i64) -> ProjectionEvent {
        let mut e = event(date, EventKind::Expense, amount, Some("Suscripciones"));
        e.source = EventSource::Subscription;
        e
    }

    #[test]
    fn totals_split_income_expense_and_subscription_share() {
        let events = vec![
            event("2026-11-01", EventKind::Income, 100_000, None),
            subscription_event("2026-11-02", 1_899),
            event("2026-11-03", EventKind::Expense, 500, Some("Comida")),
            event("2026-12-01", EventKind::Income, 1, None),
        ];
        let totals = totals_for_events(&events, "2026-11-01", "2026-11-30");
        assert_eq!(totals.income_minor, 100_000);
        assert_eq!(totals.expense_minor, 1_899 + 500);
        assert_eq!(totals.subscription_expense_minor, 1_899);
        assert_eq!(totals.other_expense_minor, 500);
        assert_eq!(totals.net_minor, 100_000 - 1_899 - 500);
        assert_eq!(totals.count, 3);
        let november = totals_for_month(&events, 2026, 11);
        assert_eq!(november.count, 3);
        assert_eq!(totals_for_year(&events, 2026).count, 4);
    }

    #[test]
    fn distribution_groups_by_category_biggest_first() {
        let events = vec![
            event("2026-11-01", EventKind::Expense, 100, Some("Comida")),
            event("2026-11-02", EventKind::Expense, 300, Some("Comida")),
            event("2026-11-03", EventKind::Expense, 200, Some("Casa")),
            event("2026-11-04", EventKind::Expense, 50, None),
            event("2026-11-05", EventKind::Expense, 900, None),
        ];
        let slices = distribution_by_category(&events, "2026-11-01", "2026-11-30");
        assert_eq!(slices[0].category, "Sin categoría");
        assert_eq!(slices[0].amount_minor, 950);
        assert_eq!(slices[0].count, 2);
        assert_eq!(slices[1].category, "Comida");
        assert_eq!(slices[2].category, "Casa");
    }

    #[test]
    fn month_range_covers_both_ends_inclusive() {
        let months = month_range("2026-11-15", "2027-02-01");
        assert_eq!(
            months,
            vec![
                YearMonth {
                    year: 2026,
                    month: 11
                },
                YearMonth {
                    year: 2026,
                    month: 12
                },
                YearMonth {
                    year: 2027,
                    month: 1
                },
                YearMonth {
                    year: 2027,
                    month: 2
                }
            ]
        );
        assert!(month_range("bad", "2027-02-01").is_empty());
    }
}
