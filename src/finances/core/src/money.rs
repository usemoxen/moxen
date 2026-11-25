//! Money: integer minor units everywhere, no floats for amounts. Ported
//! from the reference's `src/core/money.ts` (8aaad15b). Currency
//! conversion uses 128-bit integers with the same round-half-away
//! semantics the reference gets from BigInt, and the formatting helpers
//! reproduce Intl's `es-ES` output byte for byte.

use crate::CoreError;

/// Minor units per major unit: money everywhere is 100ths.
pub const CURRENCY_SCALE: i64 = 100;

/// `Math.round` of the reference: the integer closest to the value, with
/// exact halves going toward positive infinity (`-2.5` → `-2`). Unlike
/// `floor(x + 0.5)`, comparing the fractional part directly never rounds
/// the wrong way when `x + 0.5` would lose precision in the addition.
pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    if value.abs() >= 9_007_199_254_740_992.0 {
        // At or beyond 2^53 the value is already an integer double.
        return value;
    }
    let floor = value.floor();
    if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}

/// The reference's `roundMinor`: rounds a double amount to whole minor units.
pub fn round_minor(value: f64) -> i64 {
    f64_to_i64(js_round(value))
}

/// True when a value read from a raw source is a valid non-negative minor
/// amount (the integer half of the reference's type guard is the i64 type).
pub fn is_valid_minor(value: i64) -> bool {
    value >= 0
}

/// Converts an amount to another currency.
///
/// * `amount_minor` - amount in minor units
/// * `rate_scaled` - exchange rate scaled: 1 origin = rate_scaled / 1e6 destination
///
/// Returns the converted amount in minor units, rounded to the nearest
/// cent (half away from zero, exactly like the reference's BigInt math).
/// A rate that is zero or negative is rejected.
pub fn convert_minor(amount_minor: i64, rate_scaled: i64) -> Result<i64, CoreError> {
    if rate_scaled <= 0 {
        return Err(CoreError::InvalidRate(rate_scaled));
    }
    let amount = amount_minor as i128;
    let rate = rate_scaled as i128;
    let scale: i128 = 1_000_000;
    let half = scale / 2;
    let negative = amount < 0;
    let abs = if negative { -amount } else { amount };
    // 1 origin = rate_scaled / 1e6 destination, so the destination is
    // amount * rate / 1e6, rounded to the nearest one.
    let numerator = abs * rate + half;
    let result = numerator / scale;
    let signed = if negative { -result } else { result };
    i64::try_from(signed).map_err(|_| CoreError::AmountOutOfRange)
}

/// Groups an integer magnitude in thousands with the `es-ES` separator
/// (`1234567` → `1.234.567`). Like CLDR's Spanish locale, nothing below
/// 10,000 is grouped (`1500` stays `1500`).
fn group_es(magnitude: u64) -> String {
    let digits = magnitude.to_string();
    if magnitude < 10_000 {
        return digits;
    }
    let bytes = digits.as_bytes();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    let first = digits.len() % 3;
    if first > 0 {
        grouped.push_str(&digits[..first]);
    }
    let mut i = first;
    while i < bytes.len() {
        if !grouped.is_empty() {
            grouped.push('.');
        }
        grouped.push_str(&digits[i..i + 3]);
        i += 3;
    }
    grouped
}

/// Formats a minor amount the way `new Intl.NumberFormat('es-ES', { min/max
/// fraction digits: 2 })` does: two decimals, comma separator, dotted
/// thousands (`-123456` → `-1.234,56`).
fn format_es_2(amount_minor: i64) -> String {
    let magnitude = amount_minor.unsigned_abs();
    let whole = magnitude / 100;
    let cents = magnitude % 100;
    let mut out = String::new();
    if amount_minor < 0 {
        out.push('-');
    }
    out.push_str(&group_es(whole));
    out.push_str(&format!(",{cents:02}"));
    out
}

/// Formats a minor amount as a currency string in `es-ES`, like the
/// reference's `formatCurrency`: `€` and `US$` are placed after the number
/// separated by a no-break space; any other currency code just follows the
/// plain number after a regular space.
pub fn format_currency(amount_minor: i64, currency: &str) -> String {
    let number = format_es_2(amount_minor);
    match currency {
        "EUR" => format!("{number}\u{a0}€"),
        "USD" => format!("{number}\u{a0}US$"),
        other => format!("{number} {other}"),
    }
}

/// Formats a minor amount as a `es-ES` number with two decimals preceded
/// by an optional symbol (never used with a currency symbol; EUR/USD go
/// through `format_currency`).
pub fn format_minor(amount_minor: i64, symbol: &str) -> String {
    format!("{symbol}{}", format_es_2(amount_minor))
}

/// Formats a minor amount with an explicit symbol, mirroring the reference's
/// default parameter.
pub fn format_minor_default(amount_minor: i64) -> String {
    format_minor(amount_minor, "")
}

/// Converts a text amount (`19,99` / `19.99` / `1.234,56`) to minor units.
/// Returns `None` when the text is not a valid amount. Both the Spanish
/// convention (comma decimals, dotted thousands) and the English one are
/// accepted, exactly like the reference's `parseAmountToMinor`.
pub fn parse_amount_to_minor(text: &str) -> Option<i64> {
    let trimmed: String = text
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '€' && *c != '$')
        .collect();
    if trimmed.is_empty() {
        return None;
    }

    // Thousands separated by dots with a comma decimal: 1.234,56.
    let last_comma = trimmed.rfind(',');
    let last_dot = trimmed.rfind('.');
    let normalized = match (last_comma, last_dot) {
        (None, None) => trimmed,
        (Some(_), None) => trimmed.replace('.', "").replace(',', "."),
        (None, Some(_)) => trimmed.replace(',', ""),
        (Some(comma), Some(dot)) => {
            if comma > dot {
                trimmed.replace('.', "").replace(',', ".")
            } else {
                trimmed.replace(',', "")
            }
        }
    };

    let value = parse_plain_decimal(&normalized)?;
    f64_to_i64_opt(js_round(value * CURRENCY_SCALE as f64))
}

/// Converts a text exchange rate (`1,1` / `0.909091`) to the scaled form
/// (1 origin = rate / 1e6 destination). `None` when invalid.
pub fn parse_rate_to_scaled(text: &str) -> Option<i64> {
    let trimmed: String = text
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .replace(',', ".");
    let value = parse_plain_decimal(&trimmed)?;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    f64_to_i64_opt(js_round(value * 1_000_000.0))
}

/// Validates `-?\d+(\.\d+)?` and parses it with the same double rounding as
/// the reference's `Number()`.
fn parse_plain_decimal(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut i = 0;
    if bytes.first() == Some(&b'-') {
        i = 1;
    }
    let digits_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits_start {
        return None;
    }
    let mut digits_end = i;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == frac_start {
            return None;
        }
        digits_end = i;
    }
    if i != bytes.len() {
        return None;
    }
    text[..digits_end].parse::<f64>().ok()
}

/// Formats a scaled rate like the reference's `formatRate` (`es-ES`, between
/// two and six decimals, trailing zeros trimmed above two).
pub fn format_rate(rate_scaled: i64) -> String {
    let magnitude = rate_scaled.unsigned_abs();
    let whole = magnitude / 1_000_000;
    let mut fraction = format!("{:06}", magnitude % 1_000_000);
    while fraction.len() > 2 && fraction.ends_with('0') {
        fraction.pop();
    }
    let sign = if rate_scaled < 0 { "-" } else { "" };
    let grouped = group_es(whole);
    format!("{sign}{grouped},{fraction}")
}

fn f64_to_i64(value: f64) -> i64 {
    value as i64
}

fn f64_to_i64_opt(value: f64) -> Option<i64> {
    if !value.is_finite()
        || value >= 9_223_372_036_854_775_808.0
        || value < -9_223_372_036_854_775_808.0
    {
        return None;
    }
    Some(value as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_without_floats_with_cent_rounding() {
        // 12.00 USD to EUR at 1 EUR = 1.10 USD -> 10.9091 EUR -> 10.91 EUR.
        assert_eq!(convert_minor(1200, 909_091), Ok(1091));
        assert_eq!(convert_minor(400, 909_091), Ok(364));
        assert_eq!(convert_minor(1299, 909_091), Ok(1181));
        assert_eq!(convert_minor(0, 909_091), Ok(0));
    }

    #[test]
    fn rounds_up_and_down() {
        // 1.00 USD -> 0.9091 EUR -> 0.91 EUR.
        assert_eq!(convert_minor(100, 909_091), Ok(91));
        // 0.01 USD -> 0.0091 EUR -> 0.01 EUR.
        assert_eq!(convert_minor(1, 909_091), Ok(1));
    }

    #[test]
    fn rounds_half_away_from_zero_and_keeps_the_sign() {
        assert_eq!(convert_minor(-1200, 909_091), Ok(-1091));
        assert_eq!(convert_minor(2, 1_000_000), Ok(2));
        assert_eq!(convert_minor(-2, 1_000_000), Ok(-2));
        assert_eq!(convert_minor(1, 500_000), Ok(1)); // 0.5 rounds away
        assert_eq!(convert_minor(-1, 500_000), Ok(-1)); // -0.5 rounds away
    }

    #[test]
    fn rejects_non_positive_rates() {
        assert_eq!(convert_minor(1, 0), Err(CoreError::InvalidRate(0)));
        assert_eq!(convert_minor(1, -5), Err(CoreError::InvalidRate(-5)));
    }

    #[test]
    fn formats_in_spanish() {
        assert_eq!(format_currency(2499, "EUR"), "24,99\u{a0}€");
        assert_eq!(format_currency(1250, "USD"), "12,50\u{a0}US$");
        assert_eq!(format_currency(123_456_789, "GBP"), "1.234.567,89 GBP");
        assert_eq!(format_currency(-2499, "EUR"), "-24,99\u{a0}€");
        assert_eq!(format_currency(0, "EUR"), "0,00\u{a0}€");
        assert_eq!(format_minor_default(-1250), "-12,50");
        assert_eq!(format_minor(-1250, "-"), "--12,50"); // símbolo literal
    }

    #[test]
    fn parses_spanish_and_english_input() {
        assert_eq!(parse_amount_to_minor("24,99"), Some(2499));
        assert_eq!(parse_amount_to_minor("24.99"), Some(2499));
        assert_eq!(parse_amount_to_minor("1.234,56"), Some(123456));
        assert_eq!(parse_amount_to_minor("1,234.56"), Some(123456));
        assert_eq!(parse_amount_to_minor(" 12,5 € "), Some(1250));
        assert_eq!(parse_amount_to_minor("abc"), None);
        assert_eq!(parse_amount_to_minor(""), None);
        // La coma gana: "12.5,5" normaliza a 125.5, como en la referencia.
        assert_eq!(parse_amount_to_minor("12.5,5"), Some(12550));
        assert_eq!(parse_amount_to_minor("-19"), Some(-1900));
    }

    #[test]
    fn parses_exchange_rates() {
        assert_eq!(parse_rate_to_scaled("1,1"), Some(1_100_000));
        assert_eq!(parse_rate_to_scaled("0.909091"), Some(909_091));
        assert_eq!(parse_rate_to_scaled("0"), None);
        assert_eq!(parse_rate_to_scaled("-1"), None);
    }

    #[test]
    fn formats_rates() {
        assert_eq!(format_rate(909_091), "0,909091");
        assert_eq!(format_rate(1_100_000), "1,10");
        assert_eq!(format_rate(1), "0,000001");
        assert_eq!(format_rate(1_234_567), "1,234567");
        // Sin agrupación por debajo de 10.000 (es-ES agrupa desde 104).
        assert_eq!(format_rate(1_500_000_000), "1500,00");
        assert_eq!(format_rate(10_000_000_000), "10.000,00");
        assert_eq!(format_rate(123_456_000_000), "123.456,00");
    }

    #[test]
    fn js_round_matches_the_reference_semantics() {
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(-0.5), 0.0); // -0: hacia +infinito
        assert_eq!(js_round(-1.5), -1.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
    }
}
