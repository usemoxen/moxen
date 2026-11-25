//! The write side of the view-model boundary: plain-DTO commands the views
//! issue through [`FinancesMutations`]. Every type here is a UI type or a
//! plain value — no SQLite, no store types — so this crate (and later the
//! desktop bundle) never links rusqlite. The app's `StoreData` implements
//! the trait over `moxen-finances-store`; tests implement it over stubs.
//!
//! Every command returns a [`DataError`] instead of panicking, and the shell
//! refreshes the data after a success so the views show it immediately.

use crate::data::{
    AccountKind, AccountSelection, Currency, Frequency, MovementKind, MovementStatus,
};
use crate::language::{self, fill};
use chrono::NaiveDate;

/// What went wrong, in a form the interface can localize.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataErrorKind {
    Database,
    NotFound,
    Invalid,
    AccountInUse,
    Backup,
    NewerVersion,
    Io,
    /// A bank sync failure: an unaccepted application, an expired consent, a
    /// rate limit, a bank that did not answer. The detail is the sentence the
    /// banking crate already localized.
    Banking,
    /// The data source does not offer this operation (the demo).
    Unsupported,
    Other,
}

/// A command's failure: a localizable kind plus the raw detail (which may
/// come from the store, so it is shown as-is after the localized prefix).
#[derive(Clone, Debug)]
pub struct DataError {
    pub kind: DataErrorKind,
    pub detail: String,
}

impl DataError {
    pub fn new(kind: DataErrorKind, detail: impl Into<String>) -> Self {
        DataError {
            kind,
            detail: detail.into(),
        }
    }

    fn key(&self) -> &'static str {
        match self.kind {
            DataErrorKind::Database => "error.database",
            DataErrorKind::NotFound => "error.notfound",
            DataErrorKind::Invalid => "error.invalid",
            DataErrorKind::AccountInUse => "error.accountInUse",
            DataErrorKind::Backup => "error.backup",
            DataErrorKind::NewerVersion => "error.newer",
            DataErrorKind::Io => "error.io",
            DataErrorKind::Banking => "error.banking",
            DataErrorKind::Unsupported => "error.unsupported",
            DataErrorKind::Other => "error.other",
        }
    }

    /// The message the error banner shows, in the active interface language.
    pub fn localized(&self) -> String {
        if self.detail.is_empty() {
            language::message(self.key()).to_string()
        } else {
            fill(self.key(), &[("{detail}", self.detail.as_str())])
        }
    }
}

/// What creating an account takes.
#[derive(Clone, Debug)]
pub struct AccountDraft {
    pub name: String,
    pub kind: AccountKind,
    pub currency: Currency,
    /// The balance starts unset when this is `None`.
    pub balance_minor: Option<i64>,
}

/// Moving money between two accounts.
#[derive(Clone, Debug)]
pub struct TransferDraft {
    pub from_account_id: String,
    pub to_account_id: String,
    pub amount_minor: i64,
    pub currency: Currency,
    pub date: NaiveDate,
    pub note: Option<String>,
}

/// What the subscription form sends, for both create and edit. `None`
/// fields mean "no price" / "no date", not "leave the old value" (an edit
/// always sends the whole form).
#[derive(Clone, Debug)]
pub struct SubscriptionDraft {
    pub name: String,
    pub description: Option<String>,
    pub price_minor: Option<i64>,
    pub currency: Currency,
    pub frequency: Frequency,
    pub start_date: Option<NaiveDate>,
    pub billing_day: Option<i64>,
    pub end_date: Option<NaiveDate>,
}

impl Default for SubscriptionDraft {
    fn default() -> Self {
        SubscriptionDraft {
            name: String::new(),
            description: None,
            price_minor: None,
            currency: Currency::Eur,
            frequency: Frequency::Monthly,
            start_date: None,
            billing_day: None,
            end_date: None,
        }
    }
}

/// The actions the subscription screen offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubscriptionAction {
    Pause,
    Resume,
    Cancel,
    Finish,
    Reactivate,
    Delete,
}

/// What the movement form sends, for create (`id` = `None`) and edit.
#[derive(Clone, Debug)]
pub struct MovementDraft {
    pub id: Option<String>,
    pub kind: MovementKind,
    pub name: String,
    /// Only real charges carry one.
    pub subscription_id: Option<String>,
    pub category: Option<String>,
    pub amount_minor: i64,
    pub currency: Currency,
    pub date: NaiveDate,
    pub time: Option<String>,
    pub frequency: Frequency,
    pub end_date: Option<NaiveDate>,
    pub status: MovementStatus,
    pub notes: Option<String>,
}

/// The CSV sheets the Settings page can export.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CsvSheet {
    Subscriptions,
    Incomes,
    Expenses,
    Rates,
    Movements,
}

impl CsvSheet {
    pub const ALL: [CsvSheet; 5] = [
        CsvSheet::Subscriptions,
        CsvSheet::Incomes,
        CsvSheet::Expenses,
        CsvSheet::Rates,
        CsvSheet::Movements,
    ];

    pub fn key(self) -> &'static str {
        match self {
            CsvSheet::Subscriptions => "settings.csv.subscriptions",
            CsvSheet::Incomes => "settings.csv.incomes",
            CsvSheet::Expenses => "settings.csv.expenses",
            CsvSheet::Rates => "settings.csv.rates",
            CsvSheet::Movements => "settings.csv.movements",
        }
    }

    /// The file-name stem of the sheet's export.
    pub fn name(self) -> &'static str {
        match self {
            CsvSheet::Subscriptions => "subscriptions",
            CsvSheet::Incomes => "incomes",
            CsvSheet::Expenses => "expenses",
            CsvSheet::Rates => "rates",
            CsvSheet::Movements => "movements",
        }
    }
}

/// What linking a bank asks for: which country's banks to list and which one
/// to open. The application id and the key are already stored by then.
#[derive(Clone, Debug)]
pub struct BankLinkDraft {
    /// A two-letter ISO 3166 country code (`ES`), which the picker offers.
    pub country: String,
    /// The bank's name exactly as the picker showed it (`Revolut`).
    pub bank_name: String,
    /// The language the bank's own pages should use (`es`/`en`), when it
    /// supports one.
    pub language: Option<String>,
}

/// The periods the Settings page offers for the automatic sync, in minutes;
/// `None` is "off".
pub const BANK_SYNC_INTERVALS: [Option<u32>; 5] =
    [None, Some(15), Some(60), Some(360), Some(1_440)];

/// The commands the UI can run against the data. Implemented by the app's
/// store-backed `StoreData`; `DemoData` has none, so the demo renders with
/// its actions disabled.
pub trait FinancesMutations {
    /// Re-reads everything the views show. Called after every success.
    fn refresh(&self) -> Result<(), DataError>;
    /// Switches the account the reads answer for.
    fn select_account(&self, selection: AccountSelection) -> Result<(), DataError>;

    // -- accounts -------------------------------------------------------------
    fn create_account(&self, draft: &AccountDraft) -> Result<(), DataError>;
    fn rename_account(&self, id: &str, name: &str) -> Result<(), DataError>;
    fn set_account_archived(&self, id: &str, archived: bool) -> Result<(), DataError>;
    fn delete_account(&self, id: &str) -> Result<(), DataError>;
    fn create_transfer(&self, draft: &TransferDraft) -> Result<(), DataError>;

    // -- subscriptions ----------------------------------------------------------
    fn create_subscription(&self, draft: &SubscriptionDraft) -> Result<(), DataError>;
    fn update_subscription(&self, id: &str, draft: &SubscriptionDraft) -> Result<(), DataError>;
    fn apply_subscription_action(
        &self,
        id: &str,
        action: SubscriptionAction,
    ) -> Result<(), DataError>;

    // -- movements ---------------------------------------------------------------
    fn create_movement(&self, draft: &MovementDraft) -> Result<(), DataError>;
    fn update_movement(&self, draft: &MovementDraft) -> Result<(), DataError>;
    /// Marks a pending movement as done/received.
    fn confirm_movement(&self, id: &str, kind: MovementKind) -> Result<(), DataError>;
    fn delete_movement(&self, id: &str, kind: MovementKind) -> Result<(), DataError>;

    // -- backup and CSV (Settings) -------------------------------------------------
    /// The whole database as the JSON backup file's text.
    fn export_backup_json(&self) -> Result<String, DataError>;
    /// Replaces everything with the backup the text holds.
    fn restore_backup_json(&self, json: &str) -> Result<(), DataError>;
    /// One sheet as CSV text.
    fn export_csv(&self, sheet: CsvSheet) -> Result<String, DataError>;

    // -- bank sync (Settings), LOCAL-031 -------------------------------------------
    //
    // The default implementations refuse: a data source that cannot sync says
    // so instead of pretending. The app's store-backed adapter overrides every
    // one of them.
    /// Store the Enable Banking application id (public metadata, never a key).
    fn save_bank_application(&self, _app_id: &str) -> Result<(), DataError> {
        Err(unsupported())
    }
    /// Read the PEM file at `path` once, validate it, and store the key in the
    /// OS keychain. The path is not kept anywhere.
    fn import_bank_key(&self, _pem_path: &str) -> Result<(), DataError> {
        Err(unsupported())
    }
    /// Delete the stored key from the OS keychain.
    fn remove_bank_key(&self) -> Result<(), DataError> {
        Err(unsupported())
    }
    /// Start linking a bank: opens the browser and waits on the loopback
    /// callback in the background, so the window keeps painting.
    fn link_bank(&self, _draft: &BankLinkDraft) -> Result<(), DataError> {
        Err(unsupported())
    }
    /// Forget a linked bank (its import ledger and mappings), keeping the
    /// movements already imported.
    fn unlink_bank(&self, _connection_id: &str) -> Result<(), DataError> {
        Err(unsupported())
    }
    /// Point one of the bank's accounts at a local account, or at none.
    fn map_bank_account(
        &self,
        _connection_id: &str,
        _external_uid: &str,
        _account_id: &str,
    ) -> Result<(), DataError> {
        Err(unsupported())
    }
    /// Sync now: balances and booked movements, idempotently.
    fn sync_bank_now(&self, _connection_id: &str) -> Result<(), DataError> {
        Err(unsupported())
    }
    /// Set the minutes between automatic syncs, `None` for off.
    fn set_bank_sync_interval(&self, _minutes: Option<u32>) -> Result<(), DataError> {
        Err(unsupported())
    }
}

/// The error a data source without bank sync answers with.
fn unsupported() -> DataError {
    DataError::new(DataErrorKind::Unsupported, String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_errors_localize_in_both_languages() {
        language::apply(Some("en"));
        let error = DataError::new(DataErrorKind::AccountInUse, "");
        assert_eq!(
            error.localized(),
            "The account still has movements and cannot be deleted; archive it instead."
        );
        let error = DataError::new(DataErrorKind::Database, "locked".to_string());
        assert_eq!(error.localized(), "Could not reach the database: locked");
        language::apply(Some("es-ES"));
        let error = DataError::new(DataErrorKind::AccountInUse, "");
        assert_eq!(
            error.localized(),
            "La cuenta todavía tiene movimientos y no se puede borrar; archívala."
        );
        let error = DataError::new(DataErrorKind::Backup, "json roto".to_string());
        assert_eq!(
            error.localized(),
            "No se pudo leer la copia de seguridad: json roto"
        );
        language::apply(Some("en"));
    }

    #[test]
    fn csv_sheets_have_labels_in_both_languages() {
        language::apply(Some("en"));
        assert_eq!(language::message(CsvSheet::Rates.key()), "Exchange rates");
        assert_eq!(
            language::message(CsvSheet::Movements.key()),
            "Movements report"
        );
        language::apply(Some("es-ES"));
        assert_eq!(language::message(CsvSheet::Rates.key()), "Tipos de cambio");
        assert_eq!(
            language::message(CsvSheet::Movements.key()),
            "Informe de movimientos"
        );
        language::apply(Some("en"));
    }
}
