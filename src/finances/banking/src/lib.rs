//! Moxen Finances banking: a read-only account-information client for Enable
//! Banking, driven with the user's OWN application.
//!
//! Enable Banking is a service Moxen Finances supports but never provides.
//! Each user registers their own application (restricted production mode,
//! individual non-commercial use, their own accounts whitelisted), keeps its
//! private key and connects their own accounts. One key never serves two
//! users. The flow is the documented account-information one:
//!
//! 1. [`Client::list_aspsps`] lists the banks of a country.
//! 2. [`Client::start_auth`] asks for a link URL and an authorization id.
//! 3. The user opens that URL in a browser; the bank sends them back to
//!    `http://127.0.0.1:<port>/callback`, which [`callback`] serves once.
//! 4. [`Client::create_session`] turns the returned code into a session and
//!    its accounts, and that response is shown ONCE: the caller persists it.
//! 5. [`Client::account_details`], [`Client::balances`] and
//!    [`Client::transactions`] read the data; [`Client::delete_session`]
//!    closes the session and with it the bank consent.
//!
//! What this crate deliberately does not do:
//!
//! - **No payments.** Only account information is implemented.
//! - **No store, no UI, no scheduler.** It produces neutral [`model`] types; a
//!   later step maps them into the Finances store.
//! - **No configuration file and no secret on disk.** The private key lives in
//!   the OS keychain through [`secrets`], and is never written to a config, a
//!   log, a database, an error message or the repository.
//! - **No real data in the tests.** Every fixture is fictional; the fake
//!   transport replays recorded shapes, not a user's bank.
//!
//! ## Composition
//!
//! The client is generic over [`Transport`] (HTTP) and [`Clock`] (the current
//! instant and sleeping) so the tests drive it with recorded responses and a
//! sleeper that never waits. [`testing`] holds those doubles.
//!
//! ```
//! use moxen_finances_banking::testing::{FakeClock, RecordedTransport};
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let transport = RecordedTransport::empty();
//! let clock = FakeClock::at(chrono::Utc::now());
//! let _ = (transport, clock);
//! # Ok(())
//! # }
//! ```

pub mod callback;
pub mod client;
pub mod clock;
pub mod dto;
pub mod error;
pub mod jwt;
pub mod model;
pub mod money;
pub mod redact;
pub mod secrets;
pub mod testing;
pub mod transport;

use std::time::Duration;

pub use callback::{CallbackError, CallbackOutcome, CallbackServer};
pub use client::{
    Authorization, Client, PsuType, RetryPolicy, SessionGrant, SessionState, StartAuth,
    TransactionWindow,
};
pub use clock::{Clock, SystemClock};
pub use error::{BankError, ConsentEnd, Result};
pub use jwt::{JwtError, JwtSigner, PrivateKey};
pub use model::{
    BankAccount, BankBalance, BankEntry, BankLink, BankRef, BankTransaction, TransactionStatus,
};
pub use secrets::{KeychainStore, MemoryStore, PrivateKeyStore, SecretError};
pub use transport::{HttpRequest, HttpResponse, Method, Transport, TransportError, UreqTransport};

/// Every call goes here. The deprecated `api.tilisy.com` is not used.
pub const API_BASE_URL: &str = "https://api.enablebanking.com";

/// The JWT lifetime this crate mints: one hour, fresh per request.
pub const JWT_TTL: Duration = Duration::from_secs(3_600);

/// The longest JWT lifetime the API accepts (24 hours). Anything longer is
/// rejected, so it is also the clamp in [`jwt::clamp_ttl`].
pub const JWT_MAX_TTL: Duration = Duration::from_secs(86_400);

/// The loopback ports a user registers as redirect URLs, tried in order while
/// linking: `http://127.0.0.1:<port>/callback` and, because some browsers
/// resolve it separately, the same with `localhost`.
pub const DEFAULT_CALLBACK_PORTS: [u16; 3] = [47_831, 47_832, 47_833];

/// How long [`callback::wait_for_redirect`] waits for the browser by default.
pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// The `User-Agent` the client sends. Identify the app, not the person.
pub const USER_AGENT: &str = concat!("moxen-finances/", env!("CARGO_PKG_VERSION"));
