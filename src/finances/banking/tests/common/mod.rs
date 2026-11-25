//! What every test in this crate needs: the fictional fixtures, a signer built
//! from the throwaway key, and a client wired to the recorded transport and
//! the fake clock.
//!
//! Nothing here talks to a network or to a keychain, and no test reads a real
//! application id, a real key or real account data.

#![allow(dead_code)]

use std::path::PathBuf;

use chrono::{DateTime, TimeZone, Utc};
use moxen_finances_banking::testing::{FakeClock, RecordedTransport};
use moxen_finances_banking::{
    Client, HttpResponse, JwtSigner, PrivateKey, RetryPolicy, SystemClock,
};

/// The application id every test signs with. Invented, and not shaped like a
/// real one so it cannot be mistaken for somebody's application.
pub const APP_ID: &str = "fictional-application-id";

/// A fixed instant, so a token's `iat`/`exp` and a consent deadline are
/// comparable across runs.
pub fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 20, 9, 0, 0)
        .single()
        .expect("a valid instant")
}

/// A `tests/fixtures` file, read as text. The path is built with `PathBuf`, so
/// it works on Windows too.
pub fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("fixture {} could not be read: {error}", path.display()))
}

/// The throwaway PKCS#8 key of these tests.
pub fn key_pem() -> String {
    fixture("test-key-pkcs8.pem")
}

/// The signer every client uses.
pub fn signer() -> JwtSigner {
    JwtSigner::new(APP_ID, &PrivateKey::new(key_pem())).expect("the test key parses")
}

/// A 200 response with a fixture body.
pub fn ok(response: &str) -> HttpResponse {
    HttpResponse::new(200, fixture(response))
}

/// A client over a recorded transport and a fake clock, with the default retry
/// policy unless a test changes it.
pub fn client(
    transport: RecordedTransport,
    clock: &FakeClock,
) -> Client<RecordedTransport, FakeClock> {
    Client::new(signer(), transport, clock.clone())
}

/// A client with a shorter backoff, so a test that asserts the delays is not
/// also asserting the default policy.
pub fn client_with_policy(
    transport: RecordedTransport,
    clock: &FakeClock,
    policy: RetryPolicy,
) -> Client<RecordedTransport, FakeClock> {
    Client::new(signer(), transport, clock.clone()).with_policy(policy)
}

/// A client over the real clock, for the one test that wants it.
pub fn client_with_system_clock() -> Client<RecordedTransport, SystemClock> {
    Client::new(signer(), RecordedTransport::empty(), SystemClock)
}

/// A transport error with a message, for the retry tests.
pub fn transport_error() -> moxen_finances_banking::TransportError {
    moxen_finances_banking::TransportError::io("connection reset by peer")
}

/// Share a fake clock with a client, since `Client` takes it by value.
pub fn shared_clock() -> FakeClock {
    FakeClock::at(now())
}
