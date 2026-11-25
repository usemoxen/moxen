//! `StoreData`: the app's adapter that wires `moxen-finances-store` (and the
//! `moxen-finances-core` logic it is built on) behind the ui crate's
//! [`FinancesData`] / [`FinancesMutations`] traits. The ui crate keeps its
//! plain DTOs and never links SQLite; everything SQLite lives here.
//!
//! Reads answer for the currently selected account scope (`All` or one
//! account): every read serves a cached snapshot, and every command rewrites
//! the store and reloads the snapshot, so the next frame shows the change.
//! Failures come back as [`DataError`] — never a panic.
//!
//! Bank sync (LOCAL-031) sits here too: the application id is a setting, the
//! private key lives in the OS keychain through `moxen-finances-banking`, and
//! a link or a sync runs on a worker thread against its own connection to the
//! same file, so the window keeps painting. `bank_sync()` reads the store
//! directly (it is a handful of small queries) instead of the snapshot, so a
//! run that finishes in the background shows up on the next frame.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use chrono::{Datelike, NaiveDate};
use moxen_finances_banking::secrets::{KeychainStore, import_pem_file};
use moxen_finances_banking::{Client, PrivateKeyStore, SystemClock, UreqTransport};
use moxen_finances_core::accounts::total_balance_minor;
use moxen_finances_core::dates::today_madrid_now;
use moxen_finances_core::exchange::{RATE_SCALE, find_rate_at};
use moxen_finances_core::projection::{NextBillingForOptions, next_billing_for};
use moxen_finances_core::types::{
    Account, AccountKind as CoreAccountKind, Currency as CoreCurrency, ExchangeRate,
    ExpenseStatus as CoreExpenseStatus, Frequency as CoreFrequency,
    IncomeStatus as CoreIncomeStatus, SubscriptionStatus as CoreSubscriptionStatus,
};
use moxen_finances_store::csv::CsvKind;
use moxen_finances_store::derive::{projection_for, projection_for_account, total_state_for};
use moxen_finances_store::ledger::{ChargeInput, ExpenseInput, IncomeInput, TransferInput};
use moxen_finances_store::repo::{
    AccountInput, AccountPatch, SubscriptionAction as CoreSubscriptionAction, SubscriptionInput,
    SubscriptionPatch,
};
use moxen_finances_store::{Store, StoreError};
use moxen_finances_ui::commands::{
    AccountDraft, BankLinkDraft, CsvSheet, DataError, DataErrorKind, FinancesMutations,
    MovementDraft, SubscriptionAction, SubscriptionDraft, TransferDraft,
};
use moxen_finances_ui::data::{
    AccountInfo, AccountKind, AccountSelection, BalancePoint, BankSyncState, Currency,
    FinancesData, Frequency, Money, MonthSummary, Movement, MovementKind, MovementStatus,
    Subscription, SubscriptionStatus, UpcomingCharge, category_localized, passthrough_localized,
};
use moxen_finances_ui::model;

use crate::bank_sync::{
    self, APP_ID_SETTING, BankFailure, BankGateway, BankRuntime, GatewayFactory, INTERVAL_SETTING,
    UrlOpener,
};

// ---------------------------------------------------------------------------
// Mapping between the ui DTOs and the core types
// ---------------------------------------------------------------------------

fn currency_to_core(currency: Currency) -> CoreCurrency {
    match currency {
        Currency::Eur => CoreCurrency::Eur,
        Currency::Usd => CoreCurrency::Usd,
    }
}

fn currency_from_core(currency: CoreCurrency) -> Currency {
    match currency {
        CoreCurrency::Eur => Currency::Eur,
        CoreCurrency::Usd => Currency::Usd,
    }
}

fn frequency_to_core(frequency: Frequency) -> CoreFrequency {
    match frequency {
        Frequency::Once => CoreFrequency::Once,
        Frequency::Weekly => CoreFrequency::Weekly,
        Frequency::Monthly => CoreFrequency::Monthly,
        Frequency::Quarterly => CoreFrequency::Quarterly,
        Frequency::Annual => CoreFrequency::Annual,
    }
}

fn frequency_from_core(frequency: CoreFrequency) -> Frequency {
    match frequency {
        CoreFrequency::Once => Frequency::Once,
        CoreFrequency::Weekly => Frequency::Weekly,
        CoreFrequency::Monthly => Frequency::Monthly,
        CoreFrequency::Quarterly => Frequency::Quarterly,
        CoreFrequency::Annual => Frequency::Annual,
    }
}

fn kind_from_core(kind: CoreAccountKind) -> AccountKind {
    match kind {
        CoreAccountKind::Checking => AccountKind::Checking,
        CoreAccountKind::Savings => AccountKind::Savings,
        CoreAccountKind::CreditCard => AccountKind::CreditCard,
        CoreAccountKind::Cash => AccountKind::Cash,
    }
}

fn kind_to_core(kind: AccountKind) -> CoreAccountKind {
    match kind {
        AccountKind::Checking => CoreAccountKind::Checking,
        AccountKind::Savings => CoreAccountKind::Savings,
        AccountKind::CreditCard => CoreAccountKind::CreditCard,
        AccountKind::Cash => CoreAccountKind::Cash,
    }
}

fn status_from_core(status: CoreSubscriptionStatus) -> SubscriptionStatus {
    match status {
        CoreSubscriptionStatus::Active => SubscriptionStatus::Active,
        CoreSubscriptionStatus::Paused => SubscriptionStatus::Paused,
        CoreSubscriptionStatus::Cancelled => SubscriptionStatus::Cancelled,
        CoreSubscriptionStatus::Finished => SubscriptionStatus::Finished,
    }
}

fn parse_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d").ok()
}

fn iso(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn non_empty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The store's errors as the ui's plain, localizable errors.
pub fn map_error(error: StoreError) -> DataError {
    let kind = match &error {
        StoreError::Database(_) | StoreError::Core(_) => DataErrorKind::Database,
        StoreError::NotFound { .. } => DataErrorKind::NotFound,
        StoreError::InvalidTransfer { .. } => DataErrorKind::Invalid,
        StoreError::MalformedBackup(_) => DataErrorKind::Backup,
        StoreError::NewerSchema { .. } | StoreError::NewerBackup { .. } => {
            DataErrorKind::NewerVersion
        }
        StoreError::AccountInUse { .. } => DataErrorKind::AccountInUse,
        StoreError::Io { .. } | StoreError::Write(_) | StoreError::MigrationBackup { .. } => {
            DataErrorKind::Io
        }
        StoreError::Csv(_) | StoreError::Json(_) => DataErrorKind::Backup,
        StoreError::NoDataDirectory => DataErrorKind::Io,
    };
    DataError::new(kind, error.to_string())
}

// ---------------------------------------------------------------------------
// The snapshot the reads serve
// ---------------------------------------------------------------------------

struct Snapshot {
    today: NaiveDate,
    today_iso: String,
    accounts: Rc<[AccountInfo]>,
    currency: Currency,
    approximate: bool,
    balance: Money,
    balance_date: NaiveDate,
    forecast: Money,
    month: MonthSummary,
    upcoming: Rc<[UpcomingCharge]>,
    subscriptions: Rc<[Subscription]>,
    history: Rc<[BalancePoint]>,
    movements: Rc<[Movement]>,
    rates: Rc<[ExchangeRate]>,
}

fn rate_lookup(rates: &[ExchangeRate], from: Currency, to: Currency, date: &str) -> f64 {
    if from == to {
        return 1.0;
    }
    match find_rate_at(rates, currency_to_core(from), currency_to_core(to), date) {
        Some(lookup) => lookup.rate.rate_scaled as f64 / RATE_SCALE as f64,
        // No rate known: keep the unconverted amount (the approximate badge
        // flags the total), like the core does.
        None => 1.0,
    }
}

fn map_subscription(
    sub: &moxen_finances_core::types::SubscriptionWithHistory,
    charged_dates: &[String],
    today_iso: &str,
) -> Subscription {
    let status = status_from_core(sub.subscription.status);
    let next_charge = if status == SubscriptionStatus::Active {
        next_billing_for(&NextBillingForOptions {
            sub,
            today: today_iso,
            charged_dates,
        })
        .ok()
        .flatten()
        .and_then(|date| parse_date(&date))
    } else {
        None
    };
    Subscription {
        id: sub.subscription.id.clone(),
        name: sub.subscription.name.clone(),
        description: passthrough_localized(&sub.subscription.description),
        price: sub.subscription.price_minor.map(|minor| Money {
            minor,
            currency: currency_from_core(sub.subscription.currency),
        }),
        frequency: frequency_from_core(sub.subscription.frequency),
        status,
        next_charge,
        end_date: sub.subscription.end_date.as_deref().and_then(parse_date),
    }
}

fn map_income(income: &moxen_finances_core::types::Income) -> Movement {
    Movement {
        id: income.id.clone(),
        kind: MovementKind::Income,
        name: income.concept.clone(),
        subscription_id: None,
        category: None,
        amount: Money {
            minor: income.amount_minor,
            currency: currency_from_core(income.currency),
        },
        date: parse_date(&income.date).unwrap_or_default(),
        time: income.time.clone(),
        frequency: frequency_from_core(income.frequency),
        end_date: income.end_date.as_deref().and_then(parse_date),
        status: match income.status {
            CoreIncomeStatus::Expected => MovementStatus::Expected,
            CoreIncomeStatus::Received => MovementStatus::Received,
        },
        paused: income.paused,
        notes: non_empty(&income.notes).map(|notes| passthrough_localized(&notes)),
    }
}

fn map_expense(expense: &moxen_finances_core::types::Expense) -> Movement {
    Movement {
        id: expense.id.clone(),
        kind: MovementKind::Expense,
        name: expense.concept.clone(),
        subscription_id: None,
        category: Some(category_localized(&expense.category)),
        amount: Money {
            minor: expense.amount_minor,
            currency: currency_from_core(expense.currency),
        },
        date: parse_date(&expense.date).unwrap_or_default(),
        time: expense.time.clone(),
        frequency: frequency_from_core(expense.frequency),
        end_date: expense.end_date.as_deref().and_then(parse_date),
        status: match expense.status {
            CoreExpenseStatus::Planned => MovementStatus::Planned,
            CoreExpenseStatus::Pending => MovementStatus::Pending,
            CoreExpenseStatus::Done => MovementStatus::Done,
        },
        paused: false,
        notes: non_empty(&expense.notes).map(|notes| passthrough_localized(&notes)),
    }
}

fn map_charge(
    charge: &moxen_finances_core::types::ActualCharge,
    subscription_name: Option<&str>,
) -> Movement {
    Movement {
        id: charge.id.clone(),
        kind: MovementKind::Charge,
        name: subscription_name
            .map(str::to_string)
            .unwrap_or_else(|| charge.note.clone()),
        subscription_id: Some(charge.subscription_id.clone()),
        category: None,
        amount: Money {
            minor: charge.amount_minor,
            currency: currency_from_core(charge.currency),
        },
        date: parse_date(&charge.charge_date).unwrap_or_default(),
        time: charge.time.clone(),
        frequency: Frequency::Once,
        end_date: None,
        status: if charge.amount_minor == 0 {
            MovementStatus::NotCharged
        } else {
            MovementStatus::Done
        },
        paused: false,
        notes: non_empty(&charge.note).map(|note| passthrough_localized(&note)),
    }
}

/// A transfer as the movement it is for one account: money out of the source,
/// money into the destination.
fn map_transfer(transfer: &moxen_finances_core::types::Transfer, account_id: &str) -> Movement {
    let outgoing = transfer.from_account_id == account_id;
    Movement {
        id: format!("transfer-{}", transfer.id),
        kind: if outgoing {
            MovementKind::Expense
        } else {
            MovementKind::Income
        },
        name: non_empty(&transfer.note)
            .unwrap_or_else(|| moxen_finances_ui::language::message("mov.transfer").to_string()),
        subscription_id: None,
        category: None,
        amount: Money {
            minor: transfer.amount_minor,
            currency: currency_from_core(transfer.currency),
        },
        date: parse_date(&transfer.date).unwrap_or_default(),
        time: transfer.time.clone(),
        frequency: Frequency::Once,
        end_date: None,
        status: MovementStatus::Done,
        paused: false,
        notes: None,
    }
}

/// Builds the snapshot for one account scope out of the store's whole state.
fn build_snapshot(store: &Store, selection: &AccountSelection) -> Result<Snapshot, DataError> {
    let today_iso = today_madrid_now();
    let today = parse_date(&today_iso).ok_or_else(|| {
        DataError::new(
            DataErrorKind::Database,
            format!("unparseable today: {today_iso}"),
        )
    })?;
    let all = store.app_state().map_err(map_error)?;

    let accounts: Rc<[AccountInfo]> = Rc::from(
        all.accounts
            .iter()
            .map(|account| AccountInfo {
                id: account.id.clone(),
                name: account.name.clone(),
                kind: kind_from_core(account.kind),
                currency: currency_from_core(account.currency),
                archived: account.archived,
                balance: Money {
                    minor: account.balance_minor,
                    currency: currency_from_core(account.currency),
                },
            })
            .collect::<Vec<_>>(),
    );

    // The scope: one account's own rows, or the converted total of all.
    let (scoped, currency, approximate, all_state) = match selection {
        AccountSelection::All => {
            let target = all
                .accounts
                .first()
                .map(|account| account.currency)
                .unwrap_or(CoreCurrency::Eur);
            let total = total_state_for(&all, target);
            let approximate = total.total.approximate;
            let currency = currency_from_core(target);
            (total.state.clone(), currency, approximate, all.clone())
        }
        AccountSelection::One(id) => {
            let scoped = store.account_state(id).map_err(map_error)?.ok_or_else(|| {
                DataError::new(DataErrorKind::NotFound, format!("account not found: {id}"))
            })?;
            let currency = currency_from_core(scoped.account.currency);
            (scoped, currency, false, all.clone())
        }
    };

    let account: &Account = &scoped.account;
    let balance = Money {
        minor: account.balance_minor,
        currency,
    };
    let balance_date = parse_date(&account.balance_date).unwrap_or(today);

    // Subscriptions with their next charge.
    let subscriptions: Vec<Subscription> = scoped
        .subscriptions
        .iter()
        .map(|sub| {
            let charged_dates: Vec<String> = scoped
                .charges
                .iter()
                .filter(|charge| charge.subscription_id == sub.subscription.id)
                .map(|charge| charge.charge_date.clone())
                .collect();
            map_subscription(sub, &charged_dates, &today_iso)
        })
        .collect();

    // Movements: the scoped rows, plus the transfers as movements of one account.
    let mut movements: Vec<Movement> = Vec::new();
    movements.extend(scoped.incomes.iter().map(map_income));
    movements.extend(scoped.expenses.iter().map(map_expense));
    movements.extend(scoped.charges.iter().map(|charge| {
        let name = scoped
            .subscriptions
            .iter()
            .find(|sub| sub.subscription.id == charge.subscription_id)
            .map(|sub| sub.subscription.name.as_str());
        map_charge(charge, name)
    }));
    if let AccountSelection::One(id) = selection {
        movements.extend(
            scoped
                .transfers
                .iter()
                .map(|transfer| map_transfer(transfer, id)),
        );
    }

    // Upcoming charges: the active subscriptions' next billing, soonest first.
    let mut upcoming: Vec<UpcomingCharge> = subscriptions
        .iter()
        .filter(|sub| sub.status == SubscriptionStatus::Active)
        .filter_map(|sub| {
            sub.next_charge.map(|date| UpcomingCharge {
                subscription_id: sub.id.clone(),
                name: sub.name.clone(),
                amount: sub.price,
                date,
            })
        })
        .filter(|charge| charge.date >= today)
        .collect();
    upcoming.sort_by_key(|charge| charge.date);
    upcoming.truncate(8);

    let rates: Rc<[ExchangeRate]> = Rc::from(all_state.rates.clone());
    let rate = |from: Currency, to: Currency| rate_lookup(&rates, from, to, &today_iso);

    // The month's totals and the recurring cost, over the same events the pages build.
    let month_start = model::start_of_month(today);
    let month_end = model::end_of_month(today);
    let month_events = model::collect_events(
        &subscriptions,
        &movements,
        currency,
        &rate,
        month_start,
        month_end,
    );
    let totals = model::totals_for_month(&month_events, today.year(), today.month());
    let month = MonthSummary {
        year: today.year(),
        month: today.month(),
        spent: Money {
            minor: totals.expense,
            currency,
        },
        recurring: Money {
            minor: model::normalized_monthly_cost(&subscriptions, currency, &rate),
            currency,
        },
        upcoming: upcoming.len(),
    };

    // The balance history (last 90 days) and the month-end forecast come from
    // the core's projection, scoped like the rest.
    let history_from = iso(today - chrono::Duration::days(89));
    let month_end_iso = iso(month_end);
    let projection_result = match selection {
        AccountSelection::All => {
            let target = currency_to_core(currency);
            let total = total_state_for(&all_state, target);
            projection_for(&total.state, &history_from, &month_end_iso, &[]).map_err(map_error)?
        }
        AccountSelection::One(id) => {
            projection_for_account(&scoped, id, &history_from, &month_end_iso)
                .map_err(map_error)?
                .ok_or_else(|| {
                    DataError::new(DataErrorKind::NotFound, format!("account not found: {id}"))
                })?
        }
    };
    let history: Vec<BalancePoint> = projection_result
        .days
        .iter()
        .filter(|day| parse_date(&day.date).is_some_and(|date| date <= today))
        .map(|day| BalancePoint {
            date: parse_date(&day.date).expect("checked above"),
            balance: Money {
                minor: day.balance_minor,
                currency,
            },
        })
        .collect();
    let forecast = Money {
        minor: projection_result.end_balance_minor,
        currency,
    };

    // Sanity: the total across accounts matches the core's own conversion.
    if let AccountSelection::All = selection {
        let target = currency_to_core(currency);
        let expected = total_balance_minor(
            &all_state.accounts,
            target,
            &all_state.rates,
            &account.balance_date,
        );
        debug_assert_eq!(expected.total_minor, account.balance_minor);
    }

    Ok(Snapshot {
        today,
        today_iso,
        accounts,
        currency,
        approximate,
        balance,
        balance_date,
        forecast,
        month,
        upcoming: Rc::from(upcoming),
        subscriptions: Rc::from(subscriptions),
        history: Rc::from(history),
        movements: Rc::from(movements),
        rates,
    })
}

// ---------------------------------------------------------------------------
// StoreData
// ---------------------------------------------------------------------------

/// The store-backed data source: reads serve the snapshot, commands rewrite
/// the store and reload it.
pub struct StoreData {
    store: RefCell<Store>,
    selection: RefCell<AccountSelection>,
    snapshot: RefCell<Rc<Snapshot>>,
    load_error: RefCell<Option<DataError>>,
    /// Where the private key lives, how a gateway is built, and what the
    /// settings screen polls while a link or a sync runs.
    bank: Arc<BankRuntime>,
}

impl StoreData {
    /// Wraps an open store and loads its first snapshot. The bank runtime is the
    /// app's own: the OS keychain, the real client over the real transport, and
    /// the platform's browser opener.
    pub fn try_new(store: Store) -> Result<Self, DataError> {
        Self::with_bank_runtime(store, Arc::new(default_bank_runtime()))
    }

    /// The same, with a caller's runtime: what a test needs to link and sync
    /// against a recorded transport and an in-memory key store, with no
    /// keychain, no browser and no network.
    pub fn with_bank_runtime(store: Store, bank: Arc<BankRuntime>) -> Result<Self, DataError> {
        let data = StoreData {
            store: RefCell::new(store),
            selection: RefCell::new(AccountSelection::All),
            snapshot: RefCell::new(Rc::new(empty_snapshot())),
            load_error: RefCell::new(None),
            bank,
        };
        data.reload()?;
        Ok(data)
    }

    /// Opens (creating and seeding when new) the database at `path`.
    pub fn initialize(path: impl AsRef<std::path::Path>) -> Result<Self, DataError> {
        let store = Store::initialize(path).map_err(map_error)?;
        Self::try_new(store)
    }

    /// The store, for the bank tests that seed a link directly.
    #[cfg(test)]
    pub(crate) fn store_ref(&self) -> std::cell::Ref<'_, Store> {
        self.store.borrow()
    }

    /// The store, for the bank tests that seed a link directly.
    #[cfg(test)]
    pub(crate) fn store_mut(&self) -> std::cell::RefMut<'_, Store> {
        self.store.borrow_mut()
    }

    /// The bank runtime this data source runs on, so the app can start the
    /// automatic sync over the same key store and gateway factory.
    pub fn bank_runtime(&self) -> Arc<BankRuntime> {
        Arc::clone(&self.bank)
    }

    /// Re-reads the whole snapshot for the current selection.
    fn reload(&self) -> Result<(), DataError> {
        let selection = self.selection.borrow().clone();
        let result = {
            let store = self.store.borrow();
            build_snapshot(&store, &selection)
        };
        match result {
            Ok(snapshot) => {
                *self.snapshot.borrow_mut() = Rc::new(snapshot);
                *self.load_error.borrow_mut() = None;
                Ok(())
            }
            Err(error) => {
                *self.load_error.borrow_mut() = Some(error.clone());
                Err(error)
            }
        }
    }

    /// The account new rows belong to: the selected one, or the first.
    fn current_account_id(&self) -> String {
        match self.selection.borrow().clone() {
            AccountSelection::One(id) => id,
            AccountSelection::All => self
                .store
                .borrow()
                .accounts()
                .ok()
                .and_then(|accounts| accounts.into_iter().next().map(|account| account.id))
                .unwrap_or_default(),
        }
    }

    fn snapshot(&self) -> Rc<Snapshot> {
        self.snapshot.borrow().clone()
    }
}

/// The runtime the app ships with: the OS keychain for keys, the real
/// Enable Banking client over `ureq` for requests, and the platform's browser
/// for the authorization URL.
///
/// This is the ONLY place a keychain or a network is touched, and it is only
/// reached when the user asks for a link or a sync.
pub fn default_bank_runtime() -> BankRuntime {
    let factory: GatewayFactory = Arc::new(|secrets: &dyn PrivateKeyStore, app_id: &str| {
        let key = bank_sync::load_key(secrets, app_id)?;
        let signer = moxen_finances_banking::JwtSigner::new(app_id, &key)?;
        // Thirty seconds per request: transaction pages are the slow call.
        let transport = UreqTransport::new(std::time::Duration::from_secs(30));
        Ok(Box::new(Client::new(signer, transport, SystemClock)) as Box<dyn BankGateway>)
    });
    let opener: UrlOpener = Arc::new(open_in_browser);
    BankRuntime::new(Arc::new(KeychainStore::new()), factory, opener)
}

/// Hand an `https` URL to the platform's browser without a shell: `open` on
/// macOS, the URL protocol handler on Windows. The URL was already checked to
/// be `https` by the link flow, and it is passed as one argument, never joined
/// into a command line.
fn open_in_browser(url: &str) -> bool {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        // `rundll32 url.dll,FileProtocolHandler` opens the default browser
        // without going through `cmd`, so the URL is never re-parsed.
        let mut command = std::process::Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| true)
        .unwrap_or(false)
}

fn empty_snapshot() -> Snapshot {
    let today = NaiveDate::default();
    Snapshot {
        today,
        today_iso: iso(today),
        accounts: Rc::from([]),
        currency: Currency::Eur,
        approximate: false,
        balance: Money::eur(0),
        balance_date: today,
        forecast: Money::eur(0),
        month: MonthSummary {
            year: today.year(),
            month: today.month(),
            spent: Money::eur(0),
            recurring: Money::eur(0),
            upcoming: 0,
        },
        upcoming: Rc::from([]),
        subscriptions: Rc::from([]),
        history: Rc::from([]),
        movements: Rc::from([]),
        rates: Rc::from([]),
    }
}

impl FinancesData for StoreData {
    fn today(&self) -> NaiveDate {
        self.snapshot().today
    }
    fn balance(&self) -> Money {
        self.snapshot().balance
    }
    fn balance_date(&self) -> NaiveDate {
        self.snapshot().balance_date
    }
    fn month_end_forecast(&self) -> Money {
        self.snapshot().forecast
    }
    fn month_summary(&self) -> MonthSummary {
        self.snapshot().month.clone()
    }
    fn upcoming_charges(&self) -> Rc<[UpcomingCharge]> {
        self.snapshot().upcoming.clone()
    }
    fn subscriptions(&self) -> Rc<[Subscription]> {
        self.snapshot().subscriptions.clone()
    }
    fn balance_history(&self) -> Rc<[BalancePoint]> {
        self.snapshot().history.clone()
    }
    fn account_currency(&self) -> Currency {
        self.snapshot().currency
    }
    fn exchange_rate(&self, from: Currency, to: Currency) -> f64 {
        let snapshot = self.snapshot();
        rate_lookup(&snapshot.rates, from, to, &snapshot.today_iso)
    }
    fn movements(&self) -> Rc<[Movement]> {
        self.snapshot().movements.clone()
    }
    fn is_ready(&self) -> bool {
        self.load_error.borrow().is_none()
    }
    fn accounts(&self) -> Rc<[AccountInfo]> {
        self.snapshot().accounts.clone()
    }
    fn total_approximate(&self) -> bool {
        self.snapshot().approximate
    }
    fn database_path(&self) -> Option<String> {
        self.store
            .borrow()
            .path()
            .map(|path| path.display().to_string())
    }
    fn bank_sync(&self) -> BankSyncState {
        // Read live, not from the snapshot: a link or a sync that finished on
        // its worker thread has to show up on the next frame.
        bank_sync::state(&self.store.borrow(), &self.bank)
    }
}

impl FinancesMutations for StoreData {
    fn refresh(&self) -> Result<(), DataError> {
        self.reload()
    }

    fn select_account(&self, selection: AccountSelection) -> Result<(), DataError> {
        *self.selection.borrow_mut() = selection;
        self.reload()
    }

    fn create_account(&self, draft: &AccountDraft) -> Result<(), DataError> {
        let input = AccountInput {
            name: draft.name.clone(),
            kind: Some(kind_to_core(draft.kind)),
            currency: Some(currency_to_core(draft.currency)),
            balance_minor: draft.balance_minor,
            balance_date: None,
            opening_balance_minor: None,
            opening_balance_date: None,
            notes: None,
        };
        self.store
            .borrow_mut()
            .create_account(&input)
            .map_err(map_error)?;
        self.reload()
    }

    fn rename_account(&self, id: &str, name: &str) -> Result<(), DataError> {
        let patch = AccountPatch {
            name: Some(name.to_string()),
            ..Default::default()
        };
        self.store
            .borrow_mut()
            .update_account_by_id(id, &patch)
            .map_err(map_error)?;
        self.reload()
    }

    fn set_account_archived(&self, id: &str, archived: bool) -> Result<(), DataError> {
        let patch = AccountPatch {
            archived: Some(archived),
            ..Default::default()
        };
        self.store
            .borrow_mut()
            .update_account_by_id(id, &patch)
            .map_err(map_error)?;
        self.reload()
    }

    fn delete_account(&self, id: &str) -> Result<(), DataError> {
        self.store
            .borrow_mut()
            .delete_account(id)
            .map_err(map_error)?;
        // The selection may have pointed at the deleted account.
        if self.selection.borrow().clone() == AccountSelection::One(id.to_string()) {
            *self.selection.borrow_mut() = AccountSelection::All;
        }
        self.reload()
    }

    fn create_transfer(&self, draft: &TransferDraft) -> Result<(), DataError> {
        let input = TransferInput {
            date: iso(draft.date),
            time: None,
            amount_minor: draft.amount_minor,
            currency: currency_to_core(draft.currency),
            from_account_id: draft.from_account_id.clone(),
            to_account_id: draft.to_account_id.clone(),
            note: draft.note.clone(),
        };
        self.store
            .borrow_mut()
            .create_transfer(&input)
            .map_err(map_error)?;
        self.reload()
    }

    fn create_subscription(&self, draft: &SubscriptionDraft) -> Result<(), DataError> {
        let mut input = SubscriptionInput::new(draft.name.clone());
        input.description = draft.description.clone();
        input.currency = Some(currency_to_core(draft.currency));
        input.price_minor = draft.price_minor;
        input.frequency = Some(frequency_to_core(draft.frequency));
        input.start_date = draft.start_date.map(iso);
        input.billing_day = draft.billing_day;
        input.end_date = draft.end_date.map(iso);
        input.account_id = Some(self.current_account_id());
        self.store
            .borrow_mut()
            .create_subscription(&input)
            .map_err(map_error)?;
        self.reload()
    }

    fn update_subscription(&self, id: &str, draft: &SubscriptionDraft) -> Result<(), DataError> {
        let patch = SubscriptionPatch {
            name: Some(draft.name.clone()),
            description: Some(draft.description.clone().unwrap_or_default()),
            currency: Some(currency_to_core(draft.currency)),
            price_minor: Some(draft.price_minor),
            frequency: Some(frequency_to_core(draft.frequency)),
            start_date: Some(draft.start_date.map(iso)),
            billing_day: Some(draft.billing_day),
            next_billing_override: Some(None),
            end_date: Some(draft.end_date.map(iso)),
            plan: Some(None),
            notes: Some(String::new()),
            external_payment: Some(false),
            status: None,
            cancelled_at: Some(None),
            archived: Some(false),
            archived_at: Some(None),
            account_id: Some(self.current_account_id()),
        };
        self.store
            .borrow_mut()
            .update_subscription(id, &patch)
            .map_err(map_error)?;
        self.reload()
    }

    fn apply_subscription_action(
        &self,
        id: &str,
        action: SubscriptionAction,
    ) -> Result<(), DataError> {
        let today = today_madrid_now();
        match action {
            SubscriptionAction::Delete => {
                self.store
                    .borrow_mut()
                    .delete_subscription(id)
                    .map_err(map_error)?;
            }
            SubscriptionAction::Pause => {
                self.store
                    .borrow_mut()
                    .apply_subscription_action(id, CoreSubscriptionAction::Pause, &today, "")
                    .map_err(map_error)?;
            }
            SubscriptionAction::Resume => {
                self.store
                    .borrow_mut()
                    .apply_subscription_action(id, CoreSubscriptionAction::Resume, &today, "")
                    .map_err(map_error)?;
            }
            SubscriptionAction::Cancel => {
                self.store
                    .borrow_mut()
                    .apply_subscription_action(id, CoreSubscriptionAction::Cancel, &today, "")
                    .map_err(map_error)?;
            }
            SubscriptionAction::Finish => {
                self.store
                    .borrow_mut()
                    .apply_subscription_action(id, CoreSubscriptionAction::Finish, &today, "")
                    .map_err(map_error)?;
            }
            SubscriptionAction::Reactivate => {
                self.store
                    .borrow_mut()
                    .apply_subscription_action(id, CoreSubscriptionAction::Reactivate, &today, "")
                    .map_err(map_error)?;
            }
        }
        self.reload()
    }

    fn create_movement(&self, draft: &MovementDraft) -> Result<(), DataError> {
        let account_id = Some(self.current_account_id());
        match draft.kind {
            MovementKind::Income => {
                let input = IncomeInput {
                    concept: draft.name.clone(),
                    amount_minor: draft.amount_minor,
                    currency: currency_to_core(draft.currency),
                    date: iso(draft.date),
                    time: draft.time.clone(),
                    frequency: frequency_to_core(draft.frequency),
                    end_date: draft.end_date.map(iso),
                    status: match draft.status {
                        MovementStatus::Received => CoreIncomeStatus::Received,
                        _ => CoreIncomeStatus::Expected,
                    },
                    paused: false,
                    notes: draft.notes.clone().unwrap_or_default(),
                    actual_amount_minor: None,
                    account_id,
                };
                self.store
                    .borrow_mut()
                    .create_income(&input)
                    .map_err(map_error)?;
            }
            MovementKind::Expense => {
                let input = ExpenseInput {
                    concept: draft.name.clone(),
                    category: draft
                        .category
                        .clone()
                        .unwrap_or_else(|| "Otros".to_string()),
                    amount_minor: draft.amount_minor,
                    currency: currency_to_core(draft.currency),
                    date: iso(draft.date),
                    time: draft.time.clone(),
                    frequency: frequency_to_core(draft.frequency),
                    end_date: draft.end_date.map(iso),
                    status: match draft.status {
                        MovementStatus::Pending => CoreExpenseStatus::Pending,
                        MovementStatus::Done => CoreExpenseStatus::Done,
                        _ => CoreExpenseStatus::Planned,
                    },
                    notes: draft.notes.clone().unwrap_or_default(),
                    actual_amount_minor: None,
                    account_id,
                };
                self.store
                    .borrow_mut()
                    .create_expense(&input)
                    .map_err(map_error)?;
            }
            MovementKind::Charge => {
                let subscription_id = draft.subscription_id.clone().ok_or_else(|| {
                    DataError::new(DataErrorKind::Invalid, "a charge needs a subscription")
                })?;
                let input = ChargeInput {
                    subscription_id,
                    charge_date: iso(draft.date),
                    time: draft.time.clone(),
                    amount_minor: draft.amount_minor,
                    currency: currency_to_core(draft.currency),
                    rate_scaled: None,
                    note: draft.notes.clone(),
                    account_id,
                };
                self.store
                    .borrow_mut()
                    .add_charge(&input)
                    .map_err(map_error)?;
            }
        }
        self.reload()
    }

    fn update_movement(&self, draft: &MovementDraft) -> Result<(), DataError> {
        let Some(id) = draft.id.clone() else {
            return Err(DataError::new(
                DataErrorKind::Invalid,
                "an edit needs the movement's id",
            ));
        };
        // Keep the row's own account: an edit never moves a row between accounts.
        let account_id: Option<String> = match draft.kind {
            MovementKind::Income => self
                .store
                .borrow()
                .income(&id)
                .map_err(map_error)?
                .map(|row| row.account_id),
            MovementKind::Expense => self
                .store
                .borrow()
                .expense(&id)
                .map_err(map_error)?
                .map(|row| row.account_id),
            MovementKind::Charge => self
                .store
                .borrow()
                .app_state()
                .map_err(map_error)?
                .charges
                .into_iter()
                .find(|charge| charge.id == id)
                .map(|charge| charge.account_id),
        };
        match draft.kind {
            MovementKind::Income => {
                let input = IncomeInput {
                    concept: draft.name.clone(),
                    amount_minor: draft.amount_minor,
                    currency: currency_to_core(draft.currency),
                    date: iso(draft.date),
                    time: draft.time.clone(),
                    frequency: frequency_to_core(draft.frequency),
                    end_date: draft.end_date.map(iso),
                    status: match draft.status {
                        MovementStatus::Received => CoreIncomeStatus::Received,
                        _ => CoreIncomeStatus::Expected,
                    },
                    paused: false,
                    notes: draft.notes.clone().unwrap_or_default(),
                    actual_amount_minor: None,
                    account_id: account_id.filter(|id| !id.is_empty()),
                };
                self.store
                    .borrow_mut()
                    .update_income(&id, &input)
                    .map_err(map_error)?;
            }
            MovementKind::Expense => {
                let input = ExpenseInput {
                    concept: draft.name.clone(),
                    category: draft
                        .category
                        .clone()
                        .unwrap_or_else(|| "Otros".to_string()),
                    amount_minor: draft.amount_minor,
                    currency: currency_to_core(draft.currency),
                    date: iso(draft.date),
                    time: draft.time.clone(),
                    frequency: frequency_to_core(draft.frequency),
                    end_date: draft.end_date.map(iso),
                    status: match draft.status {
                        MovementStatus::Pending => CoreExpenseStatus::Pending,
                        MovementStatus::Done => CoreExpenseStatus::Done,
                        _ => CoreExpenseStatus::Planned,
                    },
                    notes: draft.notes.clone().unwrap_or_default(),
                    actual_amount_minor: None,
                    account_id: account_id.filter(|id| !id.is_empty()),
                };
                self.store
                    .borrow_mut()
                    .update_expense(&id, &input)
                    .map_err(map_error)?;
            }
            MovementKind::Charge => {
                let subscription_id = draft.subscription_id.clone().ok_or_else(|| {
                    DataError::new(DataErrorKind::Invalid, "a charge needs a subscription")
                })?;
                let input = ChargeInput {
                    subscription_id,
                    charge_date: iso(draft.date),
                    time: draft.time.clone(),
                    amount_minor: draft.amount_minor,
                    currency: currency_to_core(draft.currency),
                    rate_scaled: None,
                    note: draft.notes.clone(),
                    account_id: account_id.filter(|id| !id.is_empty()),
                };
                self.store
                    .borrow_mut()
                    .update_charge(&id, &input)
                    .map_err(map_error)?;
            }
        }
        self.reload()
    }

    fn confirm_movement(&self, id: &str, kind: MovementKind) -> Result<(), DataError> {
        match kind {
            MovementKind::Income => {
                let mut store = self.store.borrow_mut();
                let Some(income) = store.income(id).map_err(map_error)? else {
                    return Err(DataError::new(
                        DataErrorKind::NotFound,
                        format!("income not found: {id}"),
                    ));
                };
                let input = IncomeInput {
                    concept: income.concept,
                    amount_minor: income.amount_minor,
                    currency: income.currency,
                    date: income.date,
                    time: income.time,
                    frequency: income.frequency,
                    end_date: income.end_date,
                    status: CoreIncomeStatus::Received,
                    paused: income.paused,
                    notes: income.notes,
                    actual_amount_minor: income.actual_amount_minor,
                    account_id: Some(income.account_id),
                };
                store.update_income(id, &input).map_err(map_error)?;
            }
            MovementKind::Expense => {
                let mut store = self.store.borrow_mut();
                let Some(expense) = store.expense(id).map_err(map_error)? else {
                    return Err(DataError::new(
                        DataErrorKind::NotFound,
                        format!("expense not found: {id}"),
                    ));
                };
                let input = ExpenseInput {
                    concept: expense.concept,
                    category: expense.category,
                    amount_minor: expense.amount_minor,
                    currency: expense.currency,
                    date: expense.date,
                    time: expense.time,
                    frequency: expense.frequency,
                    end_date: expense.end_date,
                    status: CoreExpenseStatus::Done,
                    notes: expense.notes,
                    actual_amount_minor: expense.actual_amount_minor,
                    account_id: Some(expense.account_id),
                };
                store.update_expense(id, &input).map_err(map_error)?;
            }
            // A real charge is already confirmed by definition.
            MovementKind::Charge => {}
        }
        self.reload()
    }

    fn delete_movement(&self, id: &str, kind: MovementKind) -> Result<(), DataError> {
        let mut store = self.store.borrow_mut();
        match kind {
            MovementKind::Income => {
                store.delete_income(id).map_err(map_error)?;
            }
            MovementKind::Expense => {
                store.delete_expense(id).map_err(map_error)?;
            }
            MovementKind::Charge => {
                store.delete_charge(id).map_err(map_error)?;
            }
        }
        drop(store);
        self.reload()
    }

    fn export_backup_json(&self) -> Result<String, DataError> {
        self.store.borrow().export_json().map_err(map_error)
    }

    fn restore_backup_json(&self, json: &str) -> Result<(), DataError> {
        self.store
            .borrow_mut()
            .restore_json(json)
            .map_err(map_error)?;
        self.reload()
    }

    fn export_csv(&self, sheet: CsvSheet) -> Result<String, DataError> {
        let kind = match sheet {
            CsvSheet::Subscriptions => CsvKind::Subscriptions,
            CsvSheet::Incomes => CsvKind::Incomes,
            CsvSheet::Expenses => CsvKind::Expenses,
            CsvSheet::Rates => CsvKind::Rates,
            CsvSheet::Movements => CsvKind::Movements,
        };
        // The whole history: from the epoch to far ahead, so recurring rows
        // export too.
        self.store
            .borrow()
            .export_csv(kind, "1970-01-01", "2999-12-31")
            .map_err(map_error)
    }

    // -- bank sync (LOCAL-031) ---------------------------------------------------

    fn save_bank_application(&self, app_id: &str) -> Result<(), DataError> {
        let app_id = app_id.trim();
        if app_id.is_empty() {
            return Err(DataError::new(
                DataErrorKind::Invalid,
                moxen_finances_ui::language::message("settings.bank.app.empty"),
            ));
        }
        // The application id is public metadata: it names the application in
        // every JWT. The key never comes this way, and the setting cannot hold
        // one.
        self.store
            .borrow_mut()
            .update_setting(APP_ID_SETTING, app_id)
            .map_err(map_error)
    }

    fn import_bank_key(&self, pem_path: &str) -> Result<(), DataError> {
        let app_id = bank_sync::app_id(&self.store.borrow());
        if app_id.is_empty() {
            return Err(BankFailure::NoApplication.to_data_error());
        }
        // Read once, validated, stored in the OS keychain. The path is not
        // kept, and no part of the key touches this database or a log.
        import_pem_file(self.bank.secrets.as_ref(), &app_id, pem_path)
            .map_err(|error| BankFailure::Secret(error).to_data_error())
    }

    fn remove_bank_key(&self) -> Result<(), DataError> {
        let app_id = bank_sync::app_id(&self.store.borrow());
        if app_id.is_empty() {
            return Err(BankFailure::NoApplication.to_data_error());
        }
        self.bank
            .secrets
            .forget(&app_id)
            .map_err(|error| BankFailure::Secret(error).to_data_error())
    }

    fn link_bank(&self, draft: &BankLinkDraft) -> Result<(), DataError> {
        let app_id = bank_sync::app_id(&self.store.borrow());
        if app_id.is_empty() {
            return Err(BankFailure::NoApplication.to_data_error());
        }
        // A link with no key would fail on the first request; say which piece
        // is missing before opening a browser.
        moxen_finances_banking::secrets::PrivateKeyStore::load(self.bank.secrets.as_ref(), &app_id)
            .map_err(|error| BankFailure::Secret(error).to_data_error())?;
        let country = draft.country.trim().to_ascii_uppercase();
        if country.is_empty() || draft.bank_name.trim().is_empty() {
            return Err(DataError::new(
                DataErrorKind::Invalid,
                moxen_finances_ui::language::message("settings.bank.link.needs-application"),
            ));
        }
        let bank_name = draft.bank_name.trim().to_string();
        let language = draft.language.clone();
        // A file-backed store links on a worker thread, against its own
        // connection to the same file, so the window keeps painting while the
        // browser is open. An in-memory store (a test) has no file to share,
        // so it links here.
        let path = self.store.borrow().path().map(std::path::Path::to_path_buf);
        match path {
            Some(path) => self
                .bank
                .link_in_background(path, app_id, country, bank_name, language)
                .map_err(|failure| failure.to_data_error()),
            None => {
                let mut store = self.store.borrow_mut();
                self.bank
                    .link_inline(
                        &mut store,
                        &app_id,
                        &country,
                        &bank_name,
                        language.as_deref(),
                    )
                    .map(|_| ())
                    .map_err(|failure| failure.to_data_error())
            }
        }
    }

    fn unlink_bank(&self, connection_id: &str) -> Result<(), DataError> {
        // Ask the bank to close the session first (it needs the row we are
        // about to delete), then forget the link. The movements the link
        // imported stay: they are the user's history, not the link's.
        let (app_id, session_id, path) = {
            let store = self.store.borrow();
            match store.bank_connection(connection_id).map_err(map_error)? {
                Some(connection) => (
                    connection.app_id,
                    connection.session_id,
                    store.path().map(std::path::Path::to_path_buf),
                ),
                None => return Ok(()),
            }
        };
        if let Some(path) = path {
            self.bank
                .close_session_in_background(path, app_id, session_id);
        }
        self.store
            .borrow_mut()
            .delete_bank_connection(connection_id)
            .map_err(map_error)?;
        Ok(())
    }

    fn map_bank_account(
        &self,
        connection_id: &str,
        external_uid: &str,
        account_id: &str,
    ) -> Result<(), DataError> {
        self.store
            .borrow_mut()
            .set_bank_account_mapping(connection_id, external_uid, account_id)
            .map_err(map_error)
    }

    fn sync_bank_now(&self, connection_id: &str) -> Result<(), DataError> {
        let today =
            parse_date(&today_madrid_now()).unwrap_or_else(|| chrono::Utc::now().date_naive());
        let path = self.store.borrow().path().map(std::path::Path::to_path_buf);
        match path {
            Some(path) => self
                .bank
                .sync_in_background(path, connection_id.to_string(), today)
                .map_err(|failure| failure.to_data_error()),
            None => {
                let mut store = self.store.borrow_mut();
                self.bank
                    .sync_inline(&mut store, connection_id, today)
                    .map_err(|failure| failure.to_data_error())?;
                drop(store);
                // The ledger changed on this thread: read it again so the
                // views show the imported movements on the next frame.
                self.reload()
            }
        }
    }

    fn set_bank_sync_interval(&self, minutes: Option<u32>) -> Result<(), DataError> {
        // Off is stored as an empty value, which the reader treats as absent.
        let value = minutes
            .map(|minutes| minutes.to_string())
            .unwrap_or_default();
        self.store
            .borrow_mut()
            .update_setting(INTERVAL_SETTING, &value)
            .map_err(map_error)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> (tempfile::TempDir, StoreData) {
        let dir = tempfile::tempdir().expect("temp dir");
        let data = StoreData::initialize(dir.path().join("finances.db")).expect("store data");
        (dir, data)
    }

    #[test]
    fn a_seeded_store_snapshots_all_accounts_and_the_total() {
        let (_dir, data) = seeded();
        let accounts = data.accounts();
        assert_eq!(accounts.len(), 3, "the demo seed has three accounts");
        assert_eq!(accounts[0].name, "Cuenta corriente");
        assert!(!data.total_approximate(), "the seed carries exchange rates");
        // All-accounts view: the total is the sum of the three balances (0 here).
        assert_eq!(data.account_currency(), Currency::Eur);
        assert_eq!(data.balance().minor, 0);
        assert!(data.is_ready());
        // The demo seed has ten subscriptions, spread over the accounts.
        assert_eq!(data.subscriptions().len(), 10);
        // The rates convert USD to EUR through the seeded 1 EUR = 1.10 USD.
        let rate = data.exchange_rate(Currency::Usd, Currency::Eur);
        assert!((rate - 1.0 / 1.10).abs() < 1e-6, "rate was {rate}");
        assert_eq!(data.exchange_rate(Currency::Eur, Currency::Eur), 1.0);
        // The database path is reported for the Settings page.
        assert!(
            data.database_path()
                .is_some_and(|path| path.ends_with("finances.db"))
        );
    }

    #[test]
    fn switching_to_one_account_scopes_the_reads() {
        let (_dir, data) = seeded();
        let card = data
            .accounts()
            .iter()
            .find(|account| account.kind == AccountKind::CreditCard)
            .expect("a credit card account")
            .id
            .clone();
        FinancesMutations::select_account(&data, AccountSelection::One(card.clone()))
            .expect("select");
        // Only the subscriptions paid from that account remain.
        let all_count = 10;
        let scoped = data.subscriptions();
        assert!(
            scoped.len() < all_count,
            "one account holds fewer subscriptions than all: {}",
            scoped.len()
        );
        // The transfers touching the card appear as movements.
        assert!(
            data.movements()
                .iter()
                .any(|m| m.id.starts_with("transfer-") && m.kind == MovementKind::Income)
        );
        // Switching back restores the aggregate view.
        FinancesMutations::select_account(&data, AccountSelection::All).expect("select all");
        assert_eq!(data.subscriptions().len(), all_count);
        // Transfers never change the total: none in the all-accounts list.
        assert!(
            !data
                .movements()
                .iter()
                .any(|m| m.id.starts_with("transfer-"))
        );
    }

    #[test]
    fn a_missing_rate_flags_the_total_approximate() {
        let _dir = tempfile::tempdir().expect("temp dir");
        let mut store = Store::open_in_memory().expect("memory store");
        // Two accounts, one in USD, and no rates at all.
        store
            .create_account(&AccountInput {
                name: "EUR cuenta".into(),
                currency: Some(CoreCurrency::Eur),
                balance_minor: Some(100_000),
                ..Default::default()
            })
            .expect("account");
        store
            .create_account(&AccountInput {
                name: "USD cuenta".into(),
                currency: Some(CoreCurrency::Usd),
                balance_minor: Some(50_000),
                ..Default::default()
            })
            .expect("account");
        let data = StoreData::try_new(store).expect("data");
        assert!(data.total_approximate());
        // The unconverted USD amount still counts.
        assert_eq!(data.balance().minor, 150_000);
        assert_eq!(data.exchange_rate(Currency::Usd, Currency::Eur), 1.0);
    }

    #[test]
    fn mutations_write_through_and_refresh_the_snapshot() {
        let (_dir, data) = seeded();
        let sub_id = data.subscriptions()[0].id.clone();
        FinancesMutations::apply_subscription_action(&data, &sub_id, SubscriptionAction::Pause)
            .expect("pause");
        let subscriptions = data.subscriptions();
        let paused = subscriptions
            .iter()
            .find(|sub| sub.id == sub_id)
            .expect("still there");
        assert_eq!(paused.status, SubscriptionStatus::Paused);
        // Create a movement and see it in the refreshed snapshot.
        let before = data.movements().len();
        FinancesMutations::create_movement(
            &data,
            &MovementDraft {
                id: None,
                kind: MovementKind::Expense,
                name: "Compra de prueba".into(),
                subscription_id: None,
                category: Some("Compras".into()),
                amount_minor: 1234,
                currency: Currency::Eur,
                date: data.today(),
                time: None,
                frequency: Frequency::Once,
                end_date: None,
                status: MovementStatus::Pending,
                notes: None,
            },
        )
        .expect("create movement");
        let movements = data.movements();
        assert_eq!(movements.len(), before + 1);
        let created = movements.last().expect("the new movement");
        assert_eq!(created.name, "Compra de prueba");
        assert_eq!(created.status, MovementStatus::Pending);
        // Confirm it: pending becomes done.
        FinancesMutations::confirm_movement(&data, &created.id, MovementKind::Expense)
            .expect("confirm");
        let movements = data.movements();
        let confirmed = movements
            .iter()
            .find(|m| m.id == created.id)
            .expect("still there");
        assert_eq!(confirmed.status, MovementStatus::Done);
        // Delete it again.
        FinancesMutations::delete_movement(&data, &created.id, MovementKind::Expense)
            .expect("delete");
        assert_eq!(data.movements().len(), before);
    }

    #[test]
    fn deleting_an_account_in_use_fails_cleanly() {
        let (_dir, data) = seeded();
        // The checking account has subscriptions, so deleting it is refused.
        let checking = data.accounts()[0].id.clone();
        let error = FinancesMutations::delete_account(&data, &checking).expect_err("refused");
        assert_eq!(error.kind, DataErrorKind::AccountInUse);
        assert!(!error.detail.is_empty());
        // The account is still there and the snapshot still loads.
        assert!(data.accounts().iter().any(|a| a.id == checking));
        assert!(data.is_ready());
    }

    #[test]
    fn backup_export_and_restore_round_trip_through_the_commands() {
        let (_dir, data) = seeded();
        let json = FinancesMutations::export_backup_json(&data).expect("export");
        assert!(json.contains("\"version\":2"), "backup carries the version");
        // Change something, then restore: the change is gone.
        let sub_id = data.subscriptions()[0].id.clone();
        FinancesMutations::apply_subscription_action(&data, &sub_id, SubscriptionAction::Cancel)
            .expect("cancel");
        assert_eq!(
            data.subscriptions()
                .iter()
                .find(|s| s.id == sub_id)
                .expect("sub")
                .status,
            SubscriptionStatus::Cancelled
        );
        FinancesMutations::restore_backup_json(&data, &json).expect("restore");
        assert_eq!(
            data.subscriptions()
                .iter()
                .find(|s| s.id == sub_id)
                .expect("sub")
                .status,
            SubscriptionStatus::Active
        );
        // A malformed backup is an error, not a panic.
        let error =
            FinancesMutations::restore_backup_json(&data, "not json").expect_err("malformed");
        assert_eq!(error.kind, DataErrorKind::Backup);
    }

    #[test]
    fn csv_export_writes_every_sheet() {
        let (_dir, data) = seeded();
        for sheet in CsvSheet::ALL {
            let csv = FinancesMutations::export_csv(&data, sheet).expect("csv");
            assert!(!csv.is_empty(), "sheet {:?} is empty", sheet);
            assert!(csv.lines().count() >= 1);
        }
        let movements = FinancesMutations::export_csv(&data, CsvSheet::Movements).expect("csv");
        assert!(
            movements.contains('\u{feff}'),
            "the reference's BOM is written"
        );
    }

    #[test]
    fn accounts_can_be_created_renamed_archived_and_transferred() {
        let (_dir, data) = seeded();
        FinancesMutations::create_account(
            &data,
            &AccountDraft {
                name: "Cuenta de prueba".into(),
                kind: AccountKind::Savings,
                currency: Currency::Eur,
                balance_minor: Some(5_000),
            },
        )
        .expect("create");
        let created = data
            .accounts()
            .iter()
            .find(|a| a.name == "Cuenta de prueba")
            .expect("created")
            .id
            .clone();
        assert_eq!(data.accounts().len(), 4);
        FinancesMutations::rename_account(&data, &created, "Ahorro de prueba").expect("rename");
        assert!(
            data.accounts()
                .iter()
                .any(|a| a.id == created && a.name == "Ahorro de prueba")
        );
        // A transfer between two existing accounts appears in both scopes.
        let from = data.accounts()[0].id.clone();
        let to = data.accounts()[1].id.clone();
        FinancesMutations::create_transfer(
            &data,
            &TransferDraft {
                from_account_id: from.clone(),
                to_account_id: to.clone(),
                amount_minor: 1_000,
                currency: Currency::Eur,
                date: data.today(),
                note: Some("Traspaso de prueba".into()),
            },
        )
        .expect("transfer");
        FinancesMutations::select_account(&data, AccountSelection::One(from.clone()))
            .expect("select");
        assert!(
            data.movements()
                .iter()
                .any(|m| m.id.starts_with("transfer-") && m.kind == MovementKind::Expense)
        );
        // A transfer between the same account is refused.
        let error = FinancesMutations::create_transfer(
            &data,
            &TransferDraft {
                from_account_id: from.clone(),
                to_account_id: from.clone(),
                amount_minor: 1,
                currency: Currency::Eur,
                date: data.today(),
                note: None,
            },
        )
        .expect_err("same account");
        assert_eq!(error.kind, DataErrorKind::Invalid);
        // Archiving keeps the account but hides it from the selector's active list.
        FinancesMutations::set_account_archived(&data, &created, true).expect("archive");
        assert!(
            data.accounts()
                .iter()
                .any(|a| a.id == created && a.archived)
        );
    }
}

#[cfg(test)]
mod bank_tests {
    //! The bank sync through the trait the Settings page talks to: the
    //! application id in settings, the key in an in-memory store, the interval,
    //! the mapping, a sync and an unlink. No keychain, no browser, no network.

    use super::*;
    use crate::test_support::*;
    use moxen_finances_ui::data::BankConsent;

    #[test]
    fn the_application_id_is_a_setting_and_the_key_stays_in_its_store() {
        let (runtime, secrets) = bank_runtime(vec![]);
        let data = memory_data(runtime);
        // Nothing stored yet: linking is not ready.
        assert_eq!(data.bank_sync().app_id, "");
        assert!(!data.bank_sync().is_ready_to_link());

        data.save_bank_application("  fictional-application-id  ")
            .expect("the application");
        assert_eq!(data.bank_sync().app_id, "fictional-application-id");
        assert!(!data.bank_sync().key_stored);
        // An empty application id is refused with a localizable error.
        let error = data.save_bank_application("   ").expect_err("empty");
        assert_eq!(error.kind, DataErrorKind::Invalid);

        // The key is imported from a PEM file into the key store, and nowhere
        // else: the settings table holds no key.
        data.import_bank_key(
            &banking_fixture_path("test-key-pkcs8.pem")
                .display()
                .to_string(),
        )
        .expect("the key");
        assert!(data.bank_sync().key_stored);
        assert!(data.bank_sync().is_ready_to_link());
        assert_eq!(secrets.len(), 1);
        let settings = data.store_ref().settings().expect("settings");
        assert!(
            !settings
                .iter()
                .any(|setting| setting.value.contains("PRIVATE KEY")),
            "no setting may hold the private key"
        );

        // And it can be removed again.
        data.remove_bank_key().expect("forget");
        assert!(!data.bank_sync().key_stored);
        assert!(secrets.is_empty());
    }

    #[test]
    fn the_interval_is_stored_off_when_cleared() {
        let (runtime, _secrets) = bank_runtime(vec![]);
        let data = memory_data(runtime);
        data.set_bank_sync_interval(Some(60)).expect("an hour");
        assert_eq!(data.bank_sync().interval, Some(60));
        data.set_bank_sync_interval(None).expect("off");
        assert_eq!(data.bank_sync().interval, None);
        // And the scheduler sees nothing due while it is off.
        assert!(bank_sync::due_connections(&data.store_ref(), chrono::Utc::now()).is_empty());
    }

    #[test]
    fn a_sync_through_the_commands_imports_once_and_refreshes_the_views() {
        let (runtime, _secrets) = bank_runtime(vec![
            moxen_finances_banking::HttpResponse::new(200, banking_fixture("balances.json")),
            moxen_finances_banking::HttpResponse::new(
                200,
                banking_fixture("transactions-page-1.json"),
            ),
            moxen_finances_banking::HttpResponse::new(
                200,
                banking_fixture("transactions-page-2.json"),
            ),
            moxen_finances_banking::HttpResponse::new(
                200,
                banking_fixture("transactions-page-3.json"),
            ),
        ]);
        let data = memory_data(runtime);
        data.save_bank_application(BANK_APP_ID)
            .expect("application");
        data.import_bank_key(
            &banking_fixture_path("test-key-pkcs8.pem")
                .display()
                .to_string(),
        )
        .expect("key");
        let (connection_id, account_id) = linked_in_store(&data, "2099-12-31T00:00:00Z");
        // The linked bank shows up for the settings screen at once.
        let state = data.bank_sync();
        assert_eq!(state.connections.len(), 1);
        assert_eq!(state.connections[0].accounts.len(), 2);
        assert_eq!(state.connections[0].consent, BankConsent::Valid);

        let before = data.movements().len();
        data.sync_bank_now(&connection_id).expect("sync");
        // The in-memory store syncs on this thread, so the result is already
        // there: three booked movements, and the pending one skipped.
        assert_eq!(data.movements().len(), before + 3);
        assert_eq!(data.bank_sync().connections[0].imported, 3);
        assert_eq!(
            data.bank_sync().connections[0].last_sync,
            Some(data.today())
        );
        // The balance landed on the mapped account.
        let account = data
            .accounts()
            .iter()
            .find(|account| account.id == account_id)
            .cloned()
            .expect("the account");
        assert_eq!(account.balance.minor, 123_456);
        // No link or sync is running once the command returned.
        assert_eq!(data.bank_sync().activity.map(|_| ()), None);
        assert!(data.bank_sync().message.is_some());
    }

    #[test]
    fn mapping_and_unlinking_are_the_user_s_own_decisions() {
        let (runtime, _secrets) = bank_runtime(vec![]);
        let data = memory_data(runtime);
        data.save_bank_application(BANK_APP_ID)
            .expect("application");
        let (connection_id, account_id) = linked_in_store(&data, "2099-12-31T00:00:00Z");

        // The unmapped account of the link chooses the local account.
        data.map_bank_account(&connection_id, "fictional-account-uid-0002", &account_id)
            .expect("map");
        assert_eq!(
            data.bank_sync().connections[0].accounts[1]
                .account_id
                .as_deref(),
            Some(account_id.as_str())
        );
        // And can be unmapped again.
        data.map_bank_account(&connection_id, "fictional-account-uid-0002", "")
            .expect("unmap");
        assert_eq!(data.bank_sync().connections[0].accounts[1].account_id, None);
        // An account the link does not have is refused.
        let error = data
            .map_bank_account(&connection_id, "not-a-uid", &account_id)
            .expect_err("unknown");
        assert_eq!(error.kind, DataErrorKind::NotFound);

        // Unlinking forgets the link, keeps the movements already imported.
        data.unlink_bank(&connection_id).expect("unlink");
        assert!(data.bank_sync().connections.is_empty());
        assert!(data.accounts().iter().any(|a| a.id == account_id));
    }

    #[test]
    fn a_bank_command_without_an_application_is_refused_cleanly() {
        let (runtime, _secrets) = bank_runtime(vec![]);
        let data = memory_data(runtime);
        // No application id: linking and key import say which piece is missing
        // instead of opening a browser.
        let error = data
            .link_bank(&BankLinkDraft {
                country: "ES".into(),
                bank_name: "Banco Ficticio".into(),
                language: None,
            })
            .expect_err("no application");
        assert_eq!(error.kind, DataErrorKind::Banking);
        assert!(error.detail.contains("application id"), "{}", error.detail);
        let error = data
            .import_bank_key(
                &banking_fixture_path("test-key-pkcs8.pem")
                    .display()
                    .to_string(),
            )
            .expect_err("no application");
        assert_eq!(error.kind, DataErrorKind::Banking);
        assert!(data.bank_sync().connections.is_empty());
    }

    #[test]
    fn a_missing_link_is_a_not_found_not_a_panic() {
        let (runtime, _secrets) = bank_runtime(vec![]);
        let data = memory_data(runtime);
        data.save_bank_application(BANK_APP_ID)
            .expect("application");
        let error = data.sync_bank_now("no-such-link").expect_err("gone");
        assert_eq!(error.kind, DataErrorKind::Banking);
        // An unlink of something that is not there is a no-op: the caller
        // wanted it gone.
        data.unlink_bank("no-such-link").expect("nothing to unlink");
    }
}
