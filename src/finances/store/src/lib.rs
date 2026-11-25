//! Moxen Finances store: SQLite persistence for the app, from the scrubbed
//! TypeScript reference (`src/server/*.ts` at 8aaad15b) to LOCAL-025's
//! several accounts.
//!
//! - [`Store`] opens the file (WAL, foreign keys on, a busy timeout), runs the
//!   forward-only migrations — refusing a database from a newer build, and
//!   copying the file to `<name>.pre-v2.bak` before the schema-2 migration —
//!   and refuses a database from a newer build.
//! - [`repo`] holds every operation the reference's repository has —
//!   subscriptions with their effective-dated history, incomes, expenses,
//!   real charges, exchange rates, settings, the audit log and the
//!   whole-state read — plus the account operations LOCAL-025 adds: create,
//!   rename, archive, reorder and delete (refused while the account has
//!   movements).
//! - [`derive`] assembles what the views need from that state, including the
//!   projection anchored on the opening balance, per account and as a total
//!   across accounts converted to one currency.
//! - [`backup`] is the JSON backup and restore, [`csv`] the CSV export and
//!   append-only import, [`ledger`] the incomes, expenses, charges, rates
//!   and the transfers between accounts.
//! - [`seed`] is the FICTIONAL demo data written on first run.
//!
//! **Schema 2 is one-way**: the TypeScript reference cannot open a database
//! this build migrated (it has no `accounts` table and no `user_version`
//! check); that is accepted — see [`schema`] and this crate's README.
//!
//! Money is always integer minor units and dates are `YYYY-MM-DD` strings,
//! both from `moxen-finances-core`, which also owns the projection, the
//! statistics and the clock.

pub mod backup;
pub mod csv;
pub mod derive;
pub mod error;
pub mod ledger;
pub mod paths;
pub mod repo;
pub mod row;
pub mod schema;
pub mod seed;
mod state;

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;

pub use backup::{BACKUP_VERSION, Backup};
pub use csv::{CsvKind, ImportSummary};
pub use derive::TotalState;
pub use error::{Result, StoreError};
pub use ledger::{ChargeInput, ExpenseInput, IncomeInput, RateInput, TransferInput};
pub use repo::{
    AccountInput, AccountPatch, PlanInput, PriceInput, SubscriptionAction, SubscriptionInput,
    SubscriptionPatch,
};
pub use row::AuditEntry;
pub use schema::{MIGRATIONS, SCHEMA_VERSION};

/// How long a writer waits for another connection's lock before failing.
/// The reference sets no timeout at all (it is single-process); the desktop
/// app and the MCP server can hold the file at the same time, so a short
/// wait beats an immediate `SQLITE_BUSY`.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// An open Finances database.
pub struct Store {
    connection: Connection,
    /// `None` for an in-memory database.
    path: Option<PathBuf>,
}

impl Store {
    /// Open the database at `path`, creating the file and its folder when
    /// missing, and bring its schema up to [`SCHEMA_VERSION`]. The path is
    /// used exactly as given: neither the platform default nor
    /// `MOXEN_FINANCES_DB` is consulted.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|source| StoreError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let mut connection = Connection::open(path)?;
        prepare(&mut connection)?;
        schema::migrate(&connection, Some(path))?;
        Ok(Self {
            connection,
            path: Some(path.to_path_buf()),
        })
    }

    /// Open the database at the path the app uses:
    /// `MOXEN_FINANCES_DB` when set, otherwise the platform default. See
    /// [`paths`].
    pub fn open_default() -> Result<Self> {
        Self::open(paths::database_path()?)
    }

    /// Open the database and, when this call creates it, fill it with the
    /// FICTIONAL demo seed. An existing database is never reseeded, even when
    /// its account table is empty: only a brand-new file is a first run.
    pub fn initialize(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let created = !path.exists();
        let store = Self::open(path)?;
        if created {
            store.seed_if_empty()?;
        }
        Ok(store)
    }

    /// [`Store::initialize`] at the path the app uses.
    pub fn initialize_default() -> Result<Self> {
        let path = paths::database_path()?;
        let created = !path.exists();
        let store = Self::open(&path)?;
        if created {
            store.seed_if_empty()?;
        }
        Ok(store)
    }

    /// An in-memory database with the current schema and no seed. Handy for
    /// throwaway work; nothing is written to disk. Its migration runs without
    /// the file backup of schema 2 (there is no file to copy).
    pub fn open_in_memory() -> Result<Self> {
        let mut connection = Connection::open_in_memory()?;
        prepare(&mut connection)?;
        schema::migrate(&connection, None)?;
        Ok(Self {
            connection,
            path: None,
        })
    }

    /// The file this store opened, `None` when in memory.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The schema version the file records.
    pub fn schema_version(&self) -> Result<i64> {
        schema::schema_version(&self.connection)
    }

    /// Write the demo seed when the account table is still empty. Called on
    /// first run; a no-op on any database that has an account row.
    pub fn seed_if_empty(&self) -> Result<()> {
        if self.account_count()? > 0 {
            return Ok(());
        }
        let state = seed::build_seed_state();
        let transaction = self.connection.unchecked_transaction()?;
        state::insert_state(&transaction, &state, true)?;
        transaction.commit()?;
        Ok(())
    }

    fn account_count(&self) -> Result<i64> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))?)
    }
}

/// Pragmas every connection needs, in the order the reference asks for them.
fn prepare(connection: &mut Connection) -> Result<()> {
    // WAL: readers never block the writer, which matters once the app and the
    // MCP server share the file. SQLite may refuse (a read-only file, a
    // network share) and then keeps the rollback journal; that is legal and
    // the reference would have ended up in the same mode, so the answer is
    // not an error.
    let _mode: String = connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    // Foreign keys are off by default in SQLite and the reference turns them
    // on; the subscription history relies on ON DELETE CASCADE.
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    // Every write transaction takes the lock up front (`BEGIN IMMEDIATE`)
    // instead of upgrading halfway and risking a busy error between two
    // processes.
    connection.set_transaction_behavior(rusqlite::TransactionBehavior::Immediate);
    Ok(())
}
