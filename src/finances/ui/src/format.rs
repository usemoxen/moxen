//! Money and date formatting for the current interface language: Spanish
//! (Spain) groups thousands with `.` and decimals with `,` and puts the symbol
//! after the amount; English does the reverse.

use crate::data::{Currency, Money};
use crate::language;
use chrono::{Datelike, NaiveDate};

pub fn money(amount: Money) -> String {
    format_amount(amount.minor, amount.currency, false)
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

/// "November 2026" / "noviembre 2026".
pub fn month_label(year: i32, month: u32) -> String {
    format!("{} {year}", language::months_long()[(month - 1) as usize])
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
}
