//! Moxen Finances core: the pure domain logic ported from the TypeScript
//! reference at 8aaad15b. No UI, no I/O, no SQLite — money stays in
//! integer minor units and dates are calendar days in Europe/Madrid.
//! The behavior is pinned to the reference by the golden test vectors
//! under `tests/vectors/`.

pub mod accounts;
pub mod dates;
pub mod exchange;
pub mod money;
pub mod projection;
pub mod recurrence;
pub mod stats;
pub mod types;

pub use accounts::*;
pub use dates::*;
pub use exchange::*;
pub use money::*;
pub use projection::*;
pub use recurrence::*;
pub use stats::*;
pub use types::*;

use std::fmt;

/// The errors the reference throws, as values: an unparseable date where
/// a valid one is required, a non-positive exchange rate, or a conversion
/// that would not fit money's integer minor units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    InvalidDate(String),
    InvalidRate(i64),
    AmountOutOfRange,
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::InvalidDate(date) => write!(f, "Fecha no válida: {date}"),
            CoreError::InvalidRate(rate) => write!(f, "Tipo de cambio no válido: {rate}"),
            CoreError::AmountOutOfRange => {
                write!(f, "Importe fuera de rango para unidades menores")
            }
        }
    }
}

impl std::error::Error for CoreError {}
