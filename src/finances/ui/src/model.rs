//! The pure view-model logic behind the pages: filtering, searching, sorting
//! and grouping movements, the calendar's month grid, the collection of
//! projected day events, the day-by-day balance projection (with scenarios
//! that never touch real data) and the analysis aggregates. Everything here
//! is plain functions over the [`crate::data`] structs, so the views stay
//! dumb and this module is fully unit-testable without GPUI.

use crate::data::{
    Currency, Frequency, LocalizedText, Money, Movement, MovementKind, MovementStatus,
    Subscription, SubscriptionStatus,
};
use chrono::{Datelike, Duration, NaiveDate};
use std::collections::BTreeMap;

/// Converts an amount into the account currency's minor units, rounding to
/// the cent. Same-currency amounts pass through untouched.
pub fn to_account_minor(
    amount: Money,
    account: Currency,
    rate: &impl Fn(Currency, Currency) -> f64,
) -> i64 {
    if amount.currency == account {
        amount.minor
    } else {
        (amount.minor as f64 * rate(amount.currency, account)).round() as i64
    }
}

/// The category label a subscription charge carries.
pub const CATEGORY_SUBSCRIPTION: LocalizedText = LocalizedText {
    en: "Subscription",
    es: "Suscripción",
};

/// The category label movements without one carry.
pub const CATEGORY_OTHER: LocalizedText = LocalizedText {
    en: "Other",
    es: "Otros",
};

// ---------------------------------------------------------------------------
// Movements: filters, search, sort, grouping
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KindFilter {
    All,
    Incomes,
    /// Expenses and real charges (everything that is not an income).
    Expenses,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusFilter {
    All,
    Pending,
    Done,
    Paused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortOrder {
    Date,
    Amount,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroupBy {
    Month,
    Day,
}

#[derive(Clone, Debug)]
pub struct MovementFilter {
    pub kind: KindFilter,
    pub status: StatusFilter,
    pub query: String,
    pub sort: SortOrder,
    pub group_by: GroupBy,
}

impl Default for MovementFilter {
    fn default() -> Self {
        Self {
            kind: KindFilter::All,
            status: StatusFilter::All,
            query: String::new(),
            sort: SortOrder::Date,
            group_by: GroupBy::Month,
        }
    }
}

/// The status filter's semantics, mirroring the reference: a real charge
/// always counts as done and never as pending; "paused" only matches paused
/// recurring incomes.
pub fn matches_status(movement: &Movement, filter: StatusFilter) -> bool {
    match filter {
        StatusFilter::All => true,
        StatusFilter::Paused => movement.kind == MovementKind::Income && movement.paused,
        StatusFilter::Done => match movement.kind {
            MovementKind::Charge => true,
            MovementKind::Income => movement.status == MovementStatus::Received,
            MovementKind::Expense => movement.status == MovementStatus::Done,
        },
        StatusFilter::Pending => match movement.kind {
            MovementKind::Charge => false,
            MovementKind::Income => movement.status == MovementStatus::Expected && !movement.paused,
            MovementKind::Expense => movement.status != MovementStatus::Done,
        },
    }
}

fn matches_kind(movement: &Movement, filter: KindFilter) -> bool {
    match filter {
        KindFilter::All => true,
        KindFilter::Incomes => movement.kind == MovementKind::Income,
        KindFilter::Expenses => movement.kind != MovementKind::Income,
    }
}

/// The text a movement is searched by: name, notes and category, in both
/// interface languages so the search does not depend on which one is
/// active.
pub fn search_haystack(movement: &Movement) -> String {
    let mut parts = vec![movement.name.clone()];
    if let Some(category) = &movement.category {
        parts.push(category.en.to_string());
        parts.push(category.es.to_string());
    }
    if let Some(notes) = &movement.notes {
        parts.push(notes.en.to_string());
        parts.push(notes.es.to_string());
    }
    parts.join(" ").to_lowercase()
}

/// Applies kind, status and text search, then sorts: by date (newest first,
/// then time, then name) or by amount (largest first, in account currency).
pub fn filter_movements<'a>(
    movements: &'a [Movement],
    filter: &MovementFilter,
    account: Currency,
    rate: &impl Fn(Currency, Currency) -> f64,
) -> Vec<&'a Movement> {
    let query = filter.query.trim().to_lowercase();
    let mut out: Vec<&Movement> = movements
        .iter()
        .filter(|m| matches_kind(m, filter.kind))
        .filter(|m| matches_status(m, filter.status))
        .filter(|m| query.is_empty() || search_haystack(m).contains(query.as_str()))
        .collect();
    match filter.sort {
        SortOrder::Date => out.sort_by(|a, b| {
            b.date
                .cmp(&a.date)
                .then_with(|| time_key(a).cmp(time_key(b)))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        }),
        SortOrder::Amount => out.sort_by(|a, b| {
            to_account_minor(b.amount, account, rate)
                .cmp(&to_account_minor(a.amount, account, rate))
                .then_with(|| b.date.cmp(&a.date))
        }),
    }
    out
}

/// Movements without a time sort after the ones with one, within the day.
fn time_key(movement: &Movement) -> &str {
    movement.time.as_deref().unwrap_or("99:99")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum GroupKey {
    Month(i32, u32),
    Day(NaiveDate),
}

pub struct Group<'a> {
    pub key: GroupKey,
    pub items: Vec<&'a Movement>,
}

/// Groups the already-filtered movements by month or by day, newest first.
pub fn group_movements<'a>(items: &[&'a Movement], group_by: GroupBy) -> Vec<Group<'a>> {
    let mut groups: Vec<Group<'a>> = Vec::new();
    for movement in items {
        let key = match group_by {
            GroupBy::Month => GroupKey::Month(movement.date.year(), movement.date.month()),
            GroupBy::Day => GroupKey::Day(movement.date),
        };
        match groups.iter_mut().find(|g| g.key == key) {
            Some(group) => group.items.push(movement),
            None => groups.push(Group {
                key,
                items: vec![movement],
            }),
        }
    }
    groups.sort_by_key(|g| std::cmp::Reverse(g.key));
    groups
}

/// The net of a group in account currency minor units (incomes minus
/// expenses and charges).
pub fn group_net(
    items: &[&Movement],
    account: Currency,
    rate: &impl Fn(Currency, Currency) -> f64,
) -> i64 {
    items
        .iter()
        .map(|m| {
            let minor = to_account_minor(m.amount, account, rate);
            match m.kind {
                MovementKind::Income => minor,
                MovementKind::Expense | MovementKind::Charge => -minor,
            }
        })
        .sum()
}

// ---------------------------------------------------------------------------
// Dates: the calendar's month grid and month arithmetic
// ---------------------------------------------------------------------------

pub fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    (NaiveDate::from_ymd_opt(next_year, next_month, 1).expect("first of next month")
        - NaiveDate::from_ymd_opt(year, month, 1).expect("first of month"))
    .num_days() as u32
}

/// Adds months to a date, clamping the day to the target month's length
/// (the 31st of January becomes the 28th/29th of February).
pub fn add_months(date: NaiveDate, months: i32) -> NaiveDate {
    let total = date.year() * 12 + date.month0() as i32 + months;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) as u32 + 1;
    let day = date.day().min(days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day).expect("clamped date")
}

pub fn start_of_month(date: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(date.year(), date.month(), 1).expect("first of month")
}

pub fn end_of_month(date: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(
        date.year(),
        date.month(),
        days_in_month(date.year(), date.month()),
    )
    .expect("last of month")
}

/// The calendar's month grid: whole weeks (Monday first), up to six rows.
/// Like the reference, it stops early once a row lies entirely outside the
/// month past the fifth week.
pub fn month_grid(year: i32, month: u32) -> Vec<[NaiveDate; 7]> {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("first of month");
    // chrono: Monday = 0 .. Sunday = 6.
    let lead = first.weekday().num_days_from_monday();
    let mut cursor = first - Duration::days(lead as i64);
    let mut weeks = Vec::new();
    for week in 0..6 {
        let mut row = [cursor; 7];
        for slot in row.iter_mut() {
            *slot = cursor;
            cursor += Duration::days(1);
        }
        let outside = row[0].month() != month && row[6].month() != month;
        weeks.push(row);
        if week >= 4 && outside {
            break;
        }
    }
    weeks
}

/// The months from `from`'s month to `to`'s month, oldest first.
pub fn month_list(from: NaiveDate, to: NaiveDate) -> Vec<(i32, u32)> {
    let mut months = Vec::new();
    let end = (to.year(), to.month());
    let mut cursor = (from.year(), from.month());
    while cursor <= end {
        months.push(cursor);
        let total = cursor.0 * 12 + cursor.1 as i32;
        cursor = (total.div_euclid(12), (total.rem_euclid(12) + 1) as u32);
    }
    months
}

// ---------------------------------------------------------------------------
// Projected events
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum EventKind {
    Income,
    Expense,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventSource {
    Subscription,
    Income,
    Expense,
    /// A scenario event: local to the projection page, never real data.
    Scenario,
}

/// One projected movement on one day, already converted to the account
/// currency.
#[derive(Clone, Debug)]
pub struct DayEvent {
    pub id: String,
    pub date: NaiveDate,
    pub kind: EventKind,
    pub source: EventSource,
    pub name: String,
    pub category: Option<LocalizedText>,
    /// In the account currency, minor units.
    pub amount: i64,
    /// The original amount when it was recorded in another currency.
    pub original: Option<Money>,
    /// False when a real amount was recorded for it.
    pub estimated: bool,
}

/// Steps a date by its frequency; `Once` yields a single occurrence. Stops
/// at `to` and at `end_date` (exclusive, the first day not charged).
fn occurrences(
    date: NaiveDate,
    frequency: Frequency,
    end_date: Option<NaiveDate>,
    to: NaiveDate,
) -> Vec<NaiveDate> {
    let mut out = Vec::new();
    let mut cursor = date;
    let mut guard = 0;
    loop {
        if cursor > to || guard > 5000 {
            break;
        }
        if let Some(end) = end_date
            && cursor >= end
        {
            break;
        }
        out.push(cursor);
        cursor = match frequency {
            Frequency::Once => break,
            Frequency::Weekly => cursor + Duration::days(7),
            Frequency::Monthly => add_months(cursor, 1),
            Frequency::Quarterly => add_months(cursor, 3),
            Frequency::Annual => add_months(cursor, 12),
        };
        guard += 1;
    }
    out
}

/// A real charge replaces the estimated charge of its subscription's cycle:
/// same day, or the nearest occurrence within 7 days. Charges that match no
/// occurrence still count as an expense on their own date. A charge of 0
/// marks the cycle as not billed: the estimate is dropped without adding
/// any expense.
const CHARGE_ASSOCIATION_DAYS: i64 = 7;

/// Collects every projected event between `from` and `to` (inclusive):
/// subscription charges, recurring incomes and expenses, with the real
/// charges substituted in. Sorted by date.
pub fn collect_events(
    subscriptions: &[Subscription],
    movements: &[Movement],
    account: Currency,
    rate: &impl Fn(Currency, Currency) -> f64,
    from: NaiveDate,
    to: NaiveDate,
) -> Vec<DayEvent> {
    let mut events: Vec<DayEvent> = Vec::new();

    // Estimated subscription charges; remember where each one lives so a
    // real charge can replace it.
    let mut estimated: Vec<(String, NaiveDate, usize)> = Vec::new();
    for sub in subscriptions {
        if sub.status != SubscriptionStatus::Active {
            continue;
        }
        let (Some(price), Some(next)) = (sub.price, sub.next_charge) else {
            continue;
        };
        for date in occurrences(next, sub.frequency, sub.end_date, to) {
            if date < from {
                continue;
            }
            let original = (price.currency != account).then_some(price);
            events.push(DayEvent {
                id: format!("sub-{}-{date}", sub.id),
                date,
                kind: EventKind::Expense,
                source: EventSource::Subscription,
                name: sub.name.clone(),
                category: Some(CATEGORY_SUBSCRIPTION),
                amount: to_account_minor(price, account, rate),
                original,
                estimated: true,
            });
            estimated.push((sub.id.clone(), date, events.len() - 1));
        }
    }

    // Real charges replace their cycle's estimate.
    let charges: Vec<&Movement> = movements
        .iter()
        .filter(|m| m.kind == MovementKind::Charge)
        .collect();
    let mut mapped = vec![false; charges.len()];
    for (sub_id, date, index) in &estimated {
        let mut candidates: Vec<usize> = charges
            .iter()
            .enumerate()
            .filter(|(j, c)| {
                !mapped[*j]
                    && c.subscription_id.as_deref() == Some(sub_id.as_str())
                    && (c.date - *date).num_days().abs() <= CHARGE_ASSOCIATION_DAYS
            })
            .map(|(j, _)| j)
            .collect();
        if candidates.is_empty() {
            continue;
        }
        // Nearest date first, same day wins.
        candidates.sort_by_key(|j| (charges[*j].date - *date).num_days().abs());
        let total: i64 = candidates
            .iter()
            .map(|j| to_account_minor(charges[*j].amount, account, rate))
            .sum();
        for j in &candidates {
            mapped[*j] = true;
        }
        let event = &mut events[*index];
        event.id = format!("charge-{}", charges[candidates[0]].id);
        event.estimated = false;
        if total == 0 {
            // Not billed: the estimate disappears without any expense.
            event.amount = 0;
        } else {
            event.amount = total;
        }
    }
    // A not-billed cycle contributes no expense at all.
    events.retain(|e| e.amount != 0 || e.estimated || e.source != EventSource::Subscription);
    // Charges that matched no occurrence still count, on their own date.
    for (i, charge) in charges.iter().enumerate() {
        if mapped[i] {
            continue;
        }
        let original = (charge.amount.currency != account).then_some(charge.amount);
        events.push(DayEvent {
            id: format!("charge-{}", charge.id),
            date: charge.date,
            kind: EventKind::Expense,
            source: EventSource::Subscription,
            name: charge.name.clone(),
            category: Some(CATEGORY_SUBSCRIPTION),
            amount: to_account_minor(charge.amount, account, rate),
            original,
            estimated: false,
        });
    }

    // Incomes and expenses, recurring ones included; a paused series stops.
    for movement in movements {
        if movement.kind == MovementKind::Charge || movement.paused {
            continue;
        }
        let kind = match movement.kind {
            MovementKind::Income => EventKind::Income,
            _ => EventKind::Expense,
        };
        let estimated = match movement.kind {
            MovementKind::Income => movement.status != MovementStatus::Received,
            _ => movement.status != MovementStatus::Done,
        };
        for date in occurrences(movement.date, movement.frequency, movement.end_date, to) {
            if date < from {
                continue;
            }
            let original = (movement.amount.currency != account).then_some(movement.amount);
            events.push(DayEvent {
                id: format!("{}-{date}", movement.id),
                date,
                kind,
                source: match movement.kind {
                    MovementKind::Income => EventSource::Income,
                    _ => EventSource::Expense,
                },
                name: movement.name.clone(),
                category: movement.category,
                amount: to_account_minor(movement.amount, account, rate),
                original,
                estimated,
            });
        }
    }

    events.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });
    events
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct DayPoint {
    pub date: NaiveDate,
    /// Balance at the close of the day, in account currency minor units.
    pub balance: i64,
    pub income: i64,
    pub expense: i64,
    pub events: Vec<DayEvent>,
}

#[derive(Clone, Debug)]
pub struct Projection {
    pub from: NaiveDate,
    pub to: NaiveDate,
    /// The balance at the close of the day before `from`.
    pub start_balance: i64,
    pub end_balance: i64,
    pub days: Vec<DayPoint>,
    pub total_income: i64,
    pub total_expense: i64,
    pub min_balance: i64,
    pub min_date: Option<NaiveDate>,
    /// The first day the balance goes negative, with the deficit.
    pub first_negative: Option<(NaiveDate, i64)>,
}

/// Walks the events day by day from the balance's anchor date and returns
/// the per-day projection clipped to `[from, to]`. `anchor_minor` is the
/// real balance in the account currency's minor units, at `anchor_date`.
/// `scenario` events are added on top of the real ones and never modify
/// them.
pub fn project(
    anchor_minor: i64,
    anchor_date: NaiveDate,
    events: &[DayEvent],
    from: NaiveDate,
    to: NaiveDate,
    scenario: &[DayEvent],
) -> Projection {
    let mut by_date: BTreeMap<NaiveDate, Vec<&DayEvent>> = BTreeMap::new();
    for event in events.iter().chain(scenario.iter()) {
        by_date.entry(event.date).or_default().push(event);
    }

    let anchor_balance = anchor_minor;
    let mut balance = anchor_balance;
    let mut days = Vec::new();
    let mut total_income = 0i64;
    let mut total_expense = 0i64;
    let mut cursor = anchor_date;
    while cursor <= to {
        let todays = by_date.get(&cursor).cloned().unwrap_or_default();
        let income: i64 = todays
            .iter()
            .filter(|e| e.kind == EventKind::Income)
            .map(|e| e.amount)
            .sum();
        let expense: i64 = todays
            .iter()
            .filter(|e| e.kind == EventKind::Expense)
            .map(|e| e.amount)
            .sum();
        balance += income - expense;
        if cursor >= from {
            total_income += income;
            total_expense += expense;
            days.push(DayPoint {
                date: cursor,
                balance,
                income,
                expense,
                events: todays.into_iter().cloned().collect(),
            });
        }
        cursor += Duration::days(1);
    }
    // The balance at the close of the day before `from`.
    let start_balance = if from > anchor_date {
        days.first()
            .map(|d| d.balance - d.income + d.expense)
            .unwrap_or(anchor_balance)
    } else {
        anchor_balance
    };

    let mut min_balance = i64::MAX;
    let mut min_date = None;
    let mut first_negative = None;
    for day in &days {
        if day.balance < min_balance {
            min_balance = day.balance;
            min_date = Some(day.date);
        }
        if first_negative.is_none() && day.balance < 0 {
            first_negative = Some((day.date, -day.balance));
        }
    }
    if days.is_empty() {
        min_balance = anchor_balance;
        min_date = None;
    }
    Projection {
        from,
        to,
        start_balance,
        end_balance: days.last().map(|d| d.balance).unwrap_or(anchor_balance),
        days,
        total_income,
        total_expense,
        min_balance,
        min_date,
        first_negative,
    }
}

// ---------------------------------------------------------------------------
// Analysis aggregates
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MonthTotals {
    pub income: i64,
    pub expense: i64,
    pub net: i64,
    /// The part of the expense that comes from subscription charges.
    pub subscriptions: i64,
    pub count: usize,
}

pub fn totals_for_month(events: &[DayEvent], year: i32, month: u32) -> MonthTotals {
    let mut totals = MonthTotals::default();
    for event in events {
        if event.date.year() != year || event.date.month() != month {
            continue;
        }
        totals.count += 1;
        match event.kind {
            EventKind::Income => totals.income += event.amount,
            EventKind::Expense => {
                totals.expense += event.amount;
                if event.source == EventSource::Subscription {
                    totals.subscriptions += event.amount;
                }
            }
        }
    }
    totals.net = totals.income - totals.expense;
    totals
}

#[derive(Clone, Debug)]
pub struct CategorySlice {
    pub category: LocalizedText,
    pub amount: i64,
    pub count: usize,
}

/// The expense distribution by category between `from` and `to`, largest
/// first.
pub fn category_distribution(
    events: &[DayEvent],
    from: NaiveDate,
    to: NaiveDate,
) -> Vec<CategorySlice> {
    let mut slices: Vec<CategorySlice> = Vec::new();
    for event in events {
        if event.kind != EventKind::Expense || event.date < from || event.date > to {
            continue;
        }
        let category = event.category.unwrap_or(CATEGORY_OTHER);
        match slices.iter_mut().find(|s| s.category.en == category.en) {
            Some(slice) => {
                slice.amount += event.amount;
                slice.count += 1;
            }
            None => slices.push(CategorySlice {
                category,
                amount: event.amount,
                count: 1,
            }),
        }
    }
    slices.sort_by(|a, b| {
        b.amount
            .cmp(&a.amount)
            .then_with(|| a.category.en.cmp(b.category.en))
    });
    slices
}

/// The monthly-equivalent cost of a price, in account currency minor units.
pub fn monthly_equivalent(
    price: Money,
    frequency: Frequency,
    account: Currency,
    rate: &impl Fn(Currency, Currency) -> f64,
) -> i64 {
    let minor = to_account_minor(price, account, rate);
    match frequency {
        Frequency::Once | Frequency::Weekly | Frequency::Monthly => minor,
        Frequency::Quarterly => minor / 3,
        Frequency::Annual => minor / 12,
    }
}

#[derive(Clone, Debug)]
pub struct SubscriptionRow {
    pub id: String,
    pub name: String,
    pub monthly: i64,
    pub annual: i64,
}

/// The active subscriptions with a price, most expensive first by their
/// monthly-equivalent cost.
pub fn subscription_ranking(
    subscriptions: &[Subscription],
    account: Currency,
    rate: &impl Fn(Currency, Currency) -> f64,
) -> Vec<SubscriptionRow> {
    let mut rows: Vec<SubscriptionRow> = subscriptions
        .iter()
        .filter(|s| s.status == SubscriptionStatus::Active)
        .filter_map(|s| {
            let price = s.price?;
            let monthly = monthly_equivalent(price, s.frequency, account, rate);
            Some(SubscriptionRow {
                id: s.id.clone(),
                name: s.name.clone(),
                monthly,
                annual: monthly * 12,
            })
        })
        .collect();
    rows.sort_by(|a, b| b.monthly.cmp(&a.monthly).then_with(|| a.name.cmp(&b.name)));
    rows
}

/// The monthly-equivalent cost that cancelled or finished subscriptions no
/// longer add (the savings from having left them).
pub fn savings_from_inactive(
    subscriptions: &[Subscription],
    account: Currency,
    rate: &impl Fn(Currency, Currency) -> f64,
) -> i64 {
    subscriptions
        .iter()
        .filter(|s| {
            matches!(
                s.status,
                SubscriptionStatus::Cancelled | SubscriptionStatus::Finished
            )
        })
        .filter_map(|s| s.price.map(|price| (price, s.frequency)))
        .map(|(price, frequency)| monthly_equivalent(price, frequency, account, rate))
        .sum()
}

/// The normalized (monthly-equivalent) cost of all active subscriptions.
pub fn normalized_monthly_cost(
    subscriptions: &[Subscription],
    account: Currency,
    rate: &impl Fn(Currency, Currency) -> f64,
) -> i64 {
    subscription_ranking(subscriptions, account, rate)
        .iter()
        .map(|row| row.monthly)
        .sum()
}

#[derive(Clone, Debug)]
pub struct CostPoint {
    pub year: i32,
    pub month: u32,
    /// What the subscriptions actually charged that month.
    pub actual: i64,
    /// The normalized monthly equivalent.
    pub normalized: i64,
}

/// Per month: real subscription charges against the normalized equivalent.
pub fn cost_evolution(
    events: &[DayEvent],
    months: &[(i32, u32)],
    normalized: i64,
) -> Vec<CostPoint> {
    months
        .iter()
        .map(|&(year, month)| CostPoint {
            year,
            month,
            actual: totals_for_month(events, year, month).subscriptions,
            normalized,
        })
        .collect()
}

/// Parses a typed amount ("19.99", "19,99", "350") into minor units.
/// Both the dot and the comma are accepted as the decimal separator.
pub fn parse_amount_minor(text: &str) -> Option<i64> {
    let cleaned = text.trim().replace(',', ".");
    if cleaned.is_empty() {
        return None;
    }
    let value: f64 = cleaned.parse().ok()?;
    if !value.is_finite() || value < 0. {
        return None;
    }
    Some((value * 100.).round() as i64)
}

/// Parses a typed date ("2026-11-25") into a `NaiveDate`. Empty means "no
/// date" and is the caller's `None`; anything else must be `YYYY-MM-DD`.
pub fn parse_iso_date(text: &str) -> Option<NaiveDate> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    NaiveDate::parse_from_str(trimmed, "%Y-%m-%d").ok()
}

/// Parses a typed date that must be present (a movement's date, a
/// subscription's start). `None` for empty or malformed text.
pub fn parse_required_date(text: &str) -> Option<NaiveDate> {
    parse_iso_date(text).filter(|_| !text.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::SubscriptionStatus;

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).unwrap()
    }

    fn eur(minor: i64) -> Money {
        Money::eur(minor)
    }

    fn rate(from: Currency, to: Currency) -> f64 {
        if from == to { 1.0 } else { 0.92 }
    }

    fn movement(
        id: &str,
        kind: MovementKind,
        name: &str,
        amount: Money,
        date: NaiveDate,
    ) -> Movement {
        Movement {
            id: id.into(),
            kind,
            name: name.into(),
            subscription_id: None,
            category: None,
            amount,
            date,
            time: None,
            frequency: Frequency::Once,
            end_date: None,
            status: match kind {
                MovementKind::Income => MovementStatus::Expected,
                _ => MovementStatus::Planned,
            },
            paused: false,
            notes: None,
        }
    }

    fn sub(
        id: &str,
        price: Option<Money>,
        status: SubscriptionStatus,
        next: Option<NaiveDate>,
    ) -> Subscription {
        Subscription {
            id: id.into(),
            name: id.into(),
            description: LocalizedText { en: "", es: "" },
            price,
            frequency: Frequency::Monthly,
            status,
            next_charge: next,
            end_date: None,
        }
    }

    // -- dates ---------------------------------------------------------------

    #[test]
    fn amount_parsing_accepts_dot_and_comma() {
        assert_eq!(parse_amount_minor("19.99"), Some(1999));
        assert_eq!(parse_amount_minor("19,99"), Some(1999));
        assert_eq!(parse_amount_minor("350"), Some(35000));
        assert_eq!(parse_amount_minor(" 0.5 "), Some(50));
        assert_eq!(parse_amount_minor(""), None);
        assert_eq!(parse_amount_minor("abc"), None);
        assert_eq!(parse_amount_minor("-3"), None);
    }

    #[test]
    fn add_months_clamps_the_day() {
        assert_eq!(add_months(date(2026, 1, 31), 1), date(2026, 2, 28));
        assert_eq!(add_months(date(2024, 1, 31), 1), date(2024, 2, 29));
        assert_eq!(add_months(date(2026, 12, 15), 2), date(2027, 2, 15));
        assert_eq!(add_months(date(2026, 3, 31), -1), date(2026, 2, 28));
        assert_eq!(add_months(date(2026, 11, 25), 6), date(2027, 5, 25));
    }

    #[test]
    fn month_grid_is_monday_first_and_covers_the_month() {
        // November 2026 starts on a Sunday, so the grid leads with Oct 26.
        let grid = month_grid(2026, 11);
        assert_eq!(grid[0][0], date(2026, 10, 26));
        assert_eq!(grid[0][6], date(2026, 11, 1));
        assert!(grid.iter().flatten().any(|d| *d == date(2026, 11, 30)));
        // Every day of the month is present exactly once.
        let count = grid
            .iter()
            .flatten()
            .filter(|d| d.month() == 11 && d.year() == 2026)
            .count();
        assert_eq!(count, 30);
        // February 2026 starts on a Sunday and needs six rows; February 2027
        // starts on a Monday and fits in five.
        assert_eq!(month_grid(2026, 2).len(), 6);
        assert_eq!(month_grid(2027, 2).len(), 5);
        for week in &grid {
            for (i, day) in week.iter().enumerate() {
                assert_eq!(day.weekday().num_days_from_monday() as usize, i);
            }
        }
    }

    #[test]
    fn month_list_spans_inclusive_months() {
        assert_eq!(
            month_list(date(2026, 6, 15), date(2026, 9, 1)),
            vec![(2026, 6), (2026, 7), (2026, 8), (2026, 9)]
        );
        assert_eq!(
            month_list(date(2026, 11, 1), date(2027, 2, 28)),
            vec![(2026, 11), (2026, 12), (2027, 1), (2027, 2)]
        );
    }

    // -- filters, search, sort, grouping --------------------------------------

    fn sample_movements() -> Vec<Movement> {
        vec![
            movement(
                "i1",
                MovementKind::Income,
                "Nómina",
                eur(150000),
                date(2026, 11, 25),
            ),
            movement(
                "i2",
                MovementKind::Income,
                "Extra",
                eur(20000),
                date(2026, 11, 10),
            ),
            Movement {
                paused: true,
                status: MovementStatus::Expected,
                ..movement(
                    "i3",
                    MovementKind::Income,
                    "Alquiler",
                    eur(60000),
                    date(2026, 11, 1),
                )
            },
            Movement {
                status: MovementStatus::Done,
                category: Some(LocalizedText {
                    en: "Food",
                    es: "Comida",
                }),
                notes: Some(LocalizedText {
                    en: "weekly shop",
                    es: "compra semanal",
                }),
                ..movement(
                    "e1",
                    MovementKind::Expense,
                    "Supermercado",
                    eur(4530),
                    date(2026, 11, 24),
                )
            },
            Movement {
                status: MovementStatus::Pending,
                ..movement(
                    "e2",
                    MovementKind::Expense,
                    "Taxi",
                    eur(1200),
                    date(2026, 11, 25),
                )
            },
            Movement {
                kind: MovementKind::Charge,
                name: "AlmacenNube".into(),
                subscription_id: Some("almacen-nube".into()),
                status: MovementStatus::Done,
                amount: eur(999),
                date: date(2026, 11, 28),
                ..movement(
                    "c1",
                    MovementKind::Charge,
                    "AlmacenNube",
                    eur(999),
                    date(2026, 11, 28),
                )
            },
            movement(
                "e3",
                MovementKind::Expense,
                "Books",
                Money::usd(1000),
                date(2026, 10, 2),
            ),
        ]
    }

    #[test]
    fn kind_and_status_filters_match_the_reference() {
        let movements = sample_movements();
        let all = MovementFilter::default();
        assert_eq!(
            filter_movements(&movements, &all, Currency::Eur, &rate).len(),
            7
        );

        let incomes = MovementFilter {
            kind: KindFilter::Incomes,
            ..Default::default()
        };
        let incomes = filter_movements(&movements, &incomes, Currency::Eur, &rate);
        assert_eq!(incomes.len(), 3);
        assert!(incomes.iter().all(|m| m.kind == MovementKind::Income));

        let expenses = MovementFilter {
            kind: KindFilter::Expenses,
            ..Default::default()
        };
        let expenses = filter_movements(&movements, &expenses, Currency::Eur, &rate);
        assert_eq!(expenses.len(), 4); // expenses plus the charge

        let pending = MovementFilter {
            status: StatusFilter::Pending,
            ..Default::default()
        };
        let pending = filter_movements(&movements, &pending, Currency::Eur, &rate);
        let mut ids: Vec<&str> = pending.iter().map(|m| m.id.as_str()).collect();
        ids.sort_unstable();
        // i1/i2 expected, e2 pending, e3 planned; e1 is done and c1 a charge.
        assert_eq!(ids, ["e2", "e3", "i1", "i2"]);

        let done = MovementFilter {
            status: StatusFilter::Done,
            ..Default::default()
        };
        let done = filter_movements(&movements, &done, Currency::Eur, &rate);
        let mut ids: Vec<&str> = done.iter().map(|m| m.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["c1", "e1"]);

        let paused = MovementFilter {
            status: StatusFilter::Paused,
            ..Default::default()
        };
        let paused = filter_movements(&movements, &paused, Currency::Eur, &rate);
        assert_eq!(
            paused.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["i3"]
        );
    }

    #[test]
    fn search_matches_name_notes_and_category_case_insensitively() {
        let movements = sample_movements();
        let filter = |q: &str| MovementFilter {
            query: q.into(),
            ..Default::default()
        };
        assert_eq!(
            filter_movements(&movements, &filter("super"), Currency::Eur, &rate).len(),
            1
        );
        assert_eq!(
            filter_movements(&movements, &filter("COMPRA"), Currency::Eur, &rate).len(),
            1
        );
        // The category matches in both languages, whichever is active.
        assert_eq!(
            filter_movements(&movements, &filter("food"), Currency::Eur, &rate).len(),
            1
        );
        assert_eq!(
            filter_movements(&movements, &filter("comida"), Currency::Eur, &rate).len(),
            1
        );
        assert_eq!(
            filter_movements(&movements, &filter("almacen"), Currency::Eur, &rate).len(),
            1
        );
        assert_eq!(
            filter_movements(&movements, &filter("nada"), Currency::Eur, &rate).len(),
            0
        );
        assert_eq!(
            filter_movements(&movements, &filter("  "), Currency::Eur, &rate).len(),
            7
        );
    }

    #[test]
    fn sorting_by_date_is_newest_first_and_by_amount_largest_first() {
        let movements = sample_movements();
        let by_date = MovementFilter {
            sort: SortOrder::Date,
            ..Default::default()
        };
        let ids: Vec<&str> = filter_movements(&movements, &by_date, Currency::Eur, &rate)
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(ids, ["c1", "i1", "e2", "e1", "i2", "i3", "e3"]);
        let by_amount = MovementFilter {
            sort: SortOrder::Amount,
            ..Default::default()
        };
        let ids: Vec<&str> = filter_movements(&movements, &by_amount, Currency::Eur, &rate)
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        // The USD 10.00 expense converts to 9.20 €, below the 9.99 € charge.
        assert_eq!(ids, ["i1", "i3", "i2", "e1", "e2", "c1", "e3"]);
    }

    #[test]
    fn grouping_by_month_and_day_sorts_newest_first() {
        let movements = sample_movements();
        let all = MovementFilter::default();
        let filtered = filter_movements(&movements, &all, Currency::Eur, &rate);
        let by_month = group_movements(&filtered, GroupBy::Month);
        assert_eq!(by_month.len(), 2);
        assert_eq!(by_month[0].key, GroupKey::Month(2026, 11));
        assert_eq!(by_month[0].items.len(), 6);
        assert_eq!(by_month[1].key, GroupKey::Month(2026, 10));
        let by_day = group_movements(&filtered, GroupBy::Day);
        assert_eq!(by_day.len(), 6);
        assert_eq!(by_day[0].key, GroupKey::Day(date(2026, 11, 28)));
        assert_eq!(
            group_net(&by_month[0].items, Currency::Eur, &rate),
            150000 + 20000 + 60000 - 4530 - 1200 - 999
        );
    }

    // -- events and projection -------------------------------------------------

    #[test]
    fn collect_events_generates_recurrences_and_real_charge_substitution() {
        let subs = vec![
            sub(
                "a",
                Some(eur(1000)),
                SubscriptionStatus::Active,
                Some(date(2026, 11, 28)),
            ),
            sub(
                "b",
                Some(eur(500)),
                SubscriptionStatus::Paused,
                Some(date(2026, 11, 28)),
            ),
            sub(
                "c",
                None,
                SubscriptionStatus::Active,
                Some(date(2026, 11, 28)),
            ),
        ];
        let movements = vec![
            movement(
                "m1",
                MovementKind::Expense,
                "Cinema",
                eur(1500),
                date(2026, 11, 20),
            ),
            Movement {
                frequency: Frequency::Monthly,
                status: MovementStatus::Received,
                ..movement(
                    "m2",
                    MovementKind::Income,
                    "Nómina",
                    eur(200000),
                    date(2026, 11, 25),
                )
            },
            Movement {
                kind: MovementKind::Charge,
                name: "a".into(),
                subscription_id: Some("a".into()),
                status: MovementStatus::Done,
                amount: eur(1080),
                date: date(2026, 11, 29), // one day after the cycle: still associated
                ..movement(
                    "c1",
                    MovementKind::Charge,
                    "a",
                    eur(1080),
                    date(2026, 11, 29),
                )
            },
            Movement {
                kind: MovementKind::Charge,
                name: "ghost".into(),
                subscription_id: Some("ghost".into()),
                status: MovementStatus::Done,
                amount: eur(300),
                date: date(2026, 11, 15),
                ..movement(
                    "c2",
                    MovementKind::Charge,
                    "ghost",
                    eur(300),
                    date(2026, 11, 15),
                )
            },
            movement(
                "m3",
                MovementKind::Expense,
                "Old",
                eur(100),
                date(2026, 10, 1),
            ),
        ];
        let events = collect_events(
            &subs,
            &movements,
            Currency::Eur,
            &rate,
            date(2026, 11, 1),
            date(2026, 12, 31),
        );

        let sub_a: Vec<&DayEvent> = events
            .iter()
            .filter(|e| e.source == EventSource::Subscription && e.name == "a")
            .collect();
        // Nov 28 (real 10.80 € substituted) and Dec 28 (estimated 10.00 €).
        assert_eq!(sub_a.len(), 2);
        assert_eq!(sub_a[0].amount, 1080);
        assert!(!sub_a[0].estimated);
        assert_eq!(sub_a[1].amount, 1000);
        assert!(sub_a[1].estimated);
        // The paused and the price-less subscriptions generate nothing.
        assert!(!events.iter().any(|e| e.name == "b" || e.name == "c"));
        // The unmatched charge still counts on its own date.
        assert!(
            events
                .iter()
                .any(|e| e.id == "charge-c2" && e.amount == 300 && e.date == date(2026, 11, 15))
        );
        // The recurring income appears in November and December, not estimated.
        let incomes: Vec<&DayEvent> = events
            .iter()
            .filter(|e| e.source == EventSource::Income)
            .collect();
        assert_eq!(incomes.len(), 2);
        assert!(incomes.iter().all(|e| !e.estimated));
        // The one-off expense is in range; the October one is not.
        assert!(events.iter().any(|e| e.id == "m1-2026-11-20"));
        assert!(!events.iter().any(|e| e.id == "m3-2026-10-01"));
        // Events are sorted by date.
        assert!(events.windows(2).all(|w| w[0].date <= w[1].date));
    }

    #[test]
    fn a_zero_charge_marks_the_cycle_not_billed() {
        let subs = vec![sub(
            "a",
            Some(eur(1000)),
            SubscriptionStatus::Active,
            Some(date(2026, 11, 28)),
        )];
        let movements = vec![Movement {
            kind: MovementKind::Charge,
            name: "a".into(),
            subscription_id: Some("a".into()),
            status: MovementStatus::NotCharged,
            amount: eur(0),
            date: date(2026, 11, 28),
            ..movement("c0", MovementKind::Charge, "a", eur(0), date(2026, 11, 28))
        }];
        let events = collect_events(
            &subs,
            &movements,
            Currency::Eur,
            &rate,
            date(2026, 11, 1),
            date(2026, 11, 30),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn usd_amounts_convert_with_the_rate_and_keep_the_original() {
        let movements = vec![movement(
            "u1",
            MovementKind::Expense,
            "Tool",
            Money::usd(600),
            date(2026, 11, 5),
        )];
        let events = collect_events(
            &[],
            &movements,
            Currency::Eur,
            &rate,
            date(2026, 11, 1),
            date(2026, 11, 30),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].amount, 552);
        assert_eq!(events[0].original, Some(Money::usd(600)));
    }

    fn event(
        id: &str,
        date: NaiveDate,
        kind: EventKind,
        source: EventSource,
        amount: i64,
    ) -> DayEvent {
        DayEvent {
            id: id.into(),
            date,
            kind,
            source,
            name: id.into(),
            category: None,
            amount,
            original: None,
            estimated: true,
        }
    }

    #[test]
    fn projection_walks_days_and_finds_min_and_first_negative() {
        let anchor = eur(10000);
        let anchor_date = date(2026, 11, 25);
        let events = vec![
            event(
                "e1",
                date(2026, 11, 26),
                EventKind::Expense,
                EventSource::Subscription,
                8000,
            ),
            event(
                "e2",
                date(2026, 11, 27),
                EventKind::Income,
                EventSource::Income,
                5000,
            ),
            event(
                "e3",
                date(2026, 11, 28),
                EventKind::Expense,
                EventSource::Expense,
                9000,
            ),
        ];
        let scenario = vec![event(
            "s1",
            date(2026, 11, 27),
            EventKind::Expense,
            EventSource::Scenario,
            4000,
        )];
        let p = project(
            anchor.minor,
            anchor_date,
            &events,
            date(2026, 11, 26),
            date(2026, 11, 28),
            &scenario,
        );
        assert_eq!(p.days.len(), 3);
        assert_eq!(p.start_balance, 10000);
        assert_eq!(p.days[0].balance, 2000);
        assert_eq!(p.days[1].balance, 2000 + 5000 - 4000);
        assert_eq!(p.days[2].balance, 3000 - 9000);
        assert_eq!(p.end_balance, -6000);
        assert_eq!(p.min_balance, -6000);
        assert_eq!(p.min_date, Some(date(2026, 11, 28)));
        assert_eq!(p.first_negative, Some((date(2026, 11, 28), 6000)));
        assert_eq!(p.total_income, 5000);
        assert_eq!(p.total_expense, 8000 + 4000 + 9000);
        // Without the scenario the 27th stays positive and the deficit shrinks.
        let base = project(
            anchor.minor,
            anchor_date,
            &events,
            date(2026, 11, 26),
            date(2026, 11, 28),
            &[],
        );
        assert_eq!(base.days[1].balance, 7000);
        assert_eq!(base.first_negative, Some((date(2026, 11, 28), 2000)));
        // A range starting at the anchor keeps the anchor as start balance.
        let p2 = project(
            anchor.minor,
            anchor_date,
            &events,
            date(2026, 11, 25),
            date(2026, 11, 25),
            &[],
        );
        assert_eq!(p2.days.len(), 1);
        assert_eq!(p2.days[0].balance, 10000);
        assert_eq!(p2.start_balance, 10000);
        assert_eq!(p2.min_date, Some(date(2026, 11, 25)));
    }

    #[test]
    fn projection_converts_a_foreign_anchor_at_the_call_site() {
        let anchor = to_account_minor(Money::usd(10000), Currency::Eur, &rate);
        let p = project(
            anchor,
            date(2026, 11, 25),
            &[],
            date(2026, 11, 25),
            date(2026, 11, 25),
            &[],
        );
        assert_eq!(p.start_balance, 9200);
    }

    // -- analysis ---------------------------------------------------------------

    #[test]
    fn totals_and_categories_aggregate_the_period() {
        let events = vec![
            event(
                "1",
                date(2026, 11, 3),
                EventKind::Income,
                EventSource::Income,
                200000,
            ),
            DayEvent {
                category: Some(LocalizedText {
                    en: "Food",
                    es: "Comida",
                }),
                ..event(
                    "2",
                    date(2026, 11, 4),
                    EventKind::Expense,
                    EventSource::Expense,
                    5000,
                )
            },
            DayEvent {
                category: Some(CATEGORY_SUBSCRIPTION),
                ..event(
                    "3",
                    date(2026, 11, 5),
                    EventKind::Expense,
                    EventSource::Subscription,
                    1000,
                )
            },
            DayEvent {
                category: Some(LocalizedText {
                    en: "Food",
                    es: "Comida",
                }),
                ..event(
                    "4",
                    date(2026, 10, 5),
                    EventKind::Expense,
                    EventSource::Expense,
                    9000,
                )
            },
        ];
        let november = totals_for_month(&events, 2026, 11);
        assert_eq!(november.income, 200000);
        assert_eq!(november.expense, 6000);
        assert_eq!(november.subscriptions, 1000);
        assert_eq!(november.net, 194000);
        assert_eq!(november.count, 3);
        let categories = category_distribution(&events, date(2026, 11, 1), date(2026, 11, 30));
        assert_eq!(categories.len(), 2);
        // Food (50 €) sorts above the subscription (10 €).
        assert_eq!(categories[0].category.en, "Food");
        assert_eq!(categories[0].amount, 5000);
        assert_eq!(categories[1].category.en, "Subscription");
        assert_eq!(categories[1].amount, 1000);
        // October is excluded by the range.
        assert!(!categories.iter().any(|c| c.amount == 9000));
    }

    #[test]
    fn rankings_and_equivalents_normalize_frequencies() {
        let subs = vec![
            Subscription {
                frequency: Frequency::Annual,
                ..sub(
                    "yearly",
                    Some(eur(12000)),
                    SubscriptionStatus::Active,
                    Some(date(2026, 11, 1)),
                )
            },
            Subscription {
                frequency: Frequency::Monthly,
                ..sub(
                    "monthly",
                    Some(eur(1000)),
                    SubscriptionStatus::Active,
                    Some(date(2026, 11, 1)),
                )
            },
            Subscription {
                frequency: Frequency::Quarterly,
                ..sub(
                    "q",
                    Some(Money::usd(300)),
                    SubscriptionStatus::Active,
                    Some(date(2026, 11, 1)),
                )
            },
            Subscription {
                frequency: Frequency::Monthly,
                ..sub("dead", Some(eur(700)), SubscriptionStatus::Cancelled, None)
            },
            Subscription {
                frequency: Frequency::Monthly,
                ..sub("paused", Some(eur(900)), SubscriptionStatus::Paused, None)
            },
        ];
        let ranking = subscription_ranking(&subs, Currency::Eur, &rate);
        assert_eq!(ranking.len(), 3);
        assert_eq!(ranking[0].id, "monthly");
        assert_eq!(ranking[0].monthly, 1000);
        // The annual 120 € and the monthly 10 € tie at 10 €/mo; the name breaks it.
        assert_eq!(ranking[1].id, "yearly");
        assert_eq!(ranking[1].monthly, 1000);
        // 3 USD quarterly = 276 € / 3 = 92 €.
        assert_eq!(ranking[2].id, "q");
        assert_eq!(ranking[2].monthly, 92);
        assert_eq!(normalized_monthly_cost(&subs, Currency::Eur, &rate), 2092);
        assert_eq!(savings_from_inactive(&subs, Currency::Eur, &rate), 700);
        let months = month_list(date(2026, 10, 1), date(2026, 11, 30));
        let evolution = cost_evolution(&[], &months, 2092);
        assert_eq!(evolution.len(), 2);
        assert_eq!(evolution[0].normalized, 2092);
        assert_eq!(evolution[1].actual, 0);
    }
}
