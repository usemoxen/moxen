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
//! Every sentence exists in English and Spanish ([`Localized`]); `Display`
//! gives the English one. No variant ever carries a token, a session id in
//! full, an IBAN or a balance.

use std::time::Duration;

use thiserror::Error;

use crate::redact;
use crate::text::{Context, Language, Localized};
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

impl Localized for ConsentEnd {
    /// A sentence that points at the fix: linking the bank again, not
    /// retrying.
    fn localized(&self, language: Language) -> String {
        match self {
            ConsentEnd::Expired => language.pick(
                "the bank consent has expired; link the bank again",
                "el consentimiento del banco ha caducado; vincula el banco de nuevo",
            ),
            ConsentEnd::Revoked => language.pick(
                "you revoked the access at the bank; link the bank again",
                "has revocado el acceso en el banco; vincula el banco de nuevo",
            ),
            ConsentEnd::Closed => language.pick(
                "the session with the bank was closed; link the bank again",
                "la sesión con el banco se ha cerrado; vincula el banco de nuevo",
            ),
            ConsentEnd::ValidUntilPassed => language.pick(
                "the bank consent reached its deadline; link the bank again",
                "el consentimiento del banco ha llegado a su fecha límite; vincula el banco de nuevo",
            ),
            ConsentEnd::Unspecified => language.pick(
                "the bank no longer accepts this session; link the bank again",
                "el banco ya no acepta esta sesión; vincula el banco de nuevo",
            ),
        }
        .to_string()
    }
}

impl ConsentEnd {
    /// The English sentence, which `Display` shows.
    pub fn explanation(self) -> String {
        self.english()
    }
}

impl std::fmt::Display for ConsentEnd {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.english())
    }
}

/// Why a request or an answer was refused, in a shape both languages can
/// render. The API's own description is kept verbatim
/// ([`InvalidReason::Api`]); everything this crate decides itself is a typed
/// reason, so no sentence is Spanish-only any more.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidReason {
    /// The country was not a two-letter ISO 3166 code.
    CountryCode,
    /// The authorization carried no `state`.
    MissingState,
    /// The `state` is longer than the API accepts.
    StateTooLong,
    /// The redirect URL was not one of this crate's loopback addresses.
    RedirectUrl,
    /// No bank was named to link.
    MissingBank,
    /// The requested consent deadline had already passed.
    ConsentDeadlinePassed,
    /// The PSU language was not a two-letter code.
    LanguageCode,
    /// The callback carried no authorization code.
    MissingCode,
    /// An id (a session's, an account's) was empty.
    MissingContext(Context),
    /// An id was longer than this crate accepts.
    ContextTooLong(Context),
    /// The transaction window ended before it started.
    PeriodBackwards,
    /// The bank has more pages of movements than the cap allows.
    PageCapExceeded(u32),
    /// The bank repeated a continuation key, so there is no last page.
    ContinuationRepeated,
    /// The request could not be prepared (a body that would not serialize).
    RequestUnreadable(String),
    /// An answer was not the JSON shape this crate reads.
    ResponseUnreadable(String),
    /// A balance in an answer could not be read.
    BalanceUnreadable(String),
    /// An amount in an answer could not be read.
    AmountUnreadable(String),
    /// A transaction in an answer names no currency.
    MissingCurrency,
    /// A transaction in an answer carries no usable date.
    MissingDate,
    /// The service's own description of a bad request, kept verbatim.
    Api(String),
}

impl Localized for InvalidReason {
    fn localized(&self, language: Language) -> String {
        match self {
            InvalidReason::CountryCode => language
                .pick(
                    "the country has to be a two-letter ISO code, for example ES",
                    "el país tiene que ser un código ISO de dos letras, por ejemplo ES",
                )
                .to_string(),
            InvalidReason::MissingState => language
                .pick(
                    "the authorization has no state",
                    "falta el state de la autorización",
                )
                .to_string(),
            InvalidReason::StateTooLong => language
                .pick("the state is too long", "el state es demasiado largo")
                .to_string(),
            InvalidReason::RedirectUrl => language.pick(
                "the bank's return address has to be a local address \
                 (http://127.0.0.1:<port>/callback or http://localhost:<port>/callback)",
                "la vuelta del banco tiene que ser una dirección local \
                 (http://127.0.0.1:<puerto>/callback o http://localhost:<puerto>/callback)",
            ),
            InvalidReason::MissingBank => language.pick(
                "no bank was named to link",
                "falta el banco al que vincular",
            ),
            InvalidReason::ConsentDeadlinePassed => language.pick(
                "the consent deadline has already passed",
                "la fecha límite del consentimiento ya ha pasado",
            ),
            InvalidReason::LanguageCode => language.pick(
                "the language has to be a two-letter code, for example es",
                "el idioma tiene que ser un código de dos letras, por ejemplo es",
            ),
            InvalidReason::MissingCode => language.pick(
                "the authorization code is missing",
                "falta el código de autorización",
            ),
            InvalidReason::MissingContext(context) => match language {
                Language::English => format!("the id of {} is missing", context.english()),
                Language::Spanish => format!("falta el identificador de {}", context.spanish()),
            },
            InvalidReason::ContextTooLong(context) => match language {
                Language::English => format!("the id of {} is too long", context.english()),
                Language::Spanish => {
                    format!(
                        "el identificador de {} es demasiado largo",
                        context.spanish()
                    )
                }
            },
            InvalidReason::PeriodBackwards => language.pick(
                "the transaction window ends before it starts",
                "el periodo de movimientos termina antes de empezar",
            ),
            InvalidReason::PageCapExceeded(pages) => format!(
                "{} {pages} {}",
                language.pick("the bank has more than", "el banco tiene más de"),
                language.pick(
                    "pages of movements in this period; shorten the dates",
                    "páginas de movimientos en este periodo; acorta las fechas",
                )
            ),
            InvalidReason::ContinuationRepeated => language.pick(
                "the bank repeated the continuation key, so there is no last page",
                "el banco repitió la clave de continuación, así que no hay última página",
            ),
            InvalidReason::RequestUnreadable(detail) => format!(
                "{} {detail}",
                language.pick(
                    "the request could not be prepared:",
                    "no se pudo preparar la petición:"
                )
            ),
            InvalidReason::ResponseUnreadable(detail) => format!(
                "{} {detail}",
                language.pick(
                    "the bank's answer could not be read:",
                    "la respuesta del banco no se pudo leer:"
                )
            ),
            InvalidReason::BalanceUnreadable(detail) => format!(
                "{} {detail}",
                language.pick(
                    "a bank balance could not be read:",
                    "un saldo del banco no se pudo leer:"
                )
            ),
            InvalidReason::AmountUnreadable(detail) => format!(
                "{} {detail}",
                language.pick(
                    "a bank amount could not be read:",
                    "un importe del banco no se pudo leer:"
                )
            ),
            InvalidReason::MissingCurrency => language
                .pick(
                    "a bank transaction does not say its currency",
                    "una transacción del banco no indica su moneda",
                )
                .to_string(),
            InvalidReason::MissingDate => language
                .pick(
                    "a bank transaction carries no date",
                    "una transacción del banco no trae ninguna fecha",
                )
                .to_string(),
            InvalidReason::Api(description) => description.clone(),
        }
    }
}

impl InvalidReason {
    /// The reason the API itself gave, kept verbatim.
    pub fn api(description: impl Into<String>) -> Self {
        InvalidReason::Api(redact::clip(&description.into()))
    }
}

impl std::fmt::Display for InvalidReason {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.english())
    }
}

/// Every failure this crate reports.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum BankError {
    /// The API rejected the application's JWT: a wrong or empty private key,
    /// a wrong application id, a clock far from real time, or an application
    /// not activated for the services it asked for. Nothing the user can fix
    /// from inside a sync: the settings screen has to.
    #[error("Enable Banking did not accept the application: {message}")]
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
    #[error("Enable Banking is limiting requests; try again later")]
    RateLimited {
        /// The `Retry-After` the server sent, if any.
        retry_after: Option<Duration>,
        /// How many attempts were made before giving up.
        attempts: u32,
    },

    /// A failure that says nothing about the request: a timeout, a 5xx, a
    /// dropped connection. Retried with backoff before this is reported.
    #[error("the bank's service is not answering: {message}")]
    Transient {
        /// The HTTP status, when there was one.
        status: Option<u16>,
        /// A bounded description.
        message: String,
    },

    /// The request or the data was wrong: a bad date window, an unknown
    /// account, a response this crate could not read, more pages than the cap.
    #[error("the request to the bank is not valid: {reason}")]
    Invalid {
        /// The API's `error` code, when it named one.
        code: Option<String>,
        /// What was wrong, in a shape both languages render.
        reason: InvalidReason,
    },

    /// No response at all: DNS, TLS, connection, timeout.
    #[error("could not reach Enable Banking: {0}")]
    Transport(#[from] TransportError),

    /// The JWT could not be signed. A key the import accepted does not start
    /// failing later, so this is a corrupted keychain entry, not a bad day.
    #[error("the Enable Banking token could not be signed: {0}")]
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

    /// An unreadable or refused request this crate decided on itself.
    pub(crate) fn invalid(reason: InvalidReason) -> Self {
        BankError::Invalid { code: None, reason }
    }

    /// A bad request the API described in its own words.
    pub(crate) fn invalid_api(code: Option<&str>, description: &str) -> Self {
        BankError::Invalid {
            code: code.map(str::to_string),
            reason: InvalidReason::api(description),
        }
    }
}

impl Localized for BankError {
    fn localized(&self, language: Language) -> String {
        match self {
            BankError::Unauthorized { message, .. } => format!(
                "{} {message}",
                language.pick(
                    "Enable Banking did not accept the application:",
                    "Enable Banking no ha aceptado la aplicación:"
                )
            ),
            BankError::ConsentExpired { reason } => reason.localized(language),
            BankError::RateLimited { .. } => language
                .pick(
                    "Enable Banking is limiting requests; try again later",
                    "Enable Banking está limitando las peticiones; inténtalo más tarde",
                )
                .to_string(),
            BankError::Transient { message, .. } => format!(
                "{} {message}",
                language.pick(
                    "the bank's service is not answering:",
                    "el servicio del banco no responde:"
                )
            ),
            BankError::Invalid { reason, .. } => format!(
                "{} {}",
                language.pick(
                    "the request to the bank is not valid:",
                    "la petición al banco no es válida:"
                ),
                reason.localized(language)
            ),
            BankError::Transport(transport) => format!(
                "{} {transport}",
                language.pick(
                    "could not reach Enable Banking:",
                    "no se pudo conectar con Enable Banking:"
                )
            ),
            BankError::Signing(error) => format!(
                "{} {}",
                language.pick(
                    "the Enable Banking token could not be signed:",
                    "no se pudo firmar el token de Enable Banking:"
                ),
                error.localized(language)
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_reason() -> Vec<InvalidReason> {
        vec![
            InvalidReason::CountryCode,
            InvalidReason::MissingState,
            InvalidReason::StateTooLong,
            InvalidReason::RedirectUrl,
            InvalidReason::MissingBank,
            InvalidReason::ConsentDeadlinePassed,
            InvalidReason::LanguageCode,
            InvalidReason::MissingCode,
            InvalidReason::MissingContext(Context::Session),
            InvalidReason::MissingContext(Context::Account),
            InvalidReason::ContextTooLong(Context::Session),
            InvalidReason::ContextTooLong(Context::Account),
            InvalidReason::PeriodBackwards,
            InvalidReason::PageCapExceeded(25),
            InvalidReason::ContinuationRepeated,
            InvalidReason::RequestUnreadable("body".into()),
            InvalidReason::ResponseUnreadable("shape".into()),
            InvalidReason::BalanceUnreadable("amount".into()),
            InvalidReason::AmountUnreadable("currency".into()),
            InvalidReason::MissingCurrency,
            InvalidReason::MissingDate,
        ]
    }

    #[test]
    fn every_invalid_reason_has_both_languages() {
        for reason in every_reason() {
            let english = reason.localized(Language::English);
            let spanish = reason.localized(Language::Spanish);
            assert!(!english.is_empty(), "{reason:?} has no English");
            assert!(!spanish.is_empty(), "{reason:?} has no Spanish");
            assert_ne!(english, spanish, "{reason:?} is not translated");
            assert_eq!(reason.english(), english, "{reason:?} Display is English");
        }
    }

    #[test]
    fn the_apis_own_description_is_kept_verbatim() {
        let reason = InvalidReason::api("date_from can not be in the future");
        assert_eq!(
            reason.localized(Language::Spanish),
            "date_from can not be in the future",
            "the service words its own message"
        );
        assert_eq!(reason.english(), "date_from can not be in the future");
    }

    #[test]
    fn the_id_messages_name_the_context_in_each_language() {
        let missing = InvalidReason::MissingContext(Context::Session);
        assert_eq!(
            missing.localized(Language::English),
            "the id of the session is missing"
        );
        assert_eq!(
            missing.localized(Language::Spanish),
            "falta el identificador de la sesión"
        );
        let too_long = InvalidReason::ContextTooLong(Context::Account);
        assert_eq!(
            too_long.localized(Language::English),
            "the id of the account is too long"
        );
        assert_eq!(
            too_long.localized(Language::Spanish),
            "el identificador de la cuenta es demasiado largo"
        );
    }

    #[test]
    fn the_page_cap_message_carries_the_cap_in_both_languages() {
        let reason = InvalidReason::PageCapExceeded(25);
        assert!(
            reason.localized(Language::English).contains("25"),
            "{}",
            reason.english()
        );
        assert!(
            reason.localized(Language::Spanish).contains("25"),
            "{}",
            reason.localized(Language::Spanish)
        );
    }

    #[test]
    fn consent_endings_point_at_linking_again_in_both_languages() {
        for ending in [
            ConsentEnd::Expired,
            ConsentEnd::Revoked,
            ConsentEnd::Closed,
            ConsentEnd::ValidUntilPassed,
            ConsentEnd::Unspecified,
        ] {
            assert!(
                ending.english().contains("link the bank again"),
                "{ending:?}: {}",
                ending.english()
            );
            assert!(
                ending
                    .localized(Language::Spanish)
                    .contains("vincula el banco de nuevo"),
                "{ending:?}: {}",
                ending.localized(Language::Spanish)
            );
            // Display is the English sentence now.
            assert_eq!(ending.to_string(), ending.english());
        }
    }

    #[test]
    fn every_bank_error_has_both_languages_and_an_english_display() {
        let errors = [
            BankError::Unauthorized {
                code: Some("ACCESS_DENIED".into()),
                message: "denied".into(),
            },
            BankError::ConsentExpired {
                reason: ConsentEnd::Expired,
            },
            BankError::RateLimited {
                retry_after: Some(Duration::from_secs(3)),
                attempts: 2,
            },
            BankError::Transient {
                status: Some(500),
                message: "boom".into(),
            },
            BankError::Invalid {
                code: Some("DATE_FROM_IN_FUTURE".into()),
                reason: InvalidReason::api("date_from can not be in the future"),
            },
            BankError::Transport(TransportError::io("connection reset")),
        ];
        for error in errors {
            let english = error.localized(Language::English);
            let spanish = error.localized(Language::Spanish);
            assert!(!english.is_empty(), "{error:?}");
            assert_ne!(english, spanish, "{error:?} is not translated");
            assert_eq!(
                error.to_string(),
                english,
                "{error:?} Display is the English sentence"
            );
        }
    }
}
