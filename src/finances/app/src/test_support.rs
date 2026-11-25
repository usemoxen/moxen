//! Shared test plumbing for the app's bank sync: the banking crate's fictional
//! fixtures, a runtime over a recorded transport and an in-memory key store,
//! and a data source over an in-memory database so a link and a sync run on the
//! calling thread.
//!
//! Compiled only for tests (`#[cfg(test)]` in `main.rs`), and no part of it
//! touches a real keychain, browser, network or personal database.

use std::sync::Arc;

use moxen_finances_banking::testing::{FakeClock, RecordedTransport, test_signer};
use moxen_finances_banking::{Client, HttpResponse, MemoryStore, RetryPolicy};
use moxen_finances_store::{AccountInput, BankConnectionInput, ExternalAccountInput, Store};

use crate::bank_sync::{BankGateway, BankRuntime, GatewayFactory};
use crate::store_data::StoreData;

/// The application id every app test signs with: invented, so it cannot be
/// mistaken for anyone's.
pub const BANK_APP_ID: &str = "fictional-application-id";

/// A `tests/fixtures` file of the banking crate, as a path.
pub fn banking_fixture_path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("banking")
        .join("tests")
        .join("fixtures")
        .join(name)
}

/// The same file, read as text.
pub fn banking_fixture(name: &str) -> String {
    let path = banking_fixture_path(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// A bank runtime over a recorded transport and an in-memory key store, so a
/// test never touches a keychain, a browser or a network.
pub fn bank_runtime(responses: Vec<HttpResponse>) -> (Arc<BankRuntime>, Arc<MemoryStore>) {
    let secrets = Arc::new(MemoryStore::new());
    let transport = RecordedTransport::with(responses);
    let factory: GatewayFactory = Arc::new(move |_secrets, app_id: &str| {
        let clock = FakeClock::at(chrono::Utc::now());
        Ok(Box::new(
            Client::new(test_signer(app_id), transport.clone(), clock).with_policy(RetryPolicy {
                max_attempts: 1,
                base_delay: std::time::Duration::from_millis(1),
                max_delay: std::time::Duration::from_millis(1),
            }),
        ) as Box<dyn BankGateway>)
    });
    let runtime = BankRuntime::new(secrets.clone(), factory, Arc::new(|_: &str| true));
    (Arc::new(runtime), secrets)
}

/// A data source over an in-memory store (so a link and a sync run on the
/// calling thread) with one local account.
pub fn memory_data(runtime: Arc<BankRuntime>) -> StoreData {
    let mut store = Store::open_in_memory().expect("memory store");
    store
        .create_account(&AccountInput {
            name: "Cuenta corriente".into(),
            balance_minor: Some(0),
            ..Default::default()
        })
        .expect("an account");
    StoreData::with_bank_runtime(store, runtime).expect("store data")
}

/// One linked connection in `data`'s store, with one mapped account and one
/// that is still unmapped. Returns the connection's id and the mapped local
/// account's id.
pub fn linked_in_store(data: &StoreData, consent_valid_until: &str) -> (String, String) {
    let mut store = data.store_mut();
    let account_id = store.accounts().expect("accounts")[0].id.clone();
    let connection = store
        .link_bank(&BankConnectionInput {
            app_id: BANK_APP_ID.into(),
            bank_name: "Banco Ficticio".into(),
            bank_country: "ES".into(),
            session_id: "fictional-session-0001".into(),
            consent_valid_until: Some(consent_valid_until.into()),
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
