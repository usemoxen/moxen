//! The key's journey: imported once from a file, kept by a store, loaded for a
//! signer, and never rendered anywhere.
//!
//! No test here touches the real keychain: [`MemoryStore`] implements the same
//! trait, and the one test that wants the platform keychain is `#[ignore]`d and
//! uses its own service name and a fictional application id.

mod common;

use std::path::PathBuf;

use moxen_finances_banking::secrets::import_pem_file;
use moxen_finances_banking::{
    JwtError, KeychainStore, MemoryStore, PrivateKey, PrivateKeyStore, SecretError,
};

use common::{APP_ID, fixture};

/// A temporary directory per test, so nothing writes outside it.
fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("a temporary directory")
}

fn write(dir: &tempfile::TempDir, name: &str, contents: &str) -> PathBuf {
    let path = dir.path().join(name);
    std::fs::write(&path, contents).expect("the fixture file");
    path
}

#[test]
fn the_memory_store_keeps_and_forgets_a_key() {
    let store = MemoryStore::new();
    assert!(store.is_empty());

    let key = PrivateKey::new(fixture("test-key-pkcs8.pem"));
    store.store(APP_ID, &key).expect("stored");
    assert_eq!(store.len(), 1);

    let loaded = store.load(APP_ID).expect("loaded");
    assert_eq!(loaded.as_str(), key.as_str());

    store.forget(APP_ID).expect("forgotten");
    assert!(store.is_empty());
    assert_eq!(store.load(APP_ID).expect_err("gone"), SecretError::Missing);
    // Forgetting something that is not there is not an error: the caller wanted
    // it gone.
    store.forget(APP_ID).expect("forgetting twice is fine");
}

#[test]
fn each_application_id_is_its_own_entry() {
    let store = MemoryStore::new();
    store
        .store(
            "fictional-application-a",
            &PrivateKey::new(fixture("test-key-pkcs8.pem")),
        )
        .expect("stored");
    store
        .store(
            "fictional-application-b",
            &PrivateKey::new(fixture("test-key-pkcs1.pem")),
        )
        .expect("stored");
    assert_eq!(store.len(), 2);
    assert_ne!(
        store.load("fictional-application-a").expect("a").as_str(),
        store.load("fictional-application-b").expect("b").as_str()
    );
}

#[test]
fn importing_reads_the_file_checks_it_and_keeps_only_the_key() {
    let dir = temp_dir();
    let path = write(&dir, "enable-banking.pem", &fixture("test-key-pkcs8.pem"));
    let store = MemoryStore::new();

    import_pem_file(&store, APP_ID, &path).expect("imported");
    let loaded = store.load(APP_ID).expect("loaded");
    assert!(loaded.as_str().starts_with("-----BEGIN PRIVATE KEY-----"));
    assert!(
        !loaded.as_str().contains(path.to_string_lossy().as_ref()),
        "the path must not travel with the key"
    );

    // The file can go away: the key is in the store now, and once it is in a
    // keychain the file is not needed again.
    std::fs::remove_file(&path).expect("the file is gone");
    assert!(store.load(APP_ID).is_ok());
}

#[test]
fn importing_a_certificate_is_refused_while_the_user_is_still_there() {
    let dir = temp_dir();
    let path = write(
        &dir,
        "public.crt",
        "-----BEGIN CERTIFICATE-----\nMIIBfictional\n-----END CERTIFICATE-----\n",
    );
    let store = MemoryStore::new();
    let error = import_pem_file(&store, APP_ID, &path).expect_err("a certificate is not a key");
    assert!(matches!(
        error,
        SecretError::NotAKey(JwtError::UnsupportedLabel(_))
    ));
    assert!(store.is_empty(), "nothing was stored");
    assert!(!format!("{error:?}").contains("MIIBfictional"));
}

#[test]
fn importing_an_encrypted_key_is_refused_with_the_reason() {
    let dir = temp_dir();
    let path = write(&dir, "encrypted.pem", &fixture("test-key-encrypted.pem"));
    let store = MemoryStore::new();
    let error = import_pem_file(&store, APP_ID, &path).expect_err("encrypted keys are refused");
    assert!(matches!(
        error,
        SecretError::NotAKey(JwtError::EncryptedKey)
    ));
    assert!(store.is_empty());
}

#[test]
fn importing_an_empty_file_is_refused() {
    let dir = temp_dir();
    let path = write(&dir, "empty.pem", "  \n\n");
    let store = MemoryStore::new();
    assert_eq!(
        import_pem_file(&store, APP_ID, &path).expect_err("empty"),
        SecretError::EmptyKey
    );
    assert!(store.is_empty());
}

#[test]
fn a_missing_file_reports_the_path_and_the_kind_and_nothing_else() {
    let dir = temp_dir();
    let path = dir.path().join("not-there.pem");
    let store = MemoryStore::new();
    let error = import_pem_file(&store, APP_ID, &path).expect_err("no file");
    match &error {
        SecretError::Io {
            path: reported,
            kind,
        } => {
            assert_eq!(reported, &path);
            assert_eq!(*kind, std::io::ErrorKind::NotFound);
        }
        other => panic!("expected Io, got {other:?}"),
    }
    assert!(store.is_empty());
}

#[test]
fn a_key_and_a_store_render_themselves_without_their_contents() {
    let store = MemoryStore::new();
    store
        .store(APP_ID, &PrivateKey::new(fixture("test-key-pkcs8.pem")))
        .expect("stored");

    let key = PrivateKey::new(fixture("test-key-pkcs8.pem"));
    for rendered in [
        format!("{key:?}"),
        format!("{store:?}"),
        format!("{store:#?}"),
    ] {
        assert!(
            !rendered.contains("PRIVATE KEY"),
            "leaked armor: {rendered}"
        );
        assert!(!rendered.contains("MII"), "leaked material: {rendered}");
    }
    assert!(format!("{store:?}").contains("1 stored"));
}

#[test]
fn an_error_never_carries_the_key() {
    let dir = temp_dir();
    let path = write(&dir, "private.pem", &fixture("test-key-pkcs8.pem"));
    // A key that names no application: the error must not quote the key.
    let store = MemoryStore::new();
    let error = import_pem_file(&store, "  ", &path).expect_err("no application id");
    let rendered = format!("{error} {error:?}");
    assert!(
        !rendered.contains("PRIVATE KEY"),
        "leaked armor: {rendered}"
    );
    assert!(!rendered.contains("MII"), "leaked material: {rendered}");
}

#[test]
fn the_keychain_store_names_its_service_and_hides_everything_else() {
    let store = KeychainStore::new();
    assert_eq!(store.service(), "Moxen Finances — Enable Banking");
    let rendered = format!("{store:?}");
    assert!(rendered.contains("Enable Banking"), "{rendered}");
    assert!(!rendered.contains("PRIVATE"), "{rendered}");

    let custom = KeychainStore::with_service("Moxen Finances — tests");
    assert_eq!(custom.service(), "Moxen Finances — tests");
}

#[test]
fn a_key_loaded_from_a_store_signs_a_token() {
    // The whole path: import, load, sign. The signer is the only consumer of a
    // loaded key, and it needs nothing else.
    let dir = temp_dir();
    let path = write(&dir, "private.pem", &fixture("test-key-pkcs8.pem"));
    let store = MemoryStore::new();
    import_pem_file(&store, APP_ID, &path).expect("imported");

    let key = store.load(APP_ID).expect("loaded");
    let signer = moxen_finances_banking::JwtSigner::new(APP_ID, &key).expect("a signer");
    let token = signer.token(common::now()).expect("a token");
    assert_eq!(token.split('.').count(), 3);
}

/// The platform keychain, opt-in only: it writes a real entry (under its own
/// service name, with a fictional application id) and deletes it again, so it
/// is never part of a normal run.
#[test]
#[ignore = "writes to the platform keychain; run with --ignored on purpose"]
fn the_keychain_store_round_trips_a_fictional_key() {
    let store = KeychainStore::with_service("Moxen Finances — LOCAL-026 test");
    let app_id = "fictional-application-id-for-the-keychain-test";
    let key = PrivateKey::new(fixture("test-key-pkcs8.pem"));

    store.forget(app_id).expect("start clean");
    store.store(app_id, &key).expect("the keychain accepts it");
    let loaded = store.load(app_id).expect("read it back");
    assert_eq!(loaded.as_str(), key.as_str());
    store.forget(app_id).expect("and delete it again");
    assert_eq!(store.load(app_id).expect_err("gone"), SecretError::Missing);
}
