//! Moxen Finances core: the pure domain logic ported from the TypeScript
//! reference at 8aaad15b. No UI, no I/O, no SQLite — money stays in
//! integer minor units and dates are calendar days in Europe/Madrid.
//! The behavior is pinned to the reference by the golden test vectors
//! under `tests/vectors/`.

pub mod types;

pub use types::*;
