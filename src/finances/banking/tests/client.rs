//! The account-information calls, driven by recorded responses.
//!
//! Every test here uses [`RecordedTransport`]:
//!
//! [`RecordedTransport`]: moxen_finances_banking::testing::RecordedTransport
//!
//! - the request shapes (path, query, headers, body),
//! - the mapping into the neutral shapes,
//! - pagination through `continuation_key` and its cap,
//! - every branch of the error mapping, including the two meanings a 401 can
//!   have,
//! - the retry and the backoff, asserted through the fake clock so nothing
//!   sleeps.

mod common;

use std::time::Duration;

use chrono::NaiveDate;
use common::{client, client_with_policy, fixture, now, ok, shared_clock, transport_error};
use moxen_finances_banking::testing::RecordedTransport;
use moxen_finances_banking::{
    BankError, BankRef, ConsentEnd, HttpRequest, HttpResponse, Localized, PsuType, RetryPolicy,
    StartAuth, TransactionStatus, TransactionWindow, text::Language,
};

fn day(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).expect("a valid date")
}

fn window() -> TransactionWindow {
    TransactionWindow::new(day(2026, 1, 1), day(2026, 1, 31))
}

fn session_id() -> &'static str {
    "fictional-session-0001"
}

fn account_uid() -> &'static str {
    "fictional-account-uid-0001"
}

fn bearer(request: &HttpRequest) -> &str {
    request
        .header("authorization")
        .expect("every request carries a bearer token")
}

// ---- the happy path ----------------------------------------------------

#[test]
fn listing_banks_sends_the_country_and_reads_the_metadata() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![ok("aspsps.json")]);
    let banks = client(transport, &clock)
        .list_aspsps("es")
        .expect("two fictional banks");

    assert_eq!(banks.len(), 2);
    assert_eq!(banks[0].name, "Banco Ficticio");
    assert_eq!(banks[0].country, "ES");
    assert_eq!(banks[0].psu_types, vec!["private".to_string()]);
    assert_eq!(
        banks[0].maximum_consent_validity,
        Some(Duration::from_secs(15_552_000))
    );
    assert!(!banks[0].beta);
    assert!(banks[1].beta);
    assert_eq!(banks[1].bank_ref().name, "Caja de Pruebas");
}

#[test]
fn every_request_is_signed_and_names_the_app() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![ok("aspsps.json")]);
    let client = client(transport, &clock);
    client.list_aspsps("ES").expect("a list of banks");

    let requests = client.transport().requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.method.as_str(), "GET");
    assert_eq!(
        request.url,
        "https://api.enablebanking.com/aspsps?country=ES"
    );
    assert!(bearer(request).starts_with("Bearer "));
    assert_eq!(request.header("accept"), Some("application/json"));
    assert!(
        request
            .header("user-agent")
            .is_some_and(|agent| agent.starts_with("moxen-finances/")),
        "the app names itself, not the person"
    );
    assert!(request.body.is_none());
}

#[test]
fn a_request_debug_never_shows_the_token() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![ok("aspsps.json")]);
    let client = client(transport, &clock);
    client.list_aspsps("ES").expect("a list of banks");

    let request = &client.transport().requests()[0];
    let token = bearer(request).to_string();
    let rendered = format!("{request:?}");
    assert!(
        !rendered.contains(&token),
        "the bearer token leaked: {rendered}"
    );
    assert!(rendered.contains("redacted"), "it says so: {rendered}");
}

#[test]
fn starting_an_authorization_posts_the_documented_body() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![HttpResponse::new(
        200,
        r#"{
            "url": "https://auth.enablebanking.com/ais/start?sessionid=fictional",
            "authorization_id": "fictional-authorization-0001",
            "psu_id_hash": "fictional-psu-hash"
        }"#,
    )]);
    let client = client(transport, &clock);
    let request = StartAuth {
        bank: BankRef {
            name: "Banco Ficticio".to_string(),
            country: "ES".to_string(),
        },
        state: "fictional-state-0001".to_string(),
        redirect_url: "http://127.0.0.1:47831/callback".to_string(),
        psu_type: PsuType::Private,
        language: Some("ES".to_string()),
        valid_until: Some(now() + chrono::Duration::days(90)),
    };
    let authorization = client.start_auth(&request).expect("a link URL");

    assert!(
        authorization
            .url
            .starts_with("https://auth.enablebanking.com/")
    );
    assert_eq!(
        authorization.authorization_id,
        "fictional-authorization-0001"
    );
    assert_eq!(
        authorization.psu_id_hash.as_deref(),
        Some("fictional-psu-hash")
    );

    let requests = client.transport().requests();
    let request = &requests[0];
    assert_eq!(request.method.as_str(), "POST");
    assert_eq!(request.url, "https://api.enablebanking.com/auth");
    assert_eq!(request.header("content-type"), Some("application/json"));
    let body = request.body.as_deref().expect("a JSON body");
    assert!(body.contains("\"name\":\"Banco Ficticio\""), "{body}");
    assert!(body.contains("\"country\":\"ES\""), "{body}");
    assert!(
        body.contains("\"state\":\"fictional-state-0001\""),
        "{body}"
    );
    assert!(
        body.contains("\"redirect_url\":\"http://127.0.0.1:47831/callback\""),
        "{body}"
    );
    assert!(body.contains("\"psu_type\":\"private\""), "{body}");
    assert!(body.contains("\"language\":\"es\""), "lowercased: {body}");
    assert!(
        body.contains("\"valid_until\":\"2026-04-20T09:00:00Z\""),
        "an RFC 3339 instant: {body}"
    );
    // A Debug line of the answer masks the authorization id.
    let rendered = format!("{authorization:?}");
    assert!(
        !rendered.contains("fictional-authorization-0001"),
        "the authorization id leaked: {rendered}"
    );
}

#[test]
fn a_redirect_url_that_is_not_loopback_is_refused_locally() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    let client = client(transport, &clock);
    let mut request = StartAuth::new(
        BankRef {
            name: "Banco Ficticio".to_string(),
            country: "ES".to_string(),
        },
        "fictional-state-0001",
        "http://127.0.0.1:47831/callback",
    );
    request.redirect_url = "https://example.invalid/callback".to_string();
    let error = client.start_auth(&request).expect_err("a public redirect");
    assert!(
        matches!(error, BankError::Invalid { .. }),
        "expected a local validation error, got {error:?}"
    );
    assert!(
        client.transport().requests().is_empty(),
        "a request refused locally never reaches the transport"
    );
}

#[test]
fn an_empty_state_or_bank_is_refused_before_sending() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    let client = client(transport, &clock);
    let mut request = StartAuth::new(
        BankRef {
            name: "Banco Ficticio".to_string(),
            country: "ES".to_string(),
        },
        "  ",
        "http://127.0.0.1:47831/callback",
    );
    assert!(matches!(
        client.start_auth(&request),
        Err(BankError::Invalid { .. })
    ));

    request.state = "fictional-state".to_string();
    request.bank.name = String::new();
    assert!(matches!(
        client.start_auth(&request),
        Err(BankError::Invalid { .. })
    ));
    assert!(client.transport().requests().is_empty());
}

#[test]
fn a_consent_deadline_in_the_past_is_refused_before_sending() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    let client = client(transport, &clock);
    let request = StartAuth {
        valid_until: Some(now() - chrono::Duration::days(1)),
        ..StartAuth::new(
            BankRef {
                name: "Banco Ficticio".to_string(),
                country: "ES".to_string(),
            },
            "fictional-state",
            "http://localhost:47832/callback",
        )
    };
    assert!(matches!(
        client.start_auth(&request),
        Err(BankError::Invalid { .. })
    ));
    assert!(client.transport().requests().is_empty());
}

#[test]
fn creating_a_session_reads_the_accounts_and_the_consent_deadline() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![ok("session.json")]);
    let client = client(transport, &clock);
    let grant = client
        .create_session("fictional-code-0001")
        .expect("a session");

    assert_eq!(grant.session_id, session_id());
    assert_eq!(grant.accounts.len(), 2);
    assert_eq!(grant.accounts[0].uid, account_uid());
    assert_eq!(
        grant.accounts[0].iban.as_deref(),
        Some("ES0021000418450200051332")
    );
    assert_eq!(grant.accounts[0].name.as_deref(), Some("Cuenta de pruebas"));
    assert_eq!(grant.accounts[0].account_type.as_deref(), Some("CACC"));
    assert_eq!(grant.accounts[1].uid, "fictional-account-uid-0002");
    assert_eq!(
        grant.bank.as_ref().map(|bank| bank.name.as_str()),
        Some("Banco Ficticio")
    );
    assert_eq!(
        grant.consent_valid_until,
        Some(
            chrono::DateTime::parse_from_rfc3339("2026-06-01T00:00:00Z")
                .expect("a valid instant")
                .with_timezone(&chrono::Utc)
        )
    );

    let body = client.transport().requests()[0]
        .body
        .clone()
        .expect("a body");
    assert!(body.contains("\"code\":\"fictional-code-0001\""), "{body}");

    // The session response is shown once: what the app keeps is a link.
    let link = grant.into_link(now()).expect("a durable link");
    assert_eq!(link.account_uids.len(), 2);
    assert_eq!(link.bank.country, "ES");
    assert_eq!(link.linked_at, now());
    let rendered = format!("{link:?}");
    assert!(
        !rendered.contains(session_id()),
        "the session id leaked: {rendered}"
    );
}

#[test]
fn an_empty_authorization_code_is_refused_before_sending() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    let client = client(transport, &clock);
    assert!(matches!(
        client.create_session("   "),
        Err(BankError::Invalid { .. })
    ));
    assert!(client.transport().requests().is_empty());
}

#[test]
fn reading_a_session_reports_its_state() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![ok("session-get.json")]);
    let client = client(transport, &clock);
    let state = client.get_session(session_id()).expect("a session");

    assert_eq!(state.status.as_deref(), Some("AUTHORIZED"));
    assert_eq!(
        state.accounts,
        vec![
            account_uid().to_string(),
            "fictional-account-uid-0002".to_string()
        ]
    );
    assert_eq!(
        state.bank.as_ref().map(|bank| bank.name.as_str()),
        Some("Banco Ficticio")
    );
    assert!(state.consent_valid_until.is_some());
    assert_eq!(
        state.authorized,
        Some(
            chrono::DateTime::parse_from_rfc3339("2026-01-15T10:30:00Z")
                .expect("a valid instant")
                .with_timezone(&chrono::Utc)
        )
    );
    let request = &client.transport().requests()[0];
    assert_eq!(
        request.url,
        format!("https://api.enablebanking.com/sessions/{}", session_id())
    );
}

#[test]
fn account_details_read_the_extended_shape() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![ok("account-details.json")]);
    let client = client(transport, &clock);
    let account = client.account_details(account_uid()).expect("an account");

    assert_eq!(account.uid, account_uid());
    assert_eq!(account.iban.as_deref(), Some("ES0021000418450200051332"));
    assert_eq!(account.product.as_deref(), Some("Cuenta Ficticia"));
    assert_eq!(account.usage.as_deref(), Some("PRIV"));
    assert_eq!(
        client.transport().requests()[0].url,
        format!(
            "https://api.enablebanking.com/accounts/{}/details",
            account_uid()
        )
    );
}

#[test]
fn balances_are_minor_units_and_keep_their_sign() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![ok("balances.json")]);
    let client = client(transport, &clock);
    let balances = client.balances(account_uid()).expect("two balances");

    assert_eq!(balances.len(), 2);
    assert_eq!(balances[0].amount_minor, 123_456);
    assert_eq!(balances[0].currency, "EUR");
    assert_eq!(balances[0].balance_type.as_deref(), Some("CLAV"));
    assert_eq!(balances[0].reference_date, Some(day(2026, 1, 31)));
    assert_eq!(
        balances[1].amount_minor, -2_500,
        "an overdraft stays negative"
    );
}

#[test]
fn transactions_follow_every_page_and_drop_what_never_happened() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![
        ok("transactions-page-1.json"),
        ok("transactions-page-2.json"),
        ok("transactions-page-3.json"),
    ]);
    let client = client(transport, &clock);
    let transactions = client
        .transactions(account_uid(), &window())
        .expect("four transactions");

    assert_eq!(transactions.len(), 4, "the cancelled one is not a movement");
    assert_eq!(transactions[0].amount_minor, -1_230);
    assert_eq!(transactions[0].status, TransactionStatus::Booked);
    assert_eq!(transactions[0].booking_date, day(2026, 1, 5));
    assert_eq!(transactions[0].value_date, Some(day(2026, 1, 6)));
    assert_eq!(
        transactions[0].counterparty.as_deref(),
        Some("Supermercado Imaginario"),
        "a debit is with the creditor"
    );
    assert_eq!(
        transactions[0].remittance.as_deref(),
        Some("Compra ficticia\nTarjeta **** 0000")
    );
    assert_eq!(
        transactions[0].entry_reference.as_deref(),
        Some("FICT-0001")
    );
    assert!(transactions[0].dedupe_key.starts_with("er-"));

    assert_eq!(transactions[1].status, TransactionStatus::Pending);
    assert!(transactions[1].dedupe_key.starts_with("syn-"));
    assert_eq!(transactions[1].entry_reference, None);

    assert_eq!(transactions[2].amount_minor, 150_000);
    assert_eq!(
        transactions[2].counterparty.as_deref(),
        Some("Empresa Ficticia, S.L."),
        "a credit is with the debtor"
    );
    assert_eq!(transactions[3].amount_minor, 5_000);

    let requests = client.transport().requests();
    assert_eq!(requests.len(), 3, "three recorded pages");
    assert_eq!(
        requests[0].url,
        format!(
            "https://api.enablebanking.com/accounts/{}/transactions?date_from=2026-01-01&date_to=2026-01-31",
            account_uid()
        )
    );
    assert!(
        requests[1]
            .url
            .contains("continuation_key=ZmljdGlvbmFsLXBhZ2UtMg%3D%3D"),
        "the key is percent-encoded: {}",
        requests[1].url
    );
    assert!(
        requests[2]
            .url
            .contains("continuation_key=fictional-page-3"),
        "{}",
        requests[2].url
    );
}

#[test]
fn a_page_cap_stops_a_runaway_pagination() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![
        ok("transactions-page-1.json"),
        ok("transactions-page-2.json"),
    ]);
    let client = client(transport, &clock);
    let error = client
        .transactions(account_uid(), &window().with_page_cap(2))
        .expect_err("the second page still has a continuation key");
    assert!(matches!(error, BankError::Invalid { .. }), "{error:?}");
    assert_eq!(
        client.transport().requests().len(),
        2,
        "no third request after the cap"
    );
}

#[test]
fn a_repeated_continuation_key_does_not_loop_forever() {
    let clock = shared_clock();
    let mut page = fixture("transactions-page-2.json").clone();
    page = page.replace("\"fictional-page-3\"", "\"ZmljdGlvbmFsLXBhZ2UtMg==\"");
    let transport = RecordedTransport::with(vec![
        ok("transactions-page-1.json"),
        HttpResponse::new(200, page),
    ]);
    let client = client(transport, &clock);
    let error = client
        .transactions(account_uid(), &window())
        .expect_err("the same key twice cannot end");
    assert!(matches!(error, BankError::Invalid { .. }), "{error:?}");
    assert!(
        error
            .localized(Language::Spanish)
            .contains("repitió la clave de continuación"),
        "{error}"
    );
    assert!(
        error
            .localized(Language::English)
            .contains("repeated the continuation key"),
        "and the English sentence says the same: {error}"
    );
}

#[test]
fn a_backwards_window_is_refused_before_sending() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    let client = client(transport, &clock);
    let backwards = TransactionWindow::new(day(2026, 2, 1), day(2026, 1, 1));
    assert!(matches!(
        client.transactions(account_uid(), &backwards),
        Err(BankError::Invalid { .. })
    ));
    assert!(client.transport().requests().is_empty());
}

#[test]
fn an_empty_account_uid_is_refused_before_sending() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    let client = client(transport, &clock);
    assert!(matches!(
        client.balances(" "),
        Err(BankError::Invalid { .. })
    ));
    assert!(matches!(
        client.account_details(""),
        Err(BankError::Invalid { .. })
    ));
    assert!(matches!(
        client.get_session(""),
        Err(BankError::Invalid { .. })
    ));
    assert!(client.transport().requests().is_empty());
}

#[test]
fn deleting_a_session_asks_for_nothing_and_returns_nothing() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![HttpResponse::new(200, "{\"message\":\"OK\"}")]);
    let client = client(transport, &clock);
    client.delete_session(session_id()).expect("deleted");

    let request = &client.transport().requests()[0];
    assert_eq!(request.method.as_str(), "DELETE");
    assert_eq!(
        request.url,
        format!("https://api.enablebanking.com/sessions/{}", session_id())
    );
}

#[test]
fn fields_the_crate_does_not_read_are_ignored() {
    // The session fixture carries `all_account_ids`, `identification_hash`,
    // `psu_status` and `legal_age`; the aspsps one carries `sandbox`,
    // `auth_methods` and `services`. Reading them must not fail.
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![ok("session.json"), ok("aspsps.json")]);
    let client = client(transport, &clock);
    assert!(client.create_session("fictional-code").is_ok());
    assert!(client.list_aspsps("ES").is_ok());
}

// ---- the error mapping ------------------------------------------------

fn error_response(status: u16, body: &str) -> HttpResponse {
    HttpResponse::new(status, body)
}

#[test]
fn a_rejected_application_token_is_unauthorized() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![error_response(
        401,
        r#"{"message":"Authorization header is not provided","code":401,"error":"AUTHORIZATION_NOT_PROVIDED"}"#,
    )]);
    let client = client(transport, &clock);
    let error = client.list_aspsps("ES").expect_err("401");

    match &error {
        BankError::Unauthorized { code, .. } => {
            assert_eq!(code.as_deref(), Some("AUTHORIZATION_NOT_PROVIDED"))
        }
        other => panic!("expected Unauthorized, got {other:?}"),
    }
    assert!(
        !error.needs_link_again(),
        "a key problem is not a consent problem"
    );
    assert_eq!(client.transport().requests().len(), 1, "401 is not retried");
}

#[test]
fn an_expired_session_is_a_link_again_not_an_unauthorized() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![error_response(
        401,
        r#"{"message":"Session is expired","code":401,"error":"EXPIRED_SESSION"}"#,
    )]);
    let client = client(transport, &clock);
    let error = client
        .balances(account_uid())
        .expect_err("401 on a session");

    assert_eq!(
        error,
        BankError::ConsentExpired {
            reason: ConsentEnd::Expired
        }
    );
    assert!(error.needs_link_again());
    assert!(
        error
            .localized(Language::Spanish)
            .contains("vincula el banco de nuevo"),
        "the message points at the fix: {error}"
    );
}

#[test]
fn a_revoked_or_closed_session_says_which_it_was() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![
        error_response(
            403,
            r#"{"message":"Session is revoked","error":"REVOKED_SESSION"}"#,
        ),
        error_response(
            403,
            r#"{"message":"Session is closed","error":"CLOSED_SESSION"}"#,
        ),
    ]);
    let client = client(transport, &clock);
    assert_eq!(
        client.balances(account_uid()).expect_err("revoked"),
        BankError::ConsentExpired {
            reason: ConsentEnd::Revoked
        }
    );
    assert_eq!(
        client.account_details(account_uid()).expect_err("closed"),
        BankError::ConsentExpired {
            reason: ConsentEnd::Closed
        }
    );
}

#[test]
fn a_401_on_a_session_without_a_known_code_is_still_a_link_again() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![error_response(
        401,
        r#"{"message":"Unauthorized access"}"#,
    )]);
    let client = client(transport, &clock);
    assert_eq!(
        client.balances(account_uid()).expect_err("401"),
        BankError::ConsentExpired {
            reason: ConsentEnd::Unspecified
        }
    );
}

#[test]
fn a_401_on_an_application_call_is_never_a_link_again() {
    // The same status, the other meaning: the app's own services were denied,
    // so asking the user to link again would loop.
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![error_response(
        403,
        r#"{"message":"Access to this resource is denied","error":"ACCESS_DENIED"}"#,
    )]);
    let client = client(transport, &clock);
    let error = client.create_session("fictional-code").expect_err("403");
    match error {
        BankError::Unauthorized { code, .. } => assert_eq!(code.as_deref(), Some("ACCESS_DENIED")),
        other => panic!("expected Unauthorized, got {other:?}"),
    }
}

#[test]
fn a_rate_limit_honours_retry_after_and_then_succeeds() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![
        error_response(429, r#"{"message":"Too Many Requests"}"#).with_header("Retry-After", "2"),
        ok("aspsps.json"),
    ]);
    let client = client(transport, &clock);
    let banks = client.list_aspsps("ES").expect("the retry succeeded");

    assert_eq!(banks.len(), 2);
    assert_eq!(client.clock().slept(), vec![Duration::from_secs(2)]);
    assert_eq!(client.transport().requests().len(), 2);
}

#[test]
fn a_rate_limit_without_a_hint_backs_off_exponentially_and_gives_up() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![
        error_response(429, r#"{"message":"Too Many Requests"}"#),
        error_response(429, r#"{"message":"Too Many Requests"}"#),
        error_response(429, r#"{"message":"Too Many Requests"}"#),
    ]);
    let policy = RetryPolicy {
        max_attempts: 3,
        base_delay: Duration::from_millis(10),
        max_delay: Duration::from_secs(1),
    };
    let client = client_with_policy(transport, &clock, policy);
    let error = client.list_aspsps("ES").expect_err("three attempts");

    assert_eq!(
        error,
        BankError::RateLimited {
            retry_after: None,
            attempts: 3
        }
    );
    assert_eq!(
        client.clock().slept(),
        vec![Duration::from_millis(10), Duration::from_millis(20)],
        "doubling, and only between attempts"
    );
}

#[test]
fn retry_after_is_capped_by_the_policy() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![
        error_response(429, r#"{"message":"Too Many Requests"}"#)
            .with_header("Retry-After", "3600"),
        ok("aspsps.json"),
    ]);
    let policy = RetryPolicy {
        max_attempts: 2,
        base_delay: Duration::from_millis(1),
        max_delay: Duration::from_secs(30),
    };
    let client = client_with_policy(transport, &clock, policy);
    client
        .list_aspsps("ES")
        .expect("succeeds on the second attempt");
    assert_eq!(
        client.clock().slept(),
        vec![Duration::from_secs(30)],
        "an hour is not a wait this app will take"
    );
}

#[test]
fn a_retry_after_date_is_measured_against_the_clock() {
    let clock = shared_clock();
    // 2026-01-20T09:00:15Z is fifteen seconds after the fake clock.
    let transport = RecordedTransport::with(vec![
        error_response(429, r#"{"message":"Too Many Requests"}"#)
            .with_header("Retry-After", "Tue, 20 Jan 2026 09:00:15 GMT"),
        ok("aspsps.json"),
    ]);
    let client = client(transport, &clock);
    client
        .list_aspsps("ES")
        .expect("succeeds on the second attempt");
    assert_eq!(client.clock().slept(), vec![Duration::from_secs(15)]);
}

#[test]
fn a_server_error_is_transient_and_retried() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![
        error_response(503, r#"{"message":"Internal Server Error"}"#),
        ok("session.json"),
    ]);
    let policy = RetryPolicy {
        max_attempts: 2,
        base_delay: Duration::from_millis(5),
        max_delay: Duration::from_secs(1),
    };
    let client = client_with_policy(transport, &clock, policy);
    let grant = client
        .create_session("fictional-code")
        .expect("the retry worked");
    assert_eq!(grant.session_id, session_id());
    assert_eq!(client.clock().slept(), vec![Duration::from_millis(5)]);
}

#[test]
fn an_exhausted_server_error_is_transient_with_its_status() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![
        error_response(500, r#"{"message":"Internal Server Error"}"#),
        error_response(500, r#"{"message":"Internal Server Error"}"#),
    ]);
    let policy = RetryPolicy {
        max_attempts: 2,
        base_delay: Duration::from_millis(1),
        max_delay: Duration::from_secs(1),
    };
    let client = client_with_policy(transport, &clock, policy);
    let error = client
        .create_session("fictional-code")
        .expect_err("500 twice");
    match error {
        BankError::Transient { status, .. } => assert_eq!(status, Some(500)),
        other => panic!("expected Transient, got {other:?}"),
    }
    assert!(error.is_retryable(), "a retry later could work");
}

#[test]
fn a_dropped_connection_is_retried_and_then_reported_as_transport() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    transport.push_error(transport_error());
    transport.push(ok("aspsps.json"));
    let client = client(transport, &clock);
    let banks = client.list_aspsps("ES").expect("the retry worked");
    assert_eq!(banks.len(), 2);
    assert_eq!(client.clock().slept(), vec![Duration::from_secs(1)]);
}

#[test]
fn a_connection_that_never_comes_back_is_a_transport_error() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    transport.push_error(transport_error());
    transport.push_error(transport_error());
    transport.push_error(transport_error());
    let client = client(transport, &clock);
    let error = client.list_aspsps("ES").expect_err("three failures");
    assert!(matches!(error, BankError::Transport(_)), "{error:?}");
    assert!(!error.is_retryable(), "the policy already gave up");
}

#[test]
fn a_bad_request_is_invalid_and_not_retried() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![error_response(
        422,
        r#"{"message":"date_from can not be in the future","code":422,"error":"DATE_FROM_IN_FUTURE"}"#,
    )]);
    let client = client(transport, &clock);
    let error = client
        .transactions(account_uid(), &window())
        .expect_err("422");
    match error {
        BankError::Invalid { code, reason } => {
            assert_eq!(code.as_deref(), Some("DATE_FROM_IN_FUTURE"));
            assert!(
                reason.localized(Language::English).contains("future"),
                "{reason:?}"
            );
            // The service words this one itself, so it is kept verbatim in
            // both languages instead of being translated.
            assert_eq!(
                reason.localized(Language::Spanish),
                "date_from can not be in the future"
            );
        }
        other => panic!("expected Invalid, got {other:?}"),
    }
    assert_eq!(client.transport().requests().len(), 1);
    assert!(client.clock().slept().is_empty(), "nothing waited");
}

#[test]
fn a_body_that_is_not_json_is_invalid_rather_than_a_panic() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![HttpResponse::new(200, "not json at all")]);
    let client = client(transport, &clock);
    assert!(matches!(
        client.list_aspsps("ES"),
        Err(BankError::Invalid { .. })
    ));
}

#[test]
fn an_error_body_that_is_not_json_still_maps_by_status() {
    let clock = shared_clock();
    let transport = RecordedTransport::with(vec![HttpResponse::new(500, "<html>oops</html>")]);
    let policy = RetryPolicy {
        max_attempts: 1,
        base_delay: Duration::from_millis(1),
        max_delay: Duration::from_secs(1),
    };
    let client = client_with_policy(transport, &clock, policy);
    match client.list_aspsps("ES").expect_err("500") {
        BankError::Transient { status, message } => {
            assert_eq!(status, Some(500));
            assert!(!message.is_empty());
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

// ---- consent by the clock ---------------------------------------------

#[test]
fn a_consent_deadline_in_the_past_needs_a_new_link() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    let client = client(transport, &clock);
    let link = moxen_finances_banking::BankLink {
        session_id: session_id().to_string(),
        bank: BankRef {
            name: "Banco Ficticio".to_string(),
            country: "ES".to_string(),
        },
        account_uids: vec![account_uid().to_string()],
        consent_valid_until: now() - chrono::Duration::seconds(1),
        linked_at: now() - chrono::Duration::days(90),
    };
    assert_eq!(
        client.check_consent(&link).expect_err("expired"),
        BankError::ConsentExpired {
            reason: ConsentEnd::ValidUntilPassed
        }
    );
    assert!(
        client.transport().requests().is_empty(),
        "no call was needed"
    );
}

#[test]
fn a_consent_deadline_in_the_future_is_fine() {
    let clock = shared_clock();
    let transport = RecordedTransport::empty();
    let client = client(transport, &clock);
    let link = moxen_finances_banking::BankLink {
        session_id: session_id().to_string(),
        bank: BankRef {
            name: "Banco Ficticio".to_string(),
            country: "ES".to_string(),
        },
        account_uids: vec![account_uid().to_string()],
        consent_valid_until: now() + chrono::Duration::days(1),
        linked_at: now(),
    };
    assert!(client.check_consent(&link).is_ok());
}

// ---- the policy on its own --------------------------------------------

#[test]
fn the_default_policy_is_three_attempts_of_growing_waits() {
    let policy = RetryPolicy::default();
    assert_eq!(policy.max_attempts, 3);
    assert_eq!(policy.delay(1, None), Duration::from_secs(1));
    assert_eq!(policy.delay(2, None), Duration::from_secs(2));
    assert_eq!(
        policy.delay(9, None),
        policy.max_delay,
        "capped, not doubled forever"
    );
    assert_eq!(
        policy.delay(1, Some(Duration::from_secs(7))),
        Duration::from_secs(7),
        "the server's answer wins over the curve"
    );
}
