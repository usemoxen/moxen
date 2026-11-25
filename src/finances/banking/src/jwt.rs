//! The JWT Enable Banking authenticates an application with.
//!
//! Every request carries `Authorization: Bearer <JWT>`, and the JWT is signed
//! with the USER'S private key: their application, their key, one user per
//! key. The header is fixed (`typ` `JWT`, `alg` `RS256`, `kid` the
//! application id) and so are the claims (`iss` `enablebanking.com`, `aud`
//! `api.enablebanking.com`), with `iat`/`exp` as seconds since the epoch. The
//! API rejects a token whose lifetime is longer than 24 hours, so the TTL here
//! is one hour and every longer request is clamped to [`MAX_TTL`].
//!
//! RS256 is PKCS#1 v1.5 over SHA-256, which the `rsa` crate implements in
//! pure Rust; that keeps OpenSSL out of the build on both macOS and Windows,
//! where the TLS stack is also rustls rather than the system library. Signing
//! is deterministic, so the token path pulls no randomness.

use std::fmt;
use std::time::Duration;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use rsa::RsaPrivateKey;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::signature::{SignatureEncoding, Signer};
use rsa::traits::PublicKeyParts;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;

use crate::text::{Language, Localized};

use crate::{JWT_MAX_TTL, JWT_TTL};

/// `typ` and `alg`, fixed by the API: only RS256 is accepted.
const TOKEN_TYPE: &str = "JWT";
const ALGORITHM: &str = "RS256";
/// `iss` and `aud`, fixed by the API.
const ISSUER: &str = "enablebanking.com";
const AUDIENCE: &str = "api.enablebanking.com";

/// The PEM labels this crate signs with: PKCS#8 (`openssl genpkey`) and PKCS#1
/// (`openssl genrsa -traditional`, and what older OpenSSL writes).
const PKCS8_LABEL: &str = "PRIVATE KEY";
const PKCS1_LABEL: &str = "RSA PRIVATE KEY";
const ENCRYPTED_LABEL: &str = "ENCRYPTED PRIVATE KEY";
const PEM_PREFIX: &str = "-----BEGIN ";

/// A private key in PEM form.
///
/// The wrapper exists so that key material cannot reach a log by accident:
/// `Debug` prints a placeholder and neither `Display` nor any error type in
/// this crate ever renders its contents. The bytes still live in a `String`
/// for the lifetime of the value; nothing here writes them anywhere.
pub struct PrivateKey(String);

impl PrivateKey {
    /// Wrap PEM text read from wherever the user pointed.
    pub fn new(pem: impl Into<String>) -> Self {
        Self(pem.into())
    }

    /// The PEM text, for the signer and for nothing else.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The PEM label, without the dashes (`PRIVATE KEY`, `RSA PRIVATE KEY`,
    /// `ENCRYPTED PRIVATE KEY`), or `None` when the text is not PEM at all.
    pub fn label(&self) -> Option<&str> {
        pem_label(&self.0)
    }
}

impl fmt::Debug for PrivateKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrivateKey")
            .field("pem", &"<redacted>")
            .finish()
    }
}

/// Signs the JWT that every request carries.
///
/// Built once per application id (`kid`) and kept for the life of the client;
/// one token is minted per request because minting is a single RSA signature
/// and a stale token is indistinguishable from a rejected one.
pub struct JwtSigner {
    app_id: String,
    key: SigningKey<Sha256>,
}

impl JwtSigner {
    /// Parse the user's PEM key and pair it with their application id.
    pub fn new(app_id: impl Into<String>, private_key: &PrivateKey) -> Result<Self, JwtError> {
        let app_id = app_id.into();
        if app_id.trim().is_empty() {
            return Err(JwtError::MissingApplicationId);
        }
        let key = parse_private_key(private_key.as_str())?;
        Ok(Self {
            app_id: app_id.trim().to_string(),
            key: SigningKey::new(key),
        })
    }

    /// The application id that goes in `kid`. It identifies the application,
    /// not the user, and is never a secret on its own; it is not logged here.
    pub fn app_id(&self) -> &str {
        &self.app_id
    }

    /// The size of the signing key in bits, so a caller can tell the user that
    /// their application needs a 4096-bit key when it is smaller.
    pub fn key_bits(&self) -> usize {
        self.key.as_ref().n().bits()
    }

    /// A token minted at `now` with the crate's one-hour lifetime.
    pub fn token(&self, now: DateTime<Utc>) -> Result<String, JwtError> {
        self.token_with_ttl(now, JWT_TTL)
    }

    /// A token minted at `now`, with `ttl` clamped into `1 s ..= `[`MAX_TTL`].
    /// A zero or negative request still yields a usable one-second token; a
    /// day or more is capped at a day, because the API rejects anything longer.
    pub fn token_with_ttl(&self, now: DateTime<Utc>, ttl: Duration) -> Result<String, JwtError> {
        let ttl = clamp_ttl(ttl);
        let issued_at = now.timestamp();
        let claims = Claims {
            iss: ISSUER.to_string(),
            aud: AUDIENCE.to_string(),
            iat: issued_at,
            exp: issued_at + ttl.as_secs() as i64,
        };
        let header = Header {
            typ: TOKEN_TYPE,
            alg: ALGORITHM,
            kid: &self.app_id,
        };
        let header = encode_json(&header)?;
        let claims = encode_json(&claims)?;
        let signing_input = format!("{header}.{claims}");
        let signature = self
            .key
            .try_sign(signing_input.as_bytes())
            .map_err(|_| JwtError::Signing)?;
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_vec());
        Ok(format!("{signing_input}.{signature}"))
    }
}

impl fmt::Debug for JwtSigner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Neither the application id nor the key: a Debug line ends up in a
        // log or a crash report more often than anyone expects.
        formatter
            .debug_struct("JwtSigner")
            .field("app_id", &"<redacted>")
            .field("key", &"<redacted>")
            .finish()
    }
}

/// The JWT header, in the order the API documents it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Header<'a> {
    /// Always `JWT`.
    pub typ: &'a str,
    /// Always `RS256`.
    pub alg: &'a str,
    /// The application id the key was registered with.
    pub kid: &'a str,
}

/// The JWT claims, in the order the API documents them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claims {
    /// Always `enablebanking.com`.
    pub iss: String,
    /// Always `api.enablebanking.com`.
    pub aud: String,
    /// When the token was minted, in seconds since the epoch.
    pub iat: i64,
    /// When it stops being valid, in seconds since the epoch.
    pub exp: i64,
}

impl Claims {
    /// How long the token claims to live, in seconds. Negative when `exp` is
    /// before `iat`, which no token this crate mints ever has.
    pub fn ttl_seconds(&self) -> i64 {
        self.exp - self.iat
    }
}

/// The longest lifetime the API accepts for a token, and the crate's default.
/// Both live in the crate root so the client and the signer agree.
pub const MAX_TTL: Duration = JWT_MAX_TTL;

/// Why a token could not be produced. Every variant says what the caller has
/// to fix, and none of them carries key material. `Display` is the English
/// sentence; the Spanish one comes from [`Localized`].
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum JwtError {
    /// The text does not contain a `-----BEGIN ...-----` line at all, so it is
    /// not a PEM file (a `.key` that is really a certificate chain, a truncated
    /// download, or the wrong file).
    #[error("the key is not PEM-encoded: no «-----BEGIN ...-----» line was found")]
    MissingPem,
    /// A PEM file, but not a private key this crate can sign with: a public
    /// key, a certificate, a CA bundle.
    #[error("the PEM file holds «{0}», which is not a usable RSA private key")]
    UnsupportedLabel(String),
    /// A password-protected key. This crate never asks for or keeps a
    /// password, so the user has to export an unencrypted copy.
    #[error(
        "the private key is password-protected; export it without a password \
         (openssl pkcs8 -topk8 -nocrypt) and import it again"
    )]
    EncryptedKey,
    /// The armor says private key but the DER inside is not a readable RSA key.
    #[error("the PEM private key is damaged or is not an RSA key")]
    MalformedKey,
    /// The application id is empty, so `kid` would name no application.
    #[error("the Enable Banking application id is missing")]
    MissingApplicationId,
    /// RSA refused to sign, which for a usable key means its modulus is too
    /// small for a SHA-256 signature.
    #[error("the token could not be signed with this key")]
    Signing,
}

impl Localized for JwtError {
    fn localized(&self, language: Language) -> String {
        match self {
            JwtError::MissingPem => language.pick(
                "the key is not PEM-encoded: no «-----BEGIN ...-----» line was found",
                "la clave no está en formato PEM: no se encontró ninguna línea «-----BEGIN ...-----»",
            )
            .to_string(),
            JwtError::UnsupportedLabel(label) => language
                .pick(
                    "the PEM file holds «{label}», which is not a usable RSA private key",
                    "el archivo PEM contiene «{label}», que no es una clave privada RSA utilizable",
                )
                .replace("{label}", label),
            JwtError::EncryptedKey => language
                .pick(
                    "the private key is password-protected; export it without a password \
                     (openssl pkcs8 -topk8 -nocrypt) and import it again",
                    "la clave privada está cifrada con contraseña; expórtala sin contraseña \
                     (openssl pkcs8 -topk8 -nocrypt) y vuelve a importarla",
                )
                .to_string(),
            JwtError::MalformedKey => language
                .pick(
                    "the PEM private key is damaged or is not an RSA key",
                    "la clave privada PEM está dañada o no es una clave RSA",
                )
                .to_string(),
            JwtError::MissingApplicationId => language
                .pick(
                    "the Enable Banking application id is missing",
                    "falta el identificador de la aplicación de Enable Banking",
                )
                .to_string(),
            JwtError::Signing => language
                .pick(
                    "the token could not be signed with this key",
                    "no se pudo firmar el token con esta clave",
                )
                .to_string(),
        }
    }
}

/// A token TTL as the API will accept it: at least a second, at most a day.
pub fn clamp_ttl(ttl: Duration) -> Duration {
    ttl.clamp(Duration::from_secs(1), MAX_TTL)
}

/// Parse an unencrypted RSA private key from PKCS#8 or PKCS#1 PEM text.
fn parse_private_key(pem: &str) -> Result<RsaPrivateKey, JwtError> {
    let label = pem_label(pem).ok_or(JwtError::MissingPem)?;
    match label {
        PKCS8_LABEL => RsaPrivateKey::from_pkcs8_pem(pem).map_err(|_| JwtError::MalformedKey),
        PKCS1_LABEL => RsaPrivateKey::from_pkcs1_pem(pem).map_err(|_| JwtError::MalformedKey),
        ENCRYPTED_LABEL => Err(JwtError::EncryptedKey),
        other => Err(JwtError::UnsupportedLabel(other.to_string())),
    }
}

/// The first `-----BEGIN <label>-----` label in the text.
fn pem_label(pem: &str) -> Option<&str> {
    let start = pem.find(PEM_PREFIX)? + PEM_PREFIX.len();
    let rest = &pem[start..];
    let end = rest.find("-----")?;
    Some(rest[..end].trim())
}

/// Serialize a JWT segment and base64url-encode it without padding.
fn encode_json<T: Serialize>(value: &T) -> Result<String, JwtError> {
    let json = serde_json::to_vec(value).map_err(|_| JwtError::Signing)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json))
}

/// Decode one base64url segment of a token. Only used by the tests and by a
/// caller that wants to show what it is about to send; it never verifies.
pub fn decode_segment(segment: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(segment)
        .ok()
}
