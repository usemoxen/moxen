//! The crate's notion of time, injectable so a test never waits.
//!
//! Two things need the clock: the JWT's `iat`/`exp` and the consent check, and
//! the backoff between retries. Both go through [`Clock`], so
//! [`crate::testing::FakeClock`] can move the first and record the second
//! without sleeping for real.

use std::thread;
use std::time::Duration;

use chrono::{DateTime, Utc};

/// The current instant, and sleeping.
pub trait Clock: Send + Sync {
    /// Now, in UTC.
    fn now(&self) -> DateTime<Utc>;

    /// Wait for `duration`. Test clocks record it and return at once.
    fn sleep(&self, duration: Duration);
}

/// The real clock: the system time and [`thread::sleep`].
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }

    fn sleep(&self, duration: Duration) {
        // The retry policy caps its own delays well below what any platform
        // accepts, so this is a plain sleep.
        thread::sleep(duration);
    }
}
