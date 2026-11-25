//! The loopback server, driven over a real socket on `127.0.0.1`.
//!
//! Nothing here mocks the socket: a test connects with a `TcpStream`, sends
//! bytes like a browser and reads what came back. That is the only way to
//! prove the address family, the path, the state check and the page are right.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use moxen_finances_banking::callback::{
    CallbackError, CallbackServer, constant_time_eq, is_loopback_redirect_url, redirect_urls,
    wait_for_redirect,
};

/// A port the OS just handed out and nobody else holds. The callback server
/// takes a fixed port list, so a test picks one this way instead of betting on
/// the defaults being free while other tests run in parallel.
fn free_port() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("an ephemeral port");
    let port = listener.local_addr().expect("a local address").port();
    drop(listener);
    port
}

/// Send one raw request and read the whole answer.
fn raw(port: u16, request_line: &str) -> String {
    let mut stream =
        TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect to the loopback server");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("a read timeout");
    let head = format!("{request_line}\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(head.as_bytes())
        .expect("write the request");
    let mut response = Vec::new();
    stream.read_to_end(&mut response).expect("read the answer");
    String::from_utf8_lossy(&response).into_owned()
}

/// Send a `GET` to the callback path with a query string.
fn get(port: u16, query: &str) -> String {
    raw(port, &format!("GET /callback?{query} HTTP/1.1"))
}

fn status(response: &str) -> &str {
    response.lines().next().unwrap_or_default()
}

// ---- the state check ---------------------------------------------------

#[test]
fn a_constant_time_compare_is_a_normal_compare() {
    assert!(constant_time_eq("", ""));
    assert!(constant_time_eq("fictional-state", "fictional-state"));
    assert!(!constant_time_eq("fictional-state", "fictional-statE"));
    assert!(!constant_time_eq("fictional-state", "fictional-state "));
    assert!(!constant_time_eq("fictional-state", "fiction"));
    assert!(!constant_time_eq("", "fictional-state"));
    assert!(!constant_time_eq("fictional-state", ""));
    // Different lengths, same prefix: the length difference alone decides.
    assert!(!constant_time_eq("abcdef", "abcdefg"));
}

#[test]
fn the_redirect_urls_are_the_two_loopback_spellings() {
    let urls = redirect_urls(47_831);
    assert_eq!(urls[0], "http://127.0.0.1:47831/callback");
    assert_eq!(urls[1], "http://localhost:47831/callback");
    assert!(is_loopback_redirect_url(&urls[0]));
    assert!(is_loopback_redirect_url(&urls[1]));
}

#[test]
fn a_redirect_url_that_is_not_loopback_is_not_accepted() {
    for url in [
        "https://127.0.0.1:47831/callback",
        "http://0.0.0.0:47831/callback",
        "http://192.168.1.10:47831/callback",
        "http://127.0.0.1:0/callback",
        "http://127.0.0.1:47831/other",
        "http://127.0.0.1/callback",
        "http://example.invalid:47831/callback",
        "http://127.0.0.1:notaport/callback",
        "not a url",
        "",
    ] {
        assert!(!is_loopback_redirect_url(url), "accepted {url}");
    }
}

// ---- binding -----------------------------------------------------------

#[test]
fn the_server_binds_loopback_only_on_the_requested_port() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    assert_eq!(server.port(), port);
    let address = server.local_addr().expect("a bound address");
    assert!(address.ip().is_loopback(), "bound {address}, not loopback");
    assert_eq!(address.ip().to_string(), "127.0.0.1");
    assert_eq!(server.redirect_urls(), redirect_urls(port));
}

#[test]
fn a_busy_port_falls_through_to_the_next_one() {
    let busy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("a listener");
    let busy_port = busy.local_addr().expect("an address").port();
    let free = free_port();
    let server = CallbackServer::bind(&[busy_port, free]).expect("the second port is free");
    assert_eq!(server.port(), free, "the busy port was skipped");
    drop(busy);
}

#[test]
fn every_port_busy_is_a_typed_error() {
    let busy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("a listener");
    let busy_port = busy.local_addr().expect("an address").port();
    let error = CallbackServer::bind(&[busy_port]).expect_err("the only port is taken");
    assert_eq!(
        error,
        CallbackError::PortsUnavailable {
            ports: vec![busy_port]
        }
    );
}

// ---- the happy path ----------------------------------------------------

#[test]
fn the_redirect_is_answered_with_a_page_in_english_and_spanish() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let state = "fictional-state-0001";
    let handle = std::thread::spawn(move || server.wait(state, Duration::from_secs(10)));

    // Give the accept loop a moment; the connect retries would be noise.
    std::thread::sleep(Duration::from_millis(30));
    let response = get(port, "code=fictional-code-0001&state=fictional-state-0001");

    assert!(
        status(&response).contains("200"),
        "unexpected status line: {}",
        status(&response)
    );
    assert!(response.contains("Content-Type: text/html; charset=utf-8"));
    assert!(response.contains("You can close this tab"));
    assert!(response.contains("Puedes cerrar esta pestaña"));
    assert!(response.contains("Cache-Control: no-store"));

    let outcome = handle.join().expect("the wait finished").expect("a code");
    assert_eq!(outcome.code, "fictional-code-0001");
    assert_eq!(outcome.state, "fictional-state-0001");
}

#[test]
fn the_whole_flow_returns_the_code_and_the_port() {
    let port = free_port();
    let state = "fictional-state-0002";
    let handle =
        std::thread::spawn(move || wait_for_redirect(state, &[port], Duration::from_secs(10)));
    std::thread::sleep(Duration::from_millis(30));
    let response = get(port, "code=fictional-code-0002&state=fictional-state-0002");
    assert!(status(&response).contains("200"));

    let (outcome, answered_port) = handle.join().expect("the wait finished").expect("a code");
    assert_eq!(outcome.code, "fictional-code-0002");
    assert_eq!(answered_port, port);
}

#[test]
fn the_code_is_percent_decoded_and_a_plus_is_kept() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let state = "fictional-state-0003";
    let handle = std::thread::spawn(move || server.wait(state, Duration::from_secs(10)));
    std::thread::sleep(Duration::from_millis(30));
    // An authorization code is not form data: `+` is a plus, `%2F` a slash.
    get(port, "state=fictional-state-0003&code=a%2Bb%2Fc+d%3D");
    let outcome = handle.join().expect("the wait finished").expect("a code");
    assert_eq!(outcome.code, "a+b/c+d=");
}

// ---- the cases that must not end the wait ------------------------------

#[test]
fn a_wrong_state_is_refused_and_the_wait_goes_on() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let state = "fictional-state-0004";
    let handle = std::thread::spawn(move || server.wait(state, Duration::from_secs(10)));
    std::thread::sleep(Duration::from_millis(30));

    let refused = get(port, "code=fictional-code&state=not-our-state");
    assert!(
        status(&refused).contains("400"),
        "a wrong state is a bad request: {}",
        status(&refused)
    );

    let accepted = get(port, "code=fictional-code-0004&state=fictional-state-0004");
    assert!(status(&accepted).contains("200"));
    let outcome = handle.join().expect("the wait finished").expect("a code");
    assert_eq!(outcome.code, "fictional-code-0004");
}

#[test]
fn a_redirect_without_a_state_is_refused() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let handle =
        std::thread::spawn(move || server.wait("fictional-state", Duration::from_millis(400)));
    std::thread::sleep(Duration::from_millis(30));
    let response = get(port, "code=fictional-code");
    assert!(status(&response).contains("400"), "{}", status(&response));
    drop(handle.join());
}

#[test]
fn a_request_for_another_path_and_another_method_are_answered_without_ending_the_wait() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let state = "fictional-state-0005";
    let handle = std::thread::spawn(move || server.wait(state, Duration::from_secs(10)));
    std::thread::sleep(Duration::from_millis(30));

    let favicon = raw(port, "GET /favicon.ico HTTP/1.1");
    assert!(status(&favicon).contains("404"), "{}", status(&favicon));

    let posted = raw(port, "POST /callback HTTP/1.1");
    assert!(status(&posted).contains("405"), "{}", status(&posted));

    let health = raw(port, "GET / HTTP/1.1");
    assert!(status(&health).contains("404"), "{}", status(&health));

    let accepted = get(port, "code=fictional-code-0005&state=fictional-state-0005");
    assert!(status(&accepted).contains("200"));
    let outcome = handle.join().expect("the wait finished").expect("a code");
    assert_eq!(outcome.code, "fictional-code-0005");
}

#[test]
fn the_bank_saying_no_is_a_typed_denial() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let state = "fictional-state-0006";
    let handle = std::thread::spawn(move || server.wait(state, Duration::from_secs(10)));
    std::thread::sleep(Duration::from_millis(30));

    let response = get(
        port,
        "state=fictional-state-0006&error=access_denied&error_description=Cancelled+by+user",
    );
    assert!(
        status(&response).contains("200"),
        "the user still needs a page: {}",
        status(&response)
    );
    assert!(response.contains("The bank did not authorize the access"));

    match handle.join().expect("the wait finished") {
        Err(CallbackError::Denied { error, description }) => {
            assert_eq!(error, "access_denied");
            assert_eq!(
                description.as_deref(),
                Some("Cancelled+by+user"),
                "a plus is kept as it came, like in an authorization code"
            );
        }
        other => panic!("expected Denied, got {other:?}"),
    }
}

// ---- the deadline ------------------------------------------------------

#[test]
fn the_wait_times_out() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let started = Instant::now();
    let error = server
        .wait("fictional-state", Duration::from_millis(150))
        .expect_err("nobody connected");
    assert_eq!(error, CallbackError::Timeout);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn a_mismatch_with_no_valid_redirect_is_reported_as_a_mismatch() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let handle =
        std::thread::spawn(move || server.wait("fictional-state", Duration::from_millis(300)));
    std::thread::sleep(Duration::from_millis(30));
    get(port, "code=fictional-code&state=someone-elses-state");
    assert_eq!(
        handle.join().expect("the wait finished"),
        Err(CallbackError::StateMismatch)
    );
}

#[test]
fn an_empty_state_cannot_be_checked_and_is_refused() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    assert_eq!(
        server.wait("", Duration::from_secs(1)),
        Err(CallbackError::MissingState)
    );
}

// ---- nothing is echoed -------------------------------------------------

#[test]
fn a_script_in_the_query_never_reaches_the_page() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let state = "fictional-state-0007";
    let handle = std::thread::spawn(move || server.wait(state, Duration::from_secs(10)));
    std::thread::sleep(Duration::from_millis(30));

    let response = get(
        port,
        "code=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=fictional-state-0007",
    );
    assert!(status(&response).contains("200"));
    assert!(
        !response.contains("<script>"),
        "the page echoed the request: {response}"
    );
    let outcome = handle.join().expect("the wait finished").expect("a code");
    assert_eq!(
        outcome.code, "<script>alert(1)</script>",
        "the caller still gets the code as the bank sent it"
    );
    // And the outcome never prints it.
    assert!(!format!("{outcome:?}").contains("script"));
}

#[test]
fn a_script_in_the_state_never_reaches_the_page() {
    let port = free_port();
    let server = CallbackServer::bind(&[port]).expect("a free port");
    let handle =
        std::thread::spawn(move || server.wait("fictional-state", Duration::from_millis(200)));
    std::thread::sleep(Duration::from_millis(30));
    let response = get(
        port,
        "code=fictional&state=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    );
    assert!(
        !response.contains("<script>"),
        "the page echoed the state: {response}"
    );
    assert_eq!(
        handle.join().expect("the wait finished"),
        Err(CallbackError::StateMismatch)
    );
}
