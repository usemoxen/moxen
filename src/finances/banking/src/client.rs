//! The account-information client: nine calls, all read-only, all with the
//! user's own application.
//!
//! Every call mints a fresh JWT, sends it as the bearer token, and maps the
//! answer to either a neutral shape from [`crate::model`] or a
//! [`BankError`]. Two policies are built in:
//!
//! - **Retries** are bounded and only for failures that can be retried: a 429
//!   (honouring `Retry-After`) and a 408/5xx or a dropped connection. The
//!   delays are exponential and capped, and they go through [`Clock`], so the
//!   tests run them in microseconds.
//! - **Consent** is checked in two places: the API's own answer (a session
//!   that expired, was revoked or was closed) and [`Client::check_consent`]
//!   against the `valid_until` the caller kept. Both produce
//!   [`BankError::ConsentExpired`], which the app answers with "link the bank
//!   again", never with a retry.

use std::fmt;
use std::time::Duration;

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::clock::Clock;
use crate::dto::{
    Access, AspspData, AspspRef, AspspsResponse, AuthorizeSessionResponse, BalancesResponse,
    ErrorResponse, GetSessionResponse, SessionRequest, StartAuthRequest, StartAuthResponse,
    TransactionsResponse, parse_instant,
};
use crate::jwt::JwtSigner;
use crate::model::{BankAccount, BankBalance, BankEntry, BankLink, BankRef, BankTransaction};
use crate::redact;
use crate::transport::{HttpRequest, HttpResponse, Method, Transport};
use crate::{API_BASE_URL, USER_AGENT};

// The error enum and its result alias, re-exported from the crate root as
// well, so a caller can name either path.
use crate::error::{BankError, ConsentEnd, Result};

/// The default cap on how many pages one transaction call follows. A month of
/// a busy account fits well inside it; more means a narrower date window is
/// the right answer, not a longer sync.
pub const DEFAULT_PAGE_CAP: u32 = 25;

/// How many attempts a call makes, and how long it waits between them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Total attempts, the first one included. 1 disables retrying.
    pub max_attempts: u32,
    /// The wait after the first failed attempt; doubled on each further one.
    pub base_delay: Duration,
    /// The ceiling for any single wait, `Retry-After` included.
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(20),
        }
    }
}

impl RetryPolicy {
    /// The wait before the attempt after `attempt` failed: the server's
    /// `Retry-After` when it sent one, otherwise `base_delay` doubled per
    /// attempt, either way capped at [`RetryPolicy::max_delay`].
    pub fn delay(&self, attempt: u32, retry_after: Option<Duration>) -> Duration {
        if let Some(retry_after) = retry_after {
            return retry_after.min(self.max_delay);
        }
        let doublings = attempt.saturating_sub(1).min(16);
        let delay = self
            .base_delay
            .checked_mul(1u32 << doublings)
            .unwrap_or(self.max_delay);
        delay.min(self.max_delay)
    }
}

/// Which kind of call failed, which is half of what tells an application
/// problem from an expired consent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    /// `/aspsps`, `/auth`, `POST /sessions`: the application talks about
    /// itself, so a 401 is about its key or its status.
    Application,
    /// `/sessions/{id}` and `/accounts/...`: the session is the credential,
    /// so a 401 or 403 means the link is over.
    Session,
}

/// Which PSU type the bank should show a login for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PsuType {
    /// A personal account, which is what a Finances user has.
    Private,
    /// A business account.
    Business,
}

impl PsuType {
    /// The wire value.
    pub fn as_str(self) -> &'static str {
        match self {
            PsuType::Private => "private",
            PsuType::Business => "business",
        }
    }
}

/// What to authorize: the bank, the state, where to come back to.
#[derive(Debug, Clone)]
pub struct StartAuth {
    /// The bank, as `/aspsps` named it.
    pub bank: BankRef,
    /// Ours, echoed back on the redirect and checked there in constant time.
    pub state: String,
    /// A loopback URL this crate serves, e.g. `http://127.0.0.1:47831/callback`.
    pub redirect_url: String,
    /// Personal or business.
    pub psu_type: PsuType,
    /// A two-letter lowercase language code, when the bank supports one.
    pub language: Option<String>,
    /// When the consent should stop. The bank may grant less.
    pub valid_until: Option<DateTime<Utc>>,
}

impl StartAuth {
    /// A personal-account authorization for a loopback redirect.
    pub fn new(bank: BankRef, state: impl Into<String>, redirect_url: impl Into<String>) -> Self {
        Self {
            bank,
            state: state.into(),
            redirect_url: redirect_url.into(),
            psu_type: PsuType::Private,
            language: None,
            valid_until: None,
        }
    }
}

/// The answer to `start_auth`: open `url` in the browser.
#[derive(Clone, PartialEq, Eq)]
pub struct Authorization {
    /// Where the user has to log in.
    pub url: String,
    /// The authorization id: names the attempt, not the session.
    pub authorization_id: String,
    /// A hash of the PSU id the API uses to match attempts.
    pub psu_id_hash: Option<String>,
}

impl fmt::Debug for Authorization {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Authorization")
            .field("url", &redact::mask_url(&self.url))
            .field("authorization_id", &redact::mask(&self.authorization_id))
            .field(
                "psu_id_hash",
                &self.psu_id_hash.as_deref().map(redact::mask),
            )
            .finish()
    }
}

/// The answer to `create_session`: the session and the accounts it grants.
///
/// Part of this is shown ONCE by the API, so the caller persists what it needs
/// right away; [`SessionGrant::into_link`] builds the [`BankLink`] to keep.
#[derive(Clone)]
pub struct SessionGrant {
    /// The session id every later call uses.
    pub session_id: String,
    /// The accounts the user allowed, with their details.
    pub accounts: Vec<BankAccount>,
    /// The bank, when the API repeated it.
    pub bank: Option<BankRef>,
    /// When the consent the bank granted stops.
    pub consent_valid_until: Option<DateTime<Utc>>,
}

impl SessionGrant {
    /// The link to persist, or `None` when the API left out the bank or the
    /// consent deadline, in which case there is nothing durable to keep.
    pub fn into_link(self, linked_at: DateTime<Utc>) -> Option<BankLink> {
        Some(BankLink {
            session_id: self.session_id,
            bank: self.bank?,
            account_uids: self
                .accounts
                .iter()
                .map(|account| account.uid.clone())
                .collect(),
            consent_valid_until: self.consent_valid_until?,
            linked_at,
        })
    }
}

impl fmt::Debug for SessionGrant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionGrant")
            .field("session_id", &redact::mask(&self.session_id))
            .field("accounts", &self.accounts)
            .field("bank", &self.bank)
            .field("consent_valid_until", &self.consent_valid_until)
            .finish()
    }
}

/// What `get_session` says about a link.
#[derive(Clone)]
pub struct SessionState {
    /// The session id.
    pub session_id: String,
    /// The API's status: `AUTHORIZED`, `REVOKED`, ...
    pub status: Option<String>,
    /// The account uids in the session.
    pub accounts: Vec<String>,
    /// The bank.
    pub bank: Option<BankRef>,
    /// When the consent stops.
    pub consent_valid_until: Option<DateTime<Utc>>,
    /// When the user authorized it.
    pub authorized: Option<DateTime<Utc>>,
}

impl fmt::Debug for SessionState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionState")
            .field("session_id", &redact::mask(&self.session_id))
            .field("status", &self.status)
            .field(
                "accounts",
                &self
                    .accounts
                    .iter()
                    .map(|uid| redact::mask(uid))
                    .collect::<Vec<_>>(),
            )
            .field("bank", &self.bank)
            .field("consent_valid_until", &self.consent_valid_until)
            .field("authorized", &self.authorized)
            .finish()
    }
}

/// The date window one `transactions` call reads, and how many pages it may
/// follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransactionWindow {
    /// The first day, included.
    pub from: NaiveDate,
    /// The last day, included.
    pub to: NaiveDate,
    /// The most pages to follow before giving up.
    pub page_cap: u32,
}

impl TransactionWindow {
    /// A window from `from` to `to`, inclusive, with
    /// [`DEFAULT_PAGE_CAP`] pages.
    pub fn new(from: NaiveDate, to: NaiveDate) -> Self {
        Self {
            from,
            to,
            page_cap: DEFAULT_PAGE_CAP,
        }
    }

    /// The same window with another page cap.
    pub fn with_page_cap(mut self, page_cap: u32) -> Self {
        self.page_cap = page_cap.max(1);
        self
    }
}

/// The client. Generic over the transport and the clock so the tests drive it
/// with recorded responses and a sleeper that never waits.
pub struct Client<T: Transport, C: Clock> {
    transport: T,
    signer: JwtSigner,
    base_url: String,
    policy: RetryPolicy,
    clock: C,
}

impl<T: Transport, C: Clock> Client<T, C> {
    /// A client for `signer`'s application, over `transport`, reading the
    /// time from `clock`.
    pub fn new(signer: JwtSigner, transport: T, clock: C) -> Self {
        Self {
            transport,
            signer,
            base_url: API_BASE_URL.to_string(),
            policy: RetryPolicy::default(),
            clock,
        }
    }

    /// Another base URL, for a test or a proxy.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into().trim_end_matches('/').to_string();
        self
    }

    /// Another retry policy.
    pub fn with_policy(mut self, policy: RetryPolicy) -> Self {
        self.policy = policy;
        self
    }

    /// The clock this client reads.
    pub fn clock(&self) -> &C {
        &self.clock
    }

    /// The transport this client drives.
    pub fn transport(&self) -> &T {
        &self.transport
    }

    /// The retry policy in force.
    pub fn policy(&self) -> RetryPolicy {
        self.policy
    }

    // ---- account information -------------------------------------------

    /// `GET /aspsps`: the banks of one country, with the metadata a picker
    /// and a link flow need.
    pub fn list_aspsps(&self, country: &str) -> Result<Vec<BankEntry>> {
        let country = country.trim().to_ascii_uppercase();
        if country.len() != 2
            || !country
                .chars()
                .all(|character| character.is_ascii_alphabetic())
        {
            return Err(BankError::invalid(
                None,
                "el país tiene que ser un código ISO de dos letras, por ejemplo ES",
            ));
        }
        let path = format!("/aspsps?country={}", encode(&country));
        let response = self.send(Method::Get, &path, None::<&()>, Scope::Application)?;
        let body: AspspsResponse = decode(response)?;
        Ok(body.aspsps.iter().map(AspspData::to_model).collect())
    }

    /// `POST /auth`: get the URL to open in the browser.
    pub fn start_auth(&self, request: &StartAuth) -> Result<Authorization> {
        self.validate_start_auth(request)?;
        let body = StartAuthRequest {
            access: Access {
                valid_until: request
                    .valid_until
                    .map(|instant| instant.to_rfc3339_opts(SecondsFormat::Secs, true)),
            },
            aspsp: AspspRef::from(&request.bank),
            state: request.state.clone(),
            redirect_url: request.redirect_url.clone(),
            psu_type: request.psu_type.as_str().to_string(),
            language: request
                .language
                .as_ref()
                .map(|language| language.trim().to_ascii_lowercase()),
        };
        let response = self.send(Method::Post, "/auth", Some(&body), Scope::Application)?;
        let parsed: StartAuthResponse = decode(response)?;
        Ok(Authorization {
            url: parsed.url,
            authorization_id: parsed.authorization_id,
            psu_id_hash: parsed.psu_id_hash,
        })
    }

    /// `POST /sessions`: exchange the code the callback returned for a session
    /// and its accounts.
    pub fn create_session(&self, code: &str) -> Result<SessionGrant> {
        if code.trim().is_empty() {
            return Err(BankError::invalid(None, "falta el código de autorización"));
        }
        let body = SessionRequest {
            code: code.trim().to_string(),
        };
        let response = self.send(Method::Post, "/sessions", Some(&body), Scope::Application)?;
        let parsed: AuthorizeSessionResponse = decode(response)?;
        Ok(SessionGrant {
            session_id: parsed.session_id,
            accounts: parsed
                .accounts
                .iter()
                .map(|account| account.to_model())
                .collect(),
            bank: parsed.aspsp.as_ref().map(BankRef::from),
            consent_valid_until: parsed
                .access
                .as_ref()
                .and_then(|access| access.valid_until()),
        })
    }

    /// `GET /sessions/{id}`: what the API still says about a link.
    pub fn get_session(&self, session_id: &str) -> Result<SessionState> {
        let path = format!("/sessions/{}", require_id(session_id, "la sesión")?);
        let response = self.send(Method::Get, &path, None::<&()>, Scope::Session)?;
        let parsed: GetSessionResponse = decode(response)?;
        Ok(SessionState {
            session_id: session_id.to_string(),
            status: parsed.status,
            accounts: parsed.accounts,
            bank: parsed.aspsp.as_ref().map(BankRef::from),
            consent_valid_until: parsed
                .access
                .as_ref()
                .and_then(|access| access.valid_until()),
            authorized: parsed.authorized.as_deref().and_then(parse_instant),
        })
    }

    /// `DELETE /sessions/{id}`: close the session, and with it the bank's
    /// consent when the bank allows it.
    pub fn delete_session(&self, session_id: &str) -> Result<()> {
        let path = format!("/sessions/{}", require_id(session_id, "la sesión")?);
        self.send(Method::Delete, &path, None::<&()>, Scope::Session)?;
        Ok(())
    }

    /// `GET /accounts/{uid}/details`.
    pub fn account_details(&self, account_uid: &str) -> Result<BankAccount> {
        let path = format!(
            "/accounts/{}/details",
            require_id(account_uid, "la cuenta")?
        );
        let response = self.send(Method::Get, &path, None::<&()>, Scope::Session)?;
        let parsed: crate::dto::AccountResource = decode(response)?;
        Ok(parsed.to_model())
    }

    /// `GET /accounts/{uid}/balances`.
    pub fn balances(&self, account_uid: &str) -> Result<Vec<BankBalance>> {
        let path = format!(
            "/accounts/{}/balances",
            require_id(account_uid, "la cuenta")?
        );
        let response = self.send(Method::Get, &path, None::<&()>, Scope::Session)?;
        let parsed: BalancesResponse = decode(response)?;
        parsed
            .balances
            .iter()
            .map(|balance| balance.to_model(account_uid))
            .collect()
    }

    /// `GET /accounts/{uid}/transactions`, following `continuation_key` until
    /// the last page or the window's page cap.
    pub fn transactions(
        &self,
        account_uid: &str,
        window: &TransactionWindow,
    ) -> Result<Vec<BankTransaction>> {
        if window.to < window.from {
            return Err(BankError::invalid(
                None,
                "el periodo de movimientos termina antes de empezar",
            ));
        }
        let account_uid = require_id(account_uid, "la cuenta")?;
        let mut transactions = Vec::new();
        let mut continuation: Option<String> = None;
        let mut page = 0u32;
        loop {
            page += 1;
            let mut path = format!(
                "/accounts/{account_uid}/transactions?date_from={}&date_to={}",
                window.from, window.to
            );
            if let Some(key) = &continuation {
                path.push_str("&continuation_key=");
                path.push_str(&encode(key));
            }
            let response = self.send(Method::Get, &path, None::<&()>, Scope::Session)?;
            let body: TransactionsResponse = decode(response)?;
            for transaction in &body.transactions {
                if let Some(transaction) = transaction.to_model(account_uid)? {
                    transactions.push(transaction);
                }
            }
            match body.continuation_key.filter(|key| !key.trim().is_empty()) {
                None => return Ok(transactions),
                Some(key) => {
                    if page >= window.page_cap {
                        return Err(BankError::invalid(
                            None,
                            format!(
                                "el banco tiene más de {} páginas de movimientos en este periodo; \
                                 acorta las fechas",
                                window.page_cap
                            ),
                        ));
                    }
                    if continuation.as_deref() == Some(key.as_str()) {
                        return Err(BankError::invalid(
                            None,
                            "el banco repitió la clave de continuación, así que no hay última página",
                        ));
                    }
                    continuation = Some(key);
                }
            }
        }
    }

    /// Whether the link's consent is still good by this client's clock. The
    /// API answers the same question on the next call, but a sync that starts
    /// after the deadline only wastes a request and a round of errors.
    pub fn check_consent(&self, link: &BankLink) -> Result<()> {
        if link.consent_valid_until <= self.clock.now() {
            return Err(BankError::consent_expired(ConsentEnd::ValidUntilPassed));
        }
        Ok(())
    }

    // ---- the request path ----------------------------------------------

    /// Validate what `start_auth` is about to send, so a mistake is a local
    /// error rather than a 400 from the API.
    fn validate_start_auth(&self, request: &StartAuth) -> Result<()> {
        if request.state.trim().is_empty() {
            return Err(BankError::invalid(
                None,
                "falta el state de la autorización",
            ));
        }
        if request.state.len() > 256 {
            return Err(BankError::invalid(None, "el state es demasiado largo"));
        }
        if !crate::callback::is_loopback_redirect_url(&request.redirect_url) {
            return Err(BankError::invalid(
                None,
                "la vuelta del banco tiene que ser una dirección local \
                 (http://127.0.0.1:<puerto>/callback o http://localhost:<puerto>/callback)",
            ));
        }
        if request.bank.name.trim().is_empty() || request.bank.country.trim().is_empty() {
            return Err(BankError::invalid(None, "falta el banco al que vincular"));
        }
        if let Some(valid_until) = request.valid_until
            && valid_until <= self.clock.now()
        {
            return Err(BankError::invalid(
                None,
                "la fecha límite del consentimiento ya ha pasado",
            ));
        }
        if let Some(language) = &request.language {
            let language = language.trim();
            if language.len() != 2
                || !language
                    .chars()
                    .all(|character| character.is_ascii_alphabetic())
            {
                return Err(BankError::invalid(
                    None,
                    "el idioma tiene que ser un código de dos letras, por ejemplo es",
                ));
            }
        }
        Ok(())
    }

    /// One signed request, with the retries and the error mapping.
    fn send<B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        scope: Scope,
    ) -> Result<HttpResponse> {
        let token = self
            .signer
            .token(self.clock.now())
            .map_err(BankError::Signing)?;
        let mut request = HttpRequest::new(method, format!("{}{}", self.base_url, path))
            .with_header("Authorization", format!("Bearer {token}"))
            .with_header("Accept", "application/json")
            .with_header("User-Agent", USER_AGENT);
        if let Some(body) = body {
            let json = serde_json::to_string(body).map_err(|error| {
                BankError::invalid(None, format!("no se pudo preparar la petición: {error}"))
            })?;
            request = request
                .with_header("Content-Type", "application/json")
                .with_body(json);
        }
        self.execute(request, scope)
    }

    /// The retry loop. Rate limits and transient failures are retried with
    /// backoff; everything else is returned at once.
    fn execute(&self, request: HttpRequest, scope: Scope) -> Result<HttpResponse> {
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            match self.transport.send(&request) {
                Ok(response) if response.is_success() => return Ok(response),
                Ok(response) => {
                    let mut error = self.classify(&response, scope);
                    if let BankError::RateLimited { attempts, .. } = &mut error {
                        *attempts = attempt;
                    }
                    if !error.is_retryable() || attempt >= self.policy.max_attempts {
                        return Err(error);
                    }
                    let delay = self.policy.delay(attempt, error.retry_after());
                    self.clock.sleep(delay);
                }
                Err(transport) => {
                    if attempt >= self.policy.max_attempts {
                        return Err(BankError::Transport(transport));
                    }
                    let delay = self.policy.delay(attempt, None);
                    self.clock.sleep(delay);
                }
            }
        }
    }

    /// Turn a non-2xx answer into the error the app acts on.
    fn classify(&self, response: &HttpResponse, scope: Scope) -> BankError {
        let payload = serde_json::from_str::<ErrorResponse>(&response.body).unwrap_or_default();
        let code = payload.error_code();
        let description = payload.description();
        match response.status {
            // Session errors name their reason when it is a session anyway.
            401 | 403 => match code {
                Some("EXPIRED_SESSION") => BankError::consent_expired(ConsentEnd::Expired),
                Some("REVOKED_SESSION") => BankError::consent_expired(ConsentEnd::Revoked),
                Some("CLOSED_SESSION") | Some("SESSION_DOES_NOT_EXIST") => {
                    BankError::consent_expired(ConsentEnd::Closed)
                }
                // The application itself: a key, a status or a service it
                // does not have. Asking the user to link again would loop.
                Some(
                    "AUTHORIZATION_NOT_PROVIDED"
                    | "UNAUTHORIZED_ACCESS"
                    | "ACCESS_DENIED"
                    | "INVALID_HOST",
                ) => BankError::unauthorized(code, &description),
                _ => match scope {
                    Scope::Session => BankError::consent_expired(ConsentEnd::Unspecified),
                    Scope::Application => BankError::unauthorized(code, &description),
                },
            },
            429 => BankError::RateLimited {
                retry_after: self.retry_after(response),
                attempts: 0,
            },
            408 | 500..=599 => BankError::Transient {
                status: Some(response.status),
                message: description,
            },
            _ => BankError::invalid(code, description),
        }
    }

    /// The `Retry-After` header, as seconds or as an HTTP date.
    fn retry_after(&self, response: &HttpResponse) -> Option<Duration> {
        let value = response.header("retry-after")?.trim();
        if let Ok(seconds) = value.parse::<u64>() {
            return Some(Duration::from_secs(seconds.min(86_400)));
        }
        let instant = DateTime::parse_from_rfc2822(value)
            .ok()?
            .with_timezone(&Utc);
        (instant - self.clock.now()).to_std().ok()
    }
}

impl<T: Transport, C: Clock> fmt::Debug for Client<T, C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Client")
            .field("base_url", &self.base_url)
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

/// A request or response body as a typed shape. A body that does not parse is
/// an `Invalid` error, never a panic and never a partially filled value.
fn decode<R: DeserializeOwned>(response: HttpResponse) -> Result<R> {
    serde_json::from_str(&response.body).map_err(|error| {
        BankError::invalid(
            None,
            format!("la respuesta del banco no se pudo leer: {error}"),
        )
    })
}

/// Reject an empty id: an account uid or a session id is required, and an
/// empty one silently turns a path into a different endpoint.
fn require_id<'a>(id: &'a str, what: &str) -> Result<&'a str> {
    let id = id.trim();
    if id.is_empty() {
        return Err(BankError::invalid(
            None,
            format!("falta el identificador de {what}"),
        ));
    }
    if id.len() > 128 {
        return Err(BankError::invalid(
            None,
            format!("el identificador de {what} es demasiado largo"),
        ));
    }
    Ok(id)
}

/// Percent-encode a query value: everything but the unreserved characters.
/// Continuation keys are base64 and may contain `+`, `/` and `=`; a bank's
/// date and a UUID need nothing, but the encoder is the same for both.
fn encode(value: &str) -> String {
    const UNRESERVED: &[u8] = b"-._~";
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || UNRESERVED.contains(byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
