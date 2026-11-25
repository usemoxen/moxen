//! A harness-only look at the states the demo cannot reach: a data source that
//! accepts commands (so buttons and forms render enabled, and every command
//! does nothing) with one fictitious linked bank. Compiled only with the
//! `render-harness` feature and asked for with `MOXEN_FINANCES_PREVIEW=1`
//! next to `MOXEN_FINANCES_DEMO=1`. No database, key or network.

use chrono::NaiveDate;
use moxen_finances_ui::commands::{
    AccountDraft, CsvSheet, DataError, FinancesMutations, MovementDraft, SubscriptionAction,
    SubscriptionDraft, TransferDraft,
};
use moxen_finances_ui::data::{
    AccountInfo, AccountSelection, BalancePoint, BankConnectionInfo, BankConsent, BankSyncState,
    Currency, FinancesData, LinkedBankAccount, Money, MonthSummary, Movement, MovementKind,
    Subscription, UpcomingCharge,
};
use moxen_finances_ui::demo::DemoData;
use std::rc::Rc;

pub fn requested() -> bool {
    std::env::var_os("MOXEN_FINANCES_PREVIEW").is_some_and(|value| value == "1")
}

pub struct PreviewData(pub DemoData);

impl FinancesData for PreviewData {
    fn today(&self) -> NaiveDate {
        self.0.today()
    }
    fn balance(&self) -> Money {
        self.0.balance()
    }
    fn balance_date(&self) -> NaiveDate {
        self.0.balance_date()
    }
    fn month_end_forecast(&self) -> Money {
        self.0.month_end_forecast()
    }
    fn month_summary(&self) -> MonthSummary {
        self.0.month_summary()
    }
    fn upcoming_charges(&self) -> Rc<[UpcomingCharge]> {
        self.0.upcoming_charges()
    }
    fn subscriptions(&self) -> Rc<[Subscription]> {
        self.0.subscriptions()
    }
    fn balance_history(&self) -> Rc<[BalancePoint]> {
        self.0.balance_history()
    }
    fn exchange_rate(&self, from: Currency, to: Currency) -> f64 {
        self.0.exchange_rate(from, to)
    }
    fn movements(&self) -> Rc<[Movement]> {
        self.0.movements()
    }
    fn accounts(&self) -> Rc<[AccountInfo]> {
        self.0.accounts()
    }
    fn bank_sync(&self) -> BankSyncState {
        let account = self.0.accounts().first().map(|a| a.id.clone());
        BankSyncState {
            app_id: "fictional-application-id".into(),
            key_stored: true,
            activity: None,
            message: None,
            connections: Rc::from([BankConnectionInfo {
                id: "preview-connection".into(),
                bank_name: "Banco Ficticio".into(),
                country: "ES".into(),
                consent: BankConsent::Expiring,
                consent_until: NaiveDate::from_ymd_opt(2026, 12, 2),
                last_sync: NaiveDate::from_ymd_opt(2026, 11, 24),
                imported: 12,
                accounts: Rc::from([LinkedBankAccount {
                    external_uid: "fictional-uid".into(),
                    name: "Cuenta de pruebas".into(),
                    currency: "EUR".into(),
                    account_id: account,
                }]),
            }]),
            interval: Some(60),
        }
    }
}

/// Accepts every command and does nothing with it.
pub struct NoMutations;

impl FinancesMutations for NoMutations {
    fn refresh(&self) -> Result<(), DataError> {
        Ok(())
    }
    fn select_account(&self, _: AccountSelection) -> Result<(), DataError> {
        Ok(())
    }
    fn create_account(&self, _: &AccountDraft) -> Result<(), DataError> {
        Ok(())
    }
    fn rename_account(&self, _: &str, _: &str) -> Result<(), DataError> {
        Ok(())
    }
    fn set_account_archived(&self, _: &str, _: bool) -> Result<(), DataError> {
        Ok(())
    }
    fn delete_account(&self, _: &str) -> Result<(), DataError> {
        Ok(())
    }
    fn create_transfer(&self, _: &TransferDraft) -> Result<(), DataError> {
        Ok(())
    }
    fn create_subscription(&self, _: &SubscriptionDraft) -> Result<(), DataError> {
        Ok(())
    }
    fn update_subscription(&self, _: &str, _: &SubscriptionDraft) -> Result<(), DataError> {
        Ok(())
    }
    fn apply_subscription_action(&self, _: &str, _: SubscriptionAction) -> Result<(), DataError> {
        Ok(())
    }
    fn create_movement(&self, _: &MovementDraft) -> Result<(), DataError> {
        Ok(())
    }
    fn update_movement(&self, _: &MovementDraft) -> Result<(), DataError> {
        Ok(())
    }
    fn confirm_movement(&self, _: &str, _: MovementKind) -> Result<(), DataError> {
        Ok(())
    }
    fn delete_movement(&self, _: &str, _: MovementKind) -> Result<(), DataError> {
        Ok(())
    }
    fn export_backup_json(&self) -> Result<String, DataError> {
        Ok(String::new())
    }
    fn restore_backup_json(&self, _: &str) -> Result<(), DataError> {
        Ok(())
    }
    fn export_csv(&self, _: CsvSheet) -> Result<String, DataError> {
        Ok(String::new())
    }
}
