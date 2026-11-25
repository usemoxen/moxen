//! An optional smoke test against the user's own Enable Banking sandbox
//! application.
//!
//! It is `#[ignore]`d twice over: it never runs by default, and it does nothing
//! unless BOTH environment variables are set, so CI stays offline and no
//! worker ever needs a credential:
//!
//! ```text
//! ENABLE_BANKING_SANDBOX_APP_ID   the application id of the user's sandbox app
//! ENABLE_BANKING_SANDBOX_KEY_FILE path to that app's private key (PEM)
//! ```
//!
//! Run it on purpose:
//!
//! ```text
//! cargo test -p moxen-finances-banking --test sandbox_smoke -- --ignored --nocapture
//! ```
//!
//! It reads the bank list of one country and prints how many banks came back.
//! It never prints the application id, the key, the token or a bank's data.

use std::time::Duration;

use moxen_finances_banking::{Client, JwtSigner, PrivateKey, SystemClock, UreqTransport};

/// The two variables, read together. `None` means "not configured", which is
/// the normal state of a checkout.
fn sandbox_credentials() -> Option<(String, String)> {
    let app_id = std::env::var("ENABLE_BANKING_SANDBOX_APP_ID").ok()?;
    let key_file = std::env::var("ENABLE_BANKING_SANDBOX_KEY_FILE").ok()?;
    if app_id.trim().is_empty() || key_file.trim().is_empty() {
        return None;
    }
    Some((app_id, key_file))
}

#[test]
#[ignore = "needs ENABLE_BANKING_SANDBOX_APP_ID and ENABLE_BANKING_SANDBOX_KEY_FILE"]
fn the_sandbox_lists_the_banks_of_spain() {
    let Some((app_id, key_file)) = sandbox_credentials() else {
        println!(
            "skipped: set ENABLE_BANKING_SANDBOX_APP_ID and ENABLE_BANKING_SANDBOX_KEY_FILE \
             to run this smoke test"
        );
        return;
    };

    // Read the key without ever echoing the path's contents. A failure to read
    // it reports the kind of error, not the bytes.
    let pem = std::fs::read_to_string(&key_file)
        .unwrap_or_else(|error| panic!("the key file could not be read: {}", error.kind()));
    let signer = JwtSigner::new(app_id, &PrivateKey::new(pem)).expect("a signable key");
    let transport = UreqTransport::new(Duration::from_secs(30));
    let client = Client::new(signer, transport, SystemClock);

    let banks = client.list_aspsps("ES").expect("the sandbox answers");
    assert!(!banks.is_empty(), "the sandbox has banks");

    // The only output: a count. No application id, no token, no accounts.
    println!("{} banks listed for ES", banks.len());
}
