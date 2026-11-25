//! Decimal amounts as the API writes them (`"1.23"`) into integer minor
//! units, without a float anywhere on the way.
//!
//! The API types an amount as a string, and a bank may send any number of
//! decimals. Minor units depend on the currency ([`exponent`]): 2 for EUR and
//! most others, 0 for JPY, 3 for KWD. A string with fewer decimals than the
//! currency has is scaled up (`"1.5"` KWD → `1500`); one with more is rounded
//! half away from zero (`"1.234"` EUR → `123`), which is what a bank means by
//! a third decimal it should not have sent.
//!
//! Nothing here parses a float: `1.23_f64 * 100.0` is `122.99999999999999`,
//! and a ledger cannot afford that.

use thiserror::Error;

/// Why an amount could not become minor units.
#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum MoneyError {
    /// An empty string, a lone sign, or a lone dot.
    #[error("el importe está vacío")]
    Empty,
    /// A character that is not a digit, a single sign or a single dot.
    #[error("el importe no es un número decimal")]
    NotDecimal,
    /// More than one dot, or a sign after the first character.
    #[error("el importe tiene un formato que no se puede leer")]
    Malformed,
    /// The value does not fit in `i64` minor units.
    #[error("el importe no cabe en el rango admitido")]
    OutOfRange,
}

/// How many decimals a currency has, which is how many digits its minor unit
/// is scaled by ten raised to. Unknown codes are assumed to have 2, like EUR.
pub fn exponent(currency: &str) -> u32 {
    let code = currency.trim().to_ascii_uppercase();
    match code.as_str() {
        // No minor unit at all.
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF" | "UGX"
        | "UYI" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        // Three decimals.
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        // Four decimals.
        "CLF" | "UYW" => 4,
        // Everything else, which is almost everything.
        _ => 2,
    }
}

/// Parse an amount into minor units of `currency`, sign included: a leading
/// `-` (or `+`) is honoured, so a debit is negative.
pub fn parse(amount: &str, currency: &str) -> Result<i64, MoneyError> {
    let text = amount.trim();
    if text.is_empty() {
        return Err(MoneyError::Empty);
    }

    let (negative, digits) = match text.as_bytes()[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    if digits.is_empty() {
        return Err(MoneyError::Empty);
    }

    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    if fraction.is_some_and(|fraction| fraction.contains('.')) {
        return Err(MoneyError::Malformed);
    }
    let fraction = fraction.unwrap_or("");
    if whole.is_empty() && fraction.is_empty() {
        return Err(MoneyError::Empty);
    }
    if !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(MoneyError::NotDecimal);
    }

    let exponent = exponent(currency);
    let kept = fraction.len().min(exponent as usize);
    // Round the part that does not fit: a first dropped digit of 5 or more
    // means the value is at least half a minor unit, and halves go away from
    // zero (`1.005` EUR → 101, `-1.005` EUR → -101).
    let round_up = fraction
        .as_bytes()
        .get(exponent as usize)
        .is_some_and(|digit| *digit >= b'5');

    // Magnitude as an unsigned integer, built digit by digit so overflow is
    // caught instead of wrapping.
    let mut magnitude: u64 = 0;
    for digit in whole
        .bytes()
        .chain(fraction[..kept].bytes())
        .chain(std::iter::repeat_n(b'0', exponent as usize - kept))
    {
        let digit = u64::from(digit - b'0');
        magnitude = magnitude
            .checked_mul(10)
            .and_then(|scaled| scaled.checked_add(digit))
            .ok_or(MoneyError::OutOfRange)?;
    }
    if round_up {
        magnitude = magnitude.checked_add(1).ok_or(MoneyError::OutOfRange)?;
    }

    // Back to a signed 64-bit value. `i64::MIN`'s magnitude is one larger than
    // `i64::MAX`, and `-9223372036854775808` fits exactly.
    let signed = if negative {
        if magnitude == i64::MAX as u64 + 1 {
            i64::MIN
        } else {
            let magnitude = i64::try_from(magnitude).map_err(|_| MoneyError::OutOfRange)?;
            -magnitude
        }
    } else {
        i64::try_from(magnitude).map_err(|_| MoneyError::OutOfRange)?
    };
    Ok(signed)
}
