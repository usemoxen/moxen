//! Recurrence patterns: occurrence generation, pauses and the next
//! billing date. Ported from the reference's `src/core/recurrence.ts`
//! (8aaad15b): the first occurrence is always the start date, months with
//! no day 29/30/31 clamp to the month end, a 29/02 resolves to 28/02 in
//! non-leap years, and `endDate` is exclusive.

use crate::CoreError;
use crate::dates::{
    IsoDateParts, add_days_iso, add_years_iso, compare_iso_dates, days_in_month, parse_iso_date,
    to_iso_date,
};
use crate::types::{Frequency, PauseEntry, SubscriptionStatus};

/// The default cap on generated occurrences, like the reference.
pub const MAX_OCCURRENCES: usize = 2000;

#[derive(Debug, Clone)]
pub struct OccurrenceOptions<'a> {
    pub start_date: &'a str,
    pub frequency: Frequency,
    /// Día de cobro para mensual/trimestral/anual. None = día de startDate.
    pub billing_day: Option<i64>,
    pub from_date: &'a str,
    pub to_date: &'a str,
    pub max_occurrences: Option<usize>,
}

impl<'a> OccurrenceOptions<'a> {
    pub fn new(
        start_date: &'a str,
        frequency: Frequency,
        from_date: &'a str,
        to_date: &'a str,
    ) -> Self {
        Self {
            start_date,
            frequency,
            billing_day: None,
            from_date,
            to_date,
            max_occurrences: None,
        }
    }
}

/// Generates the dates of a recurrent pattern inside a range. The first
/// occurrence is always the start date; months adjust to the last day when
/// the day does not exist and leap years resolve on 28/02. Occurrences
/// before `from_date` are skipped, and generation stops past `to_date`.
pub fn generate_occurrences(options: &OccurrenceOptions) -> Result<Vec<String>, CoreError> {
    parse_iso_date(options.start_date)
        .ok_or_else(|| CoreError::InvalidDate(options.start_date.to_string()))?;
    let max = options.max_occurrences.unwrap_or(MAX_OCCURRENCES);
    let mut result: Vec<String> = Vec::new();

    if options.frequency == Frequency::Once {
        if compare_iso_dates(options.start_date, options.from_date) != std::cmp::Ordering::Less
            && compare_iso_dates(options.start_date, options.to_date) != std::cmp::Ordering::Greater
        {
            result.push(options.start_date.to_string());
        }
        return Ok(result);
    }

    for k in 0..max {
        let date = occurrence_at_offset(
            options.start_date,
            options.frequency,
            k as i64,
            options.billing_day,
        )?;
        if compare_iso_dates(&date, options.to_date) == std::cmp::Ordering::Greater {
            break;
        }
        if compare_iso_dates(&date, options.from_date) != std::cmp::Ordering::Less {
            result.push(date);
        }
    }
    Ok(result)
}

fn occurrence_at_offset(
    start_date: &str,
    frequency: Frequency,
    offset: i64,
    billing_day: Option<i64>,
) -> Result<String, CoreError> {
    let start =
        parse_iso_date(start_date).ok_or_else(|| CoreError::InvalidDate(start_date.to_string()))?;
    if offset == 0 {
        return Ok(start_date.to_string());
    }

    match frequency {
        Frequency::Weekly => add_days_iso(start_date, offset * 7),
        Frequency::Annual => {
            let year = start.year + offset;
            let day = billing_day
                .unwrap_or(start.day)
                .min(days_in_month(year, start.month));
            Ok(to_iso_date(IsoDateParts {
                year,
                month: start.month,
                day,
            }))
        }
        Frequency::Monthly | Frequency::Quarterly => {
            let months_per_step = if frequency == Frequency::Quarterly {
                3
            } else {
                1
            };
            let total = start.year * 12 + (start.month - 1) + offset * months_per_step;
            let year = total.div_euclid(12);
            let month = total - year * 12 + 1;
            let day = billing_day
                .unwrap_or(start.day)
                .min(days_in_month(year, month));
            Ok(to_iso_date(IsoDateParts { year, month, day }))
        }
        Frequency::Once => Ok(start_date.to_string()),
    }
}

/// The first date of the pattern at or after `from_date` (inclusive).
pub fn first_occurrence_from(
    start_date: &str,
    frequency: Frequency,
    from_date: &str,
    billing_day: Option<i64>,
) -> Result<Option<String>, CoreError> {
    let horizon = add_years_iso(from_date, 5)?;
    let occurrences = generate_occurrences(&OccurrenceOptions {
        start_date,
        frequency,
        billing_day,
        from_date,
        to_date: &horizon,
        max_occurrences: None,
    })?;
    Ok(occurrences.into_iter().next())
}

/// Is the date inside any pause interval? Both ends are inclusive.
pub fn is_paused_at(pauses: &[PauseEntry], date: &str) -> bool {
    pauses.iter().any(|pause| {
        let after_start = compare_iso_dates(date, &pause.start_date) != std::cmp::Ordering::Less;
        let before_end = pause
            .end_date
            .as_deref()
            .is_none_or(|end| compare_iso_dates(date, end) != std::cmp::Ordering::Greater);
        after_start && before_end
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecurrenceStatus {
    pub paused: bool,
    pub pause: Option<PauseEntry>,
}

/// The pause that covers the date, if any.
pub fn pause_state_at(pauses: &[PauseEntry], date: &str) -> RecurrenceStatus {
    let pause = pauses.iter().find(|p| {
        let after_start = compare_iso_dates(date, &p.start_date) != std::cmp::Ordering::Less;
        let before_end = p
            .end_date
            .as_deref()
            .is_none_or(|end| compare_iso_dates(date, end) != std::cmp::Ordering::Greater);
        after_start && before_end
    });
    RecurrenceStatus {
        paused: pause.is_some(),
        pause: pause.cloned(),
    }
}

/// Whether a subscription can generate a charge on the given date.
#[derive(Debug, Clone)]
pub struct CanChargeOptions<'a> {
    pub status: SubscriptionStatus,
    pub end_date: Option<&'a str>,
    pub cancelled_at: Option<&'a str>,
    pub pauses: &'a [PauseEntry],
    pub start_date: Option<&'a str>,
    pub archived_at: Option<&'a str>,
}

pub fn can_charge_on(date: &str, options: &CanChargeOptions) -> bool {
    let Some(start_date) = options.start_date else {
        return false;
    };
    if compare_iso_dates(date, start_date) == std::cmp::Ordering::Less {
        return false;
    }
    if let Some(end) = options.end_date
        && compare_iso_dates(date, end) != std::cmp::Ordering::Less
    {
        return false;
    }
    if let Some(cancelled) = options.cancelled_at
        && compare_iso_dates(date, cancelled) != std::cmp::Ordering::Less
    {
        return false;
    }
    if let Some(archived) = options.archived_at
        && compare_iso_dates(date, archived) != std::cmp::Ordering::Less
    {
        return false;
    }
    if is_paused_at(options.pauses, date) {
        return false;
    }
    // 'cancelled' without a cancellation date generates nothing new.
    if options.status == SubscriptionStatus::Cancelled && options.cancelled_at.is_none() {
        return false;
    }
    true
}

/// The inputs of the next billing calculation.
#[derive(Debug, Clone)]
pub struct NextBillingOptions<'a> {
    pub start_date: &'a str,
    pub frequency: Frequency,
    pub billing_day: Option<i64>,
    pub next_billing_override: Option<&'a str>,
    pub end_date: Option<&'a str>,
    pub cancelled_at: Option<&'a str>,
    pub pauses: &'a [PauseEntry],
    pub today: &'a str,
    pub archived_at: Option<&'a str>,
    /// Fechas con un cargo real ya registrado: no vuelven a proponerse.
    pub charged_dates: &'a [String],
}

/// The next charge date from today: the manual override when it applies,
/// otherwise the first occurrence that is not charged, paused, ended,
/// cancelled or archived.
pub fn next_billing_date(options: &NextBillingOptions) -> Result<Option<String>, CoreError> {
    let is_archived = |date: &str| -> bool {
        match options.archived_at {
            Some(at) => compare_iso_dates(date, at) != std::cmp::Ordering::Less,
            None => false,
        }
    };

    if let Some(override_date) = options.next_billing_override {
        let not_charged = !options.charged_dates.iter().any(|d| d == override_date);
        let future = compare_iso_dates(override_date, options.today) != std::cmp::Ordering::Less;
        if future && not_charged && !is_archived(override_date) {
            let within_end = options.end_date.is_none_or(|end| {
                compare_iso_dates(override_date, end) == std::cmp::Ordering::Less
            });
            let within_cancel = options
                .cancelled_at
                .is_none_or(|c| compare_iso_dates(override_date, c) == std::cmp::Ordering::Less);
            let unpaused = !is_paused_at(options.pauses, override_date);
            if within_end && within_cancel && unpaused {
                return Ok(Some(override_date.to_string()));
            }
        }
    }

    let horizon = add_years_iso(options.today, 5)?;
    let occurrences = generate_occurrences(&OccurrenceOptions {
        start_date: options.start_date,
        frequency: options.frequency,
        billing_day: options.billing_day,
        from_date: options.today,
        to_date: &horizon,
        max_occurrences: None,
    })?;
    for date in occurrences {
        if options.charged_dates.contains(&date) || is_archived(&date) {
            continue;
        }
        let within_end = options
            .end_date
            .is_none_or(|end| compare_iso_dates(&date, end) == std::cmp::Ordering::Less);
        let within_cancel = options
            .cancelled_at
            .is_none_or(|c| compare_iso_dates(&date, c) == std::cmp::Ordering::Less);
        let unpaused = !is_paused_at(options.pauses, &date);
        if within_end && within_cancel && unpaused {
            return Ok(Some(date));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occurrences(start: &str, frequency: Frequency, from: &str, to: &str) -> Vec<String> {
        generate_occurrences(&OccurrenceOptions {
            start_date: start,
            frequency,
            billing_day: None,
            from_date: from,
            to_date: to,
            max_occurrences: None,
        })
        .unwrap()
    }

    #[test]
    fn monthly_on_day_31_clamps_to_the_month_end() {
        assert_eq!(
            occurrences("2026-01-31", Frequency::Monthly, "2026-01-01", "2026-06-30"),
            [
                "2026-01-31",
                "2026-02-28",
                "2026-03-31",
                "2026-04-30",
                "2026-05-31",
                "2026-06-30"
            ]
        );
    }

    #[test]
    fn monthly_on_day_30_and_29() {
        assert_eq!(
            occurrences("2026-01-30", Frequency::Monthly, "2026-01-01", "2026-04-30"),
            ["2026-01-30", "2026-02-28", "2026-03-30", "2026-04-30"]
        );
        assert_eq!(
            occurrences("2024-01-29", Frequency::Monthly, "2024-01-01", "2024-03-31"),
            ["2024-01-29", "2024-02-29", "2024-03-29"]
        );
    }

    #[test]
    fn annual_respects_leap_years() {
        assert_eq!(
            occurrences("2024-02-29", Frequency::Annual, "2024-01-01", "2029-12-31"),
            [
                "2024-02-29",
                "2025-02-28",
                "2026-02-28",
                "2027-02-28",
                "2028-02-29",
                "2029-02-28"
            ]
        );
    }

    #[test]
    fn weekly_and_quarterly() {
        assert_eq!(
            occurrences("2026-03-08", Frequency::Weekly, "2026-03-01", "2026-03-31"),
            ["2026-03-08", "2026-03-15", "2026-03-22", "2026-03-29"]
        );
        assert_eq!(
            occurrences(
                "2026-01-15",
                Frequency::Quarterly,
                "2026-01-01",
                "2027-06-30"
            ),
            [
                "2026-01-15",
                "2026-04-15",
                "2026-07-15",
                "2026-10-15",
                "2027-01-15",
                "2027-04-15"
            ]
        );
    }

    #[test]
    fn configurable_billing_day() {
        let result = generate_occurrences(&OccurrenceOptions {
            start_date: "2026-04-23",
            frequency: Frequency::Monthly,
            billing_day: Some(5),
            from_date: "2026-04-01",
            to_date: "2026-07-31",
            max_occurrences: None,
        })
        .unwrap();
        assert_eq!(
            result,
            ["2026-04-23", "2026-05-05", "2026-06-05", "2026-07-05"]
        );
    }

    #[test]
    fn the_first_occurrence_is_the_start_date() {
        assert_eq!(
            occurrences("2026-11-08", Frequency::Once, "2026-11-01", "2026-11-30"),
            ["2026-11-08"]
        );
    }

    fn pause(start: &str, end: Option<&str>) -> Vec<PauseEntry> {
        vec![PauseEntry {
            id: "p1".into(),
            subscription_id: "s1".into(),
            start_date: start.into(),
            end_date: end.map(|e| e.into()),
            note: String::new(),
            created_at: String::new(),
        }]
    }

    #[test]
    fn is_paused_at_keeps_both_ends_inclusive() {
        let pauses = pause("2026-12-01", Some("2027-02-28"));
        assert!(!is_paused_at(&pauses, "2026-11-30"));
        assert!(is_paused_at(&pauses, "2026-12-01"));
        assert!(is_paused_at(&pauses, "2027-02-28"));
        assert!(!is_paused_at(&pauses, "2027-03-01"));
    }

    #[test]
    fn an_open_pause_covers_everything_after_it() {
        let pauses = pause("2026-12-01", None);
        assert!(is_paused_at(&pauses, "2027-06-01"));
    }

    #[test]
    fn can_charge_on_end_cancellation_archive_and_pause() {
        let no_pauses: Vec<PauseEntry> = Vec::new();
        let december_pause = pause("2026-12-01", Some("2027-02-28"));
        fn base<'a>(
            end_date: Option<&'a str>,
            cancelled: Option<&'a str>,
            archived: Option<&'a str>,
            pauses: &'a [PauseEntry],
        ) -> CanChargeOptions<'a> {
            CanChargeOptions {
                status: SubscriptionStatus::Active,
                end_date,
                cancelled_at: cancelled,
                pauses,
                start_date: Some("2026-04-23"),
                archived_at: archived,
            }
        }
        assert!(!can_charge_on(
            "2026-12-20",
            &base(Some("2026-12-20"), None, None, &no_pauses)
        ));
        assert!(can_charge_on(
            "2026-12-19",
            &base(Some("2026-12-20"), None, None, &no_pauses)
        ));
        let cancelled = CanChargeOptions {
            status: SubscriptionStatus::Cancelled,
            end_date: None,
            cancelled_at: Some("2026-12-01"),
            pauses: &no_pauses,
            start_date: Some("2026-04-23"),
            archived_at: None,
        };
        assert!(!can_charge_on("2026-12-01", &cancelled));
        assert!(!can_charge_on(
            "2026-12-01",
            &base(None, None, Some("2026-12-01"), &no_pauses)
        ));
        let paused = CanChargeOptions {
            status: SubscriptionStatus::Paused,
            end_date: None,
            cancelled_at: None,
            pauses: &december_pause,
            start_date: Some("2026-04-23"),
            archived_at: None,
        };
        assert!(!can_charge_on("2026-12-23", &paused));
        assert!(can_charge_on(
            "2026-11-23",
            &base(None, None, None, &december_pause)
        ));
        // finished sin fecha no impide el histórico
        let finished = CanChargeOptions {
            status: SubscriptionStatus::Finished,
            end_date: None,
            cancelled_at: None,
            pauses: &no_pauses,
            start_date: Some("2026-04-23"),
            archived_at: None,
        };
        assert!(can_charge_on("2026-11-23", &finished));
    }

    fn billing_opts<'a>(
        override_date: Option<&'a str>,
        today: &'a str,
        pauses: &'a [PauseEntry],
    ) -> NextBillingOptions<'a> {
        NextBillingOptions {
            start_date: "2026-04-23",
            frequency: Frequency::Monthly,
            billing_day: None,
            next_billing_override: override_date,
            end_date: None,
            cancelled_at: None,
            pauses,
            today,
            archived_at: None,
            charged_dates: &[],
        }
    }

    #[test]
    fn next_billing_computes_overrides_and_pauses() {
        let no_pauses: Vec<PauseEntry> = Vec::new();
        let december = pause("2026-12-01", Some("2027-02-28"));
        assert_eq!(
            next_billing_date(&billing_opts(None, "2026-11-18", &no_pauses)),
            Ok(Some("2026-11-23".into()))
        );
        assert_eq!(
            next_billing_date(&billing_opts(Some("2026-12-01"), "2026-11-18", &no_pauses)),
            Ok(Some("2026-12-01".into()))
        );
        assert_eq!(
            next_billing_date(&billing_opts(None, "2026-12-15", &december)),
            Ok(Some("2027-03-23".into()))
        );
    }
}
