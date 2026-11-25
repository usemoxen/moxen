//! Golden vectors: the exact inputs and outputs of the TypeScript
//! reference (see tests/vectors/README.md), asserted here end to end.
//! Every file is regenerated from a pinned commit of the reference, so a
//! failure below means the Rust port drifted — not that the vector aged.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use moxen_finances_core::dates::{self, IsoDateParts};
use moxen_finances_core::exchange::{self, ConversionResult, RateLookup};
use moxen_finances_core::money;
use moxen_finances_core::projection::{
    self, EventCollectionInput, EventKind, EventSource, NextBillingForOptions, ProjectionEvent,
    ProjectionInput, ProjectionWarning, ResolvedPrice,
};
use moxen_finances_core::recurrence::{self, CanChargeOptions, OccurrenceOptions};
use moxen_finances_core::stats::{self, CategorySlice, PeriodTotals, SubscriptionCostPoint};
use moxen_finances_core::types::{
    Account, ActualCharge, Currency, ExchangeRate, Expense, Frequency, Income, PauseEntry,
    SubscriptionStatus, SubscriptionWithHistory,
};
use moxen_finances_core::{CoreError, YearMonth};

fn vector(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("vectors")
        .join(name)
}

fn load<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let path = vector(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| {
        panic!(
            "parse {} against the reference generator: {error}",
            path.display()
        )
    })
}

fn chunk<T: std::fmt::Debug>(items: &[T]) -> String {
    // Keep failures readable for the long projection scenarios.
    items
        .iter()
        .map(|item| {
            let mut out = String::new();
            write!(out, "{item:?}").ok();
            out
        })
        .collect::<Vec<_>>()
        .chunks(3)
        .map(|group| group.join(", "))
        .collect::<Vec<_>>()
        .join(",\n  ")
}

// ---------------------------------------------------------------------------
// money.json
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoneyVectors {
    convert: Vec<ConvertCase>,
    format_currency: Vec<FormatCurrencyCase>,
    format_minor: Vec<FormatMinorCase>,
    parse_amount_to_minor: Vec<ParseTextCase>,
    parse_rate_to_scaled: Vec<ParseTextCase>,
    format_rate: Vec<FormatRateCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertCase {
    amount_minor: i64,
    rate_scaled: i64,
    expected: Option<i64>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FormatCurrencyCase {
    amount_minor: i64,
    currency: String,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FormatMinorCase {
    amount_minor: i64,
    symbol: String,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseTextCase {
    text: String,
    expected: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FormatRateCase {
    rate_scaled: i64,
    expected: String,
}

#[test]
fn money_matches_the_reference() {
    let vectors: MoneyVectors = load("money.json");

    for case in &vectors.convert {
        let result = money::convert_minor(case.amount_minor, case.rate_scaled);
        match (&case.expected, &case.error) {
            (Some(expected), None) => assert_eq!(
                result,
                Ok(*expected),
                "convert_minor({}, {}) = {:?}",
                case.amount_minor,
                case.rate_scaled,
                result
            ),
            (None, Some(_)) => assert!(
                result.is_err(),
                "convert_minor({}, {}) should error",
                case.amount_minor,
                case.rate_scaled
            ),
            other => panic!("bad convert vector: {other:?}"),
        }
    }

    for case in &vectors.format_currency {
        assert_eq!(
            money::format_currency(case.amount_minor, &case.currency),
            case.expected,
            "format_currency({}, {})",
            case.amount_minor,
            case.currency
        );
    }
    for case in &vectors.format_minor {
        assert_eq!(
            money::format_minor(case.amount_minor, &case.symbol),
            case.expected,
            "format_minor({}, {:?})",
            case.amount_minor,
            case.symbol
        );
    }
    for case in &vectors.parse_amount_to_minor {
        assert_eq!(
            money::parse_amount_to_minor(&case.text),
            case.expected,
            "parse_amount_to_minor({:?})",
            case.text
        );
    }
    for case in &vectors.parse_rate_to_scaled {
        assert_eq!(
            money::parse_rate_to_scaled(&case.text),
            case.expected,
            "parse_rate_to_scaled({:?})",
            case.text
        );
    }
    for case in &vectors.format_rate {
        assert_eq!(
            money::format_rate(case.rate_scaled),
            case.expected,
            "format_rate({})",
            case.rate_scaled
        );
    }
}

// ---------------------------------------------------------------------------
// dates.json
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatesVectors {
    days_in_month: Vec<DaysInMonthCase>,
    leap_years: Vec<YearBool>,
    add_days: Vec<AddDaysCase>,
    add_months: Vec<AddMonthsCase>,
    add_years: Vec<AddYearsCase>,
    diff_days: Vec<DiffDaysCase>,
    validity: Vec<ValidityCase>,
    parse: Vec<ParseCase>,
    range_bounds: Vec<RangeBoundCase>,
    month_bounds: Vec<MonthBoundCase>,
    order: Vec<OrderCase>,
    #[serde(rename = "toISODate")]
    to_iso_date: Vec<ToIsoCase>,
    clamp_day: Vec<ClampDayCase>,
    today_madrid: Vec<TodayCase>,
    format_short: Vec<FormatCase>,
    format_long: Vec<FormatCase>,
    month_labels: Vec<MonthLabelCase>,
    weekday_short: Vec<FormatCase>,
    month_grid: Vec<GridCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaysInMonthCase {
    year: i64,
    month: i64,
    expected: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClampDayCase {
    year: i64,
    month: i64,
    day: i64,
    expected: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct YearBool {
    year: i64,
    expected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddDaysCase {
    date: String,
    days: i64,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMonthsCase {
    date: String,
    months: i64,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddYearsCase {
    date: String,
    years: i64,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffDaysCase {
    from: String,
    to: String,
    expected: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidityCase {
    date: String,
    expected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseCase {
    date: String,
    expected: Option<IsoPartsJson>,
}

#[derive(Deserialize, Copy, Clone)]
#[serde(rename_all = "camelCase")]
struct IsoPartsJson {
    year: i64,
    month: i64,
    day: i64,
}

impl IsoPartsJson {
    fn to_parts(self) -> IsoDateParts {
        IsoDateParts {
            year: self.year,
            month: self.month,
            day: self.day,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RangeBoundCase {
    date: String,
    from: Option<String>,
    to: Option<String>,
    expected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonthBoundCase {
    date: String,
    expected_start: String,
    expected_end: String,
    expected_month: YearMonth,
    expected_day: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderCase {
    a: String,
    b: String,
    expected_compare: i64,
    expected_max: String,
    expected_min: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToIsoCase {
    parts: IsoPartsJson,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TodayCase {
    instant: String,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FormatCase {
    date: String,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonthLabelCase {
    year: i64,
    month: i64,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GridCase {
    year: i64,
    month: i64,
    expected: Vec<Vec<String>>,
}

#[test]
fn dates_match_the_reference() {
    let vectors: DatesVectors = load("dates.json");

    for case in &vectors.days_in_month {
        assert_eq!(dates::days_in_month(case.year, case.month), case.expected);
    }
    for case in &vectors.leap_years {
        assert_eq!(dates::is_leap_year(case.year), case.expected);
    }
    for case in &vectors.add_days {
        assert_eq!(
            dates::add_days_iso(&case.date, case.days),
            Ok(case.expected.clone()),
            "add_days_iso({:?}, {})",
            case.date,
            case.days
        );
    }
    for case in &vectors.add_months {
        assert_eq!(
            dates::add_months_iso(&case.date, case.months),
            Ok(case.expected.clone()),
            "add_months_iso({:?}, {})",
            case.date,
            case.months
        );
    }
    for case in &vectors.add_years {
        assert_eq!(
            dates::add_years_iso(&case.date, case.years),
            Ok(case.expected.clone()),
            "add_years_iso({:?}, {})",
            case.date,
            case.years
        );
    }
    for case in &vectors.diff_days {
        assert_eq!(
            dates::diff_days(&case.from, &case.to),
            Ok(case.expected),
            "diff_days({:?}, {:?})",
            case.from,
            case.to
        );
    }
    for case in &vectors.validity {
        assert_eq!(
            dates::is_valid_iso_date(&case.date),
            case.expected,
            "{:?}",
            case.date
        );
    }
    for case in &vectors.parse {
        assert_eq!(
            dates::parse_iso_date(&case.date),
            case.expected.map(IsoPartsJson::to_parts),
            "parse_iso_date({:?})",
            case.date
        );
    }
    for case in &vectors.range_bounds {
        assert_eq!(
            dates::is_iso_date_in_range(&case.date, case.from.as_deref(), case.to.as_deref()),
            case.expected
        );
    }
    for case in &vectors.month_bounds {
        assert_eq!(
            dates::start_of_month(&case.date),
            Ok(case.expected_start.clone())
        );
        assert_eq!(
            dates::end_of_month(&case.date),
            Ok(case.expected_end.clone())
        );
        assert_eq!(
            dates::month_of(&case.date),
            Ok(case.expected_month),
            "month_of({:?})",
            case.date
        );
        assert_eq!(dates::day_of_iso(&case.date), Ok(case.expected_day));
    }
    for case in &vectors.order {
        let compare = match dates::compare_iso_dates(&case.a, &case.b) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        assert_eq!(compare, case.expected_compare);
        assert_eq!(dates::max_iso(&case.a, &case.b), case.expected_max);
        assert_eq!(dates::min_iso(&case.a, &case.b), case.expected_min);
    }
    for case in &vectors.to_iso_date {
        assert_eq!(dates::to_iso_date(case.parts.to_parts()), case.expected);
    }
    for case in &vectors.clamp_day {
        assert_eq!(
            dates::clamp_day_to_month(case.year, case.month, case.day),
            case.expected
        );
    }
    for case in &vectors.today_madrid {
        let instant = chrono::DateTime::parse_from_rfc3339(&case.instant)
            .expect("valid instant in vector")
            .with_timezone(&chrono::Utc);
        assert_eq!(
            dates::today_madrid(instant),
            case.expected,
            "{:?}",
            case.instant
        );
    }
    for case in &vectors.format_short {
        assert_eq!(dates::format_date_short(&case.date), case.expected);
    }
    for case in &vectors.format_long {
        assert_eq!(dates::format_date_long(&case.date), case.expected);
    }
    for case in &vectors.month_labels {
        assert_eq!(
            dates::format_month_label(case.year, case.month),
            case.expected
        );
    }
    for case in &vectors.weekday_short {
        assert_eq!(dates::weekday_short(&case.date), case.expected);
    }
    for case in &vectors.month_grid {
        assert_eq!(
            dates::get_month_grid(case.year, case.month),
            case.expected,
            "grid({}, {})",
            case.year,
            case.month
        );
    }
}

// ---------------------------------------------------------------------------
// recurrence.json
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecurrenceVectors {
    occurrences: Vec<OccurrenceCase>,
    first_occurrence_from: Vec<FirstFromCase>,
    is_paused_at: Vec<PausesCase>,
    pause_state_at: Vec<PauseStateCase>,
    can_charge_on: Vec<CanChargeCase>,
    next_billing_date: Vec<NextBillingCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OccurrenceCase {
    start_date: String,
    frequency: Frequency,
    from_date: String,
    to_date: String,
    billing_day: Option<i64>,
    max_occurrences: Option<usize>,
    expected: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirstFromCase {
    start_date: String,
    frequency: Frequency,
    from_date: String,
    billing_day: Option<i64>,
    expected: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PausesCase {
    pauses: Vec<PauseEntry>,
    date: String,
    expected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PauseStateCase {
    pauses: Vec<PauseEntry>,
    date: String,
    expected: PauseStateJson,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PauseStateJson {
    paused: bool,
    pause: Option<PauseEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanChargeCase {
    date: String,
    options: CanChargeJson,
    expected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanChargeJson {
    status: SubscriptionStatus,
    end_date: Option<String>,
    cancelled_at: Option<String>,
    #[serde(default)]
    pauses: Vec<PauseEntry>,
    start_date: Option<String>,
    #[serde(default)]
    archived_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextBillingCase {
    options: NextBillingJson,
    expected: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextBillingJson {
    start_date: String,
    frequency: Frequency,
    billing_day: Option<i64>,
    #[serde(rename = "override", default)]
    next_billing_override: Option<String>,
    end_date: Option<String>,
    cancelled_at: Option<String>,
    #[serde(default)]
    pauses: Vec<PauseEntry>,
    today: String,
    #[serde(default)]
    archived_at: Option<String>,
    #[serde(default)]
    charged_dates: Vec<String>,
}

#[test]
fn recurrence_matches_the_reference() {
    let vectors: RecurrenceVectors = load("recurrence.json");

    for case in &vectors.occurrences {
        let result = recurrence::generate_occurrences(&OccurrenceOptions {
            start_date: &case.start_date,
            frequency: case.frequency,
            billing_day: case.billing_day,
            from_date: &case.from_date,
            to_date: &case.to_date,
            max_occurrences: case.max_occurrences,
        })
        .expect("valid vector dates");
        assert_eq!(
            result,
            case.expected,
            "occurrences of {} {} from {}",
            case.start_date,
            case.frequency.as_str(),
            case.from_date
        );
    }
    for case in &vectors.first_occurrence_from {
        let result = recurrence::first_occurrence_from(
            &case.start_date,
            case.frequency,
            &case.from_date,
            case.billing_day,
        )
        .expect("valid vector dates");
        assert_eq!(result, case.expected, "first from {}", case.from_date);
    }
    for case in &vectors.is_paused_at {
        assert_eq!(
            recurrence::is_paused_at(&case.pauses, &case.date),
            case.expected,
            "is_paused_at({})",
            case.date
        );
    }
    for case in &vectors.pause_state_at {
        let state = recurrence::pause_state_at(&case.pauses, &case.date);
        assert_eq!(
            state.paused, case.expected.paused,
            "pause_state_at({})",
            case.date
        );
        assert_eq!(
            state.pause, case.expected.pause,
            "pause_state_at({})",
            case.date
        );
    }
    for case in &vectors.can_charge_on {
        let options = CanChargeOptions {
            status: case.options.status,
            end_date: case.options.end_date.as_deref(),
            cancelled_at: case.options.cancelled_at.as_deref(),
            pauses: &case.options.pauses,
            start_date: case.options.start_date.as_deref(),
            archived_at: case.options.archived_at.as_deref(),
        };
        assert_eq!(
            recurrence::can_charge_on(&case.date, &options),
            case.expected,
            "can_charge_on({})",
            case.date
        );
    }
    for case in &vectors.next_billing_date {
        let options = recurrence::NextBillingOptions {
            start_date: &case.options.start_date,
            frequency: case.options.frequency,
            billing_day: case.options.billing_day,
            next_billing_override: case.options.next_billing_override.as_deref(),
            end_date: case.options.end_date.as_deref(),
            cancelled_at: case.options.cancelled_at.as_deref(),
            pauses: &case.options.pauses,
            today: &case.options.today,
            archived_at: case.options.archived_at.as_deref(),
            charged_dates: &case.options.charged_dates,
        };
        assert_eq!(
            recurrence::next_billing_date(&options).expect("valid vector dates"),
            case.expected,
            "next_billing_date from {} at {}",
            case.options.start_date,
            case.options.today
        );
    }
}

// ---------------------------------------------------------------------------
// exchange.json
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeVectors {
    find_rate_at: Vec<FindRateCase>,
    convert_to_account_currency: Vec<ConvertCase2>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindRateCase {
    rates: Vec<ExchangeRate>,
    from: Currency,
    to: Currency,
    date: String,
    expected: Option<RateLookup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertCase2 {
    amount_minor: i64,
    from: Currency,
    account_currency: Currency,
    date: String,
    rates: Vec<ExchangeRate>,
    expected: ConversionResult,
}

#[test]
fn exchange_matches_the_reference() {
    let vectors: ExchangeVectors = load("exchange.json");

    for case in &vectors.find_rate_at {
        assert_eq!(
            exchange::find_rate_at(&case.rates, case.from, case.to, &case.date),
            case.expected,
            "find_rate_at({} -> {}, {})",
            case.from.as_str(),
            case.to.as_str(),
            case.date
        );
    }
    for case in &vectors.convert_to_account_currency {
        assert_eq!(
            exchange::convert_to_account_currency(
                case.amount_minor,
                case.from,
                case.account_currency,
                &case.date,
                &case.rates
            ),
            case.expected,
            "convert({} {} -> {}, {})",
            case.amount_minor,
            case.from.as_str(),
            case.account_currency.as_str(),
            case.date
        );
    }
}

// ---------------------------------------------------------------------------
// projection.json
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionVectors {
    price_at: Vec<PriceAtCase>,
    project_balance: Vec<BalanceScenario>,
    collect_events: Vec<CollectScenario>,
    next_billing_for: Vec<NextBillingForCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriceAtCase {
    subscription: SubscriptionWithHistory,
    date: String,
    expected: Option<ResolvedPrice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputJson {
    account: Option<Account>,
    account_currency: Currency,
    subscriptions: Vec<SubscriptionWithHistory>,
    incomes: Vec<Income>,
    expenses: Vec<Expense>,
    rates: Vec<ExchangeRate>,
    #[serde(default)]
    charges: Vec<ActualCharge>,
    from_date: String,
    to_date: String,
    #[serde(default)]
    extra_events: Vec<ProjectionEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BalanceScenario {
    name: String,
    input: InputJson,
    expected: ExpectedBalance,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectScenario {
    name: String,
    input: InputJson,
    expected: CollectedJson,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectedJson {
    events: Vec<ProjectionEvent>,
    warnings: Vec<ProjectionWarning>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedBalance {
    start_date: String,
    end_date: String,
    start_balance_minor: i64,
    end_balance_minor: i64,
    total_income_minor: i64,
    total_expense_minor: i64,
    net_minor: i64,
    min_balance_minor: i64,
    min_balance_date: Option<String>,
    first_negative_date: Option<String>,
    first_negative_deficit_minor: Option<i64>,
    warnings: Vec<ProjectionWarning>,
    events: Vec<ProjectionEvent>,
    days: Vec<ExpectedDay>,
}

type ExpectedDay = (String, i64, i64, i64, Vec<String>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextBillingForCase {
    subscription: SubscriptionWithHistory,
    today: String,
    charged_dates: Vec<String>,
    expected: Option<String>,
}

#[test]
fn projection_matches_the_reference() {
    let vectors: ProjectionVectors = load("projection.json");

    for case in &vectors.price_at {
        assert_eq!(
            projection::price_at(&case.subscription, &case.date),
            case.expected,
            "price_at({:?}, {})",
            case.subscription.subscription.name,
            case.date
        );
    }

    for scenario in &vectors.project_balance {
        let input = &scenario.input;
        let account = input
            .account
            .clone()
            .expect("projectBalance vectors carry an account");
        let collection = EventCollectionInput {
            account_currency: input.account_currency,
            subscriptions: &input.subscriptions,
            incomes: &input.incomes,
            expenses: &input.expenses,
            rates: &input.rates,
            charges: &input.charges,
            from_date: &input.from_date,
            to_date: &input.to_date,
            extra_events: &input.extra_events,
        };
        let result = projection::project_balance(&ProjectionInput {
            account: &account,
            events: collection,
        })
        .unwrap_or_else(|error| panic!("{}: {error}", scenario.name));
        let expected = &scenario.expected;

        assert_eq!(
            result.start_date, expected.start_date,
            "{}: startDate",
            scenario.name
        );
        assert_eq!(
            result.end_date, expected.end_date,
            "{}: endDate",
            scenario.name
        );
        assert_eq!(
            result.start_balance_minor, expected.start_balance_minor,
            "{}",
            scenario.name
        );
        assert_eq!(
            result.end_balance_minor, expected.end_balance_minor,
            "{}: endBalance",
            scenario.name
        );
        assert_eq!(
            result.total_income_minor, expected.total_income_minor,
            "{}: income",
            scenario.name
        );
        assert_eq!(
            result.total_expense_minor, expected.total_expense_minor,
            "{}: expense",
            scenario.name
        );
        assert_eq!(
            result.net_minor, expected.net_minor,
            "{}: net",
            scenario.name
        );
        assert_eq!(
            result.min_balance_minor, expected.min_balance_minor,
            "{}: minBalance",
            scenario.name
        );
        assert_eq!(
            result.min_balance_date, expected.min_balance_date,
            "{}: minDate",
            scenario.name
        );
        assert_eq!(
            result.first_negative_date, expected.first_negative_date,
            "{}: firstNegative",
            scenario.name
        );
        assert_eq!(
            result.first_negative_deficit_minor, expected.first_negative_deficit_minor,
            "{}: deficit",
            scenario.name
        );
        assert_eq!(
            result.warnings,
            expected.warnings,
            "{}: warnings\nexpected [{}]",
            scenario.name,
            chunk(&expected.warnings)
        );
        assert_eq!(
            result.events,
            expected.events,
            "{}: events\nexpected [{}]",
            scenario.name,
            chunk(&expected.events)
        );
        assert_eq!(
            result.days.len(),
            expected.days.len(),
            "{}: day count",
            scenario.name
        );
        for (index, (date, balance, income, expense, event_ids)) in expected.days.iter().enumerate()
        {
            let day = &result.days[index];
            assert_eq!(day.date, *date, "{}: day {index}", scenario.name);
            assert_eq!(
                day.balance_minor, *balance,
                "{}: balance {date}",
                scenario.name
            );
            assert_eq!(
                day.income_minor, *income,
                "{}: income {date}",
                scenario.name
            );
            assert_eq!(
                day.expense_minor, *expense,
                "{}: expense {date}",
                scenario.name
            );
            let ids: Vec<&str> = day.events.iter().map(|event| event.id.as_str()).collect();
            assert_eq!(
                ids,
                event_ids.iter().map(String::as_str).collect::<Vec<_>>(),
                "{}: events of {date}",
                scenario.name
            );
        }
    }

    for scenario in &vectors.collect_events {
        let input = &scenario.input;
        let collected = projection::collect_events(&EventCollectionInput {
            account_currency: input.account_currency,
            subscriptions: &input.subscriptions,
            incomes: &input.incomes,
            expenses: &input.expenses,
            rates: &input.rates,
            charges: &input.charges,
            from_date: &input.from_date,
            to_date: &input.to_date,
            extra_events: &input.extra_events,
        })
        .unwrap_or_else(|error| panic!("{}: {error}", scenario.name));
        assert_eq!(
            collected.events,
            scenario.expected.events,
            "{}: events\nexpected [{}]",
            scenario.name,
            chunk(&scenario.expected.events)
        );
        assert_eq!(
            collected.warnings, scenario.expected.warnings,
            "{}: warnings",
            scenario.name
        );
    }

    for case in &vectors.next_billing_for {
        let result = projection::next_billing_for(&NextBillingForOptions {
            sub: &case.subscription,
            today: &case.today,
            charged_dates: &case.charged_dates,
        })
        .expect("valid dates");
        assert_eq!(
            result, case.expected,
            "next_billing_for({:?})",
            case.subscription.subscription.name
        );
    }
}

// ---------------------------------------------------------------------------
// stats.json
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsVectors {
    totals_for_events: Vec<TotalsCase>,
    totals_for_month: Vec<MonthTotalsCase>,
    distribution_by_category: Vec<DistributionCase>,
    monthly_equivalent_minor: Vec<EquivalentCase>,
    annualized_minor: Vec<EquivalentCase>,
    normalized_monthly_cost: Vec<CostCase>,
    savings_from_inactive: CostCase,
    subscription_cost_ranking: RankingCase,
    subscription_cost_evolution: EvolutionCase,
    month_range: Vec<MonthRangeCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TotalsCase {
    events: Vec<ProjectionEvent>,
    from: String,
    to: String,
    expected: PeriodTotals,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonthTotalsCase {
    events: Vec<ProjectionEvent>,
    year: i64,
    month: i64,
    expected: PeriodTotals,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DistributionCase {
    events: Vec<ProjectionEvent>,
    from: String,
    to: String,
    expected: Vec<CategorySlice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EquivalentCase {
    amount_minor: i64,
    frequency: Frequency,
    expected: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CostCase {
    subscriptions: Vec<SubscriptionWithHistory>,
    date: String,
    rates: Vec<ExchangeRate>,
    account_currency: Currency,
    expected: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RankingCase {
    subscriptions: Vec<SubscriptionWithHistory>,
    date: String,
    rates: Vec<ExchangeRate>,
    account_currency: Currency,
    expected: Vec<RankRowJson>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RankRowJson {
    subscription_id: String,
    monthly_equivalent_minor: Option<i64>,
    annualized_minor: Option<i64>,
    next_billing: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvolutionCase {
    subscriptions: Vec<SubscriptionWithHistory>,
    events: Vec<ProjectionEvent>,
    rates: Vec<ExchangeRate>,
    account_currency: Currency,
    months: Vec<YearMonth>,
    expected: Vec<SubscriptionCostPoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonthRangeCase {
    from: String,
    to: String,
    expected: Vec<YearMonth>,
}

#[test]
fn stats_match_the_reference() {
    let vectors: StatsVectors = load("stats.json");

    for case in &vectors.totals_for_events {
        assert_eq!(
            stats::totals_for_events(&case.events, &case.from, &case.to),
            case.expected,
            "totals for [{}, {}]",
            case.from,
            case.to
        );
    }
    for case in &vectors.totals_for_month {
        assert_eq!(
            stats::totals_for_month(&case.events, case.year, case.month),
            case.expected,
            "totals for {}-{}",
            case.year,
            case.month
        );
    }
    for case in &vectors.distribution_by_category {
        assert_eq!(
            stats::distribution_by_category(&case.events, &case.from, &case.to),
            case.expected,
            "distribution for [{}, {}]",
            case.from,
            case.to
        );
    }
    for case in &vectors.monthly_equivalent_minor {
        assert_eq!(
            projection::monthly_equivalent_minor(case.amount_minor, case.frequency),
            case.expected,
            "monthlyEquivalentMinor({}, {})",
            case.amount_minor,
            case.frequency.as_str()
        );
    }
    for case in &vectors.annualized_minor {
        assert_eq!(
            projection::annualized_minor(case.amount_minor, case.frequency),
            case.expected
        );
    }
    for case in &vectors.normalized_monthly_cost {
        assert_eq!(
            stats::normalized_monthly_cost(
                &case.subscriptions,
                &case.date,
                &case.rates,
                case.account_currency
            ),
            case.expected,
            "normalized cost at {}",
            case.date
        );
    }
    {
        let case = &vectors.savings_from_inactive;
        assert_eq!(
            stats::savings_from_inactive(
                &case.subscriptions,
                &case.date,
                &case.rates,
                case.account_currency
            ),
            case.expected
        );
    }
    {
        let case = &vectors.subscription_cost_ranking;
        let rows = stats::subscription_cost_ranking(
            &case.subscriptions,
            &case.date,
            &case.rates,
            case.account_currency,
        );
        let mapped: Vec<RankRowJson> = rows
            .iter()
            .map(|row| RankRowJson {
                subscription_id: row.subscription.subscription.id.clone(),
                monthly_equivalent_minor: row.monthly_equivalent_minor,
                annualized_minor: row.annualized_minor,
                next_billing: row.next_billing.clone(),
            })
            .collect();
        assert_eq!(mapped, case.expected, "ranking at {}", case.date);
    }
    {
        let case = &vectors.subscription_cost_evolution;
        assert_eq!(
            stats::subscription_cost_evolution(
                &case.subscriptions,
                &case.events,
                &case.rates,
                case.account_currency,
                &case.months
            ),
            case.expected
        );
    }
    for case in &vectors.month_range {
        assert_eq!(stats::month_range(&case.from, &case.to), case.expected);
    }
}

// The EventKind/EventSource enums appear in vectors as "income"/"expense",
// already covered by the serde renames; keep the ident used so a rename
// cannot silently break the JSON.
#[test]
fn event_enums_keep_the_reference_names() {
    assert_eq!(
        serde_json::to_string(&EventKind::Income).expect("serialize"),
        r#""income""#
    );
    assert_eq!(
        serde_json::to_string(&EventKind::Expense).expect("serialize"),
        r#""expense""#
    );
    assert_eq!(
        serde_json::to_string(&EventSource::Subscription).expect("serialize"),
        r#""subscription""#
    );
}

// A CoreError display keeps the reference's Spanish messages.
#[test]
fn errors_say_what_the_reference_says() {
    assert_eq!(
        CoreError::InvalidDate("2026-13-01".into()).to_string(),
        "Fecha no válida: 2026-13-01"
    );
    assert_eq!(
        CoreError::InvalidRate(0).to_string(),
        "Tipo de cambio no válido: 0"
    );
}
