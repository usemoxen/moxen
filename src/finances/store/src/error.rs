//! The store's errors: one enum for every failure the reference can hit,
//! with the source error kept so a caller can tell a broken database from a
//! malformed backup or a bad CSV row. Messages are in Spanish because they
//! reach the user (the store's consumer is the desktop app, which is
//! Spanish first, like the reference).

use std::path::PathBuf;

use thiserror::Error;

use moxen_finances_core::CoreError;

/// The crate's result type.
pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Error)]
pub enum StoreError {
    /// SQLite refused or failed a statement.
    #[error("error de la base de datos: {0}")]
    Database(#[from] rusqlite::Error),

    /// The file could not be created, read or written.
    #[error("no se pudo acceder a {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },

    /// Encoding text (a CSV sheet) failed.
    #[error("no se pudo escribir el texto: {0}")]
    Write(std::io::Error),

    /// The database was written by a newer version of the app: its schema is
    /// ahead of what this build knows how to run, so it is left untouched.
    #[error(
        "la base de datos usa el esquema {found}, más nuevo que el que admite esta \
         versión ({supported}). Actualiza Moxen Finances para abrirla."
    )]
    NewerSchema { found: i64, supported: i64 },

    /// A backup file whose JSON is valid but does not describe a backup.
    #[error("la copia de seguridad no es válida: {0}")]
    MalformedBackup(String),

    /// A backup written by a newer version: restoring it would drop data this
    /// build cannot represent.
    #[error(
        "la copia de seguridad es de la versión {found} y esta versión solo \
         restaura la {supported}. Actualiza Moxen Finances para restaurarla."
    )]
    NewerBackup { found: i64, supported: i64 },

    /// The row a command names is gone.
    #[error("{entity} no encontrado: {id}")]
    NotFound { entity: &'static str, id: String },

    /// A CSV file the platform refused, or a field it could not encode.
    #[error("no se pudo leer o escribir el CSV: {0}")]
    Csv(#[from] csv::Error),

    /// A value could not be turned into JSON (an audit payload).
    #[error("no se pudo serializar a JSON: {0}")]
    Json(#[from] serde_json::Error),

    /// The domain logic rejected the data (an unparseable date, a rate of
    /// zero, an amount that does not fit minor units).
    #[error(transparent)]
    Core(#[from] CoreError),

    /// `dirs` found no data folder for this platform, so there is no default
    /// place for the database.
    #[error("no se encontró la carpeta de datos de la aplicación para este sistema")]
    NoDataDirectory,

    /// The schema-2 or schema-3 migration could not copy the database file to
    /// its `.pre-v<N>.bak` backup, so it refused to run: the database is
    /// exactly as it was.
    #[error(
        "no se pudo copiar la base de datos a {to} antes de migrar (se necesita para no \
         perder el esquema anterior): la base de datos no se ha tocado. Motivo: {source}"
    )]
    MigrationBackup {
        from: PathBuf,
        to: PathBuf,
        source: std::io::Error,
    },

    /// The account asked for still has movements, so it cannot be deleted:
    /// archiving is the way to retire an account without losing its history.
    #[error("la cuenta {id} aún tiene movimientos y no se puede borrar; archívala")]
    AccountInUse { id: String },

    /// A transfer needs two different accounts.
    #[error("un traspaso necesita dos cuentas distintas: {reason}")]
    InvalidTransfer { reason: String },
}
