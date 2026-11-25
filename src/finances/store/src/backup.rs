//! The JSON backup and restore, from the reference's `exportAll` and
//! `importAll` (`src/server/repo.ts` at 8aaad15b) to LOCAL-025's several
//! accounts.
//!
//! A schema-1 backup (the reference's, or ours before version 2) still
//! restores into a schema 2 database **as the first account**: it carries one
//! `account` object and rows without an account, and [`Backup::state`] turns
//! that into the single first account every row belongs to. A version 2
//! backup carries `accounts` and `transfers` as well.
//!
//! Restoring replaces the data in one transaction and records what it
//! replaced in the audit log, which the reference also keeps.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use moxen_finances_core::types::{
    Account, ActualCharge, AppState, ExchangeRate, Expense, Income, SubscriptionWithHistory,
    Transfer,
};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::row::{log_audit, now};
use crate::state::insert_state;

/// The backup format this build writes and the newest it restores.
///
/// Version 1 is the reference's payload (one account, no transfers); the
/// extra fields here default, so one reads back unchanged and restores as
/// the first account.
pub const BACKUP_VERSION: i64 = 2;

/// The JSON backup file. Field order and names match
/// `{ version, exportedAt, ...state }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    #[serde(default = "default_version")]
    pub version: i64,
    #[serde(default)]
    pub exported_at: String,
    pub account: Account,
    /// LOCAL-025: every account. Absent in a version 1 payload, which is the
    /// single `account` above.
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub subscriptions: Vec<SubscriptionWithHistory>,
    #[serde(default)]
    pub incomes: Vec<Income>,
    #[serde(default)]
    pub expenses: Vec<Expense>,
    #[serde(default)]
    pub rates: Vec<ExchangeRate>,
    /// Optional in the reference (`payload.charges ?? []`): older backups do
    /// not carry it.
    #[serde(default)]
    pub charges: Vec<ActualCharge>,
    /// LOCAL-025: the transfers between accounts.
    #[serde(default)]
    pub transfers: Vec<Transfer>,
    #[serde(default)]
    pub settings: BTreeMap<String, String>,
}

fn default_version() -> i64 {
    BACKUP_VERSION
}

impl Backup {
    /// The state the payload carries. A version 1 payload (no `accounts`)
    /// becomes the one account its rows belong to.
    pub fn state(&self) -> AppState {
        let accounts = if self.accounts.is_empty() {
            vec![self.account.clone()]
        } else {
            self.accounts.clone()
        };
        let account = accounts
            .first()
            .cloned()
            .unwrap_or_else(|| self.account.clone());
        AppState {
            account,
            accounts,
            subscriptions: self.subscriptions.clone(),
            incomes: self.incomes.clone(),
            expenses: self.expenses.clone(),
            rates: self.rates.clone(),
            charges: self.charges.clone(),
            transfers: self.transfers.clone(),
            settings: self.settings.clone(),
        }
    }

    /// The payload as the file holds it: compact JSON, like the reference's
    /// `JSON.stringify`.
    pub fn to_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self)?)
    }

    /// Read a backup file. Malformed JSON and a JSON document that is not a
    /// backup both come back as [`StoreError::MalformedBackup`], never as a
    /// panic.
    pub fn from_json(text: &str) -> Result<Self> {
        serde_json::from_str(text).map_err(|error| StoreError::MalformedBackup(format!("{error}")))
    }
}

/// `exportAll`: the whole state plus the format version and the moment.
pub(crate) fn export_all(conn: &Connection) -> Result<Backup> {
    let state = crate::repo::app_state(conn)?;
    Ok(Backup {
        version: BACKUP_VERSION,
        exported_at: now(),
        account: state.account,
        accounts: state.accounts,
        subscriptions: state.subscriptions,
        incomes: state.incomes,
        expenses: state.expenses,
        rates: state.rates,
        charges: state.charges,
        transfers: state.transfers,
        settings: state.settings,
    })
}

/// `importAll`: replace everything the payload holds, in one transaction.
/// The audit log keeps its history and gains the `import` entry.
pub(crate) fn restore_all(conn: &Connection, backup: &Backup) -> Result<()> {
    if backup.version > BACKUP_VERSION {
        return Err(StoreError::NewerBackup {
            found: backup.version,
            supported: BACKUP_VERSION,
        });
    }
    if backup.version < 1 {
        return Err(StoreError::MalformedBackup(format!(
            "versión de copia de seguridad no válida: {}",
            backup.version
        )));
    }

    let stamped = now();
    let transaction = conn.unchecked_transaction()?;
    log_audit(
        &transaction,
        "database",
        "",
        "import",
        &ImportAudit {
            version: backup.version,
            exported_at: &backup.exported_at,
        },
        &stamped,
    )?;
    // Children before parents, exactly like the reference; the cascade would
    // take them anyway, but the order keeps a half-deleted database
    // impossible even with foreign keys off. The transfers go with the
    // movements, the single `account` table is gone since schema 2.
    for table in [
        "subscription_prices",
        "subscription_plans",
        "subscription_billing_days",
        "subscription_pauses",
        "subscription_status_history",
        "subscriptions",
        "subscription_charges",
        "incomes",
        "expenses",
        "transfers",
        "exchange_rates",
        "settings",
        "accounts",
    ] {
        transaction.execute(&format!("DELETE FROM {table}"), [])?;
    }
    insert_state(&transaction, &backup.state(), false)?;
    transaction.commit()?;
    Ok(())
}

/// The payload the reference writes for the import itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportAudit<'a> {
    version: i64,
    exported_at: &'a str,
}

impl Store {
    /// The backup of everything in the database.
    pub fn export_all(&self) -> Result<Backup> {
        export_all(self.connection())
    }

    /// The backup as the file holds it (compact JSON).
    pub fn export_json(&self) -> Result<String> {
        self.export_all()?.to_json()
    }

    /// Replace everything with a backup, in one transaction.
    pub fn restore_all(&mut self, backup: &Backup) -> Result<()> {
        restore_all(self.connection(), backup)
    }

    /// Restore from a backup file's text.
    pub fn restore_json(&mut self, text: &str) -> Result<()> {
        let backup = Backup::from_json(text)?;
        self.restore_all(&backup)
    }
}
