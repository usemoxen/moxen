//! The real transport: `ureq` over rustls, pointed at this crate's own loopback
//! server so a test exercises the HTTP path without leaving the machine.
//!
//! No request here goes to Enable Banking: the success case talks to the
//! callback server in the same process, and the failure case talks to a port
//! nothing listens on.

use std::net::{Ipv4Addr, TcpListener};
use std::time::Duration;

use moxen_finances_banking::callback::CallbackServer;
use moxen_finances_banking::{
    HttpRequest, HttpResponse, Method, Transport, TransportError, UreqTransport,
};

/// A port the OS just handed out and nobody holds.
fn free_port() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("an ephemeral port");
    let port = listener.local_addr().expect("a local address").port();
    drop(listener);
    port
}

#[test]
fn a_real_http_get_reaches_the_loopback_server_and_reads_the_page() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let handle =
        std::thread::spawn(move || server.wait("fictional-state", Duration::from_secs(10)));

    let transport = UreqTransport::new(Duration::from_secs(5));
    let request = HttpRequest::new(
        Method::Get,
        format!("http://127.0.0.1:{port}/callback?code=fictional-code&state=fictional-state"),
    )
    .with_header("Accept", "text/html");
    let response = transport
        .send(&request)
        .expect("the loopback server answers");

    assert_eq!(response.status, 200);
    assert!(
        response
            .header("content-type")
            .is_some_and(|value| value.starts_with("text/html")),
        "headers were {:?}",
        response.headers
    );
    assert!(response.body.contains("You can close this tab"));

    let outcome = handle.join().expect("the wait finished").expect("a code");
    assert_eq!(outcome.code, "fictional-code");
}

#[test]
fn a_port_nobody_listens_on_is_a_transport_error() {
    let port = free_port();
    let transport = UreqTransport::new(Duration::from_secs(2));
    let request = HttpRequest::new(Method::Get, format!("http://127.0.0.1:{port}/callback"));
    let error = transport.send(&request).expect_err("nothing is listening");
    assert!(!error.message.is_empty());
    // The message is bounded and does not quote a credential; there is none
    // here anyway, which is the point of clipping it.
    assert!(error.message.len() <= 201);
}

#[test]
fn the_real_transport_keeps_a_non_2xx_status_as_a_response() {
    // `http_status_as_error(false)`: the API's error body and `Retry-After`
    // have to survive to the client, which is what maps them.
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let handle =
        std::thread::spawn(move || server.wait("fictional-state", Duration::from_millis(300)));

    let transport = UreqTransport::new(Duration::from_secs(5));
    let request = HttpRequest::new(Method::Get, format!("http://127.0.0.1:{port}/nothing-here"));
    let response = transport.send(&request).expect("a 404 is still a response");
    assert_eq!(response.status, 404);
    assert!(response.body.contains("Nothing here"));
    drop(handle.join());
}

#[test]
fn a_request_renders_without_its_token_or_its_identifiers() {
    let request = HttpRequest::new(
        Method::Post,
        "https://api.enablebanking.com/sessions/fictional-session-0001?continuation_key=ZmljdGlvbmFsLXBhZ2UtMg==",
    )
    .with_header("Authorization", "Bearer eyJhbGciOiJSUzI1NiJ9.fictional.signature")
    .with_header("Accept", "application/json")
    .with_body(r#"{"code":"fictional-code-0001"}"#);

    let rendered = format!("{request:?}");
    assert!(
        !rendered.contains("eyJhbGci"),
        "the token leaked: {rendered}"
    );
    assert!(
        !rendered.contains("fictional-session-0001"),
        "the session id leaked: {rendered}"
    );
    assert!(
        !rendered.contains("ZmljdGlvbmFsLXBhZ2UtMg=="),
        "the continuation key leaked: {rendered}"
    );
    assert!(
        !rendered.contains("fictional-code-0001"),
        "the code leaked: {rendered}"
    );
    assert!(
        rendered.contains("api.enablebanking.com"),
        "the host stays readable"
    );
    assert!(rendered.contains("application/json"));
}

#[test]
fn a_response_renders_its_body_as_a_length() {
    let response = HttpResponse::new(200, r#"{"balances":[{"amount":"1234.56"}]}"#);
    let rendered = format!("{response:?}");
    assert!(
        !rendered.contains("1234.56"),
        "a balance leaked: {rendered}"
    );
    assert!(rendered.contains("bytes"), "{rendered}");
}

#[test]
fn a_header_with_the_same_name_replaces_the_old_one() {
    // Two Authorization headers would be a signed request the server rejects,
    // and renewing the token must not append.
    let request = HttpRequest::new(Method::Get, "https://api.enablebanking.com/aspsps")
        .with_header("Authorization", "Bearer first")
        .with_header("authorization", "Bearer second");
    let values: Vec<&String> = request
        .headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value)
        .collect();
    assert_eq!(values, vec!["Bearer second"]);
}

#[test]
fn a_transport_error_keeps_its_timeout_flag() {
    let timed_out = TransportError::timeout("the request timed out");
    assert!(timed_out.timed_out);
    assert!(!TransportError::io("connection reset").timed_out);
    assert!(
        TransportError::io("x".repeat(5_000))
            .message
            .chars()
            .count()
            <= 201
    );
    assert!(
        TransportError::io("  padded  ").message == "padded",
        "a message is trimmed"
    );
}
