//! The JSON backup and restore: `exportAll` and `importAll` of the
//! reference's `src/server/repo.ts`, and the payload shape of its
//! `/api/export/json` file, so a backup made by the TypeScript app restores
//! here and one made here restores there.
//!
//! The payload is the whole state plus `version` and `exportedAt`; restoring
//! replaces the data in one transaction and records what it replaced in the
//! audit log, which the reference also keeps.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use moxen_finances_core::types::{
    Account, ActualCharge, AppState, ExchangeRate, Expense, Income, SubscriptionWithHistory,
};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::row::{log_audit, now};
use crate::state::insert_state;

/// The backup format this build writes and the newest it restores.
pub const BACKUP_VERSION: i64 = 1;

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
    #[serde(default)]
    pub settings: BTreeMap<String, String>,
}

fn default_version() -> i64 {
    BACKUP_VERSION
}

impl Backup {
    /// The state the payload carries.
    pub fn state(&self) -> AppState {
        AppState {
            account: self.account.clone(),
            subscriptions: self.subscriptions.clone(),
            incomes: self.incomes.clone(),
            expenses: self.expenses.clone(),
            rates: self.rates.clone(),
            charges: self.charges.clone(),
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
        subscriptions: state.subscriptions,
        incomes: state.incomes,
        expenses: state.expenses,
        rates: state.rates,
        charges: state.charges,
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
    // impossible even with foreign keys off.
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
        "exchange_rates",
        "settings",
        "account",
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
