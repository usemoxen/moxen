//! The loopback server the browser comes back to while linking a bank.
//!
//! The user registers `http://127.0.0.1:<port>/callback` (and the
//! `localhost` spelling, because some browsers treat the two differently) as
//! redirect URLs of THEIR OWN Enable Banking application. While linking, this
//! server listens on `127.0.0.1` only, on the first free port of a fixed list,
//! serves exactly one `GET /callback`, checks the `state` against the value
//! that was sent with [`crate::Client::start_auth`] in constant time, and
//! answers with a page that says the tab can be closed, in English and
//! Spanish.
//!
//! What it deliberately does not do:
//!
//! - **It never listens anywhere but loopback.** The bind address is
//!   `127.0.0.1`, so no other machine can reach it, and a peer that is not
//!   loopback (impossible while bound that way, checked anyway) is dropped.
//! - **It echoes nothing.** Every page is a constant: the `state`, the `code`,
//!   the `error_description` the bank sends and the request line never reach
//!   the HTML, so there is nothing to escape and nothing to inject.
//! - **It answers nothing but `GET /callback`.** Any other path or method
//!   gets a 404 or 405 and the server keeps waiting until the deadline.
//! - **A wrong `state` cannot cancel the link.** It is answered with a 400 and
//!   the wait goes on, so a stray request from another page on the same
//!   machine cannot make the user start over; if no valid redirect ever
//!   arrives, the timeout reports the mismatch instead of a plain timeout.

use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::DEFAULT_CALLBACK_PORTS;
use crate::text::{Language, Localized};

/// The path a user registers.
pub const CALLBACK_PATH: &str = "/callback";

/// How often the non-blocking accept loop looks at the deadline.
const POLL: Duration = Duration::from_millis(20);

/// How long one browser connection may take to send its request.
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// The most bytes of a request line and headers this server reads. A browser
/// sends a few hundred; this only bounds a local accident.
const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// How many connections a single link may open before the server gives up:
/// a favicon request, a prefetch and a retry fit; a loop does not.
const MAX_CONNECTIONS: usize = 64;

/// What a successfully validated redirect carries.
#[derive(Clone, PartialEq, Eq)]
pub struct CallbackOutcome {
    /// The authorization code to exchange for a session.
    pub code: String,
    /// The state, already checked against ours.
    pub state: String,
}

impl fmt::Debug for CallbackOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The code is a single-use credential: it is not for logs.
        formatter
            .debug_struct("CallbackOutcome")
            .field("code", &"<redacted>")
            .field("state", &crate::redact::mask(&self.state))
            .finish()
    }
}

/// Why no code arrived. `Display` is the English sentence; the Spanish one
/// comes from [`Localized`].
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum CallbackError {
    /// Every port of the list was busy, so no redirect URL could answer.
    #[error("no free port was found to receive the bank's return: {ports:?}")]
    PortsUnavailable {
        /// The ports that were tried, in order.
        ports: Vec<u16>,
    },

    /// The bank redirected with `error` instead of `code`: the user cancelled,
    /// or the bank refused. There is nothing to retry.
    #[error("the bank did not authorize the access: {error}")]
    Denied {
        /// The OAuth error code (`access_denied`, ...).
        error: String,
        /// The bank's human-readable description.
        description: Option<String>,
    },

    /// A redirect arrived with a `state` that was not ours, and no valid one
    /// followed before the deadline.
    #[error("the bank's answer does not match this request (different state)")]
    StateMismatch,

    /// The deadline passed with no usable redirect.
    #[error("the bank did not answer in time")]
    Timeout,

    /// A socket failure while listening or reading.
    #[error("could not listen on 127.0.0.1: {message}")]
    Io {
        /// A bounded description, without request contents.
        message: String,
    },

    /// A local client opened more connections than one link can need.
    #[error("too many connections while waiting for the bank")]
    TooManyConnections,

    /// The state to compare against was empty, which cannot be checked.
    #[error("the request has no state to check")]
    MissingState,
}

impl Localized for CallbackError {
    fn localized(&self, language: Language) -> String {
        match self {
            CallbackError::PortsUnavailable { ports } => format!(
                "{} {ports:?}",
                language.pick(
                    "no free port was found to receive the bank's return:",
                    "no hay ningún puerto libre para recibir la vuelta del banco:"
                )
            ),
            CallbackError::Denied { error, .. } => format!(
                "{} {error}",
                language.pick(
                    "the bank did not authorize the access:",
                    "el banco no ha autorizado el acceso:"
                )
            ),
            CallbackError::StateMismatch => language
                .pick(
                    "the bank's answer does not match this request (different state)",
                    "la respuesta del banco no corresponde a esta solicitud (state distinto)",
                )
                .to_string(),
            CallbackError::Timeout => language
                .pick(
                    "the bank did not answer in time",
                    "el banco no respondió a tiempo",
                )
                .to_string(),
            CallbackError::Io { message } => format!(
                "{} {message}",
                language.pick(
                    "could not listen on 127.0.0.1:",
                    "no se pudo escuchar en 127.0.0.1:"
                )
            ),
            CallbackError::TooManyConnections => language
                .pick(
                    "too many connections while waiting for the bank",
                    "demasiadas conexiones mientras se esperaba al banco",
                )
                .to_string(),
            CallbackError::MissingState => language
                .pick(
                    "the request has no state to check",
                    "la solicitud no tiene state que comprobar",
                )
                .to_string(),
        }
    }
}

/// The redirect URLs a user should register for one port: both spellings,
/// because they are different origins to a browser.
pub fn redirect_urls(port: u16) -> [String; 2] {
    [
        format!("http://127.0.0.1:{port}{CALLBACK_PATH}"),
        format!("http://localhost:{port}{CALLBACK_PATH}"),
    ]
}

/// A fresh `state` for one authorization: 32 hex characters from the OS
/// randomness, so two links can never share one and a stray local request
/// cannot be matched by guessing.
pub fn new_state() -> String {
    use rand::RngCore as _;
    let mut bytes = [0_u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    let mut state = String::with_capacity(32);
    for byte in bytes {
        state.push_str(&format!("{byte:02x}"));
    }
    state
}

/// Whether `url` is one of the loopback redirect URLs this crate serves. A
/// link flow only works with one of these, and only a loopback origin is
/// private to this machine.
pub fn is_loopback_redirect_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let Some((authority, path)) = rest.split_once('/') else {
        return false;
    };
    if path != &CALLBACK_PATH[1..] {
        return false;
    }
    let Some((host, port)) = authority.rsplit_once(':') else {
        return false;
    };
    if host != "127.0.0.1" && host != "localhost" {
        return false;
    }
    matches!(port.parse::<u16>(), Ok(port) if port != 0)
}

/// A server bound to one loopback port, waiting for the browser.
pub struct CallbackServer {
    listener: TcpListener,
    port: u16,
}

impl CallbackServer {
    /// Bind the first free port of the list, or of [`DEFAULT_CALLBACK_PORTS`]
    /// when the list is empty. Only `127.0.0.1` is ever bound, never
    /// `0.0.0.0`, never a hostname and never a name that resolves.
    pub fn bind(ports: &[u16]) -> Result<Self, CallbackError> {
        let ports = if ports.is_empty() {
            DEFAULT_CALLBACK_PORTS.to_vec()
        } else {
            ports.to_vec()
        };
        for port in &ports {
            let address = SocketAddr::from((Ipv4Addr::LOCALHOST, *port));
            if let Ok(listener) = TcpListener::bind(address) {
                return Ok(Self {
                    listener,
                    port: *port,
                });
            }
            // Busy is the expected reason to try the next one; anything else
            // (a permission rule) fails on every port too.
        }
        Err(CallbackError::PortsUnavailable { ports })
    }

    /// Bind one of the default ports.
    pub fn bind_default() -> Result<Self, CallbackError> {
        Self::bind(&DEFAULT_CALLBACK_PORTS)
    }

    /// The port that was actually bound, for the redirect URL the user
    /// registered.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The address the socket is bound to. It is `127.0.0.1:<port>` and
    /// nothing else; a test asserts exactly that.
    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// The URLs this server answers on.
    pub fn redirect_urls(&self) -> [String; 2] {
        redirect_urls(self.port)
    }

    /// Wait up to `timeout` for a valid redirect, then return its code or the
    /// reason there is none. The server is consumed: one link, one callback.
    pub fn wait(self, state: &str, timeout: Duration) -> Result<CallbackOutcome, CallbackError> {
        if state.is_empty() {
            return Err(CallbackError::MissingState);
        }
        let deadline = Instant::now() + timeout;
        self.listener
            .set_nonblocking(true)
            .map_err(|error| CallbackError::Io {
                message: error.kind().to_string(),
            })?;
        let mut connections = 0usize;
        let mut mismatched = false;
        loop {
            match self.listener.accept() {
                Ok((stream, peer)) => {
                    connections += 1;
                    if connections > MAX_CONNECTIONS {
                        return Err(CallbackError::TooManyConnections);
                    }
                    // Bound to loopback, so this is always true; checked anyway
                    // so a future change of bind address cannot silently
                    // accept a remote host.
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    match serve(stream, state)? {
                        Answer::Done(outcome) => return Ok(outcome),
                        Answer::Mismatched => mismatched = true,
                        Answer::Unrelated => {}
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(if mismatched {
                            CallbackError::StateMismatch
                        } else {
                            CallbackError::Timeout
                        });
                    }
                    std::thread::sleep(POLL);
                }
                // A connection that died between accept and here (a browser
                // opened a speculative socket) is not a reason to give up.
                Err(error) if error.kind() == ErrorKind::ConnectionAborted => continue,
                Err(error) => {
                    return Err(CallbackError::Io {
                        message: error.kind().to_string(),
                    });
                }
            }
        }
    }
}

impl fmt::Debug for CallbackServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CallbackServer")
            .field("port", &self.port)
            .finish()
    }
}

/// Bind a free port and wait for the redirect in one call, returning the
/// outcome and the port that answered.
pub fn wait_for_redirect(
    state: &str,
    ports: &[u16],
    timeout: Duration,
) -> Result<(CallbackOutcome, u16), CallbackError> {
    let server = CallbackServer::bind(ports)?;
    let port = server.port();
    let outcome = server.wait(state, timeout)?;
    Ok((outcome, port))
}

/// What one connection produced.
enum Answer {
    /// A validated code.
    Done(CallbackOutcome),
    /// The right path, a `state` that was not ours.
    Mismatched,
    /// A path or method this server does not answer, or a malformed redirect.
    Unrelated,
}

/// Read one request, answer it, and report what it was.
fn serve(mut stream: TcpStream, expected_state: &str) -> Result<Answer, CallbackError> {
    // On macOS and Windows an accepted socket inherits the listener's
    // non-blocking mode. Left that way, a request that has not arrived yet
    // reads as nothing: the browser gets a 400 and then a reset.
    stream
        .set_nonblocking(false)
        .map_err(|error| CallbackError::Io {
            message: error.kind().to_string(),
        })?;
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
    let request = read_head(&mut stream)?;

    let Some((method, target)) = parse_request_line(&request) else {
        respond(&mut stream, 400, BAD_REQUEST_PAGE);
        return Ok(Answer::Unrelated);
    };
    if method != "GET" {
        respond(&mut stream, 405, BAD_REQUEST_PAGE);
        return Ok(Answer::Unrelated);
    }
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target, None),
    };
    if path != CALLBACK_PATH {
        respond(&mut stream, 404, NOT_FOUND_PAGE);
        return Ok(Answer::Unrelated);
    }

    let query = query.map(parse_query).unwrap_or_default();
    let value = |key: &str| {
        query
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };

    if let Some(error) = value("error")
        && !error.is_empty()
    {
        respond(&mut stream, 200, DENIED_PAGE);
        return Err(CallbackError::Denied {
            error: crate::redact::clip(error),
            description: value("error_description").map(crate::redact::clip),
        });
    }

    let Some(state) = value("state") else {
        respond(&mut stream, 400, BAD_REQUEST_PAGE);
        return Ok(Answer::Mismatched);
    };
    if !constant_time_eq(state, expected_state) {
        respond(&mut stream, 400, BAD_REQUEST_PAGE);
        return Ok(Answer::Mismatched);
    }
    let Some(code) = value("code").filter(|code| !code.is_empty()) else {
        respond(&mut stream, 400, BAD_REQUEST_PAGE);
        return Ok(Answer::Unrelated);
    };

    respond(&mut stream, 200, DONE_PAGE);
    Ok(Answer::Done(CallbackOutcome {
        code: code.to_string(),
        state: state.to_string(),
    }))
}

/// Read the request line and headers, stopping at the blank line, at
/// [`MAX_REQUEST_BYTES`], or when the client goes quiet.
fn read_head(stream: &mut TcpStream) -> Result<String, CallbackError> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 512];
    loop {
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if buffer.len() >= MAX_REQUEST_BYTES {
            break;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                if buffer.len() > MAX_REQUEST_BYTES {
                    buffer.truncate(MAX_REQUEST_BYTES);
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => break,
            Err(error) if error.kind() == ErrorKind::TimedOut => break,
            Err(error) => {
                return Err(CallbackError::Io {
                    message: error.kind().to_string(),
                });
            }
        }
    }
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// `GET /callback?... HTTP/1.1` → the method and the target.
fn parse_request_line(request: &str) -> Option<(&str, &str)> {
    let line = request.lines().next()?;
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    Some((method, target))
}

/// Split a query string into decoded pairs. `+` is left alone: an
/// authorization code may contain one, and a code is not form data.
fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((name, value)) => (percent_decode(name), percent_decode(value)),
            None => (percent_decode(pair), String::new()),
        })
        .collect()
}

/// Decode `%XX` sequences; anything malformed is kept as it came.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Compare two strings without letting the comparison time depend on where
/// they first differ, so a wrong `state` cannot be guessed byte by byte.
pub fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = left.len() ^ right.len();
    let longest = left.len().max(right.len());
    for index in 0..longest {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        difference |= usize::from(a ^ b);
    }
    difference == 0
}

/// Write a small static page. The body is a constant: no request data is ever
/// interpolated, so there is nothing to escape.
fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {length}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         \r\n",
        length = body.len(),
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

/// The page after a valid redirect. English and Spanish, because the app is
/// bilingual and the browser is not ours.
const DONE_PAGE: &str = "<!doctype html>\n\
<html lang=\"en\">\n\
<head><meta charset=\"utf-8\"><title>Moxen Finances</title></head>\n\
<body>\n\
<h1>You can close this tab</h1>\n\
<p>Moxen Finances received the bank's answer and will finish linking.</p>\n\
<hr>\n\
<div lang=\"es\">\n\
<h1>Puedes cerrar esta pestaña</h1>\n\
<p>Moxen Finances ha recibido la respuesta del banco y terminará de vincularlo.</p>\n\
</div>\n\
</body>\n\
</html>\n";

/// The page when the bank sent `error` instead of a code.
const DENIED_PAGE: &str = "<!doctype html>\n\
<html lang=\"en\">\n\
<head><meta charset=\"utf-8\"><title>Moxen Finances</title></head>\n\
<body>\n\
<h1>You can close this tab</h1>\n\
<p>The bank did not authorize the access. Nothing was linked.</p>\n\
<hr>\n\
<div lang=\"es\">\n\
<h1>Puedes cerrar esta pestaña</h1>\n\
<p>El banco no ha autorizado el acceso. No se ha vinculado nada.</p>\n\
</div>\n\
</body>\n\
</html>\n";

/// The page for a request that is not the redirect this server waits for.
const BAD_REQUEST_PAGE: &str = "<!doctype html>\n\
<html lang=\"en\">\n\
<head><meta charset=\"utf-8\"><title>Moxen Finances</title></head>\n\
<body>\n\
<h1>This address is not valid</h1>\n\
<p>Moxen Finances is waiting for a bank redirect at this address.</p>\n\
<hr>\n\
<div lang=\"es\">\n\
<h1>Esta dirección no es válida</h1>\n\
<p>Moxen Finances está esperando la vuelta del banco en esta dirección.</p>\n\
</div>\n\
</body>\n\
</html>\n";

/// The page for any other path (a favicon, a probe).
const NOT_FOUND_PAGE: &str = "<!doctype html>\n\
<html lang=\"en\">\n\
<head><meta charset=\"utf-8\"><title>Moxen Finances</title></head>\n\
<body>\n\
<h1>Nothing here</h1>\n\
<p>Moxen Finances only answers the bank's redirect.</p>\n\
<hr>\n\
<div lang=\"es\">\n\
<h1>Aquí no hay nada</h1>\n\
<p>Moxen Finances solo responde a la vuelta del banco.</p>\n\
</div>\n\
</body>\n\
</html>\n";
