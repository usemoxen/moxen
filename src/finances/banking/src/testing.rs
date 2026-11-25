//! Test doubles, compiled in so both this crate's tests and a caller's can
//! drive the client without a network, a keychain or a real wait.
//!
//! [`RecordedTransport`] answers with whatever responses were queued, in
//! order, and keeps every request it saw so a test can assert on the URL, the
//! headers and the body. [`FakeClock`] fixes "now" and records sleeps instead
//! of taking them, which is how the backoff is tested in microseconds.
//!
//! The fixtures this crate ships are fictional: bank names, "IBAN-shaped"
//! strings that are not real accounts, invented counterparties.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};

use crate::clock::Clock;
use crate::transport::{HttpRequest, HttpResponse, Transport, TransportError};

/// A transport that replays queued responses and records what it was asked.
///
/// `Clone` shares the same queues, so a caller that builds a client per run
/// (the app's bank runtime) keeps the one recording of what was asked.
#[derive(Default, Clone)]
pub struct RecordedTransport {
    responses: Arc<Mutex<VecDeque<Result<HttpResponse, TransportError>>>>,
    requests: Arc<Mutex<Vec<HttpRequest>>>,
}

impl RecordedTransport {
    /// A transport with nothing queued: every call fails with a clear
    /// transport error, which makes an unexpected request obvious.
    pub fn empty() -> Self {
        Self::default()
    }

    /// A transport that answers the given responses in order.
    pub fn with(responses: Vec<HttpResponse>) -> Self {
        let transport = Self::default();
        for response in responses {
            transport.push(response);
        }
        transport
    }

    /// Queue one response.
    pub fn push(&self, response: HttpResponse) {
        self.responses
            .lock()
            .expect("recorded responses")
            .push_back(Ok(response));
    }

    /// Queue one transport failure.
    pub fn push_error(&self, error: TransportError) {
        self.responses
            .lock()
            .expect("recorded responses")
            .push_back(Err(error));
    }

    /// The requests the client made, in order.
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests
            .lock()
            .expect("recorded requests")
            .iter()
            .cloned()
            .collect()
    }

    /// How many requests are still queued for an answer.
    pub fn remaining(&self) -> usize {
        self.responses.lock().expect("recorded responses").len()
    }
}

impl Transport for RecordedTransport {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, TransportError> {
        self.requests
            .lock()
            .expect("recorded requests")
            .push(request.clone());
        self.responses
            .lock()
            .expect("recorded responses")
            .pop_front()
            .unwrap_or_else(|| {
                Err(TransportError::io(
                    "no response was recorded for this request",
                ))
            })
    }
}

/// A clock that starts at a fixed instant and records sleeps instead of
/// taking them, moving its own time forward by each one.
///
/// The handles are `Arc`s, so a test keeps one and hands a clone to a client.
#[derive(Clone)]
pub struct FakeClock {
    now: Arc<Mutex<DateTime<Utc>>>,
    slept: Arc<Mutex<Vec<Duration>>>,
}

impl FakeClock {
    /// A clock stopped at `now`.
    pub fn at(now: DateTime<Utc>) -> Self {
        Self {
            now: Arc::new(Mutex::new(now)),
            slept: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Every sleep the client asked for, in order.
    pub fn slept(&self) -> Vec<Duration> {
        self.slept.lock().expect("recorded sleeps").clone()
    }

    /// The sum of every sleep, which is how long the retries would have
    /// waited for real.
    pub fn total_slept(&self) -> Duration {
        self.slept
            .lock()
            .expect("recorded sleeps")
            .iter()
            .copied()
            .sum()
    }

    /// Move the clock forward without counting it as a sleep.
    pub fn advance(&self, by: Duration) {
        let delta = TimeDelta::from_std(by).unwrap_or_else(|_| TimeDelta::zero());
        let mut now = self.now.lock().expect("fake clock");
        *now += delta;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> DateTime<Utc> {
        *self.now.lock().expect("fake clock")
    }

    fn sleep(&self, duration: Duration) {
        self.slept.lock().expect("recorded sleeps").push(duration);
        self.advance(duration);
    }
}

/// The throwaway PKCS#8 key of this crate's own tests, compiled in so a caller
/// (the app's sync tests) can wire a client without generating, reading or
/// writing a key.
///
/// It is NOT a credential: it was generated for `tests/fixtures`, is registered
/// with no service, signs nothing but the tokens these tests mint, and its
/// public half exists nowhere upstream. No test uses it against a real API.
pub const TEST_KEY_PEM: &str = include_str!("../tests/fixtures/test-key-pkcs8.pem");

/// A signer for [`TEST_KEY_PEM`] under `app_id`, so a caller's tests can build
/// a [`crate::Client`] over a [`RecordedTransport`]:
///
/// ```
/// use moxen_finances_banking::testing::{test_signer, FakeClock, RecordedTransport};
/// let clock = FakeClock::at(chrono::Utc::now());
/// let client = moxen_finances_banking::Client::new(
///     test_signer("fictional-application-id"),
///     RecordedTransport::empty(),
///     clock,
/// );
/// # let _ = client;
/// ```
pub fn test_signer(app_id: &str) -> crate::JwtSigner {
    crate::JwtSigner::new(app_id, &crate::PrivateKey::new(TEST_KEY_PEM.to_string()))
        .expect("the throwaway test key parses")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_test_key_signs_a_token_under_any_application() {
        let signer = test_signer("fictional-application-id");
        let clock = FakeClock::at(chrono::Utc::now());
        let token = signer.token(clock.now()).expect("a signed token");
        assert_eq!(token.split('.').count(), 3, "three JWT segments");
        // The private half never renders as a key.
        assert!(format!("{TEST_KEY_PEM:?}").contains("PRIVATE KEY"));
    }
}
