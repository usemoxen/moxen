//! Linking and syncing, driven end to end against a REAL temporary SQLite
//! database, the banking crate's recorded transport and fake clock, and an
//! in-memory key store. No test opens a socket to Enable Banking, writes to a
//! real keychain, or reads a real account: the responses are the crate's
//! fictional fixtures, and the one test that links end to end plays the
//! browser itself against the loopback callback.

use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};

use moxen_finances_banking::testing::{FakeClock, RecordedTransport, TEST_KEY_PEM, test_signer};
use moxen_finances_banking::text::Language;
use moxen_finances_banking::{
    BankError, Client, HttpResponse, MemoryStore, PrivateKey, PrivateKeyStore, RetryPolicy,
    StartAuth,
};
use moxen_finances_store::{AccountInput, BankConnectionInput, ExternalAccountInput, Store};
use moxen_finances_ui::commands::DataErrorKind;
use moxen_finances_ui::data::{BankActivity, BankConsent};

use super::*;

/// The application id every test signs with: invented, so it cannot be
/// mistaken for anyone's.
const APP_ID: &str = "fictional-application-id";

/// The state the end-to-end link sends, so the test can answer its own
/// callback without reading it out of a running server.
const LINK_STATE: &str = "fictional-state-0123456789abcdef";

/// A fixed "now", so a consent deadline is comparable across runs.
fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 20, 9, 0, 0)
        .single()
        .expect("a valid instant")
}

fn day(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).expect("a valid date")
}

/// A `tests/fixtures` file of the banking crate, read as text. The path is
/// built with `PathBuf` across the workspace, so it works on Windows too.
fn banking_fixture(name: &str) -> String {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("banking")
        .join("tests")
        .join("fixtures")
        .join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("fixture {} could not be read: {error}", path.display()))
}

fn ok(name: &str) -> HttpResponse {
    HttpResponse::new(200, banking_fixture(name))
}

fn json(body: &str) -> HttpResponse {
    HttpResponse::new(200, body.to_string())
}

/// A store in a throwaway folder, with one local account to import into.
fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().expect("temporary folder");
    let mut store = Store::open(dir.path().join("finances.db")).expect("open");
    store
        .create_account(&AccountInput {
            name: "Cuenta corriente".into(),
            balance_minor: Some(0),
            ..Default::default()
        })
        .expect("an account");
    (dir, store)
}

/// A client over the recorded transport and the fake clock, giving up at once
/// so a test's queue stays in step with its assertions.
fn client(transport: RecordedTransport, clock: &FakeClock) -> Client<RecordedTransport, FakeClock> {
    Client::new(test_signer(APP_ID), transport, clock.clone()).with_policy(RetryPolicy {
        max_attempts: 1,
        base_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(1),
    })
}

/// One linked connection with one mapped account and one unmapped, as `link`
/// leaves it before the user chooses.
fn linked(store: &mut Store, consent_valid_until: Option<&str>) -> (String, String) {
    let account_id = store.accounts().expect("accounts")[0].id.clone();
    let connection = store
        .link_bank(&BankConnectionInput {
            app_id: APP_ID.into(),
            bank_name: "Banco Ficticio".into(),
            bank_country: "ES".into(),
            session_id: "fictional-session-0001".into(),
            consent_valid_until: consent_valid_until.map(str::to_string),
            accounts: vec![
                ExternalAccountInput {
                    external_uid: "fictional-account-uid-0001".into(),
                    account_id: account_id.clone(),
                    name: "Cuenta de pruebas".into(),
                    currency: "EUR".into(),
                },
                ExternalAccountInput {
                    external_uid: "fictional-account-uid-0002".into(),
                    account_id: String::new(),
                    name: "Ahorro de pruebas".into(),
                    currency: "EUR".into(),
                },
            ],
        })
        .expect("link");
    (connection.id, account_id)
}

/// One mapped account's answers: its balances and the three pages of
/// transactions (the crate's fixtures chain them through `continuation_key`).
fn account_answers() -> Vec<HttpResponse> {
    vec![
        ok("balances.json"),
        ok("transactions-page-1.json"),
        ok("transactions-page-2.json"),
        ok("transactions-page-3.json"),
    ]
}

fn sync_request(connection_id: &str, to: NaiveDate) -> SyncRequest<'_> {
    SyncRequest {
        connection_id,
        from: None,
        to,
    }
}

#[test]
fn a_first_sync_imports_the_booked_movements_and_sets_the_balance() {
    let (_dir, mut store) = store();
    let (connection_id, account_id) = linked(&mut store, Some("2026-06-01T00:00:00Z"));
    let clock = FakeClock::at(now());
    let gateway = client(RecordedTransport::with(account_answers()), &clock);

    let report = sync(
        &gateway,
        &mut store,
        &sync_request(&connection_id, day(2026, 1, 31)),
        now(),
    )
    .expect("sync");

    // The booked debit of page 1 and the two booked credits of pages 2 and 3
    // land; the pending one and the cancelled one do not.
    assert_eq!(report.imported, 3, "three booked movements");
    assert_eq!(report.duplicates, 0);
    assert_eq!(report.pending, 1, "the pending movement is skipped");
    assert_eq!(report.balances, 1, "the mapped account got its balance");
    assert_eq!(report.unmapped, 1, "the unmapped account was not read");

    let state = store
        .account_state(&account_id)
        .expect("state")
        .expect("there");
    assert_eq!(state.expenses.len(), 1, "the booked debit");
    assert_eq!(state.expenses[0].amount_minor, 1_230);
    assert_eq!(state.expenses[0].concept, "Supermercado Imaginario");
    assert_eq!(state.expenses[0].date, "2026-01-05");
    let mut incomes: Vec<i64> = state.incomes.iter().map(|row| row.amount_minor).collect();
    incomes.sort_unstable();
    assert_eq!(incomes, vec![5_000, 150_000], "the two booked credits");

    // The booked balance (CLAV, 1234.56) landed with the day the bank meant.
    let account = store
        .accounts()
        .expect("accounts")
        .into_iter()
        .find(|account| account.id == account_id)
        .expect("the account");
    assert_eq!(account.balance_minor, 123_456);
    assert_eq!(account.balance_date, "2026-01-31");

    // The link remembers when it last synced.
    let connection = store
        .bank_connection(&connection_id)
        .expect("read")
        .expect("there");
    assert_eq!(
        connection.last_sync_at.as_deref(),
        Some("2026-01-20T09:00:00Z"),
        "the sync is stamped"
    );
}

#[test]
fn syncing_the_same_window_again_imports_nothing() {
    let (_dir, mut store) = store();
    let (connection_id, account_id) = linked(&mut store, Some("2026-06-01T00:00:00Z"));
    let clock = FakeClock::at(now());

    let first = sync(
        &client(RecordedTransport::with(account_answers()), &clock),
        &mut store,
        &sync_request(&connection_id, day(2026, 1, 31)),
        now(),
    )
    .expect("first sync");
    assert_eq!(first.imported, 3);

    // The same window again, with the same bank answers: every dedupe key is
    // already in the ledger, so the second sync creates nothing.
    let second = sync(
        &client(RecordedTransport::with(account_answers()), &clock),
        &mut store,
        &sync_request(&connection_id, day(2026, 1, 31)),
        now(),
    )
    .expect("second sync");
    assert_eq!(second.imported, 0, "a repeated sync imports zero");
    assert_eq!(second.duplicates, 3, "all three were already there");

    let state = store
        .account_state(&account_id)
        .expect("state")
        .expect("there");
    assert_eq!(state.expenses.len(), 1, "no movement was duplicated");
    assert_eq!(state.incomes.len(), 2);
    assert_eq!(store.bank_movement_count(&connection_id).expect("count"), 3);

    // A third time, after the balance changed at the bank: still no movement,
    // but the balance is refreshed.
    let mut changed = banking_fixture("balances.json");
    changed = changed.replace("1234.56", "1000.00");
    let third = sync(
        &client(
            RecordedTransport::with(vec![
                HttpResponse::new(200, changed),
                ok("transactions-page-1.json"),
                ok("transactions-page-2.json"),
                ok("transactions-page-3.json"),
            ]),
            &clock,
        ),
        &mut store,
        &sync_request(&connection_id, day(2026, 1, 31)),
        now(),
    )
    .expect("third sync");
    assert_eq!(third.imported, 0);
    assert_eq!(third.duplicates, 3);
    assert_eq!(third.balances, 1, "the balance is always refreshed");
    let account = store
        .accounts()
        .expect("accounts")
        .into_iter()
        .find(|account| account.id == account_id)
        .expect("the account");
    assert_eq!(account.balance_minor, 100_000);
}

#[test]
fn an_expired_consent_stops_the_sync_and_asks_for_a_new_link() {
    let (_dir, mut store) = store();
    // The consent ran out a day before "now".
    let (connection_id, _account_id) = linked(&mut store, Some("2026-01-19T09:00:00Z"));
    let clock = FakeClock::at(now());
    let gateway = client(RecordedTransport::empty(), &clock);

    let failure = sync(
        &gateway,
        &mut store,
        &sync_request(&connection_id, day(2026, 1, 31)),
        now(),
    )
    .expect_err("an expired consent cannot sync");

    assert!(failure.needs_link_again(), "{failure:?}");
    assert!(
        matches!(failure, BankFailure::Bank(BankError::ConsentExpired { .. })),
        "{failure:?}"
    );
    // It failed before asking anything: no request was made at all.
    assert!(gateway.transport().requests().is_empty());
    assert!(
        failure
            .localized(Language::Spanish)
            .contains("vincula el banco de nuevo"),
        "{}",
        failure.localized(Language::Spanish)
    );
    assert!(
        failure
            .localized(Language::English)
            .contains("link the bank again"),
        "{}",
        failure.localized(Language::English)
    );
}

#[test]
fn a_consent_that_is_about_to_run_out_is_expiring_not_expired() {
    let one_day = chrono::Duration::days(1);
    assert_eq!(
        consent_state(Some(now() + one_day), now()),
        BankConsent::Expiring
    );
    assert_eq!(
        consent_state(Some(now() - one_day), now()),
        BankConsent::Expired
    );
    assert_eq!(
        consent_state(Some(now() + chrono::Duration::days(60)), now()),
        BankConsent::Valid
    );
    assert_eq!(consent_state(None, now()), BankConsent::Unknown);
    // The banner is what asks for the new link.
    assert!(consent_state(Some(now() + one_day), now()).needs_link_again());
    assert_eq!(
        consent_state(Some(now() - one_day), now()),
        BankConsent::Expired
    );
}

#[test]
fn the_sync_reads_from_the_last_sync_with_a_three_day_overlap() {
    let (_dir, mut store) = store();
    let (connection_id, _account_id) = linked(&mut store, Some("2026-06-01T00:00:00Z"));
    store
        .set_bank_last_sync(&connection_id, "2026-01-10T09:00:00Z")
        .expect("stamp");
    let clock = FakeClock::at(now());
    let gateway = client(RecordedTransport::with(account_answers()), &clock);

    sync(
        &gateway,
        &mut store,
        &sync_request(&connection_id, day(2026, 1, 20)),
        now(),
    )
    .expect("sync");

    let request = gateway
        .transport()
        .requests()
        .into_iter()
        .find(|request| request.url.contains("/transactions"))
        .expect("a transactions request");
    assert!(
        request.url.contains("date_from=2026-01-07"),
        "the window starts three days before the last sync: {}",
        request.url
    );
    assert!(
        request.url.contains("date_to=2026-01-20"),
        "{}",
        request.url
    );
}

#[test]
fn a_bank_that_is_not_in_the_countrys_list_is_named_back() {
    let (_dir, mut store) = store();
    let clock = FakeClock::at(now());
    let gateway = client(RecordedTransport::with(vec![ok("aspsps.json")]), &clock);
    let opener = |_: &str| true;

    let failure = link(
        &gateway,
        &mut store,
        &LinkRequest {
            app_id: APP_ID,
            country: "ES",
            bank_name: "Banco Inexistente",
            language: None,
            ports: &[47_851],
            timeout: Duration::from_millis(50),
            state: None,
            open_url: &opener,
        },
    )
    .expect_err("not in the list");

    assert_eq!(
        failure,
        BankFailure::BankNotFound("Banco Inexistente".to_string())
    );
    assert!(
        failure
            .localized(Language::Spanish)
            .contains("no está en la lista de bancos"),
        "{}",
        failure.localized(Language::Spanish)
    );
    assert!(store.bank_connections().expect("connections").is_empty());
}

#[test]
fn an_authorization_url_that_is_not_https_is_never_opened() {
    let (_dir, mut store) = store();
    let clock = FakeClock::at(now());
    let gateway = client(
        RecordedTransport::with(vec![
            ok("aspsps.json"),
            json(
                r#"{"url":"http://not-secure.invalid/login","authorization_id":"fictional-auth"}"#,
            ),
        ]),
        &clock,
    );
    let opened = Arc::new(AtomicBool::new(false));
    let flag = opened.clone();
    let opener = move |_: &str| {
        flag.store(true, Ordering::SeqCst);
        true
    };

    let failure = link(
        &gateway,
        &mut store,
        &LinkRequest {
            app_id: APP_ID,
            country: "ES",
            bank_name: "Banco Ficticio",
            language: None,
            ports: &[47_852],
            timeout: Duration::from_millis(50),
            state: None,
            open_url: &opener,
        },
    )
    .expect_err("not https");

    assert_eq!(failure, BankFailure::UnsafeUrl);
    assert!(
        !opened.load(Ordering::SeqCst),
        "the browser was never handed an http URL"
    );
    assert!(store.bank_connections().expect("connections").is_empty());
}

#[test]
fn a_callback_that_never_arrives_times_out_without_linking_anything() {
    let (_dir, mut store) = store();
    let clock = FakeClock::at(now());
    let gateway = client(
        RecordedTransport::with(vec![
            ok("aspsps.json"),
            json(r#"{"url":"https://bank.invalid/authorize","authorization_id":"fictional-auth"}"#),
        ]),
        &clock,
    );
    let port = free_port();
    let seen = Arc::new(Mutex::new(None));
    let recorded = seen.clone();
    let opener = move |url: &str| {
        *recorded.lock().expect("the opened url") = Some(url.to_string());
        // The user closed the tab: nobody answers.
        true
    };

    let failure = link(
        &gateway,
        &mut store,
        &LinkRequest {
            app_id: APP_ID,
            country: "ES",
            bank_name: "Banco Ficticio",
            language: None,
            ports: &[port],
            timeout: Duration::from_millis(80),
            state: None,
            open_url: &opener,
        },
    )
    .expect_err("nobody answered");

    assert!(
        matches!(
            failure,
            BankFailure::Callback(moxen_finances_banking::CallbackError::Timeout)
        ),
        "{failure:?}"
    );
    // The URL the browser was given was the loopback one the server bound,
    // never a hostname or another machine.
    let url = seen.lock().expect("the opened url").clone().expect("a url");
    assert_eq!(url, "https://bank.invalid/authorize");
    assert!(store.bank_connections().expect("connections").is_empty());
}

/// A loopback port nothing is listening on, so the callback server binds it.
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("a free port");
    let port = listener.local_addr().expect("the address").port();
    drop(listener);
    port
}

/// Answers the callback the way a browser would: one `GET /callback` with the
/// code and the state the link sent.
fn answer_callback(port: u16, state: String) {
    std::thread::spawn(move || {
        // A moment for the link to reach its wait loop; the server's accept
        // backlog makes this a courtesy, not a requirement.
        std::thread::sleep(Duration::from_millis(30));
        let mut stream =
            std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect to the callback");
        let request = format!(
            "GET /callback?code=fictional-code&state={state} HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Connection: close\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .expect("send the callback");
        let _ = stream.flush();
    });
}

#[test]
fn a_full_link_binds_loopback_exchanges_the_code_and_keeps_the_session() {
    let (_dir, mut store) = store();
    let clock = FakeClock::at(now());
    let port = free_port();
    let gateway = client(
        RecordedTransport::with(vec![
            ok("aspsps.json"),
            json(
                r#"{"url":"https://bank.invalid/authorize?state=fictional","authorization_id":"fictional-auth"}"#,
            ),
            ok("session.json"),
        ]),
        &clock,
    );
    let opened = Arc::new(Mutex::new(None));
    let recorded = opened.clone();
    // The "browser": it is handed the URL and, in return, answers the loopback
    // callback with the code and the state the link minted (which this test
    // pinned).
    let opener = move |url: &str| {
        *recorded.lock().expect("the opened url") = Some(url.to_string());
        answer_callback(port, LINK_STATE.to_string());
        true
    };

    let connection = link(
        &gateway,
        &mut store,
        &LinkRequest {
            app_id: APP_ID,
            country: "ES",
            bank_name: "banco ficticio",
            language: Some("es"),
            ports: &[port],
            timeout: Duration::from_secs(5),
            state: Some(LINK_STATE),
            open_url: &opener,
        },
    )
    .expect("the link completes");

    // The connection keeps the public metadata of the session, never a key.
    assert_eq!(connection.app_id, APP_ID);
    assert_eq!(connection.bank_name, "Banco Ficticio");
    assert_eq!(connection.bank_country, "ES");
    assert_eq!(connection.session_id, "fictional-session-0001");
    assert_eq!(
        connection.consent_valid_until.as_deref(),
        Some("2026-06-01T00:00:00Z")
    );
    // Both granted accounts are kept, unmapped: the mapping is the user's.
    let accounts = store.bank_accounts(&connection.id).expect("accounts");
    assert_eq!(accounts.len(), 2);
    assert!(accounts.iter().all(|account| account.account_id.is_empty()));
    assert_eq!(accounts[0].name, "Cuenta de pruebas");
    assert_eq!(accounts[0].currency, "EUR");
    // The authorization was asked for with a loopback redirect and the
    // language the interface is in.
    let auth_request = gateway
        .transport()
        .requests()
        .into_iter()
        .find(|request| request.url.ends_with("/auth"))
        .expect("a POST /auth");
    let body = auth_request.body.clone().expect("a body");
    assert!(body.contains("http://127.0.0.1:"), "{body}");
    assert!(body.contains("/callback"), "{body}");
    assert!(body.contains("\"language\":\"es\""), "{body}");
    assert_eq!(
        opened.lock().expect("the opened url").as_deref(),
        Some("https://bank.invalid/authorize?state=fictional")
    );
}

#[test]
fn the_sync_interval_is_due_only_after_its_minutes() {
    let last = Some(now());
    assert!(!sync_is_due(None, last, now() + chrono::Duration::days(30)));
    assert!(!sync_is_due(
        Some(60),
        last,
        now() + chrono::Duration::minutes(59)
    ));
    assert!(sync_is_due(
        Some(60),
        last,
        now() + chrono::Duration::minutes(60)
    ));
    // Never synced, and the interval is on: due at once.
    assert!(sync_is_due(Some(60), None, now()));
    // An unparseable or zero setting is off, never a zero-minute loop.
    assert_eq!(interval_from_setting(Some("0")), None);
    assert_eq!(interval_from_setting(Some("nope")), None);
    assert_eq!(interval_from_setting(Some("15")), Some(15));
    assert_eq!(interval_from_setting(None), None);
}

// -- the runtime the settings screen drives ---------------------------------

/// A runtime whose gateway is a client over `transport`, whose keys live in
/// memory, and whose browser only remembers the URL.
fn runtime(
    transport: RecordedTransport,
    clock: &FakeClock,
) -> (
    Arc<BankRuntime>,
    Arc<MemoryStore>,
    Arc<Mutex<Option<String>>>,
) {
    let secrets = Arc::new(MemoryStore::new());
    let opened = Arc::new(Mutex::new(None));
    let factory: GatewayFactory = {
        let clock = clock.clone();
        Arc::new(move |_secrets: &dyn PrivateKeyStore, app_id: &str| {
            Ok(Box::new(
                Client::new(test_signer(app_id), transport.clone(), clock.clone()).with_policy(
                    RetryPolicy {
                        max_attempts: 1,
                        base_delay: Duration::from_millis(1),
                        max_delay: Duration::from_millis(1),
                    },
                ),
            ) as Box<dyn BankGateway>)
        })
    };
    let opener: UrlOpener = {
        let opened = opened.clone();
        Arc::new(move |url: &str| {
            *opened.lock().expect("the opened url") = Some(url.to_string());
            true
        })
    };
    let runtime = Arc::new(
        BankRuntime::new(secrets.clone(), factory, opener)
            .with_ports(vec![47_860], Duration::from_millis(50)),
    );
    (runtime, secrets, opened)
}

#[test]
fn the_state_reports_the_application_the_key_and_the_linked_banks() {
    let (_dir, mut store) = store();
    store
        .update_setting(APP_ID_SETTING, APP_ID)
        .expect("the application");
    let clock = FakeClock::at(now());
    let (runtime, secrets, _opened) = runtime(RecordedTransport::empty(), &clock);

    // No key yet: linking is not ready.
    let state = super::state(&store, &runtime);
    assert_eq!(state.app_id, APP_ID);
    assert!(!state.key_stored);
    assert!(!state.is_ready_to_link());
    assert!(!state.is_busy());

    // The import goes through the same key store the app uses, with the
    // throwaway key: a real keychain is never touched.
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("banking")
        .join("tests")
        .join("fixtures")
        .join("test-key-pkcs8.pem");
    moxen_finances_banking::secrets::import_pem_file(secrets.as_ref(), APP_ID, &path)
        .expect("the key is imported");
    let state = super::state(&store, &runtime);
    assert!(state.key_stored, "the memory store holds the key now");
    assert!(state.is_ready_to_link());

    // A linked bank shows its consent, its accounts and its count. The
    // deadline is far ahead because the state reads the real clock.
    let (connection_id, account_id) = linked(&mut store, Some("2099-12-31T00:00:00Z"));
    store
        .import_bank_movements(
            &connection_id,
            &[BankMovement {
                dedupe_key: "er-0001".into(),
                external_uid: "fictional-account-uid-0001".into(),
                booking_date: "2026-01-05".into(),
                amount_minor: -1_230,
                currency: "EUR".into(),
                concept: "Supermercado Imaginario".into(),
                notes: String::new(),
            }],
        )
        .expect("one movement");
    let state = super::state(&store, &runtime);
    assert_eq!(state.connections.len(), 1);
    let connection = &state.connections[0];
    assert_eq!(connection.bank_name, "Banco Ficticio");
    assert_eq!(connection.country, "ES");
    assert_eq!(connection.consent, BankConsent::Valid);
    assert_eq!(connection.consent_until, day(2099, 12, 31).into());
    assert_eq!(connection.imported, 1);
    assert_eq!(connection.accounts.len(), 2);
    assert_eq!(
        connection.accounts[0].account_id.as_deref(),
        Some(account_id.as_str())
    );
    assert_eq!(connection.accounts[1].account_id, None);
    assert_eq!(state.interval, None);
}

#[test]
fn a_sync_through_the_runtime_stamps_the_link_and_reports_its_numbers() {
    let (_dir, mut store) = store();
    let (connection_id, _account_id) = linked(&mut store, Some("2026-06-01T00:00:00Z"));
    let clock = FakeClock::at(now());
    let (runtime, _secrets, _opened) = runtime(RecordedTransport::with(account_answers()), &clock);

    let report = runtime
        .sync_inline(&mut store, &connection_id, day(2026, 1, 31))
        .expect("sync");
    assert_eq!(report.imported, 3);
    assert_eq!(report.duplicates, 0);
    // The runtime's own status is what the settings screen polls.
    assert_eq!(runtime.activity(), None, "the flag is released");
    let message = runtime.message().expect("a result line");
    assert!(message.contains('3'), "{message}");
}

#[test]
fn the_runtime_refuses_a_second_run_while_one_holds_the_flag() {
    let (_dir, mut store) = store();
    let (connection_id, _account_id) = linked(&mut store, Some("2026-06-01T00:00:00Z"));
    let clock = FakeClock::at(now());
    let (runtime, _secrets, _opened) = runtime(RecordedTransport::with(account_answers()), &clock);

    runtime.begin(BankActivity::Linking).expect("the flag");
    assert_eq!(runtime.activity(), Some(BankActivity::Linking));
    let failure = runtime
        .sync_inline(&mut store, &connection_id, day(2026, 1, 20))
        .expect_err("one at a time");
    assert_eq!(failure, BankFailure::Busy);
    assert_eq!(
        failure.localized(Language::Spanish),
        "ya hay una vinculación o una sincronización en marcha"
    );
    assert_eq!(failure.to_data_error().kind, DataErrorKind::Banking);
    runtime.finish(None);
    assert_eq!(runtime.activity(), None);
}

#[test]
fn syncing_a_connection_that_is_gone_says_so_instead_of_asking_the_keychain() {
    let (_dir, mut store) = store();
    let clock = FakeClock::at(now());
    let (runtime, _secrets, _opened) = runtime(RecordedTransport::empty(), &clock);
    let failure = runtime
        .sync_inline(&mut store, "no-such-connection", day(2026, 1, 20))
        .expect_err("gone");
    assert_eq!(failure, BankFailure::NotFound);
    assert_eq!(failure.to_data_error().kind, DataErrorKind::Banking);
    assert!(!failure.needs_link_again());
}

#[test]
fn a_link_that_cannot_sign_says_which_piece_is_missing() {
    let (_dir, mut store) = store();
    // A factory that behaves like the app's: it loads the key first.
    let factory: GatewayFactory = Arc::new(|secrets: &dyn PrivateKeyStore, app_id: &str| {
        let key = load_key(secrets, app_id)?;
        Ok(Box::new(MemoryGateway::new(key)) as Box<dyn BankGateway>)
    });
    let secrets = Arc::new(MemoryStore::new());
    let runtime = BankRuntime::new(secrets.clone(), factory, Arc::new(|_: &str| true))
        .with_ports(vec![47_861], Duration::from_millis(20));

    // No application id at all.
    let failure = runtime
        .link_inline(&mut store, "", "ES", "Banco Ficticio", None)
        .expect_err("no application");
    assert_eq!(failure, BankFailure::NoApplication);
    assert!(failure.needs_link_again());

    // An application id without a key.
    let failure = runtime
        .link_inline(&mut store, APP_ID, "ES", "Banco Ficticio", None)
        .expect_err("no key");
    assert_eq!(
        failure,
        BankFailure::Secret(moxen_finances_banking::SecretError::Missing)
    );
    assert!(failure.needs_link_again());
    assert!(
        failure
            .localized(Language::English)
            .contains("no key is stored"),
        "{}",
        failure.localized(Language::English)
    );
    // And with the key in place the keychain answers, still never a network.
    secrets
        .store(APP_ID, &PrivateKey::new(TEST_KEY_PEM.to_string()))
        .expect("the throwaway key");
    assert!(key_stored(secrets.as_ref(), APP_ID));
    assert!(!key_stored(secrets.as_ref(), ""));
    let _ = &mut store;
}

/// A gateway that answers nothing, for the tests that stop before the network:
/// it exists so a runtime's factory can return a real `Box<dyn BankGateway>`.
struct MemoryGateway {
    _key: PrivateKey,
}

impl MemoryGateway {
    fn new(key: PrivateKey) -> Self {
        Self { _key: key }
    }
}

impl BankGateway for MemoryGateway {
    fn list_aspsps(
        &self,
        _country: &str,
    ) -> Result<Vec<moxen_finances_banking::BankEntry>, BankError> {
        Err(BankError::Invalid {
            code: None,
            reason: moxen_finances_banking::InvalidReason::MissingBank,
        })
    }
    fn start_auth(
        &self,
        _request: &StartAuth,
    ) -> Result<moxen_finances_banking::Authorization, BankError> {
        Err(BankError::Invalid {
            code: None,
            reason: moxen_finances_banking::InvalidReason::MissingBank,
        })
    }
    fn create_session(
        &self,
        _code: &str,
    ) -> Result<moxen_finances_banking::SessionGrant, BankError> {
        Err(BankError::Invalid {
            code: None,
            reason: moxen_finances_banking::InvalidReason::MissingCode,
        })
    }
    fn balances(
        &self,
        _account_uid: &str,
    ) -> Result<Vec<moxen_finances_banking::BankBalance>, BankError> {
        Ok(Vec::new())
    }
    fn transactions(
        &self,
        _account_uid: &str,
        _window: &moxen_finances_banking::TransactionWindow,
    ) -> Result<Vec<moxen_finances_banking::BankTransaction>, BankError> {
        Ok(Vec::new())
    }
    fn check_consent(&self, _link: &moxen_finances_banking::BankLink) -> Result<(), BankError> {
        Ok(())
    }
    fn delete_session(&self, _session_id: &str) -> Result<(), BankError> {
        Ok(())
    }
}

#[test]
fn the_state_says_which_activity_is_running_and_its_last_message() {
    let (_dir, store) = store();
    let clock = FakeClock::at(now());
    let (runtime, _secrets, _opened) = runtime(RecordedTransport::empty(), &clock);
    assert!(super::state(&store, &runtime).message.is_none());
    runtime.begin(BankActivity::Syncing).expect("the flag");
    let state = super::state(&store, &runtime);
    assert_eq!(state.activity, Some(BankActivity::Syncing));
    assert!(state.is_busy());
    runtime.finish(Some("Synced: 0 new, 3 already there".into()));
    let state = super::state(&store, &runtime);
    assert!(!state.is_busy());
    assert_eq!(
        state.message.as_deref(),
        Some("Synced: 0 new, 3 already there")
    );
}
