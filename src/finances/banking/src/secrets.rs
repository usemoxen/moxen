//! Where the user's private key lives: the OS keychain, never a file.
//!
//! The key is imported ONCE, from a PEM file the user points to
//! ([`import_pem_file`]); from then on it lives in the macOS Keychain or the
//! Windows Credential Manager, under a fixed service name and the
//! application id, and the path is not kept anywhere. Nothing in this crate
//! writes the key to a config file, a log, the database, an error message or
//! the repository: [`PrivateKey`]'s `Debug` is a placeholder, every error here
//! carries a kind and never the contents, and the only way out is
//! [`PrivateKeyStore::load`], which hands it straight to the signer.
//!
//! [`MemoryStore`] implements the same trait without a keychain, for tests and
//! for a caller that wants the app to run with the key held in memory for one
//! session.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use thiserror::Error;

use crate::jwt::{JwtError, JwtSigner, PrivateKey};

/// The keychain service name. The account (the "user" of the entry) is the
/// Enable Banking application id, so two applications are two entries.
pub const KEYCHAIN_SERVICE: &str = "Moxen Finances — Enable Banking";

/// Why a key could not be stored, loaded or imported.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum SecretError {
    /// The OS keychain refused: locked, unavailable, or a policy of the
    /// platform. The message comes from the platform and never carries the
    /// key.
    #[error("no se pudo usar el llavero del sistema: {message}")]
    Keychain {
        /// The platform's description of the failure.
        message: String,
    },

    /// No key is stored for that application id.
    #[error("no hay ninguna clave guardada para esta aplicación de Enable Banking")]
    Missing,

    /// The file could not be read. The path is the user's own and is only
    /// shown back to them; it is never stored.
    #[error("no se pudo leer {path}: {kind}")]
    Io {
        /// The file the user pointed at.
        path: PathBuf,
        /// The kind of IO failure, not its message.
        kind: std::io::ErrorKind,
    },

    /// The file is empty or only whitespace.
    #[error("el archivo de la clave está vacío")]
    EmptyKey,

    /// The file is not a usable private key: the error says why, and the
    /// import refuses it here rather than failing on the first sync.
    #[error("{0}")]
    NotAKey(#[from] JwtError),
}

/// A place a private key can live: the OS keychain, or memory.
pub trait PrivateKeyStore: Send + Sync {
    /// Store `key` for `app_id`, replacing any previous one.
    fn store(&self, app_id: &str, key: &PrivateKey) -> Result<(), SecretError>;

    /// Load the key of `app_id`.
    fn load(&self, app_id: &str) -> Result<PrivateKey, SecretError>;

    /// Delete the key of `app_id`. Deleting a key that is not there is not an
    /// error: the caller wanted it gone.
    fn forget(&self, app_id: &str) -> Result<(), SecretError>;
}

/// Read a PEM file the user pointed at, check that it really is a usable
/// private key for `app_id`, and store it. The path is used and forgotten.
pub fn import_pem_file(
    store: &dyn PrivateKeyStore,
    app_id: &str,
    path: impl AsRef<Path>,
) -> Result<(), SecretError> {
    let path = path.as_ref();
    let text = std::fs::read_to_string(path).map_err(|source| SecretError::Io {
        path: path.to_path_buf(),
        kind: source.kind(),
    })?;
    if text.trim().is_empty() {
        return Err(SecretError::EmptyKey);
    }
    let key = PrivateKey::new(text);
    // An unusable key (a certificate, an encrypted key, a truncated file) is
    // refused here, while the user is still looking at the file picker.
    JwtSigner::new(app_id, &key)?;
    store.store(app_id, &key)
}

/// The keychain of the platform: Keychain on macOS, Credential Manager on
/// Windows.
#[derive(Clone)]
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    /// The store the app uses, under [`KEYCHAIN_SERVICE`].
    pub fn new() -> Self {
        Self {
            service: KEYCHAIN_SERVICE.to_string(),
        }
    }

    /// A store under another service name, for a test that must not touch the
    /// app's entries.
    pub fn with_service(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    /// The service name the entries live under.
    pub fn service(&self) -> &str {
        &self.service
    }

    /// The entry of one application. The error is the platform's and never
    /// contains the key.
    fn entry(&self, app_id: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, app_id).map_err(|error| SecretError::Keychain {
            message: error.to_string(),
        })
    }
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for KeychainStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeychainStore")
            .field("service", &self.service)
            .finish()
    }
}

impl PrivateKeyStore for KeychainStore {
    fn store(&self, app_id: &str, key: &PrivateKey) -> Result<(), SecretError> {
        self.entry(app_id)?
            .set_password(key.as_str())
            .map_err(|error| SecretError::Keychain {
                message: error.to_string(),
            })
    }

    fn load(&self, app_id: &str) -> Result<PrivateKey, SecretError> {
        match self.entry(app_id)?.get_password() {
            Ok(pem) => Ok(PrivateKey::new(pem)),
            Err(keyring::Error::NoEntry) => Err(SecretError::Missing),
            Err(error) => Err(SecretError::Keychain {
                message: error.to_string(),
            }),
        }
    }

    fn forget(&self, app_id: &str) -> Result<(), SecretError> {
        match self.entry(app_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(SecretError::Keychain {
                message: error.to_string(),
            }),
        }
    }
}

/// A store that keeps keys in memory.
///
/// It is what the tests use, and what a caller can use to run with a key for
/// one session without leaving it in the keychain. It never writes anything
/// anywhere, and its `Debug` prints the number of keys, not the keys.
#[derive(Default)]
pub struct MemoryStore {
    keys: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// How many keys are held, for a test or a status line.
    pub fn len(&self) -> usize {
        self.keys.lock().map(|keys| keys.len()).unwrap_or(0)
    }

    /// Whether the store holds no key.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl fmt::Debug for MemoryStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemoryStore")
            .field("keys", &format_args!("<{} stored>", self.len()))
            .finish()
    }
}

impl PrivateKeyStore for MemoryStore {
    fn store(&self, app_id: &str, key: &PrivateKey) -> Result<(), SecretError> {
        let mut keys = self.keys.lock().map_err(|_| SecretError::Keychain {
            message: "el almacén en memoria está bloqueado".to_string(),
        })?;
        keys.insert(app_id.to_string(), key.as_str().to_string());
        Ok(())
    }

    fn load(&self, app_id: &str) -> Result<PrivateKey, SecretError> {
        let keys = self.keys.lock().map_err(|_| SecretError::Keychain {
            message: "el almacén en memoria está bloqueado".to_string(),
        })?;
        keys.get(app_id)
            .map(|pem| PrivateKey::new(pem.clone()))
            .ok_or(SecretError::Missing)
    }

    fn forget(&self, app_id: &str) -> Result<(), SecretError> {
        let mut keys = self.keys.lock().map_err(|_| SecretError::Keychain {
            message: "el almacén en memoria está bloqueado".to_string(),
        })?;
        keys.remove(app_id);
        Ok(())
    }
}
