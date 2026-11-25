//! The one place the crate talks to a network, and the seam the tests use.
//!
//! [`Transport`] is deliberately blocking. The client is called from a worker
//! thread of the app that already knows it is doing network work (it shows a
//! "connecting" state), so an async runtime would add a dependency, a
//! scheduler and a `Future` in every signature for no gain, and the callback
//! server has to be a blocking socket listener anyway. It also keeps
//! [`testing::RecordedTransport`] trivial: a queue of responses instead of a
//! mock runtime.
//!
//! [`UreqTransport`] is `ureq` with rustls and Mozilla's roots compiled in: no
//! OpenSSL, no system trust store, the same behaviour on macOS and Windows.

use std::fmt;
use std::time::Duration;

use crate::redact;

/// The three methods the account-information flow uses. There is no `PUT`,
/// `PATCH` or `HEAD` because there is no endpoint that needs one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// `GET /aspsps`, `/sessions/{id}`, `/accounts/{uid}/...`.
    Get,
    /// `POST /auth`, `/sessions`.
    Post,
    /// `DELETE /sessions/{id}`.
    Delete,
}

impl Method {
    /// The method as the wire spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Delete => "DELETE",
        }
    }
}

/// One request, ready to send.
#[derive(Clone)]
pub struct HttpRequest {
    /// GET, POST or DELETE.
    pub method: Method,
    /// The absolute URL, query string included.
    pub url: String,
    /// Headers, `Authorization` and `Accept` among them.
    pub headers: Vec<(String, String)>,
    /// The JSON body for `POST`, `None` otherwise.
    pub body: Option<String>,
}

impl HttpRequest {
    /// A request without headers or a body.
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    /// Add a header, replacing one with the same name (case-insensitive).
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        let name = name.into();
        self.headers
            .retain(|(existing, _)| !existing.eq_ignore_ascii_case(&name));
        self.headers.push((name, value.into()));
        self
    }

    /// Set the JSON body.
    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// The value of a header, if it is there.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // A Debug line is a log line: the bearer token is a signed credential
        // and the path holds session ids and account uids, so both are masked.
        // The body holds the authorization code, likewise.
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(name, value)| (name.as_str(), header_debug_value(name, value)))
            .collect();
        formatter
            .debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &redact::mask_url(&self.url))
            .field("headers", &headers)
            .field("body", &self.body.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// `Authorization` is masked whole; any other header is shown, masked by
/// length like the URL, since only the bearer token is a credential.
fn header_debug_value<'a>(name: &str, value: &'a str) -> &'a str {
    if name.eq_ignore_ascii_case("authorization") {
        "<redacted>"
    } else {
        value
    }
}

/// One response, as the transport saw it.
#[derive(Clone)]
pub struct HttpResponse {
    /// The HTTP status code.
    pub status: u16,
    /// Response headers, `Retry-After` among them.
    pub headers: Vec<(String, String)>,
    /// The body, read as text. JSON on success and on an error alike.
    pub body: String,
}

impl HttpResponse {
    /// A response with a status and a body, for a fake transport.
    pub fn new(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: body.into(),
        }
    }

    /// Add a header.
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// The value of a header, if it is there.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Whether the status is 2xx.
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

impl fmt::Debug for HttpResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The body carries account names, balances and IBANs.
        formatter
            .debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .field("body", &format_args!("<{} bytes>", self.body.len()))
            .finish()
    }
}

/// A request that never produced a response: DNS, TCP, TLS, a timeout, or a
/// broken connection. The client retries these (bounded), because the API is
/// a remote service and a dropped connection says nothing about the request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    /// A bounded, redacted description: no URL with ids, no body.
    pub message: String,
    /// Whether the failure was a timeout, which is worth retrying first.
    pub timed_out: bool,
}

impl TransportError {
    /// A failed connection or transfer.
    pub fn io(message: impl Into<String>) -> Self {
        Self {
            message: redact::clip(&message.into()),
            timed_out: false,
        }
    }

    /// A request the transport gave up on after its own timeout.
    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            message: redact::clip(&message.into()),
            timed_out: true,
        }
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TransportError {}

/// Where requests go. Implementations must be safe to share across threads;
/// the client calls them from whichever worker thread is syncing.
pub trait Transport: Send + Sync {
    /// Send one request and return its response, or the reason there is none.
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, TransportError>;
}

/// The real transport: `ureq` over rustls.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    /// A transport that gives up on a request after `timeout`. Five to thirty
    /// seconds suits the API: transaction pages are the slow call.
    pub fn new(timeout: Duration) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            // Non-2xx is a response to map, not a transport failure: the body
            // carries the API's `error` code and `Retry-After` matters.
            .http_status_as_error(false)
            .user_agent(crate::USER_AGENT)
            .build();
        Self {
            agent: config.into(),
        }
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new(Duration::from_secs(30))
    }
}

impl fmt::Debug for UreqTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("UreqTransport").finish()
    }
}

impl Transport for UreqTransport {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, TransportError> {
        // `get`/`delete` are `RequestBuilder<WithoutBody>` and `post` is
        // `RequestBuilder<WithBody>`, so the match has to produce the result
        // of the call, not the builder.
        let sent = match request.method {
            Method::Get => headed(self.agent.get(&request.url), request).call(),
            Method::Delete => headed(self.agent.delete(&request.url), request).call(),
            Method::Post => {
                let body = request.body.clone().unwrap_or_default();
                headed(self.agent.post(&request.url), request).send(body)
            }
        };
        let mut response = sent.map_err(map_ureq_error)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_string()
            .map_err(map_ureq_error)?;
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

/// Add a request's headers to a builder, whatever its typestate.
fn headed<Any>(
    builder: ureq::RequestBuilder<Any>,
    request: &HttpRequest,
) -> ureq::RequestBuilder<Any> {
    let mut builder = builder;
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder
}

/// A transaction page is the biggest response the API sends; anything beyond
/// this is a broken response or the wrong host, not a payload to load.
const MAX_BODY_BYTES: u64 = 32 * 1024 * 1024;

/// `ureq`'s error, trimmed to what the client needs and freed of any URL.
fn map_ureq_error(error: ureq::Error) -> TransportError {
    match error {
        // Only reachable if `http_status_as_error` is ever turned back on.
        ureq::Error::StatusCode(status) => {
            TransportError::io(format!("unexpected HTTP status {status}"))
        }
        ureq::Error::Timeout(_) => TransportError::timeout("the request timed out"),
        ureq::Error::Io(error) if error.kind() == std::io::ErrorKind::TimedOut => {
            TransportError::timeout("the request timed out")
        }
        other => TransportError::io(other.to_string()),
    }
}
