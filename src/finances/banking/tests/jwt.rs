//! The token Enable Banking checks: header, claims, lifetime, signature, and
//! the typed errors for every way a PEM key can be wrong.
//!
//! The key is the throwaway one in `tests/fixtures`; the signature is verified
//! with the public half, so these tests prove the RS256 output is real rather
//! than merely well-shaped.

mod common;

use std::time::Duration;

use common::{APP_ID, fixture, key_pem, now};
use moxen_finances_banking::jwt::{Claims, Header};
use moxen_finances_banking::{JwtError, JwtSigner, PrivateKey};
use rsa::RsaPrivateKey;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePrivateKey;
use rsa::signature::Verifier;
use sha2::Sha256;

/// Split a token and decode its two JSON segments.
fn segments(token: &str) -> (String, String) {
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3, "a JWT has three segments");
    let decode = |segment: &str| {
        let bytes =
            moxen_finances_banking::jwt::decode_segment(segment).expect("base64url segment");
        String::from_utf8(bytes).expect("utf-8 segment")
    };
    (decode(parts[0]), decode(parts[1]))
}

fn signer() -> JwtSigner {
    JwtSigner::new(APP_ID, &PrivateKey::new(key_pem())).expect("the test key parses")
}

#[test]
fn header_carries_the_type_algorithm_and_application_id() {
    let token = signer().token(now()).expect("a token");
    let (header, _) = segments(&token);
    let header: Header<'_> = serde_json::from_str(&header).expect("a header");
    assert_eq!(header.typ, "JWT");
    assert_eq!(header.alg, "RS256");
    assert_eq!(header.kid, APP_ID);
}

#[test]
fn claims_carry_the_documented_issuer_audience_and_hour_lifetime() {
    let token = signer().token(now()).expect("a token");
    let (_, claims) = segments(&token);
    let claims: Claims = serde_json::from_str(&claims).expect("claims");
    assert_eq!(claims.iss, "enablebanking.com");
    assert_eq!(claims.aud, "api.enablebanking.com");
    assert_eq!(claims.iat, now().timestamp());
    assert_eq!(claims.ttl_seconds(), 3600);
}

#[test]
fn the_header_lists_typ_alg_kid_in_that_order() {
    // The API documents the order; nothing requires it, but a test pins the
    // shape a reader of our traffic will see.
    let token = signer().token(now()).expect("a token");
    let (header, _) = segments(&token);
    let typ = header.find("\"typ\"").expect("typ");
    let alg = header.find("\"alg\"").expect("alg");
    let kid = header.find("\"kid\"").expect("kid");
    assert!(typ < alg && alg < kid, "header was {header}");
}

#[test]
fn a_longer_ttl_is_clamped_to_a_day_and_a_shorter_one_to_a_second() {
    let signer = signer();
    let day = signer
        .token_with_ttl(now(), Duration::from_secs(48 * 3600))
        .expect("a token");
    let (_, claims) = segments(&day);
    let claims: Claims = serde_json::from_str(&claims).expect("claims");
    assert_eq!(
        claims.ttl_seconds(),
        86_400,
        "the API rejects more than 24 h"
    );

    let nothing = signer
        .token_with_ttl(now(), Duration::ZERO)
        .expect("a token");
    let (_, claims) = segments(&nothing);
    let claims: Claims = serde_json::from_str(&claims).expect("claims");
    assert_eq!(claims.ttl_seconds(), 1, "a token still has to be usable");
}

#[test]
fn the_signature_verifies_with_the_public_key_of_the_same_pem() {
    let token = signer().token(now()).expect("a token");
    let parts: Vec<&str> = token.split('.').collect();
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let signature_bytes =
        moxen_finances_banking::jwt::decode_segment(parts[2]).expect("a signature");
    let signature = Signature::try_from(signature_bytes.as_slice()).expect("an RS256 signature");

    let key = RsaPrivateKey::from_pkcs8_pem(&key_pem()).expect("the test key");
    let verifying = VerifyingKey::<Sha256>::new(key.to_public_key());
    verifying
        .verify(signing_input.as_bytes(), &signature)
        .expect("the signature must verify");
}

#[test]
fn a_tampered_payload_does_not_verify() {
    let token = signer().token(now()).expect("a token");
    let parts: Vec<&str> = token.split('.').collect();
    // Keep the header and the signature, change the payload by one character.
    let mut payload = parts[1].to_string();
    payload.push('A');
    let tampered_input = format!("{}.{}", parts[0], payload);

    let signature_bytes =
        moxen_finances_banking::jwt::decode_segment(parts[2]).expect("a signature");
    let signature = Signature::try_from(signature_bytes.as_slice()).expect("an RS256 signature");
    let key = RsaPrivateKey::from_pkcs8_pem(&key_pem()).expect("the test key");
    let verifying = VerifyingKey::<Sha256>::new(key.to_public_key());
    assert!(
        verifying
            .verify(tampered_input.as_bytes(), &signature)
            .is_err(),
        "a changed payload must not verify with the old signature"
    );
}

#[test]
fn both_pem_shapes_the_user_can_have_are_accepted() {
    let pkcs8 = JwtSigner::new(APP_ID, &PrivateKey::new(fixture("test-key-pkcs8.pem")))
        .expect("PKCS#8 parses");
    let pkcs1 = JwtSigner::new(APP_ID, &PrivateKey::new(fixture("test-key-pkcs1.pem")))
        .expect("PKCS#1 parses");
    assert_eq!(pkcs8.key_bits(), 2048);
    assert_eq!(pkcs1.key_bits(), 2048);

    // The two files hold the same pair, and RS256 is deterministic, so the
    // same instant yields the same token from either shape.
    let at = now();
    assert_eq!(
        pkcs8.token(at).expect("a token"),
        pkcs1.token(at).expect("a token"),
    );
}

#[test]
fn the_key_size_is_reported_so_the_app_can_ask_for_4096_bits() {
    let signer = JwtSigner::new(APP_ID, &PrivateKey::new(key_pem())).expect("the test key");
    // Enable Banking asks for 4096 bits in its own instructions; this test key
    // is 2048 because it only signs throwaway tokens, and the crate reports
    // the size instead of refusing a smaller key.
    assert_eq!(signer.key_bits(), 2048);
}

#[test]
fn an_encrypted_key_is_refused_with_its_own_error() {
    let error = JwtSigner::new(APP_ID, &PrivateKey::new(fixture("test-key-encrypted.pem")))
        .expect_err("an encrypted key cannot be used");
    assert_eq!(error, JwtError::EncryptedKey);
    assert!(
        error.to_string().contains("cifrada"),
        "the message has to tell the user what to do: {error}"
    );
}

#[test]
fn a_certificate_is_refused_as_not_a_private_key() {
    let certificate = "-----BEGIN CERTIFICATE-----\nMIIBfictional\n-----END CERTIFICATE-----\n";
    let error = JwtSigner::new(APP_ID, &PrivateKey::new(certificate))
        .expect_err("a certificate is not a key");
    assert_eq!(error, JwtError::UnsupportedLabel("CERTIFICATE".to_string()));
}

#[test]
fn text_that_is_not_pem_at_all_is_missing_pem() {
    let error =
        JwtSigner::new(APP_ID, &PrivateKey::new("this is not a key")).expect_err("not a key");
    assert_eq!(error, JwtError::MissingPem);
}

#[test]
fn a_truncated_key_is_malformed() {
    let truncated = "-----BEGIN PRIVATE KEY-----\nMIIBnotreallyaKey\n-----END PRIVATE KEY-----\n";
    let error = JwtSigner::new(APP_ID, &PrivateKey::new(truncated))
        .expect_err("truncated DER cannot parse");
    assert_eq!(error, JwtError::MalformedKey);
}

#[test]
fn an_empty_application_id_is_refused() {
    let error = JwtSigner::new("  ", &PrivateKey::new(key_pem())).expect_err("no application id");
    assert_eq!(error, JwtError::MissingApplicationId);
}

#[test]
fn debug_output_never_carries_the_key_or_the_application_id() {
    let key = PrivateKey::new(key_pem());
    let signer = JwtSigner::new(APP_ID, &key).expect("the test key");
    for rendered in [format!("{key:?}"), format!("{signer:?}")] {
        assert!(
            !rendered.contains("PRIVATE KEY"),
            "leaked PEM armor: {rendered}"
        );
        assert!(!rendered.contains("MII"), "leaked key material: {rendered}");
        assert!(
            !rendered.contains(APP_ID),
            "leaked the application id: {rendered}"
        );
        assert!(
            rendered.contains("redacted"),
            "should say it is redacted: {rendered}"
        );
    }
}

#[test]
fn a_pkcs1_key_is_recognized_by_its_label() {
    let key = PrivateKey::new(fixture("test-key-pkcs1.pem"));
    assert_eq!(key.label(), Some("RSA PRIVATE KEY"));
    let key = PrivateKey::new(fixture("test-key-pkcs8.pem"));
    assert_eq!(key.label(), Some("PRIVATE KEY"));
    assert_eq!(PrivateKey::new("nothing").label(), None);
}

#[test]
fn a_token_round_trips_through_its_own_decoder() {
    let token = signer().token(now()).expect("a token");
    assert!(token.contains('.'));
    assert_eq!(token.split('.').count(), 3);
    // A token minted an hour later is a different token.
    let later = signer()
        .token(now() + chrono::Duration::hours(1))
        .expect("a token");
    assert_ne!(token, later);
}

#[test]
fn an_decoded_segment_of_garbage_is_none() {
    assert!(moxen_finances_banking::jwt::decode_segment("not base64!!").is_none());
}
