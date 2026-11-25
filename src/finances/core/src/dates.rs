//! Date helpers for the Europe/Madrid calendar, ported from the
//! reference's `src/core/dates.ts` (8aaad15b). Dates are `YYYY-MM-DD`
//! strings and every calculation works on natural calendar days, with no
//! hours and no daylight-saving transitions. The reference computes on
//! `Date.UTC` (proleptic Gregorian), which is exactly what `chrono`'s
//! `NaiveDate` is; only the years before 100 differ, where JavaScript maps
//! years 0-99 onto 1900-1999 — real personal-finance data never goes there.

use chrono::{DateTime, Datelike, Days, NaiveDate, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::CoreError;

/// The parts of an ISO date: month and day are 1-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IsoDateParts {
    pub year: i64,
    pub month: i64,
    pub day: i64,
}

/// Today's date in Europe/Madrid as a `YYYY-MM-DD` string, DST included.
/// chrono-tz holds the IANA rules inside the binary, so this does not
/// depend on a timezone database being installed.
pub fn today_madrid(now: DateTime<Utc>) -> String {
    let madrid = chrono_tz::Europe::Madrid;
    let local = now.with_timezone(&madrid);
    to_iso_date(IsoDateParts {
        year: local.year().into(),
        month: local.month().into(),
        day: local.day().into(),
    })
}

/// An instant formatted exactly like the reference's
/// `new Date().toISOString()`: UTC, millisecond precision, `Z` suffix. The
/// store stamps every `created_at`/`updated_at` with it, and formats the
/// timestamps it keeps in a backup.
pub fn format_instant(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The current instant, as `new Date().toISOString()` would write it. The
/// store calls this instead of keeping a clock of its own, so chrono stays
/// out of its dependencies.
pub fn now_utc_iso() -> String {
    format_instant(Utc::now())
}

/// Today's date in Europe/Madrid right now.
pub fn today_madrid_now() -> String {
    today_madrid(Utc::now())
}

fn to_naive(parts: IsoDateParts) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(
        i32::try_from(parts.year).ok()?,
        u32::try_from(parts.month).ok()?,
        u32::try_from(parts.day).ok()?,
    )
}

fn from_naive(date: NaiveDate) -> IsoDateParts {
    IsoDateParts {
        year: date.year().into(),
        month: date.month().into(),
        day: date.day().into(),
    }
}

/// Pads to two digits ({:02}).
fn pad2(value: i64) -> String {
    format!("{value:02}")
}

/// Parses a strict `YYYY-MM-DD`; `None` when the shape or the calendar day
/// is invalid (`2026-02-30`, `2026-13-01`, and `2026-02-29` in a non-leap
/// year all fail, `2024-02-29` passes).
pub fn parse_iso_date(value: &str) -> Option<IsoDateParts> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let mut i = 0;
    while i < 10 {
        if i == 4 || i == 7 {
            i += 1;
            continue;
        }
        if !bytes[i].is_ascii_digit() {
            return None;
        }
        i += 1;
    }
    let year: i64 = value[0..4].parse().ok()?;
    let month: i64 = value[5..7].parse().ok()?;
    let day: i64 = value[8..10].parse().ok()?;
    // Leading zeros are fine for the parser, but "0026-11-17" must not
    // round-trip as "26-11-17": the reference's Number() accepts them.
    if !(1..=12).contains(&month) {
        return None;
    }
    if day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(IsoDateParts { year, month, day })
}

/// Formats parts as `YYYY-MM-DD` (year zero-padded to four digits).
pub fn to_iso_date(parts: IsoDateParts) -> String {
    format!(
        "{:04}-{}-{}",
        parts.year,
        pad2(parts.month),
        pad2(parts.day)
    )
}

/// True when the string parses as a `YYYY-MM-DD` calendar date.
pub fn is_valid_iso_date(value: &str) -> bool {
    parse_iso_date(value).is_some()
}

pub fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Days in a month, leap years included. Months outside 1-12 return 0
/// (the reference feeds JavaScript nonsense there and gets nonsense back).
pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Lexicographic comparison, valid for `YYYY-MM-DD` strings.
pub fn compare_iso_dates(a: &str, b: &str) -> std::cmp::Ordering {
    a.cmp(b)
}

pub fn max_iso<'a>(a: &'a str, b: &'a str) -> &'a str {
    if compare_iso_dates(a, b) != std::cmp::Ordering::Less {
        a
    } else {
        b
    }
}

pub fn min_iso<'a>(a: &'a str, b: &'a str) -> &'a str {
    if compare_iso_dates(a, b) != std::cmp::Ordering::Greater {
        a
    } else {
        b
    }
}

/// True when `date` falls in `[from, to]`; a null bound is open on that side.
pub fn is_iso_date_in_range(date: &str, from: Option<&str>, to: Option<&str>) -> bool {
    if let Some(from) = from
        && compare_iso_dates(date, from) == std::cmp::Ordering::Less
    {
        return false;
    }
    if let Some(to) = to
        && compare_iso_dates(date, to) == std::cmp::Ordering::Greater
    {
        return false;
    }
    true
}

fn ensure_naive(date: &str) -> Result<NaiveDate, CoreError> {
    let parts = parse_or_fail(date)?;
    to_naive(parts).ok_or_else(|| CoreError::InvalidDate(date.to_string()))
}

fn parse_or_fail(date: &str) -> Result<IsoDateParts, CoreError> {
    parse_iso_date(date).ok_or_else(|| CoreError::InvalidDate(date.to_string()))
}

/// Adds natural days across month and year boundaries (`addDaysISO`),
/// on the calendar (no hours, no DST).
pub fn add_days_iso(date: &str, days: i64) -> Result<String, CoreError> {
    let naive = ensure_naive(date)?;
    let span = Days::new(days.unsigned_abs());
    let shifted = if days >= 0 {
        naive.checked_add_days(span)
    } else {
        naive.checked_sub_days(span)
    };
    shifted
        .map(|d| to_iso_date(from_naive(d)))
        .ok_or_else(|| CoreError::InvalidDate(date.to_string()))
}

/// Adds natural months with month-end clamping: `31/01 + 1 month` is
/// `28/02` (or `29/02` in a leap year).
pub fn add_months_iso(date: &str, months: i64) -> Result<String, CoreError> {
    let parts = parse_or_fail(date)?;
    let total = parts.year * 12 + (parts.month - 1) + months;
    let year = total.div_euclid(12);
    let month = total - year * 12 + 1;
    let day = parts.day.min(days_in_month(year, month));
    Ok(to_iso_date(IsoDateParts { year, month, day }))
}

/// Adds natural years; a `29/02` becomes `28/02` when the target year is
/// not a leap year.
pub fn add_years_iso(date: &str, years: i64) -> Result<String, CoreError> {
    let parts = parse_or_fail(date)?;
    let year = parts.year + years;
    let day = parts.day.min(days_in_month(year, parts.month));
    Ok(to_iso_date(IsoDateParts {
        year,
        month: parts.month,
        day,
    }))
}

/// Whole calendar days between two dates (`to` - `from`).
pub fn diff_days(from: &str, to: &str) -> Result<i64, CoreError> {
    let a =
        to_naive(parse_or_fail(from)?).ok_or_else(|| CoreError::InvalidDate(from.to_string()))?;
    let b = to_naive(parse_or_fail(to)?).ok_or_else(|| CoreError::InvalidDate(to.to_string()))?;
    Ok((b - a).num_days())
}

pub fn start_of_month(date: &str) -> Result<String, CoreError> {
    let parts = parse_or_fail(date)?;
    Ok(to_iso_date(IsoDateParts {
        year: parts.year,
        month: parts.month,
        day: 1,
    }))
}

pub fn end_of_month(date: &str) -> Result<String, CoreError> {
    let parts = parse_or_fail(date)?;
    Ok(to_iso_date(IsoDateParts {
        year: parts.year,
        month: parts.month,
        day: days_in_month(parts.year, parts.month),
    }))
}

/// The month a date belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YearMonth {
    pub year: i64,
    pub month: i64,
}

pub fn month_of(date: &str) -> Result<YearMonth, CoreError> {
    let parts = parse_or_fail(date)?;
    Ok(YearMonth {
        year: parts.year,
        month: parts.month,
    })
}

pub fn day_of_iso(date: &str) -> Result<i64, CoreError> {
    Ok(parse_or_fail(date)?.day)
}

const MONTHS_SHORT: [&str; 12] = [
    "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic",
];

const MONTHS_LONG: [&str; 12] = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
];

const WEEKDAYS_LONG: [&str; 7] = [
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
    "domingo",
];

const WEEKDAYS_SHORT: [&str; 7] = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

/// `18 nov 2026`, like Intl `es-ES` with a short month. Invalid dates come
/// back unchanged, like the reference.
pub fn format_date_short(date: &str) -> String {
    match parse_iso_date(date) {
        Some(parts) => format!(
            "{} {} {}",
            parts.day,
            MONTHS_SHORT[(parts.month - 1) as usize],
            parts.year
        ),
        None => date.to_string(),
    }
}

/// `miércoles, 18 de noviembre de 2026`, like Intl `es-ES` long format.
/// Invalid dates come back unchanged, like the reference.
pub fn format_date_long(date: &str) -> String {
    let Some(parts) = parse_iso_date(date) else {
        return date.to_string();
    };
    let Some(naive) = to_naive(parts) else {
        return date.to_string();
    };
    let weekday = WEEKDAYS_LONG[naive.weekday().num_days_from_monday() as usize];
    format!(
        "{weekday}, {} de {} de {}",
        parts.day,
        MONTHS_LONG[(parts.month - 1) as usize],
        parts.year
    )
}

/// `Noviembre de 2026`, capitalized like the reference's `formatMonthLabel`.
/// An out-of-range month rolls over the year, like the reference's Intl call.
pub fn format_month_label(year: i64, month: i64) -> String {
    let total = year * 12 + (month - 1);
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) + 1;
    let raw = format!("{} de {}", MONTHS_LONG[(month - 1) as usize], year);
    let mut chars = raw.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => raw,
    }
}

/// `mié`, like Intl `es-ES` short weekday. Empty for an invalid date.
pub fn weekday_short(date: &str) -> String {
    let Some(parts) = parse_iso_date(date) else {
        return String::new();
    };
    let Some(naive) = to_naive(parts) else {
        return String::new();
    };
    WEEKDAYS_SHORT[naive.weekday().num_days_from_monday() as usize].to_string()
}

/// A calendar month grid: weeks that start on Monday, including the days
/// of the neighbouring months needed to complete them. Exactly like the
/// reference, a full sixth week without any day of the month is still
/// pushed before the loop stops, so trailing weeks can appear.
pub fn get_month_grid(year: i64, month: i64) -> Vec<Vec<String>> {
    let first = to_iso_date(IsoDateParts {
        year,
        month,
        day: 1,
    });
    // getUTCDay counts Sunday as 0; weeks here start on Monday.
    let first_weekday = to_naive(IsoDateParts {
        year,
        month,
        day: 1,
    })
    .map(|d| d.weekday().num_days_from_sunday() as i64)
    .unwrap_or(1);
    let lead = (first_weekday + 6) % 7;
    let mut cursor = add_days_iso(&first, -lead).unwrap_or(first.clone());
    let mut weeks: Vec<Vec<String>> = Vec::new();
    for week in 0..6 {
        let mut row: Vec<String> = Vec::new();
        for _ in 0..7 {
            row.push(cursor.clone());
            cursor = add_days_iso(&cursor, 1).unwrap_or(cursor);
        }
        weeks.push(row.clone());
        let row_month = |index: usize| parse_iso_date(&row[index]).map(|p| p.month);
        if week >= 4 && row_month(0) != Some(month) && row_month(6) != Some(month) {
            break;
        }
    }
    weeks
}

/// The day of the month a recurrence pattern's day number clamps to.
pub fn clamp_day_to_month(year: i64, month: i64, day: i64) -> i64 {
    day.min(days_in_month(year, month))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_per_month_and_leap_years() {
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2026, 2), 28);
        assert!(is_leap_year(2024));
        assert!(!is_leap_year(1900));
        assert!(is_leap_year(2000));
    }

    #[test]
    fn monthly_on_day_29_30_31_clamps_to_month_end() {
        assert_eq!(add_months_iso("2026-01-31", 1), Ok("2026-02-28".into()));
        assert_eq!(add_months_iso("2026-01-30", 1), Ok("2026-02-28".into()));
        assert_eq!(add_months_iso("2026-03-31", 1), Ok("2026-04-30".into()));
        assert_eq!(add_months_iso("2026-12-31", 2), Ok("2027-02-28".into()));
        assert_eq!(add_months_iso("2024-01-29", 1), Ok("2024-02-29".into()));
    }

    #[test]
    fn annual_with_february_29th() {
        assert_eq!(add_years_iso("2024-02-29", 1), Ok("2025-02-28".into()));
        assert_eq!(add_years_iso("2024-02-29", 4), Ok("2028-02-29".into()));
        assert_eq!(add_years_iso("2026-02-28", 1), Ok("2027-02-28".into()));
    }

    #[test]
    fn add_and_diff_days() {
        assert_eq!(add_days_iso("2026-11-30", 1), Ok("2026-12-01".into()));
        assert_eq!(add_days_iso("2026-12-31", 1), Ok("2027-01-01".into()));
        assert_eq!(diff_days("2026-11-17", "2026-11-18"), Ok(1));
        assert_eq!(diff_days("2026-11-17", "2026-11-17"), Ok(0));
        assert_eq!(
            compare_iso_dates("2026-11-17", "2026-11-18"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn instants_look_like_the_reference_toiso_string() {
        let instant = DateTime::from_timestamp(1_763_478_896, 789_000_000).unwrap();
        assert_eq!(format_instant(instant), "2025-11-18T15:14:56.789Z");
        // The current clock keeps the same shape: UTC, millis, Z.
        let now = now_utc_iso();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'), "{now}");
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
        assert!(is_valid_iso_date(&today_madrid_now()));
    }

    #[test]
    fn rejects_impossible_dates() {
        assert!(!is_valid_iso_date("2026-02-30"));
        assert!(!is_valid_iso_date("2026-13-01"));
        assert!(is_valid_iso_date("2024-02-29"));
        assert!(!is_valid_iso_date("2026-02-29"));
        assert!(is_valid_iso_date("2026-11-17"));
    }

    #[test]
    fn the_calendar_grid_starts_on_monday_and_covers_the_month() {
        let grid = get_month_grid(2026, 11);
        assert_eq!(grid.len(), 6);
        assert_eq!(grid[0][0], "2026-10-26");
        assert_eq!(grid[5][6], "2026-12-06");
        let november = grid
            .iter()
            .flatten()
            .filter(|d| d.starts_with("2026-11"))
            .count();
        assert_eq!(november, 30);
    }

    #[test]
    fn formats_dates_in_spanish() {
        assert_eq!(format_date_short("2026-11-18"), "18 nov 2026");
        assert_eq!(format_date_short("2026-01-05"), "5 ene 2026");
        assert_eq!(format_date_short("bad"), "bad");
        assert_eq!(
            format_date_long("2026-11-18"),
            "miércoles, 18 de noviembre de 2026"
        );
        assert_eq!(format_month_label(2026, 11), "Noviembre de 2026");
        assert_eq!(format_month_label(2027, 1), "Enero de 2027");
        assert_eq!(weekday_short("2026-11-18"), "mié");
        assert_eq!(weekday_short("2026-11-21"), "sáb");
        assert_eq!(weekday_short("2026-11-22"), "dom");
        assert_eq!(weekday_short("no-date"), "");
    }

    #[test]
    fn today_madrid_returns_yyyy_mm_dd() {
        let late = DateTime::parse_from_rfc3339("2026-11-17T23:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let morning = DateTime::parse_from_rfc3339("2026-11-17T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(today_madrid(late), "2026-11-18");
        assert_eq!(today_madrid(morning), "2026-11-17");
    }
}
