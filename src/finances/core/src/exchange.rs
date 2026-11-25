//! Effective-dated exchange rates. Ported from the reference's
//! `src/core/exchange.ts` (8aaad15b): the rate in force on a date wins
//! (direct pair, then the inverse, then a cross through EUR); when nothing
//! is in force, the latest known rate is used and marked approximate so
//! past charges are not silently discarded.

use serde::{Deserialize, Serialize};

use crate::dates::compare_iso_dates;
use crate::money::{convert_minor, js_round};
use crate::types::{Currency, ExchangeRate};

/// The scale of a stored rate: 1 origin = rate_scaled / 1e6 destination.
pub const RATE_SCALE: i64 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLookup {
    pub rate: ExchangeRate,
    /// true si no existía un tipo vigente en la fecha y se usa el más
    /// reciente disponible.
    pub approximate: bool,
}

fn invert(rate: &ExchangeRate, from: Currency, to: Currency) -> ExchangeRate {
    // Math.round((SCALE * SCALE) / rate.rateScaled) in the reference, done
    // on the same doubles to keep identical rounding.
    let inverted = f64_to_i64(js_round(
        (RATE_SCALE as f64 * RATE_SCALE as f64) / rate.rate_scaled as f64,
    ));
    ExchangeRate {
        id: format!("inverse:{}", rate.id),
        from_currency: from,
        to_currency: to,
        rate_scaled: inverted,
        effective_from: rate.effective_from.clone(),
        source: rate.source.clone(),
        note: format!(
            "Inverso de {}",
            if rate.note.is_empty() {
                "registro"
            } else {
                &rate.note
            }
        ),
        created_at: rate.created_at.clone(),
    }
}

/// The entry with the latest `effective_from` (the reference's stable sort
/// keeps input order when two share a date).
fn latest_filter<'a, I>(rates: I) -> Option<&'a ExchangeRate>
where
    I: Iterator<Item = &'a ExchangeRate>,
{
    rates.fold(None, |best: Option<&ExchangeRate>, rate| match best {
        Some(best) => {
            if compare_iso_dates(&rate.effective_from, &best.effective_from)
                == std::cmp::Ordering::Greater
            {
                Some(rate)
            } else {
                Some(best)
            }
        }
        None => Some(rate),
    })
}

/// Looks up the exchange rate applicable on a date. Priority: a direct pair
/// in force, the inverse pair in force, a cross through EUR; if none is in
/// force on the date, the most recent available is used and marked
/// approximate, so past charges are not discarded.
pub fn find_rate_at(
    rates: &[ExchangeRate],
    from: Currency,
    to: Currency,
    date: &str,
) -> Option<RateLookup> {
    if from == to {
        return None;
    }

    let in_force = |rate: &ExchangeRate| {
        compare_iso_dates(&rate.effective_from, date) != std::cmp::Ordering::Greater
    };

    let direct = latest_filter(
        rates
            .iter()
            .filter(|r| r.from_currency == from && r.to_currency == to && in_force(r)),
    );
    if let Some(direct) = direct {
        return Some(RateLookup {
            rate: direct.clone(),
            approximate: false,
        });
    }

    let inverse = latest_filter(
        rates
            .iter()
            .filter(|r| r.from_currency == to && r.to_currency == from && in_force(r)),
    );
    if let Some(inverse) = inverse {
        return Some(RateLookup {
            rate: invert(inverse, from, to),
            approximate: false,
        });
    }

    if from != Currency::Eur && to != Currency::Eur {
        let to_eur = find_rate_at(rates, from, Currency::Eur, date);
        let eur_to = find_rate_at(rates, Currency::Eur, to, date);
        if let (Some(to_eur), Some(eur_to)) = (to_eur, eur_to) {
            return Some(RateLookup {
                rate: ExchangeRate {
                    id: format!("cross:{}:{}", to_eur.rate.id, eur_to.rate.id),
                    from_currency: from,
                    to_currency: to,
                    // Math.round((a * b) / SCALE) on doubles, like the reference.
                    rate_scaled: f64_to_i64(js_round(
                        (to_eur.rate.rate_scaled as f64 * eur_to.rate.rate_scaled as f64)
                            / RATE_SCALE as f64,
                    )),
                    effective_from: date.to_string(),
                    source: "Cruce".into(),
                    note: "Cruce calculado a través de EUR".into(),
                    created_at: String::new(),
                },
                approximate: to_eur.approximate || eur_to.approximate,
            });
        }
    }

    let direct_any = latest_filter(
        rates
            .iter()
            .filter(|r| r.from_currency == from && r.to_currency == to),
    );
    if let Some(direct_any) = direct_any {
        return Some(RateLookup {
            rate: direct_any.clone(),
            approximate: true,
        });
    }

    let inverse_any = latest_filter(
        rates
            .iter()
            .filter(|r| r.from_currency == to && r.to_currency == from),
    );
    if let Some(inverse_any) = inverse_any {
        return Some(RateLookup {
            rate: invert(inverse_any, from, to),
            approximate: true,
        });
    }

    None
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionResult {
    pub amount_minor: i64,
    pub rate_scaled: Option<i64>,
    pub rate_source: Option<String>,
    /// true si se convirtió o si es una estimación; false si el importe
    /// real ya estaba en la moneda de la cuenta.
    pub estimated: bool,
    /// true si no había tipo vigente en la fecha.
    pub approximate: bool,
}

/// Converts an amount to the account's currency. When no exchange rate is
/// available at all the unconverted amount comes back with a null rate, so
/// the projection can warn about it.
pub fn convert_to_account_currency(
    amount_minor: i64,
    from: Currency,
    account_currency: Currency,
    date: &str,
    rates: &[ExchangeRate],
) -> ConversionResult {
    if from == account_currency {
        return ConversionResult {
            amount_minor,
            rate_scaled: Some(RATE_SCALE),
            rate_source: None,
            estimated: false,
            approximate: false,
        };
    }
    match find_rate_at(rates, from, account_currency, date) {
        None => ConversionResult {
            amount_minor,
            rate_scaled: None,
            rate_source: None,
            estimated: true,
            approximate: true,
        },
        Some(lookup) => {
            // A stored rate beyond money's range cannot be applied; the
            // reference would produce a lossy double. Keep the original
            // amount so the warning system still speaks.
            let converted =
                convert_minor(amount_minor, lookup.rate.rate_scaled).unwrap_or(amount_minor);
            ConversionResult {
                amount_minor: converted,
                rate_scaled: Some(lookup.rate.rate_scaled),
                rate_source: Some(lookup.rate.source),
                estimated: true,
                approximate: lookup.approximate,
            }
        }
    }
}

fn f64_to_i64(value: f64) -> i64 {
    if !value.is_finite() || value >= 9_007_199_254_740_992.0 {
        return i64::MAX;
    }
    if value <= -9_007_199_254_740_992.0 {
        return i64::MIN;
    }
    value as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate(id: &str, from: Currency, to: Currency, scaled: i64, from_date: &str) -> ExchangeRate {
        ExchangeRate {
            id: id.into(),
            from_currency: from,
            to_currency: to,
            rate_scaled: scaled,
            effective_from: from_date.into(),
            source: "Test".into(),
            note: "Nota".into(),
            created_at: String::new(),
        }
    }

    #[test]
    fn same_currency_is_no_conversion() {
        let result =
            convert_to_account_currency(1500, Currency::Eur, Currency::Eur, "2026-11-18", &[]);
        assert_eq!(result.amount_minor, 1500);
        assert_eq!(result.rate_scaled, Some(RATE_SCALE));
        assert_eq!(result.rate_source, None);
        assert!(!result.estimated);
        assert!(!result.approximate);
    }

    #[test]
    fn direct_rate_in_force_wins() {
        let rates = vec![
            rate("r1", Currency::Usd, Currency::Eur, 800_000, "2026-10-01"),
            rate("r2", Currency::Usd, Currency::Eur, 909_091, "2026-11-01"),
        ];
        let lookup = find_rate_at(&rates, Currency::Usd, Currency::Eur, "2026-11-18").unwrap();
        assert_eq!(lookup.rate.id, "r2");
        assert!(!lookup.approximate);
    }

    #[test]
    fn inverse_rate_is_used_when_no_direct_pair() {
        let rates = vec![rate(
            "r1",
            Currency::Eur,
            Currency::Usd,
            1_100_000,
            "2026-01-01",
        )];
        let lookup = find_rate_at(&rates, Currency::Usd, Currency::Eur, "2026-11-18").unwrap();
        assert_eq!(lookup.rate.id, "inverse:r1");
        assert_eq!(lookup.rate.rate_scaled, 909_091);
        assert!(!lookup.approximate);
    }

    #[test]
    fn no_rate_in_force_falls_back_to_approximate() {
        let rates = vec![rate(
            "r1",
            Currency::Usd,
            Currency::Eur,
            909_091,
            "2026-11-01",
        )];
        let lookup = find_rate_at(&rates, Currency::Usd, Currency::Eur, "2026-10-15").unwrap();
        assert_eq!(lookup.rate.id, "r1");
        assert!(lookup.approximate);
    }

    #[test]
    fn no_rate_at_all_keeps_the_amount_and_warns() {
        let result =
            convert_to_account_currency(1200, Currency::Usd, Currency::Eur, "2026-11-18", &[]);
        assert_eq!(result.amount_minor, 1200);
        assert_eq!(result.rate_scaled, None);
        assert!(result.estimated);
        assert!(result.approximate);
    }

    #[test]
    fn converts_like_the_reference() {
        let rates = vec![rate(
            "r1",
            Currency::Usd,
            Currency::Eur,
            909_091,
            "2026-01-01",
        )];
        let result =
            convert_to_account_currency(1200, Currency::Usd, Currency::Eur, "2026-11-08", &rates);
        assert_eq!(result.amount_minor, 1091);
        assert_eq!(result.rate_source, Some("Test".into()));
        assert!(result.estimated);
        assert!(!result.approximate);
    }
}
