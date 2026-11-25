//! What can go wrong, said once, in a shape the app can act on.
//!
//! The API answers a failure with a status and an [`crate::dto::ErrorResponse`]
//! (`message`, `error` code, `detail`), and the difference between those
//! answers is the difference between "your application is not accepted"
//! ([`BankError::Unauthorized`]), "your bank consent is over, link the bank
//! again" ([`BankError::ConsentExpired`]), "slow down"
//! ([`BankError::RateLimited`]) and "that request was wrong"
//! ([`BankError::Invalid`]). Telling them apart is the whole point of the
//! enum: the app shows a settings screen for the first, a "link again" button
//! for the second, and a retry later for the third.
//!
//! Messages are in Spanish because they reach the user, like the store's. No
//! variant ever carries a token, a session id in full, an IBAN or a balance.

use std::time::Duration;

use thiserror::Error;

use crate::redact;
use crate::transport::TransportError;

/// The crate's result type.
pub type Result<T> = std::result::Result<T, BankError>;

/// Why a consent is finished, so the app can say which happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentEnd {
    /// The bank consent reached its `valid_until`.
    Expired,
    /// The user revoked the access at the bank.
    Revoked,
    /// The session was closed (deleted, or closed by the bank).
    Closed,
    /// The link expired by this crate's clock: no call needed to know.
    ValidUntilPassed,
    /// The API refused a session-scoped call with a 401 or 403 but named no
    /// reason this crate knows, so the safest reading is "link again".
    Unspecified,
}

impl ConsentEnd {
    /// A sentence the app can show, in Spanish. It points at the fix: linking
    /// the bank again, not retrying.
    pub fn explanation(self) -> &'static str {
        match self {
            ConsentEnd::Expired => {
                "el consentimiento del banco ha caducado; vincula el banco de nuevo"
            }
            ConsentEnd::Revoked => "has revocado el acceso en el banco; vincula el banco de nuevo",
            ConsentEnd::Closed => "la sesión con el banco se ha cerrado; vincula el banco de nuevo",
            ConsentEnd::ValidUntilPassed => {
                "el consentimiento del banco ha llegado a su fecha límite; vincula el banco de nuevo"
            }
            ConsentEnd::Unspecified => {
                "el banco ya no acepta esta sesión; vincula el banco de nuevo"
            }
        }
    }
}

impl std::fmt::Display for ConsentEnd {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.explanation())
    }
}

/// Every failure this crate reports.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum BankError {
    /// The API rejected the application's JWT: a wrong or empty private key,
    /// a wrong application id, a clock far from real time, or an application
    /// not activated for the services it asked for. Nothing the user can fix
    /// from inside a sync: the settings screen has to.
    #[error("Enable Banking no ha aceptado la aplicación: {message}")]
    Unauthorized {
        /// The API's `error` code, when it named one.
        code: Option<String>,
        /// The API's message, bounded and without credentials.
        message: String,
    },

    /// The session or its consent is over. The app asks the user to link the
    /// bank again instead of retrying.
    #[error("{reason}")]
    ConsentExpired {
        /// Which of the endings happened.
        reason: ConsentEnd,
    },

    /// The API (or the bank behind it) is limiting requests. `retry_after`
    /// is what the server asked for, when it said.
    #[error("Enable Banking está limitando las peticiones; inténtalo más tarde")]
    RateLimited {
        /// The `Retry-After` the server sent, if any.
        retry_after: Option<Duration>,
        /// How many attempts were made before giving up.
        attempts: u32,
    },

    /// A failure that says nothing about the request: a timeout, a 5xx, a
    /// dropped connection. Retried with backoff before this is reported.
    #[error("el servicio del banco no responde: {message}")]
    Transient {
        /// The HTTP status, when there was one.
        status: Option<u16>,
        /// A bounded description.
        message: String,
    },

    /// The request or the data was wrong: a bad date window, an unknown
    /// account, a response this crate could not read, more pages than the cap.
    #[error("la petición al banco no es válida: {message}")]
    Invalid {
        /// The API's `error` code, when it named one.
        code: Option<String>,
        /// A bounded description of what was wrong.
        message: String,
    },

    /// No response at all: DNS, TLS, connection, timeout.
    #[error("no se pudo conectar con Enable Banking: {0}")]
    Transport(#[from] TransportError),

    /// The JWT could not be signed. A key the import accepted does not start
    /// failing later, so this is a corrupted keychain entry, not a bad day.
    #[error("no se pudo firmar el token de Enable Banking: {0}")]
    Signing(#[from] crate::jwt::JwtError),
}

impl BankError {
    /// Whether the app should offer "link the bank again" rather than a retry.
    pub fn needs_link_again(&self) -> bool {
        matches!(self, BankError::ConsentExpired { .. })
    }

    /// Whether trying the same call again, later, could work.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            BankError::RateLimited { .. } | BankError::Transient { .. }
        )
    }

    /// What the server asked to wait, if it said.
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            BankError::RateLimited { retry_after, .. } => *retry_after,
            _ => None,
        }
    }

    /// A 401 or 403 that names no session code: the two meanings are "the
    /// application is not accepted" and "this session is over", and only the
    /// caller knows which call it was. This builds the first.
    pub(crate) fn unauthorized(code: Option<&str>, message: &str) -> Self {
        BankError::Unauthorized {
            code: code.map(str::to_string),
            message: redact::clip(message),
        }
    }

    /// [`BankError::unauthorized`] for the second.
    pub(crate) fn consent_expired(reason: ConsentEnd) -> Self {
        BankError::ConsentExpired { reason }
    }

    /// An unreadable or refused request.
    pub(crate) fn invalid(code: Option<&str>, message: impl Into<String>) -> Self {
        BankError::Invalid {
            code: code.map(str::to_string),
            message: redact::clip(&message.into()),
        }
    }
}
