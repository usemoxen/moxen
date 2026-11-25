//! Decimal strings into integer minor units, with no float in the way.
//!
//! The cases that matter for a ledger are here: a negative amount, a zero, a
//! currency with three decimals, an amount at the edge of `i64`, and the
//! classic traps (`0.07`, `1.005`) where a float would round the wrong way.

use moxen_finances_banking::money::{MoneyError, exponent, parse};

#[test]
fn two_decimals_are_the_common_case() {
    assert_eq!(parse("1.23", "EUR").unwrap(), 123);
    assert_eq!(parse("0.00", "EUR").unwrap(), 0);
    assert_eq!(parse("0", "EUR").unwrap(), 0);
    assert_eq!(parse("12", "EUR").unwrap(), 1200);
    assert_eq!(parse("1.5", "EUR").unwrap(), 150);
    assert_eq!(parse(".5", "EUR").unwrap(), 50);
    assert_eq!(parse("12.", "EUR").unwrap(), 1200);
}

#[test]
fn a_leading_minus_is_a_debit_and_a_leading_plus_a_credit() {
    assert_eq!(parse("-1.23", "EUR").unwrap(), -123);
    assert_eq!(parse("+1.23", "EUR").unwrap(), 123);
    assert_eq!(parse("-0.01", "EUR").unwrap(), -1);
    assert_eq!(parse("-0.00", "EUR").unwrap(), 0);
}

#[test]
fn surrounding_whitespace_is_trimmed() {
    assert_eq!(parse("  1.23\n", "EUR").unwrap(), 123);
    assert_eq!(parse("\t-4.50 ", "EUR").unwrap(), -450);
}

#[test]
fn the_float_traps_come_out_exact() {
    // 0.07_f64 * 100.0 is 7.000000000000001 and 1.005_f64 * 100.0 is
    // 100.49999999999999; neither may reach a ledger.
    assert_eq!(parse("0.07", "EUR").unwrap(), 7);
    assert_eq!(parse("1.005", "EUR").unwrap(), 101);
    assert_eq!(parse("2.675", "EUR").unwrap(), 268);
    assert_eq!(parse("-1.005", "EUR").unwrap(), -101);
}

#[test]
fn a_three_decimal_currency_keeps_its_third_digit() {
    assert_eq!(exponent("KWD"), 3);
    assert_eq!(parse("1.234", "KWD").unwrap(), 1234);
    assert_eq!(parse("1.2", "KWD").unwrap(), 1200);
    assert_eq!(parse("0.001", "KWD").unwrap(), 1);
    // More decimals than the currency has: round half away from zero.
    assert_eq!(parse("1.2344", "KWD").unwrap(), 1234);
    assert_eq!(parse("1.2345", "KWD").unwrap(), 1235);
    assert_eq!(parse("-0.0005", "KWD").unwrap(), -1);
}

#[test]
fn a_currency_without_decimals_rounds_to_whole_units() {
    assert_eq!(exponent("JPY"), 0);
    assert_eq!(parse("1234", "JPY").unwrap(), 1234);
    assert_eq!(parse("1234.0", "JPY").unwrap(), 1234);
    assert_eq!(parse("1234.4", "JPY").unwrap(), 1234);
    assert_eq!(parse("1234.5", "JPY").unwrap(), 1235);
    assert_eq!(parse("1234.9", "JPY").unwrap(), 1235);
}

#[test]
fn a_four_decimal_currency_and_an_unknown_one() {
    assert_eq!(exponent("CLF"), 4);
    assert_eq!(parse("1.2345", "CLF").unwrap(), 12345);
    // Nothing known about it: two decimals, like EUR.
    assert_eq!(exponent("XYZ"), 2);
    assert_eq!(parse("1.23", "XYZ").unwrap(), 123);
}

#[test]
fn the_currency_code_is_case_insensitive() {
    assert_eq!(parse("1.234", "kwd").unwrap(), 1234);
    assert_eq!(parse("1234", " jpy ").unwrap(), 1234);
}

#[test]
fn a_huge_amount_fits_at_the_edge_and_not_past_it() {
    assert_eq!(parse("92233720368547758.07", "EUR").unwrap(), i64::MAX);
    assert_eq!(parse("-92233720368547758.08", "EUR").unwrap(), i64::MIN);
    assert_eq!(
        parse("92233720368547758.08", "EUR"),
        Err(MoneyError::OutOfRange)
    );
    assert_eq!(
        parse("999999999999999999999.99", "EUR"),
        Err(MoneyError::OutOfRange)
    );
    assert_eq!(
        parse("123456789012345678901234567890", "JPY"),
        Err(MoneyError::OutOfRange)
    );
}

#[test]
fn a_malformed_amount_is_a_typed_error() {
    assert_eq!(parse("", "EUR"), Err(MoneyError::Empty));
    assert_eq!(parse("   ", "EUR"), Err(MoneyError::Empty));
    assert_eq!(parse("-", "EUR"), Err(MoneyError::Empty));
    assert_eq!(parse(".", "EUR"), Err(MoneyError::Empty));
    assert_eq!(parse("1.2.3", "EUR"), Err(MoneyError::Malformed));
    assert_eq!(parse("1,23", "EUR"), Err(MoneyError::NotDecimal));
    assert_eq!(parse("abc", "EUR"), Err(MoneyError::NotDecimal));
    assert_eq!(parse("1e5", "EUR"), Err(MoneyError::NotDecimal));
    assert_eq!(parse("1 2", "EUR"), Err(MoneyError::NotDecimal));
    assert_eq!(parse("1-2", "EUR"), Err(MoneyError::NotDecimal));
    assert_eq!(parse("--1", "EUR"), Err(MoneyError::NotDecimal));
}

#[test]
fn a_zero_amount_of_any_currency_is_zero() {
    for currency in ["EUR", "JPY", "KWD", "CLF"] {
        assert_eq!(parse("0", currency).unwrap(), 0);
        assert_eq!(parse("0.0", currency).unwrap(), 0);
    }
}
