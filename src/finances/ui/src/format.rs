//! Money and date formatting for the current interface language: Spanish
//! (Spain) groups thousands with `.` and decimals with `,` and puts the symbol
//! after the amount; English does the reverse.

use crate::data::{Currency, Money};
use crate::language::{self, fill, message};
use chrono::{Datelike, NaiveDate};

pub fn money(amount: Money) -> String {
    format_amount(amount.minor, amount.currency, false)
}

/// "2026-11-25": the text a date field shows and parses back.
pub fn iso_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// "12.99": the text an amount field shows and parses back (always a dot,
/// whatever the interface language, so the form is unambiguous).
pub fn amount_text(minor: i64) -> String {
    format!("{:.2}", minor as f64 / 100.)
}

pub fn signed_money(amount: Money) -> String {
    format_amount(amount.minor, amount.currency, true)
}

fn group_thousands(digits: &str, spanish: bool) -> String {
    let separator = if spanish { '.' } else { ',' };
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(separator);
        }
        out.push(c);
    }
    out
}

fn format_amount(minor: i64, currency: Currency, always_sign: bool) -> String {
    let symbol = match currency {
        Currency::Eur => "€",
        Currency::Usd => "$",
    };
    let negative = minor < 0;
    let abs = minor.unsigned_abs();
    let grouped = group_thousands(&(abs / 100).to_string(), language::spanish());
    let decimals = format!("{:02}", abs % 100);
    let sign = if negative {
        "-"
    } else if always_sign {
        "+"
    } else {
        ""
    };
    if language::spanish() {
        format!("{sign}{grouped},{decimals} {symbol}")
    } else {
        format!("{sign}{symbol}{grouped}.{decimals}")
    }
}

/// "November 25, 2026" / "25 de noviembre de 2026".
pub fn long_date(date: NaiveDate) -> String {
    let months = language::months_long();
    let month = months[(date.month() - 1) as usize];
    if language::spanish() {
        format!("{} de {} de {}", date.day(), month, date.year())
    } else {
        format!("{month} {}, {}", date.day(), date.year())
    }
}

/// "Nov 25, 2026" / "25 nov 2026".
pub fn short_date(date: NaiveDate) -> String {
    let months = language::months_short();
    let month = months[(date.month() - 1) as usize];
    if language::spanish() {
        format!("{} {} {}", date.day(), month, date.year())
    } else {
        format!("{month} {}, {}", date.day(), date.year())
    }
}

/// "Nov 25" / "25 nov", for the chart axes.
pub fn day_month(date: NaiveDate) -> String {
    let month = language::months_short()[(date.month() - 1) as usize];
    if language::spanish() {
        format!("{} {month}", date.day())
    } else {
        format!("{month} {}", date.day())
    }
}

/// "Nov 2026" / "nov 2026", for axes spanning about a year or more.
pub fn month_year_short(date: NaiveDate) -> String {
    let month = language::months_short()[(date.month() - 1) as usize];
    format!("{month} {}", date.year())
}

/// The projection table's day cell, short enough never to be cut: "Nov 27 ·
/// In 2 days" near today, the date alone further away (with its year once it
/// is another one).
pub fn table_day(date: NaiveDate, today: NaiveDate) -> String {
    let day = if date.year() == today.year() {
        day_month(date)
    } else {
        short_date(date)
    };
    // With a year in it there is no room for the relative day as well.
    if date.year() == today.year() && (date - today).num_days().abs() <= 30 {
        return format!("{day} · {}", relative_day_label(date, today));
    }
    day
}

/// "November 2026" / "noviembre 2026".
pub fn month_label(year: i32, month: u32) -> String {
    format!("{} {year}", language::months_long()[(month - 1) as usize])
}

/// "Nov 2026" / "nov 2026", for the chart axes.
pub fn short_month_label(year: i32, month: u32) -> String {
    let _ = year;
    language::months_short()[(month - 1) as usize].to_string()
}

/// The amount without its decimals ("€10,000" / "10.000 €"), for axes.
pub fn whole_money(amount: Money) -> String {
    let full = money(Money {
        minor: amount.minor / 100 * 100,
        ..amount
    });
    full.replace(if language::spanish() { ",00" } else { ".00" }, "")
}

/// The abbreviated amount for tight spots like calendar cells: under 10,000
/// in major units it is the plain amount, above it a compact form
/// ("€4.2k" / "4,2 mil €").
pub fn compact_money(amount: Money) -> String {
    let symbol = match amount.currency {
        Currency::Eur => "€",
        Currency::Usd => "$",
    };
    let spanish = language::spanish();
    let value = amount.minor as f64 / 100.;
    let abs = value.abs();
    let sign = if amount.minor < 0 { "-" } else { "" };
    let body = if abs < 10_000. {
        let grouped = group_thousands(&(abs.trunc() as i64).to_string(), spanish);
        if spanish {
            format!("{grouped} {symbol}")
        } else {
            format!("{symbol}{grouped}")
        }
    } else if abs < 1_000_000. {
        // One decimal of thousands, comma in Spanish ("4,2 mil €").
        let scaled = abs / 1_000.;
        let whole = scaled.trunc() as i64;
        let tenth = ((scaled - whole as f64) * 10.).round() as i64;
        let (whole, tenth) = if tenth >= 10 {
            (whole + 1, 0)
        } else {
            (whole, tenth)
        };
        if spanish {
            format!("{whole},{tenth} mil {symbol}")
        } else {
            format!("{symbol}{whole}.{tenth}k")
        }
    } else {
        let millions = abs / 1_000_000.;
        if spanish {
            format!("{millions:.1} M {symbol}")
        } else {
            format!("{symbol}{millions:.1}M")
        }
    };
    format!("{sign}{body}")
}

/// "42%" / "42 %".
pub fn percent(share: f64) -> String {
    let value = (share * 100.).round() as i64;
    if language::spanish() {
        format!("{value} %")
    } else {
        format!("{value}%")
    }
}

/// "Mon" / "lun".
pub fn weekday_short(date: NaiveDate) -> &'static str {
    let weekdays = language::weekdays_short();
    weekdays[date.weekday().num_days_from_monday() as usize]
}

/// "Today" / "Hoy", "Tomorrow" / "Mañana", "Yesterday" / "Ayer",
/// "In 5 days" / "En 5 días", "3 days ago" / "Hace 3 días", or the short date
/// when it is further away.
pub fn relative_day_label(date: NaiveDate, today: NaiveDate) -> String {
    let days = (date - today).num_days();
    match days {
        0 => message("rel.today").to_string(),
        1 => message("rel.tomorrow").to_string(),
        -1 => message("rel.yesterday").to_string(),
        d if (2..=30).contains(&d) => fill("rel.in", &[("{count}", &d.to_string())]),
        d if (-30..=-2).contains(&d) => fill("rel.ago", &[("{count}", &(-d).to_string())]),
        _ => short_date(date),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::language::apply;

    #[test]
    fn money_formats_in_both_languages() {
        apply(Some("en"));
        assert_eq!(money(Money::eur(421357)), "€4,213.57");
        assert_eq!(money(Money::usd(600)), "$6.00");
        assert_eq!(money(Money::eur(5)), "€0.05");
        assert_eq!(signed_money(Money::eur(-12345)), "-€123.45");
        assert_eq!(signed_money(Money::eur(12345)), "+€123.45");
        apply(Some("es-ES"));
        assert_eq!(money(Money::eur(421357)), "4.213,57 €");
        assert_eq!(money(Money::usd(600)), "6,00 $");
        assert_eq!(money(Money::eur(5)), "0,05 €");
        assert_eq!(signed_money(Money::eur(-12345)), "-123,45 €");
        apply(None);
    }

    #[test]
    fn dates_format_in_both_languages() {
        let date = NaiveDate::from_ymd_opt(2026, 11, 25).unwrap();
        apply(Some("en"));
        assert_eq!(long_date(date), "November 25, 2026");
        assert_eq!(short_date(date), "Nov 25, 2026");
        assert_eq!(month_label(2026, 11), "November 2026");
        apply(Some("es-ES"));
        assert_eq!(long_date(date), "25 de noviembre de 2026");
        assert_eq!(short_date(date), "25 nov 2026");
        assert_eq!(month_label(2026, 11), "noviembre 2026");
        apply(None);
    }

    #[test]
    fn axis_amounts_drop_the_decimals() {
        apply(Some("en"));
        assert_eq!(whole_money(Money::eur(1_000_000)), "€10,000");
        assert_eq!(whole_money(Money::eur(-100_000)), "-€1,000");
        apply(Some("es-ES"));
        assert_eq!(whole_money(Money::eur(1_000_000)), "10.000 €");
        apply(Some("en"));
    }

    #[test]
    fn the_projection_table_day_never_repeats_the_date() {
        apply(Some("es-ES"));
        let today = NaiveDate::from_ymd_opt(2026, 11, 25).expect("a date");
        let at = |days| table_day(today + chrono::Duration::days(days), today);
        assert!(at(2).starts_with("27 nov · "), "{}", at(2));
        assert_eq!(at(31), "26 dic");
        assert_eq!(at(60), "24 ene 2027");
        apply(Some("en"));
    }

    #[test]
    fn compact_money_percent_weekday_and_relative_days() {
        let date = NaiveDate::from_ymd_opt(2026, 11, 25).unwrap(); // a Wednesday
        apply(Some("en"));
        assert_eq!(compact_money(Money::eur(421357)), "€4,213");
        assert_eq!(compact_money(Money::eur(4213570)), "€42.1k");
        assert_eq!(compact_money(Money::eur(950)), "€9");
        assert_eq!(compact_money(Money::eur(-4213570)), "-€42.1k");
        assert_eq!(compact_money(Money::eur(250000000)), "€2.5M");
        assert_eq!(percent(0.423), "42%");
        assert_eq!(weekday_short(date), "Wed");
        assert_eq!(short_month_label(2026, 11), "Nov");
        let today = date;
        assert_eq!(relative_day_label(today, today), "Today");
        assert_eq!(
            relative_day_label(today + chrono::Duration::days(1), today),
            "Tomorrow"
        );
        assert_eq!(
            relative_day_label(today - chrono::Duration::days(1), today),
            "Yesterday"
        );
        assert_eq!(
            relative_day_label(today + chrono::Duration::days(5), today),
            "In 5 days"
        );
        assert_eq!(
            relative_day_label(today - chrono::Duration::days(3), today),
            "3 days ago"
        );
        assert_eq!(
            relative_day_label(today + chrono::Duration::days(90), today),
            "Feb 23, 2027"
        );
        apply(Some("es-ES"));
        assert_eq!(compact_money(Money::eur(421357)), "4.213 €");
        assert_eq!(compact_money(Money::eur(4213570)), "42,1 mil €");
        assert_eq!(compact_money(Money::eur(950)), "9 €");
        assert_eq!(compact_money(Money::eur(-4213570)), "-42,1 mil €");
        assert_eq!(percent(0.423), "42 %");
        assert_eq!(weekday_short(date), "mié");
        assert_eq!(short_month_label(2026, 11), "nov");
        assert_eq!(relative_day_label(today, today), "Hoy");
        assert_eq!(
            relative_day_label(today + chrono::Duration::days(5), today),
            "En 5 días"
        );
        assert_eq!(
            relative_day_label(today - chrono::Duration::days(3), today),
            "Hace 3 días"
        );
        apply(None);
    }
}
