//! The balance projection: event collection (real charges, estimates,
//! incomes and expenses) and the day-by-day balance walk. Ported from the
//! reference's `src/core/projection.ts` (8aaad15b). Real charges replace
//! estimates within a ±7-day matching window (an amount of 0 marks a cycle
//! that was never charged), `endDate` is exclusive, prices/plans/pauses
//! and billing days are effective-dated with the latest effective record
//! winning on equal dates, and the projection starts from the account's
//! real balance.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::CoreError;
use crate::dates::{add_days_iso, compare_iso_dates, diff_days, max_iso, parse_iso_date};
use crate::exchange::{ConversionResult, convert_to_account_currency};
use crate::money::js_round;
use crate::recurrence::{
    CanChargeOptions, OccurrenceOptions, can_charge_on, generate_occurrences, next_billing_date,
};
use crate::types::{
    Account, ActualCharge, Currency, ExchangeRate, Expense, Frequency, Income, PriceHistoryEntry,
    Subscription, SubscriptionWithHistory,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Income,
    Expense,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventSource {
    Subscription,
    Income,
    Expense,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionEvent {
    pub id: String,
    pub date: String,
    /// The reference's `type` field: an income or an expense.
    #[serde(rename = "type")]
    pub kind: EventKind,
    pub source: EventSource,
    pub source_id: String,
    pub name: String,
    pub detail: String,
    /// Importe en la moneda de la cuenta, en unidades menores.
    pub amount_minor: i64,
    pub original_amount_minor: Option<i64>,
    pub original_currency: Option<Currency>,
    pub rate_scaled: Option<i64>,
    /// true = estimación; false = importe real confirmado.
    pub estimated: bool,
    pub status: Option<String>,
    pub category: Option<String>,
    /// false si el cargo se paga desde otra cuenta y no debe mover este
    /// saldo. Absent (null) on incomes and plain expenses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affects_balance: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WarningCode {
    #[serde(rename = "missing-start")]
    MissingStart,
    #[serde(rename = "missing-price")]
    MissingPrice,
    #[serde(rename = "missing-rate")]
    MissingRate,
    #[serde(rename = "approximate-rate")]
    ApproximateRate,
    #[serde(rename = "paused-no-interval")]
    PausedNoInterval,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionWarning {
    pub code: WarningCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyPoint {
    pub date: String,
    pub balance_minor: i64,
    pub income_minor: i64,
    pub expense_minor: i64,
    pub events: Vec<ProjectionEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionResult {
    pub start_date: String,
    pub end_date: String,
    pub start_balance_minor: i64,
    pub end_balance_minor: i64,
    pub days: Vec<DailyPoint>,
    pub events: Vec<ProjectionEvent>,
    pub warnings: Vec<ProjectionWarning>,
    pub total_income_minor: i64,
    pub total_expense_minor: i64,
    pub net_minor: i64,
    pub min_balance_minor: i64,
    pub min_balance_date: Option<String>,
    pub first_negative_date: Option<String>,
    pub first_negative_deficit_minor: Option<i64>,
}

/// Everything `collect_events` needs to gather the movements of a range.
#[derive(Debug, Clone)]
pub struct EventCollectionInput<'a> {
    pub account_currency: Currency,
    pub subscriptions: &'a [SubscriptionWithHistory],
    pub incomes: &'a [Income],
    pub expenses: &'a [Expense],
    pub rates: &'a [ExchangeRate],
    /// Importes reales cobrados por el banco, por suscripción y fecha.
    pub charges: &'a [ActualCharge],
    pub from_date: &'a str,
    pub to_date: &'a str,
    pub extra_events: &'a [ProjectionEvent],
}

impl<'a> EventCollectionInput<'a> {
    pub fn new(
        account_currency: Currency,
        subscriptions: &'a [SubscriptionWithHistory],
        incomes: &'a [Income],
        expenses: &'a [Expense],
        rates: &'a [ExchangeRate],
        from_date: &'a str,
        to_date: &'a str,
    ) -> Self {
        Self {
            account_currency,
            subscriptions,
            incomes,
            expenses,
            rates,
            charges: &[],
            from_date,
            to_date,
            extra_events: &[],
        }
    }
}

/// `collect_events` projection input: the shared collection plus the real
/// account the balance walk starts from.
#[derive(Debug, Clone)]
pub struct ProjectionInput<'a> {
    pub account: &'a Account,
    pub events: EventCollectionInput<'a>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectedEvents {
    pub events: Vec<ProjectionEvent>,
    pub warnings: Vec<ProjectionWarning>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PriceSource {
    History,
    Current,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPrice {
    pub price_minor: i64,
    pub currency: Currency,
    pub source: PriceSource,
}

/// The latest price whose effective window covers the date, at equal
/// dates the one registered last (`createdAt`); the current price is the
/// fallback when no history applies.
pub fn price_at(sub: &SubscriptionWithHistory, date: &str) -> Option<ResolvedPrice> {
    let applicable = pick_latest_price(sub.prices.iter().filter(|p| {
        compare_iso_dates(&p.effective_from, date) != Ordering::Greater
            && p.effective_to
                .as_deref()
                .is_none_or(|to| compare_iso_dates(date, to) != Ordering::Greater)
    }));
    if let Some(applicable) = applicable {
        return Some(price_from_entry(applicable, PriceSource::History));
    }

    let fallback = pick_latest_price(
        sub.prices
            .iter()
            .filter(|p| compare_iso_dates(&p.effective_from, date) != Ordering::Greater),
    );
    if let Some(fallback) = fallback {
        return Some(price_from_entry(fallback, PriceSource::History));
    }

    sub.subscription
        .price_minor
        .map(|price_minor| ResolvedPrice {
            price_minor,
            currency: sub.subscription.currency,
            source: PriceSource::Current,
        })
}

fn price_from_entry(entry: &PriceHistoryEntry, source: PriceSource) -> ResolvedPrice {
    ResolvedPrice {
        price_minor: entry.price_minor,
        currency: entry.currency,
        source,
    }
}

/// `filter().sort(priceOrder)[0]`: the latest `effectiveFrom` wins and, on
/// equal dates, the latest `createdAt`; the first one in list order wins
/// full ties (like the reference's stable sort).
fn pick_latest_price<'a, I>(prices: I) -> Option<&'a PriceHistoryEntry>
where
    I: Iterator<Item = &'a PriceHistoryEntry>,
{
    prices.fold(None, |best: Option<&PriceHistoryEntry>, price| match best {
        None => Some(price),
        Some(best) => {
            let by_date = compare_iso_dates(&price.effective_from, &best.effective_from);
            let candidate_first = match by_date {
                Ordering::Greater => true,
                Ordering::Equal => price.created_at > best.created_at,
                Ordering::Less => false,
            };
            if candidate_first {
                Some(price)
            } else {
                Some(best)
            }
        }
    })
}

#[derive(Debug, Clone, PartialEq)]
struct GroupedCharge {
    date: String,
    amount_minor: i64,
    currency: Currency,
    rate_scaled: Option<i64>,
    count: i64,
}

/// Groups the real charges per subscription and date: a charge split in
/// parts sums them into one.
fn group_charges(
    charges: &[ActualCharge],
    from_date: &str,
    to_date: &str,
) -> HashMap<String, Vec<GroupedCharge>> {
    let mut map: HashMap<String, Vec<GroupedCharge>> = HashMap::new();
    for charge in charges {
        if compare_iso_dates(&charge.charge_date, from_date) == Ordering::Less
            || compare_iso_dates(&charge.charge_date, to_date) == Ordering::Greater
        {
            continue;
        }
        let list = map.entry(charge.subscription_id.clone()).or_default();
        if let Some(existing) = list
            .iter_mut()
            .find(|entry| entry.date == charge.charge_date)
        {
            existing.amount_minor += charge.amount_minor;
            existing.count += 1;
            existing.rate_scaled = charge.rate_scaled.or(existing.rate_scaled);
        } else {
            list.push(GroupedCharge {
                date: charge.charge_date.clone(),
                amount_minor: charge.amount_minor,
                currency: charge.currency,
                rate_scaled: charge.rate_scaled,
                count: 1,
            });
        }
    }
    for list in map.values_mut() {
        list.sort_by(|a, b| compare_iso_dates(&a.date, &b.date));
    }
    map
}

/// Assigns real charges to occurrences: the same date, or the closest one
/// within ±7 days, each charge used at most once.
fn match_charges(dates: &[String], charges: &[GroupedCharge]) -> HashMap<String, usize> {
    let mut used: HashSet<usize> = HashSet::new();
    let mut matches: HashMap<String, usize> = HashMap::new();
    for date in dates {
        let mut best: Option<usize> = None;
        let mut best_distance: i64 = i64::MAX;
        for (index, charge) in charges.iter().enumerate() {
            if used.contains(&index) {
                continue;
            }
            let Ok(distance) = diff_days(date, &charge.date).map(i64::abs) else {
                continue;
            };
            if distance == 0 {
                best = Some(index);
                break;
            }
            if distance <= 7 && distance < best_distance {
                best = Some(index);
                best_distance = distance;
            }
        }
        if let Some(best) = best {
            matches.insert(date.clone(), best);
            used.insert(best);
        }
    }
    matches
}

fn warn(warnings: &mut Vec<ProjectionWarning>, warning: ProjectionWarning) {
    warnings.push(warning);
}

/// Gathers every movement (real, expected and projected) of a range: real
/// charges replace their matched occurrence, unmatched real charges are
/// expenses on their own, and missing data is collected as warnings
/// instead of inventing amounts.
pub fn collect_events(input: &EventCollectionInput) -> Result<CollectedEvents, CoreError> {
    let mut events: Vec<ProjectionEvent> = Vec::new();
    let mut warnings: Vec<ProjectionWarning> = Vec::new();
    let charges_by_subscription = group_charges(input.charges, input.from_date, input.to_date);

    for sub in input.subscriptions {
        let actual_charges = charges_by_subscription
            .get(&sub.subscription.id)
            .cloned()
            .unwrap_or_default();
        let mut used_charges: HashSet<usize> = HashSet::new();

        let occurrences: Vec<String> = match &sub.subscription.start_date {
            None => {
                warn(
                    &mut warnings,
                    ProjectionWarning {
                        code: WarningCode::MissingStart,
                        subscription_id: Some(sub.subscription.id.clone()),
                        message: format!(
                            "«{}» no tiene fecha de inicio: sus cobros estimados no se pueden proyectar.",
                            sub.subscription.name
                        ),
                    },
                );
                Vec::new()
            }
            Some(start_date) => generate_occurrences(&OccurrenceOptions {
                start_date,
                frequency: sub.subscription.frequency,
                billing_day: sub.subscription.billing_day,
                from_date: input.from_date,
                to_date: input.to_date,
                max_occurrences: None,
            })?
            .into_iter()
            .filter(|date| {
                can_charge_on(
                    date,
                    &CanChargeOptions {
                        status: sub.subscription.status,
                        end_date: sub.subscription.end_date.as_deref(),
                        cancelled_at: sub.subscription.cancelled_at.as_deref(),
                        pauses: &sub.pauses,
                        start_date: Some(start_date),
                        archived_at: sub.subscription.archived_at.as_deref(),
                    },
                )
            })
            .collect(),
        };
        let matches = match_charges(&occurrences, &actual_charges);
        emit_subscription_events(
            input,
            sub,
            &occurrences,
            &matches,
            &actual_charges,
            &mut used_charges,
            &mut events,
            &mut warnings,
        );
    }

    for income in input.incomes {
        if income.paused {
            continue;
        }
        let occurrences = generate_occurrences(&OccurrenceOptions {
            start_date: &income.date,
            frequency: income.frequency,
            billing_day: None,
            from_date: input.from_date,
            to_date: input.to_date,
            max_occurrences: None,
        })?;
        for date in occurrences {
            if let Some(end) = income.end_date.as_deref()
                && compare_iso_dates(&date, end) != Ordering::Less
            {
                continue;
            }
            let actual = income.actual_amount_minor;
            let converted = actual.map_or_else(
                || {
                    Some(convert_to_account_currency(
                        income.amount_minor,
                        income.currency,
                        input.account_currency,
                        &date,
                        input.rates,
                    ))
                },
                |_| None,
            );
            if let Some(converted) = &converted {
                if converted.rate_scaled.is_none() {
                    warn(
                        &mut warnings,
                        ProjectionWarning {
                            code: WarningCode::MissingRate,
                            subscription_id: None,
                            message: format!(
                                "No hay tipo de cambio {} → {} para el ingreso «{}».",
                                income.currency.as_str(),
                                input.account_currency.as_str(),
                                income.concept
                            ),
                        },
                    );
                    continue;
                }
                if converted.approximate {
                    warn(
                        &mut warnings,
                        ProjectionWarning {
                            code: WarningCode::ApproximateRate,
                            subscription_id: None,
                            message: format!(
                                "El ingreso «{}» se convierte con el tipo de cambio más reciente disponible.",
                                income.concept
                            ),
                        },
                    );
                }
            }
            events.push(income_or_expense_event(
                date,
                EventSource::Income,
                &income.id,
                &income.concept,
                &income.notes,
                &converted,
                actual,
                &income.amount_minor,
                income.currency,
                income.status.as_str(),
                Some("Ingresos".to_string()),
            ));
        }
    }

    for expense in input.expenses {
        let occurrences = generate_occurrences(&OccurrenceOptions {
            start_date: &expense.date,
            frequency: expense.frequency,
            billing_day: None,
            from_date: input.from_date,
            to_date: input.to_date,
            max_occurrences: None,
        })?;
        for date in occurrences {
            if let Some(end) = expense.end_date.as_deref()
                && compare_iso_dates(&date, end) != Ordering::Less
            {
                continue;
            }
            let actual = expense.actual_amount_minor;
            let converted = actual.map_or_else(
                || {
                    Some(convert_to_account_currency(
                        expense.amount_minor,
                        expense.currency,
                        input.account_currency,
                        &date,
                        input.rates,
                    ))
                },
                |_| None,
            );
            if let Some(converted) = &converted {
                if converted.rate_scaled.is_none() {
                    warn(
                        &mut warnings,
                        ProjectionWarning {
                            code: WarningCode::MissingRate,
                            subscription_id: None,
                            message: format!(
                                "No hay tipo de cambio {} → {} para el gasto «{}».",
                                expense.currency.as_str(),
                                input.account_currency.as_str(),
                                expense.concept
                            ),
                        },
                    );
                    continue;
                }
                if converted.approximate {
                    warn(
                        &mut warnings,
                        ProjectionWarning {
                            code: WarningCode::ApproximateRate,
                            subscription_id: None,
                            message: format!(
                                "El gasto «{}» se convierte con el tipo de cambio más reciente disponible.",
                                expense.concept
                            ),
                        },
                    );
                }
            }
            let category = if expense.category.is_empty() {
                None
            } else {
                Some(expense.category.clone())
            };
            events.push(income_or_expense_event(
                date,
                EventSource::Expense,
                &expense.id,
                &expense.concept,
                &expense.notes,
                &converted,
                actual,
                &expense.amount_minor,
                expense.currency,
                expense.status.as_str(),
                category,
            ));
        }
    }

    for event in input.extra_events {
        if compare_iso_dates(&event.date, input.from_date) != Ordering::Less
            && compare_iso_dates(&event.date, input.to_date) != Ordering::Greater
        {
            events.push(event.clone());
        }
    }

    events.sort_by(compare_event_order);
    Ok(CollectedEvents { events, warnings })
}

#[allow(clippy::too_many_arguments)]
fn emit_subscription_events(
    input: &EventCollectionInput,
    sub: &SubscriptionWithHistory,
    occurrences: &[String],
    matches: &HashMap<String, usize>,
    actual_charges: &[GroupedCharge],
    used_charges: &mut HashSet<usize>,
    events: &mut Vec<ProjectionEvent>,
    warnings: &mut Vec<ProjectionWarning>,
) {
    let mut warned_price = false;
    let mut warned_rate = false;
    let mut warned_approximate = false;

    for date in occurrences {
        let matched = matches.get(date).copied();
        if let Some(matched) = matched {
            used_charges.insert(matched);
            let actual_charge = &actual_charges[matched];
            // Un cargo real de 0 € marca un ciclo que no llegó a cobrarse.
            if actual_charge.amount_minor == 0 {
                continue;
            }
            let price = price_at(sub, &actual_charge.date).or_else(|| price_at(sub, date));
            let detail = if actual_charge.count > 1 {
                plan_prefix(
                    &sub.subscription.plan,
                    &format!("{} cobros agrupados", actual_charge.count),
                )
            } else {
                plan_or_description(&sub.subscription.plan, &sub.subscription.description)
            };
            events.push(ProjectionEvent {
                id: format!("{}:charge:{}", sub.subscription.id, actual_charge.date),
                date: actual_charge.date.clone(),
                kind: EventKind::Expense,
                source: EventSource::Subscription,
                source_id: sub.subscription.id.clone(),
                name: sub.subscription.name.clone(),
                detail,
                amount_minor: actual_charge.amount_minor,
                original_amount_minor: price.as_ref().map(|p| p.price_minor),
                original_currency: price.as_ref().map(|p| p.currency),
                rate_scaled: actual_charge.rate_scaled,
                estimated: false,
                status: Some(sub.subscription.status.as_str().to_string()),
                category: Some("Suscripciones".into()),
                affects_balance: Some(!sub.subscription.external_payment),
            });
            continue;
        }

        let Some(price) = price_at(sub, date) else {
            if !warned_price {
                warned_price = true;
                warn(warnings, missing_price_warning(&sub.subscription));
            }
            continue;
        };

        let converted = convert_to_account_currency(
            price.price_minor,
            price.currency,
            input.account_currency,
            date,
            input.rates,
        );
        if converted.rate_scaled.is_none() {
            if !warned_rate {
                warned_rate = true;
                warn(
                    warnings,
                    missing_rate_warning(&sub.subscription, price.currency, input.account_currency),
                );
            }
            continue;
        }
        if converted.approximate && !warned_approximate {
            warned_approximate = true;
            warn(
                warnings,
                approximate_rate_warning(&sub.subscription, converted.rate_source.as_deref()),
            );
        }

        events.push(ProjectionEvent {
            id: format!("{}:{}", sub.subscription.id, date),
            date: date.clone(),
            kind: EventKind::Expense,
            source: EventSource::Subscription,
            source_id: sub.subscription.id.clone(),
            name: sub.subscription.name.clone(),
            detail: plan_or_description(&sub.subscription.plan, &sub.subscription.description),
            amount_minor: converted.amount_minor,
            original_amount_minor: Some(price.price_minor),
            original_currency: Some(price.currency),
            rate_scaled: converted.rate_scaled,
            estimated: true,
            status: Some(sub.subscription.status.as_str().to_string()),
            category: Some("Suscripciones".into()),
            affects_balance: Some(!sub.subscription.external_payment),
        });
    }

    // Cargos reales sin ocurrencia (cobros atrasados, pausas, fin de
    // contrato o backfill).
    for (index, charge) in actual_charges.iter().enumerate() {
        if used_charges.contains(&index) || charge.amount_minor == 0 {
            continue;
        }
        let price = price_at(sub, &charge.date);
        let detail = if charge.count > 1 {
            format!("{} cobros reales agrupados", charge.count)
        } else {
            plan_or_description(&sub.subscription.plan, &sub.subscription.description)
        };
        events.push(ProjectionEvent {
            id: format!("{}:charge:{}", sub.subscription.id, charge.date),
            date: charge.date.clone(),
            kind: EventKind::Expense,
            source: EventSource::Subscription,
            source_id: sub.subscription.id.clone(),
            name: sub.subscription.name.clone(),
            detail,
            amount_minor: charge.amount_minor,
            original_amount_minor: price.as_ref().map(|p| p.price_minor),
            original_currency: price.as_ref().map(|p| p.currency),
            rate_scaled: charge.rate_scaled,
            estimated: false,
            status: Some(sub.subscription.status.as_str().to_string()),
            category: Some("Suscripciones".into()),
            affects_balance: Some(!sub.subscription.external_payment),
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn income_or_expense_event(
    date: String,
    source: EventSource,
    source_id: &str,
    concept: &str,
    notes: &str,
    converted: &Option<ConversionResult>,
    actual: Option<i64>,
    original_amount_minor: &i64,
    original_currency: Currency,
    status: &str,
    category: Option<String>,
) -> ProjectionEvent {
    // actual ?? converted.amountMinor: a real amount wins over the conversion,
    // and a missing conversion falls back to the original amount.
    let amount_minor = actual
        .or(converted
            .as_ref()
            .map(|c| c.amount_minor)
            .or(Some(*original_amount_minor)))
        .unwrap_or(*original_amount_minor);
    ProjectionEvent {
        id: format!("{source_id}:{date}"),
        date,
        kind: if source == EventSource::Income {
            EventKind::Income
        } else {
            EventKind::Expense
        },
        source,
        source_id: source_id.to_string(),
        name: concept.to_string(),
        detail: notes.to_string(),
        amount_minor,
        original_amount_minor: Some(*original_amount_minor),
        original_currency: Some(original_currency),
        rate_scaled: converted.as_ref().and_then(|c| c.rate_scaled),
        estimated: actual.is_none(),
        status: Some(status.to_string()),
        category,
        affects_balance: None,
    }
}

fn plan_prefix(plan: &Option<String>, suffix: &str) -> String {
    // `Plan {plan}. {suffix}` when a plan is set, like the reference.
    match plan {
        Some(plan) => format!("Plan {plan}. {suffix}"),
        None => suffix.to_string(),
    }
}

fn plan_or_description(plan: &Option<String>, description: &str) -> String {
    match plan {
        Some(plan) => format!("Plan {plan}"),
        None => description.to_string(),
    }
}

fn missing_price_warning(sub: &Subscription) -> ProjectionWarning {
    ProjectionWarning {
        code: WarningCode::MissingPrice,
        subscription_id: Some(sub.id.clone()),
        message: format!(
            "«{}» no tiene importe: el cargo no se incluye en la previsión.",
            sub.name
        ),
    }
}

fn missing_rate_warning(sub: &Subscription, from: Currency, to: Currency) -> ProjectionWarning {
    ProjectionWarning {
        code: WarningCode::MissingRate,
        subscription_id: Some(sub.id.clone()),
        message: format!(
            "No hay tipo de cambio {} → {} para «{}».",
            from.as_str(),
            to.as_str(),
            sub.name
        ),
    }
}

fn approximate_rate_warning(sub: &Subscription, source: Option<&str>) -> ProjectionWarning {
    let source = match source {
        Some(source) if !source.is_empty() => source.to_string(),
        _ => "aproximado".to_string(),
    };
    ProjectionWarning {
        code: WarningCode::ApproximateRate,
        subscription_id: Some(sub.id.clone()),
        message: format!(
            "No hay tipo de cambio vigente en la fecha para «{}»; se usa el más reciente disponible ({source}).",
            sub.name
        ),
    }
}

/// The reference's sort: date, then incomes before expenses, then the name
/// with `localeCompare('es-ES')`.
fn compare_event_order(a: &ProjectionEvent, b: &ProjectionEvent) -> Ordering {
    let by_date = compare_iso_dates(&a.date, &b.date);
    if by_date != Ordering::Equal {
        return by_date;
    }
    if a.kind != b.kind {
        return if a.kind == EventKind::Income {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    compare_names_es(&a.name, &b.name)
}

/// A Spanish collation of the event names: all base letters first, then
/// accents, then lowercase-before-uppercase, like ICU's es-ES compares
/// primary, secondary and tertiary level. Aware of the Latin accents and
/// ñ of the realistic data; full ICU tailoring (e.g. ñ as a primary letter
/// before "nz") is out of scope.
pub fn compare_names_es(a: &str, b: &str) -> Ordering {
    let a_keys: Vec<(char, u32, u32)> = a.chars().map(collation_key).collect();
    let b_keys: Vec<(char, u32, u32)> = b.chars().map(collation_key).collect();
    for level in 0..3 {
        let field = |key: &(char, u32, u32)| match level {
            0 => {
                let mut buf = [0u8; 4];
                key.0.encode_utf8(&mut buf).as_bytes()[0]
            }
            1 => key.1 as u8,
            _ => key.2 as u8,
        };
        let mut ordering = Ordering::Equal;
        for (key_a, key_b) in a_keys.iter().zip(&b_keys) {
            ordering = field(key_a).cmp(&field(key_b));
            if ordering != Ordering::Equal {
                break;
            }
        }
        if ordering == Ordering::Equal {
            ordering = a_keys.len().cmp(&b_keys.len());
        }
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    a.cmp(b)
}

/// (base letter, accent rank, case rank) per character: `a` < `á` < `b`,
/// `a` < `A`, `n` < `ñ` < `o`.
fn collation_key(c: char) -> (char, u32, u32) {
    let case_rank = if c.is_uppercase() { 1 } else { 0 };
    let lowercase = if case_rank == 1 {
        c.to_lowercase().next().unwrap_or(c)
    } else {
        c
    };
    if lowercase.is_ascii() {
        return (lowercase, 0, case_rank);
    }
    let (base, accent) = match lowercase {
        'à' => ('a', 1),
        'á' => ('a', 2),
        'â' => ('a', 3),
        'ã' => ('a', 4),
        'ä' => ('a', 5),
        'å' => ('a', 6),
        'è' => ('e', 1),
        'é' => ('e', 2),
        'ê' => ('e', 3),
        'ë' => ('e', 4),
        'ì' => ('i', 1),
        'í' => ('i', 2),
        'î' => ('i', 3),
        'ï' => ('i', 4),
        'ò' => ('o', 1),
        'ó' => ('o', 2),
        'ô' => ('o', 3),
        'õ' => ('o', 4),
        'ö' => ('o', 5),
        'ù' => ('u', 1),
        'ú' => ('u', 2),
        'û' => ('u', 3),
        'ü' => ('u', 4),
        'ç' => ('c', 1),
        'ñ' => ('n', 1),
        other => (other, 0),
    };
    (base, accent + 1, case_rank)
}

/// Projects the balance day by day from the account's real balance. The
/// projection starts at the later of `from_date` and the balance date.
pub fn project_balance(input: &ProjectionInput) -> Result<ProjectionResult, CoreError> {
    let account = input.account;
    let start = max_iso(input.events.from_date, &account.balance_date).to_string();
    let end = input.events.to_date.to_string();

    let collected = collect_events(&EventCollectionInput {
        account_currency: input.events.account_currency,
        subscriptions: input.events.subscriptions,
        incomes: input.events.incomes,
        expenses: input.events.expenses,
        rates: input.events.rates,
        charges: input.events.charges,
        from_date: &start,
        to_date: &end,
        extra_events: input.events.extra_events,
    })?;

    let mut by_date: HashMap<&str, Vec<&ProjectionEvent>> = HashMap::new();
    let mut total_income: i64 = 0;
    let mut total_expense: i64 = 0;
    for event in &collected.events {
        by_date.entry(&event.date).or_default().push(event);
        if event.affects_balance == Some(false) {
            continue;
        }
        match event.kind {
            EventKind::Income => total_income += event.amount_minor,
            EventKind::Expense => total_expense += event.amount_minor,
        }
    }

    let empty_days: Vec<DailyPoint> = Vec::new();
    let invalid = parse_iso_date(&start).is_none()
        || parse_iso_date(&end).is_none()
        || compare_iso_dates(&start, &end) == Ordering::Greater;
    if invalid {
        return Ok(ProjectionResult {
            start_date: start,
            end_date: end,
            start_balance_minor: account.balance_minor,
            end_balance_minor: account.balance_minor,
            days: empty_days,
            events: collected.events,
            warnings: collected.warnings,
            total_income_minor: 0,
            total_expense_minor: 0,
            net_minor: 0,
            min_balance_minor: account.balance_minor,
            min_balance_date: None,
            first_negative_date: None,
            first_negative_deficit_minor: None,
        });
    }

    let mut days: Vec<DailyPoint> = Vec::new();
    let mut balance = account.balance_minor;
    let mut min_balance = balance;
    let mut min_balance_date: Option<String> = None;
    let mut first_negative_date: Option<String> = None;
    let mut first_negative_deficit: Option<i64> = None;

    let mut cursor = start.clone();
    while compare_iso_dates(&cursor, &end) != Ordering::Greater {
        let day_events = by_date.get(cursor.as_str()).cloned().unwrap_or_default();
        let mut income: i64 = 0;
        let mut expense: i64 = 0;
        for event in &day_events {
            if event.affects_balance == Some(false) {
                continue;
            }
            match event.kind {
                EventKind::Income => income += event.amount_minor,
                EventKind::Expense => expense += event.amount_minor,
            }
        }
        balance += income - expense;
        days.push(DailyPoint {
            date: cursor.clone(),
            balance_minor: balance,
            income_minor: income,
            expense_minor: expense,
            events: day_events.iter().map(|e| (*e).clone()).collect(),
        });
        if balance < min_balance {
            min_balance = balance;
            min_balance_date = Some(cursor.clone());
        }
        if first_negative_date.is_none() && balance < 0 {
            first_negative_date = Some(cursor.clone());
            first_negative_deficit = Some(-balance);
        }
        cursor = add_days_iso(&cursor, 1)?;
    }

    Ok(ProjectionResult {
        start_date: start,
        end_date: end,
        start_balance_minor: account.balance_minor,
        end_balance_minor: balance,
        days,
        events: collected.events,
        warnings: collected.warnings,
        total_income_minor: total_income,
        total_expense_minor: total_expense,
        net_minor: total_income - total_expense,
        min_balance_minor: min_balance,
        min_balance_date,
        first_negative_date,
        first_negative_deficit_minor: first_negative_deficit,
    })
}

/// The monthly equivalent cost of a price by frequency (a 52-week year,
/// like the reference).
pub fn monthly_equivalent_minor(price_minor: i64, frequency: Frequency) -> i64 {
    match frequency {
        Frequency::Weekly => js_round((price_minor as f64 * 52.0) / 12.0) as i64,
        Frequency::Monthly => price_minor,
        Frequency::Quarterly => js_round(price_minor as f64 / 3.0) as i64,
        Frequency::Annual => js_round(price_minor as f64 / 12.0) as i64,
        Frequency::Once => price_minor,
    }
}

pub fn annualized_minor(price_minor: i64, frequency: Frequency) -> i64 {
    match frequency {
        Frequency::Weekly => price_minor * 52,
        Frequency::Monthly => price_minor * 12,
        Frequency::Quarterly => price_minor * 4,
        Frequency::Annual | Frequency::Once => price_minor,
    }
}

/// The inputs of `next_billing_for`.
#[derive(Debug, Clone)]
pub struct NextBillingForOptions<'a> {
    pub sub: &'a SubscriptionWithHistory,
    pub today: &'a str,
    /// Fechas con un cargo real ya registrado.
    pub charged_dates: &'a [String],
}

pub fn next_billing_for(options: &NextBillingForOptions) -> Result<Option<String>, CoreError> {
    let Some(start_date) = options.sub.subscription.start_date.as_deref() else {
        return Ok(None);
    };
    next_billing_date(&crate::recurrence::NextBillingOptions {
        start_date,
        frequency: options.sub.subscription.frequency,
        billing_day: options.sub.subscription.billing_day,
        next_billing_override: options.sub.subscription.next_billing_override.as_deref(),
        end_date: options.sub.subscription.end_date.as_deref(),
        cancelled_at: options.sub.subscription.cancelled_at.as_deref(),
        pauses: &options.sub.pauses,
        today: options.today,
        archived_at: options.sub.subscription.archived_at.as_deref(),
        charged_dates: options.charged_dates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ExpenseStatus, IncomeStatus, SubscriptionStatus};

    fn sub_with_price(price: Option<i64>, start: Option<&str>) -> SubscriptionWithHistory {
        SubscriptionWithHistory {
            subscription: crate::types::Subscription {
                id: "s1".into(),
                name: "Suscripción".into(),
                description: "Desc".into(),
                currency: Currency::Eur,
                price_minor: price,
                frequency: Frequency::Monthly,
                start_date: start.map(|s| s.into()),
                billing_day: None,
                next_billing_override: None,
                end_date: None,
                status: SubscriptionStatus::Active,
                cancelled_at: None,
                plan: None,
                notes: String::new(),
                external_payment: false,
                archived: false,
                archived_at: None,
                created_at: String::new(),
                updated_at: String::new(),
            },
            prices: vec![],
            plans: vec![],
            pauses: vec![],
            status_history: vec![],
            billing_days: vec![],
        }
    }

    fn price_entry(
        effective_from: &str,
        created_at: &str,
        effective_to: Option<&str>,
    ) -> PriceHistoryEntry {
        PriceHistoryEntry {
            id: format!("price-{effective_from}-{created_at}"),
            subscription_id: "s1".into(),
            price_minor: 2499,
            currency: Currency::Eur,
            effective_from: effective_from.into(),
            effective_to: effective_to.map(Into::into),
            note: String::new(),
            created_at: created_at.into(),
        }
    }

    #[test]
    fn equal_effective_dates_pick_the_latest_registered_price() {
        let mut sub = sub_with_price(None, Some("2026-04-23"));
        sub.prices = vec![
            price_entry("2026-11-18", "2026-11-18T13:00:00.000Z", None),
            price_entry("2026-11-18", "2026-11-18T14:00:00.000Z", None),
        ];
        assert_eq!(price_at(&sub, "2026-11-18").unwrap().price_minor, 2499);
        // Y el historial gana sobre el precio actual.
        assert_eq!(price_at(&sub, "2026-11-18").unwrap().price_minor, 2499);
    }

    #[test]
    fn effective_windows_close_with_effective_to() {
        let mut sub = sub_with_price(Some(1899), Some("2025-01-01"));
        sub.prices = vec![
            price_entry("2025-04-17", "2025-04-17T00:00:00.000Z", Some("2026-07-16")),
            price_entry("2026-07-17", "2026-07-17T00:00:00.000Z", None),
        ];
        assert_eq!(price_at(&sub, "2026-06-01").unwrap().price_minor, 2499);
        assert_eq!(price_at(&sub, "2026-07-16").unwrap().price_minor, 2499);
        assert_eq!(price_at(&sub, "2026-07-17").unwrap().price_minor, 2499);
        assert_eq!(
            price_at(&sub, "2024-01-01").unwrap().source,
            PriceSource::Current
        );
    }

    #[test]
    fn spanish_collation_orders_names_like_locale_compare() {
        assert_eq!(compare_names_es("a", "A"), Ordering::Less);
        assert_eq!(compare_names_es("A", "a"), Ordering::Greater);
        assert_eq!(compare_names_es("almacén", "asistente"), Ordering::Less);
        assert_eq!(compare_names_es("a", "á"), Ordering::Less);
        assert_eq!(compare_names_es("á", "ab"), Ordering::Less);
        assert_eq!(compare_names_es("ñ", "n"), Ordering::Greater);
        assert_eq!(compare_names_es("ño", "o"), Ordering::Less);
    }

    fn simple_subscription(id: &str, amount_minor: i64) -> Income {
        Income {
            id: id.into(),
            concept: format!("Ingreso {id}"),
            amount_minor,
            currency: Currency::Eur,
            date: "2026-11-05".into(),
            time: None,
            frequency: Frequency::Once,
            end_date: None,
            status: IncomeStatus::Expected,
            paused: false,
            notes: String::new(),
            actual_amount_minor: None,
            created_at: String::new(),
        }
    }

    fn simple_expense(id: &str, amount_minor: i64) -> Expense {
        Expense {
            id: id.into(),
            concept: format!("Gasto {id}"),
            category: "Tecnología".into(),
            amount_minor,
            currency: Currency::Eur,
            date: "2026-11-10".into(),
            time: None,
            frequency: Frequency::Once,
            end_date: None,
            status: ExpenseStatus::Planned,
            notes: String::new(),
            actual_amount_minor: None,
            created_at: String::new(),
        }
    }

    fn account_with(balance_minor: i64, balance_date: &str) -> Account {
        Account {
            id: "account".into(),
            name: "Demo".into(),
            currency: Currency::Eur,
            balance_minor,
            balance_date: balance_date.into(),
            balance_set: true,
            opening_balance_minor: 0,
            opening_balance_date: None,
            opening_balance_set: false,
            notes: String::new(),
        }
    }

    #[test]
    fn projects_day_by_day_from_the_real_balance() {
        let subs: Vec<SubscriptionWithHistory> = vec![sub_with_price(None, None)];
        let incomes = vec![simple_subscription("i1", 100_000)];
        let expenses = vec![simple_expense("e1", 35_000)];
        let account = account_with(50_000, "2026-11-01");
        let events = EventCollectionInput::new(
            Currency::Eur,
            &subs,
            &incomes,
            &expenses,
            &[],
            "2026-11-01",
            "2026-11-30",
        );
        let result = project_balance(&ProjectionInput {
            account: &account,
            events,
        })
        .unwrap();
        assert_eq!(result.start_balance_minor, 50_000);
        assert_eq!(result.days.len(), 30);
        assert_eq!(result.days[4].income_minor, 100_000);
        assert_eq!(result.days[9].expense_minor, 35_000);
        assert_eq!(result.end_balance_minor, 50_000 + 100_000 - 35_000);
        assert_eq!(result.total_income_minor, 100_000);
        assert_eq!(result.total_expense_minor, 35_000);
        assert_eq!(result.net_minor, 65_000);
        assert_eq!(result.first_negative_date, None);
    }

    #[test]
    fn starts_at_the_balance_date_when_it_is_later_than_from_date() {
        let subs: Vec<SubscriptionWithHistory> = vec![sub_with_price(None, None)];
        let incomes: Vec<Income> = vec![simple_subscription("i1", 10_000)];
        let expenses: Vec<Expense> = vec![];
        let account = account_with(20_000, "2026-11-10");
        let events = EventCollectionInput::new(
            Currency::Eur,
            &subs,
            &incomes,
            &expenses,
            &[],
            "2026-11-01",
            "2026-11-30",
        );
        let result = project_balance(&ProjectionInput {
            account: &account,
            events,
        })
        .unwrap();
        assert_eq!(result.start_date, "2026-11-10");
        // The income of 2026-11-05 is before the range start.
        assert_eq!(result.total_income_minor, 0);
        assert_eq!(result.days.len(), 21);
    }

    #[test]
    fn first_negative_day_is_reported_with_its_deficit() {
        let subs: Vec<SubscriptionWithHistory> = vec![sub_with_price(None, None)];
        let incomes: Vec<Income> = vec![];
        let expenses = vec![simple_expense("e1", 35_000)];
        let account = account_with(10_000, "2026-11-01");
        let events = EventCollectionInput::new(
            Currency::Eur,
            &subs,
            &incomes,
            &expenses,
            &[],
            "2026-11-01",
            "2026-11-30",
        );
        let result = project_balance(&ProjectionInput {
            account: &account,
            events,
        })
        .unwrap();
        assert_eq!(result.first_negative_date.as_deref(), Some("2026-11-10"));
        assert_eq!(result.first_negative_deficit_minor, Some(25_000));
        assert_eq!(result.min_balance_date.as_deref(), Some("2026-11-10"));
        assert_eq!(result.min_balance_minor, -25_000);
    }

    #[test]
    fn end_date_is_exclusive_for_incomes_and_expenses() {
        let subs: Vec<SubscriptionWithHistory> = vec![sub_with_price(None, None)];
        let mut income = simple_subscription("i1", 100_000);
        income.end_date = Some("2026-11-05".into());
        let incomes = [income];
        let expenses: Vec<Expense> = vec![];
        let account = account_with(0, "2026-11-01");
        let events = EventCollectionInput::new(
            Currency::Eur,
            &subs,
            &incomes,
            &expenses,
            &[],
            "2026-11-01",
            "2026-11-30",
        );
        let result = project_balance(&ProjectionInput {
            account: &account,
            events,
        })
        .unwrap();
        assert_eq!(result.total_income_minor, 0);
    }
}
