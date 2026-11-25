//! The bridge between the Enable Banking client and the store: linking a bank,
//! syncing it idempotently, and the runtime the Settings screen talks to.
//!
//! ## What it does
//!
//! - [`BankGateway`] is the slice of [`moxen_finances_banking::Client`] a link
//!   or a sync needs, so the tests drive the whole path with the banking
//!   crate's [`moxen_finances_banking::testing::RecordedTransport`], a fake
//!   clock and an in-memory key store, and never touch a network or a keychain.
//! - [`link`] lists the country's banks, opens the authorization URL in the
//!   browser, waits on the loopback callback, exchanges the code for a session
//!   and writes the connection and its accounts into the store. The private key
//!   never comes near the database: the gateway's owner read it from the OS
//!   keychain.
//! - [`sync`] reads balances and booked movements for every mapped account and
//!   imports them through [`moxen_finances_store::Store::import_bank_movements`],
//!   which keys each movement by the banking crate's dedupe key. A second sync
//!   of the same window therefore imports zero: the ledger is idempotent, not
//!   merely usually-so.
//! - [`BankRuntime`] is what the store-backed data source holds: the key store,
//!   the gateway factory, the opener, and the shared status the Settings screen
//!   polls while a link or a sync runs on its own thread.
//!
//! ## What it never does
//!
//! No test reaches a real API, no key is written anywhere but a key store
//! behind [`PrivateKeyStore`], and no error carries a token, a session id or a
//! balance.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};

use moxen_finances_banking::callback::{self, CallbackServer};
use moxen_finances_banking::model::BankAccount;
use moxen_finances_banking::secrets::PrivateKeyStore;
use moxen_finances_banking::text::{Language, Localized};
use moxen_finances_banking::{
    Authorization, BankBalance, BankEntry, BankError, BankLink, BankRef, BankTransaction,
    CallbackError, Client, Clock, JwtError, PrivateKey, SecretError, SessionGrant, StartAuth,
    TransactionStatus, TransactionWindow, Transport,
};
use moxen_finances_store::banking::{BankConnectionInput, BankImportSummary, BankMovement};
use moxen_finances_store::{BankConnection, ExternalAccount, Store, StoreError};
use moxen_finances_ui::commands::{DataError, DataErrorKind};
use moxen_finances_ui::data::{
    BankActivity, BankConnectionInfo, BankConsent, BankSyncState, LinkedBankAccount,
};

/// How long before its deadline a consent starts asking for a new link.
pub const CONSENT_NOTICE_DAYS: i64 = 7;

/// How far back a first sync reads when the link has never synced.
pub const FIRST_SYNC_DAYS: i64 = 90;

/// The setting that holds the application id. Public metadata: it names the
/// application in every JWT (`kid`), and it is never the private key.
pub const APP_ID_SETTING: &str = "banking.app_id";

/// The setting that holds the minutes between automatic syncs.
pub const INTERVAL_SETTING: &str = "banking.sync_interval_minutes";

/// The slice of the banking client a link or a sync uses. Implemented by
/// [`moxen_finances_banking::Client`]; a test can supply anything.
pub trait BankGateway: Send {
    fn list_aspsps(&self, country: &str) -> Result<Vec<BankEntry>, BankError>;
    fn start_auth(&self, request: &StartAuth) -> Result<Authorization, BankError>;
    fn create_session(&self, code: &str) -> Result<SessionGrant, BankError>;
    fn balances(&self, account_uid: &str) -> Result<Vec<BankBalance>, BankError>;
    fn transactions(
        &self,
        account_uid: &str,
        window: &TransactionWindow,
    ) -> Result<Vec<BankTransaction>, BankError>;
    fn check_consent(&self, link: &BankLink) -> Result<(), BankError>;
    fn delete_session(&self, session_id: &str) -> Result<(), BankError>;
}

impl<T: Transport, C: Clock> BankGateway for Client<T, C> {
    fn list_aspsps(&self, country: &str) -> Result<Vec<BankEntry>, BankError> {
        Client::list_aspsps(self, country)
    }
    fn start_auth(&self, request: &StartAuth) -> Result<Authorization, BankError> {
        Client::start_auth(self, request)
    }
    fn create_session(&self, code: &str) -> Result<SessionGrant, BankError> {
        Client::create_session(self, code)
    }
    fn balances(&self, account_uid: &str) -> Result<Vec<BankBalance>, BankError> {
        Client::balances(self, account_uid)
    }
    fn transactions(
        &self,
        account_uid: &str,
        window: &TransactionWindow,
    ) -> Result<Vec<BankTransaction>, BankError> {
        Client::transactions(self, account_uid, window)
    }
    fn check_consent(&self, link: &BankLink) -> Result<(), BankError> {
        Client::check_consent(self, link)
    }
    fn delete_session(&self, session_id: &str) -> Result<(), BankError> {
        Client::delete_session(self, session_id)
    }
}

/// Every way a link or a sync can fail, each with a sentence in both interface
/// languages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BankFailure {
    /// The API itself refused or failed.
    Bank(BankError),
    /// The OS keychain refused, or there is no key.
    Secret(SecretError),
    /// The loopback callback never produced a code.
    Callback(CallbackError),
    /// The database refused a write, with the sentence it gave.
    Store(String),
    /// No Enable Banking application id is stored yet.
    NoApplication,
    /// The stored key for that application cannot sign a token.
    Signing(JwtError),
    /// The bank is not in that country's list.
    BankNotFound(String),
    /// The session came back without the bank or its consent deadline, so
    /// there is nothing durable to keep.
    IncompleteGrant,
    /// The bank's authorization URL was not `https`, so it was not handed to
    /// the browser.
    UnsafeUrl,
    /// The link or the connection named is gone.
    NotFound,
    /// A link or a sync is already running: one at a time.
    Busy,
}

impl From<BankError> for BankFailure {
    fn from(error: BankError) -> Self {
        BankFailure::Bank(error)
    }
}

impl From<SecretError> for BankFailure {
    fn from(error: SecretError) -> Self {
        BankFailure::Secret(error)
    }
}

impl From<CallbackError> for BankFailure {
    fn from(error: CallbackError) -> Self {
        BankFailure::Callback(error)
    }
}

impl From<StoreError> for BankFailure {
    fn from(error: StoreError) -> Self {
        BankFailure::Store(error.to_string())
    }
}

impl From<JwtError> for BankFailure {
    fn from(error: JwtError) -> Self {
        BankFailure::Signing(error)
    }
}

impl BankFailure {
    /// The sentence for `language`.
    pub fn localized(&self, language: Language) -> String {
        match self {
            BankFailure::Bank(error) => error.localized(language),
            BankFailure::Secret(error) => error.localized(language),
            BankFailure::Callback(error) => error.localized(language),
            BankFailure::Signing(error) => error.localized(language),
            // The store's own errors are single-language for now; they reach
            // the user as they are.
            BankFailure::Store(message) => message.clone(),
            BankFailure::NoApplication => language
                .pick(
                    "no Enable Banking application id is stored yet",
                    "todavía no hay ningún identificador de aplicación de Enable Banking guardado",
                )
                .to_string(),
            BankFailure::BankNotFound(name) => match language {
                Language::English => format!("{name} is not in that country's list of banks"),
                Language::Spanish => format!("{name} no está en la lista de bancos de ese país"),
            },
            BankFailure::IncompleteGrant => language
                .pick(
                    "the bank did not return the session's metadata, so nothing was linked",
                    "el banco no ha devuelto los datos de la sesión, así que no se ha vinculado nada",
                )
                .to_string(),
            BankFailure::UnsafeUrl => language
                .pick(
                    "the authorization URL was not https, so it was not opened",
                    "la dirección de autorización no era https, así que no se ha abierto",
                )
                .to_string(),
            BankFailure::NotFound => language
                .pick("that linked bank is gone", "ese banco vinculado ya no existe")
                .to_string(),
            BankFailure::Busy => language
                .pick(
                    "a link or a sync is already running",
                    "ya hay una vinculación o una sincronización en marcha",
                )
                .to_string(),
        }
    }

    /// The sentence in the interface's current language.
    pub fn localized_now(&self) -> String {
        self.localized(language_now())
    }

    /// Whether the answer is "link the bank again" rather than a retry.
    pub fn needs_link_again(&self) -> bool {
        matches!(
            self,
            BankFailure::Bank(BankError::ConsentExpired { .. })
                | BankFailure::Secret(SecretError::Missing)
                | BankFailure::NoApplication
        )
    }

    /// The failure as the UI's plain, localized error.
    pub fn to_data_error(&self) -> DataError {
        DataError::new(DataErrorKind::Banking, self.localized_now())
    }
}

/// The interface language the app is painting in, as the banking crate names
/// it.
pub fn language_now() -> Language {
    Language::from_code(moxen_finances_ui::language::current().code())
}

/// What linking needs beyond the gateway and the store.
pub struct LinkRequest<'a> {
    /// The stored application id, for the connection row.
    pub app_id: &'a str,
    /// A two-letter ISO country code.
    pub country: &'a str,
    /// The bank's name as the country's list spells it.
    pub bank_name: &'a str,
    /// The language the bank's own pages should use.
    pub language: Option<&'a str>,
    /// The loopback ports to try, in order.
    pub ports: &'a [u16],
    /// How long to wait for the browser.
    pub timeout: Duration,
    /// The `state` to send with the authorization; `None` mints a fresh one.
    /// A test passes one so it can answer its own loopback callback.
    pub state: Option<&'a str>,
    /// Hands the authorization URL to the browser; `false` when it could not
    /// be opened (the link still waits, and times out).
    pub open_url: &'a dyn Fn(&str) -> bool,
}

/// What one sync did, for the settings screen's one-line result.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub imported: usize,
    pub duplicates: usize,
    /// Movements in a currency the ledger does not hold.
    pub unsupported_currency: usize,
    /// Movements whose account the user has not mapped yet.
    pub unmapped: usize,
    /// Movements the bank reported as pending (not booked, so not imported).
    pub pending: usize,
    /// Accounts whose balance was written.
    pub balances: usize,
}

impl SyncReport {
    fn absorb(&mut self, summary: &BankImportSummary) {
        self.imported += summary.imported;
        self.duplicates += summary.duplicates;
        self.unsupported_currency += summary.unsupported_currency;
        self.unmapped += summary.unmapped;
    }
}

/// Link a bank end to end: list, authorize in the browser, exchange the code,
/// and keep the session.
pub fn link(
    gateway: &dyn BankGateway,
    store: &mut Store,
    request: &LinkRequest<'_>,
) -> Result<BankConnection, BankFailure> {
    let banks = gateway.list_aspsps(request.country)?;
    let wanted = request.bank_name.trim();
    let entry = banks
        .iter()
        .find(|entry| entry.name.eq_ignore_ascii_case(wanted))
        .or_else(|| {
            banks
                .iter()
                .find(|entry| entry.name.to_lowercase().contains(&wanted.to_lowercase()))
        })
        .ok_or_else(|| BankFailure::BankNotFound(wanted.to_string()))?;

    let server = CallbackServer::bind(request.ports)?;
    // The `127.0.0.1` spelling: the user registers both, the server answers
    // both, and this one cannot resolve to anything else.
    let redirect_url = server.redirect_urls()[0].clone();
    let state = request
        .state
        .map(str::to_string)
        .unwrap_or_else(callback::new_state);
    let mut auth = StartAuth::new(entry.bank_ref(), state.clone(), redirect_url);
    auth.language = request
        .language
        .map(|language| language.trim().to_ascii_lowercase());
    let authorization = gateway.start_auth(&auth)?;
    if !authorization.url.starts_with("https://") {
        return Err(BankFailure::UnsafeUrl);
    }
    // Opening the browser is best-effort: the callback still waits.
    (request.open_url)(&authorization.url);
    let outcome = server.wait(&state, request.timeout)?;
    let grant = match gateway.create_session(&outcome.code) {
        Ok(grant) => grant,
        // The banking crate already tells a refused consent from a bad
        // application; carry it through unchanged.
        Err(error) => return Err(BankFailure::Bank(error)),
    };
    let accounts = grant.accounts.clone();
    let kept = grant
        .into_link(Utc::now())
        .ok_or(BankFailure::IncompleteGrant)?;
    let input = BankConnectionInput {
        app_id: request.app_id.trim().to_string(),
        bank_name: kept.bank.name.clone(),
        bank_country: kept.bank.country.clone(),
        session_id: kept.session_id.clone(),
        consent_valid_until: Some(
            kept.consent_valid_until
                .to_rfc3339_opts(SecondsFormat::Secs, true),
        ),
        accounts: accounts
            .iter()
            .map(
                |account: &BankAccount| moxen_finances_store::ExternalAccountInput {
                    external_uid: account.uid.clone(),
                    // The user maps every account in the settings screen: the link
                    // alone never guesses which local account it should feed.
                    account_id: String::new(),
                    name: account.name.clone().unwrap_or_default(),
                    currency: account
                        .currency
                        .clone()
                        .unwrap_or_else(|| "EUR".to_string()),
                },
            )
            .collect(),
    };
    Ok(store.link_bank(&input)?)
}

/// What one sync needs.
pub struct SyncRequest<'a> {
    pub connection_id: &'a str,
    /// The first day to read; `None` continues from the last sync (or
    /// [`FIRST_SYNC_DAYS`] back).
    pub from: Option<NaiveDate>,
    /// The last day to read, included.
    pub to: NaiveDate,
}

/// Sync one linked bank: every mapped account's balance, and its booked
/// movements since the last sync, imported once each.
pub fn sync(
    gateway: &dyn BankGateway,
    store: &mut Store,
    request: &SyncRequest<'_>,
    now: DateTime<Utc>,
) -> Result<SyncReport, BankFailure> {
    let connection = store
        .bank_connection(request.connection_id)?
        .ok_or(BankFailure::NotFound)?;
    let accounts = store.bank_accounts(&connection.id)?;
    let link = bank_link(&connection, &accounts);
    // The client's clock decides: past the deadline no request is worth
    // making, and the answer is "link the bank again".
    gateway.check_consent(&link)?;

    let from = request.from.or_else(|| {
        connection
            .last_sync_at
            .as_deref()
            .and_then(|instant| instant.get(..10))
            .and_then(|day| NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
            // A little overlap: a movement booked late still lands once, and
            // the dedupe key makes the second sighting free.
            .map(|day| day - chrono::Duration::days(3))
    });
    let from = from.unwrap_or_else(|| request.to - chrono::Duration::days(FIRST_SYNC_DAYS));
    let window = TransactionWindow::new(from, request.to);

    let mut report = SyncReport::default();
    for account in &accounts {
        let account_id = account.account_id.clone();
        if account_id.is_empty() {
            // An unmapped account is not read at all: nothing to file it
            // under.
            report.unmapped += 1;
            continue;
        }
        if let Some(balance) = booked_balance(gateway.balances(&account.external_uid)?) {
            let date = balance.reference_date.unwrap_or(request.to);
            let iso = date.format("%Y-%m-%d").to_string();
            if store
                .set_bank_balance(&account_id, balance.amount_minor, &iso)?
                .is_some()
            {
                report.balances += 1;
            }
        }
        let transactions = gateway.transactions(&account.external_uid, &window)?;
        let mut movements = Vec::new();
        for transaction in &transactions {
            match movement(transaction) {
                Some(movement) => movements.push(movement),
                None => report.pending += 1,
            }
        }
        report.absorb(&store.import_bank_movements(&connection.id, &movements)?);
    }
    store.set_bank_last_sync(
        &connection.id,
        &now.to_rfc3339_opts(SecondsFormat::Secs, true),
    )?;
    Ok(report)
}

/// The movement one bank transaction becomes, or `None` when the bank has not
/// booked it yet (a pending movement is not in the ledger until it is).
fn movement(transaction: &BankTransaction) -> Option<BankMovement> {
    if transaction.status != TransactionStatus::Booked {
        return None;
    }
    let remittance = transaction
        .remittance
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let concept = transaction
        .counterparty
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| remittance.map(|text| text.lines().next().unwrap_or(text).to_string()))
        .unwrap_or_else(|| "…".to_string());
    Some(BankMovement {
        dedupe_key: transaction.dedupe_key.clone(),
        external_uid: transaction.account_uid.clone(),
        booking_date: transaction.booking_date.format("%Y-%m-%d").to_string(),
        amount_minor: transaction.amount_minor,
        currency: transaction.currency.clone(),
        concept,
        notes: remittance.unwrap_or_default().to_string(),
    })
}

/// The balance a ledger wants: the booked one (`CLAV`) when the bank sends it,
/// then the interim available one (`ITBD`), then whatever came first.
fn booked_balance(balances: Vec<BankBalance>) -> Option<BankBalance> {
    let pick = |kind: &str| {
        balances
            .iter()
            .find(|balance| balance.balance_type.as_deref() == Some(kind))
            .cloned()
    };
    pick("CLAV")
        .or_else(|| pick("ITBD"))
        .or_else(|| balances.into_iter().next())
}

/// The link a stored connection describes, for the consent check.
fn bank_link(connection: &BankConnection, accounts: &[ExternalAccount]) -> BankLink {
    let consent_valid_until = connection
        .consent_valid_until
        .as_deref()
        .and_then(|instant| DateTime::parse_from_rfc3339(instant).ok())
        .map(|instant| instant.with_timezone(&Utc))
        .unwrap_or_else(|| DateTime::<Utc>::MIN_UTC);
    BankLink {
        session_id: connection.session_id.clone(),
        bank: BankRef {
            name: connection.bank_name.clone(),
            country: connection.bank_country.clone(),
        },
        account_uids: accounts
            .iter()
            .map(|account| account.external_uid.clone())
            .collect(),
        consent_valid_until,
        linked_at: connection
            .created_at
            .parse::<DateTime<Utc>>()
            .unwrap_or(DateTime::<Utc>::MIN_UTC),
    }
}

/// How a consent stands at `now`, with the notice window
/// ([`CONSENT_NOTICE_DAYS`]) that turns "valid" into "link again soon".
pub fn consent_state(valid_until: Option<DateTime<Utc>>, now: DateTime<Utc>) -> BankConsent {
    let Some(valid_until) = valid_until else {
        return BankConsent::Unknown;
    };
    if valid_until <= now {
        BankConsent::Expired
    } else if valid_until - now <= chrono::Duration::days(CONSENT_NOTICE_DAYS) {
        BankConsent::Expiring
    } else {
        BankConsent::Valid
    }
}

/// Whether an automatic sync is due: the interval has passed since the last
/// successful one, or nothing has ever succeeded and the interval is on.
pub fn sync_is_due(
    interval_minutes: Option<u32>,
    last_sync: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    let Some(minutes) = interval_minutes else {
        return false;
    };
    let interval = chrono::Duration::minutes(i64::from(minutes));
    match last_sync {
        None => true,
        Some(last) => now - last >= interval,
    }
}

/// The interval the settings hold, `None` when off or unparseable.
pub fn interval_from_setting(value: Option<&str>) -> Option<u32> {
    value?
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|minutes| *minutes > 0)
}

/// How often the automatic sync looks at the clock and the interval. A turn
/// that finds nothing due costs one settings read.
pub const SCHEDULER_TICK: Duration = Duration::from_secs(60);

/// The connections an automatic sync has to run right now: every linked bank
/// whose interval has passed since its last sync. An interval that is off
/// (or unreadable) makes this empty, so nothing ever runs "every zero
/// minutes".
pub fn due_connections(store: &Store, now: DateTime<Utc>) -> Vec<String> {
    let Some(interval) = interval_from_setting(setting(store, INTERVAL_SETTING).as_deref()) else {
        return Vec::new();
    };
    store
        .bank_connections()
        .unwrap_or_default()
        .into_iter()
        .filter(|connection| !connection.session_id.is_empty())
        .filter(|connection| {
            sync_is_due(
                Some(interval),
                parse_instant(connection.last_sync_at.as_deref()),
                now,
            )
        })
        .map(|connection| connection.id)
        .collect()
}

/// The instant of a stored RFC 3339 stamp.
fn parse_instant(instant: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(instant?)
        .ok()
        .map(|instant| instant.with_timezone(&Utc))
}

/// Runs the automatic sync for as long as the app runs: one worker thread that
/// every [`SCHEDULER_TICK`] syncs the connections that are due, one at a time,
/// and leaves a dead consent alone until the user links the bank again.
///
/// It opens its own connection to the file on each turn, so the thread never
/// holds a lock the window is waiting for.
pub fn start_scheduler(path: PathBuf, runtime: Arc<BankRuntime>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(SCHEDULER_TICK);
            let Ok(mut store) = Store::open(&path) else {
                continue;
            };
            let today = moxen_finances_core::dates::today_madrid_now()
                .get(..10)
                .and_then(|day| NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
                .unwrap_or_else(|| Utc::now().date_naive());
            for connection_id in due_connections(&store, Utc::now()) {
                // A sync the user started by hand is already running: wait for
                // the next turn rather than queueing behind it.
                if runtime.activity().is_some() {
                    break;
                }
                match runtime.sync_inline(&mut store, &connection_id, today) {
                    Ok(_) => {}
                    // A consent that ran out needs a new link, not another
                    // turn: the settings banner is the fix.
                    Err(failure) if failure.needs_link_again() => break,
                    Err(_) => {}
                }
            }
        }
    });
}

/// Reads the stored application id out of a store's settings.
pub fn app_id(store: &Store) -> String {
    setting(store, APP_ID_SETTING).unwrap_or_default()
}

/// Reads one setting, empty values treated as absent.
pub fn setting(store: &Store, key: &str) -> Option<String> {
    store
        .settings()
        .ok()?
        .into_iter()
        .find(|setting| setting.key == key)
        .map(|setting| setting.value)
        .filter(|value| !value.trim().is_empty())
}

/// Whether a key is stored for `app_id`.
pub fn key_stored(secrets: &dyn PrivateKeyStore, app_id: &str) -> bool {
    !app_id.trim().is_empty() && secrets.load(app_id).is_ok()
}

/// The key a signer needs, loading it from the key store.
pub fn load_key(secrets: &dyn PrivateKeyStore, app_id: &str) -> Result<PrivateKey, BankFailure> {
    if app_id.trim().is_empty() {
        return Err(BankFailure::NoApplication);
    }
    Ok(secrets.load(app_id)?)
}

/// Everything the Settings screen shows about one connection, in the UI's
/// plain DTOs.
pub fn connection_info(
    store: &Store,
    connection: &BankConnection,
    now: DateTime<Utc>,
) -> BankConnectionInfo {
    let accounts = store.bank_accounts(&connection.id).unwrap_or_default();
    let consent_until = connection
        .consent_valid_until
        .as_deref()
        .and_then(|instant| DateTime::parse_from_rfc3339(instant).ok())
        .map(|instant| instant.with_timezone(&Utc));
    BankConnectionInfo {
        id: connection.id.clone(),
        bank_name: connection.bank_name.clone(),
        country: connection.bank_country.clone(),
        consent: consent_state(consent_until, now),
        consent_until: consent_until.map(|instant| instant.date_naive()),
        last_sync: parse_day(connection.last_sync_at.as_deref()),
        imported: store
            .bank_movement_count(&connection.id)
            .unwrap_or(0)
            .max(0) as usize,
        accounts: accounts
            .iter()
            .map(|account| LinkedBankAccount {
                external_uid: account.external_uid.clone(),
                name: account.name.clone(),
                currency: account.currency.clone(),
                account_id: Some(account.account_id.clone()).filter(|id| !id.is_empty()),
            })
            .collect::<Vec<_>>()
            .into(),
    }
}

/// The calendar day of a stored `YYYY-MM-DD…` instant.
fn parse_day(instant: Option<&str>) -> Option<NaiveDate> {
    instant
        .and_then(|instant| instant.get(..10))
        .and_then(|day| NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
}

/// The one-line "synced" message, in the current language.
pub fn report_message(report: &SyncReport) -> String {
    moxen_finances_ui::language::fill(
        "settings.bank.synced",
        &[
            ("{imported}", &report.imported.to_string()),
            ("{duplicates}", &report.duplicates.to_string()),
        ],
    )
}

// ---------------------------------------------------------------------------
// The runtime the Settings screen drives
// ---------------------------------------------------------------------------

/// Builds a gateway for a stored application id, loading its key from the key
/// store. A test's factory returns a gateway over a recorded transport.
pub type GatewayFactory = Arc<
    dyn Fn(&dyn PrivateKeyStore, &str) -> Result<Box<dyn BankGateway>, BankFailure> + Send + Sync,
>;

/// Opens an authorization URL in the browser. `false` when it could not: the
/// link still waits for the callback.
pub type UrlOpener = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// What the store-backed data source holds for bank sync: where keys live, how
/// gateways are built, how a browser opens, and the status the settings screen
/// polls.
pub struct BankRuntime {
    pub secrets: Arc<dyn PrivateKeyStore>,
    factory: GatewayFactory,
    opener: UrlOpener,
    activity: Arc<Mutex<Option<BankActivity>>>,
    message: Arc<Mutex<Option<String>>>,
    /// The ports the loopback callback tries; the crate's defaults in
    /// production, one port in a test.
    ports: Vec<u16>,
    /// How long a link waits for the browser.
    timeout: Duration,
}

impl BankRuntime {
    /// A runtime over `secrets` and `factory`, opening URLs with `opener`, on
    /// the default loopback ports and callback timeout.
    pub fn new(
        secrets: Arc<dyn PrivateKeyStore>,
        factory: GatewayFactory,
        opener: UrlOpener,
    ) -> Self {
        Self {
            secrets,
            factory,
            opener,
            activity: Arc::new(Mutex::new(None)),
            message: Arc::new(Mutex::new(None)),
            ports: moxen_finances_banking::DEFAULT_CALLBACK_PORTS.to_vec(),
            timeout: moxen_finances_banking::CALLBACK_TIMEOUT,
        }
    }

    /// Another set of ports and timeout, so a test waits for a free port of its
    /// own choosing instead of 47831.
    #[cfg(test)]
    pub fn with_ports(mut self, ports: Vec<u16>, timeout: Duration) -> Self {
        self.ports = ports;
        self.timeout = timeout;
        self
    }

    /// What is running, if anything.
    pub fn activity(&self) -> Option<BankActivity> {
        *self.activity.lock().expect("bank activity")
    }

    /// The last finished run's message.
    pub fn message(&self) -> Option<String> {
        self.message.lock().expect("bank message").clone()
    }

    /// Takes the busy flag for `activity`, refusing when another run holds it.
    pub fn begin(&self, activity: BankActivity) -> Result<(), BankFailure> {
        let mut slot = self.activity.lock().expect("bank activity");
        if slot.is_some() {
            return Err(BankFailure::Busy);
        }
        *slot = Some(activity);
        Ok(())
    }

    /// Clears the busy flag and keeps `message` as the result line.
    pub fn finish(&self, message: Option<String>) {
        *self.activity.lock().expect("bank activity") = None;
        *self.message.lock().expect("bank message") = message;
    }

    /// Builds the gateway for `app_id`, with its key loaded from the key store.
    fn gateway(&self, app_id: &str) -> Result<Box<dyn BankGateway>, BankFailure> {
        (self.factory)(self.secrets.as_ref(), app_id)
    }

    /// Links a bank on this thread, against the store handle it is given. What
    /// an in-memory database (a test) needs, and the same code the background
    /// run uses.
    pub fn link_inline(
        &self,
        store: &mut Store,
        app_id: &str,
        country: &str,
        bank_name: &str,
        language: Option<&str>,
    ) -> Result<BankConnection, BankFailure> {
        self.begin(BankActivity::Linking)?;
        let result = self.link_with(store, app_id, country, bank_name, language);
        self.finish(match &result {
            Ok(connection) => Some(link_message(&connection.bank_name)),
            Err(failure) => Some(failure.localized_now()),
        });
        result
    }

    fn link_with(
        &self,
        store: &mut Store,
        app_id: &str,
        country: &str,
        bank_name: &str,
        language: Option<&str>,
    ) -> Result<BankConnection, BankFailure> {
        let gateway = self.gateway(app_id)?;
        let opener = self.opener.clone();
        let open_url = move |url: &str| opener(url);
        let request = LinkRequest {
            app_id,
            country,
            bank_name,
            language,
            ports: &self.ports,
            timeout: self.timeout,
            state: None,
            open_url: &open_url,
        };
        link(gateway.as_ref(), store, &request)
    }

    /// Syncs a linked bank on this thread.
    pub fn sync_inline(
        &self,
        store: &mut Store,
        connection_id: &str,
        today: NaiveDate,
    ) -> Result<SyncReport, BankFailure> {
        self.begin(BankActivity::Syncing)?;
        let result = self.sync_with(store, connection_id, today);
        self.finish(match &result {
            Ok(report) => Some(report_message(report)),
            Err(failure) => Some(failure.localized_now()),
        });
        result
    }

    fn sync_with(
        &self,
        store: &mut Store,
        connection_id: &str,
        today: NaiveDate,
    ) -> Result<SyncReport, BankFailure> {
        let connection = store
            .bank_connection(connection_id)?
            .ok_or(BankFailure::NotFound)?;
        // The keychain is only touched once the link is known to exist: a
        // missing link is a mismatch, not a reason to ask for a key.
        let gateway = self.gateway(&connection.app_id)?;
        let request = SyncRequest {
            connection_id,
            from: None,
            to: today,
        };
        sync(gateway.as_ref(), store, &request, Utc::now())
    }

    /// Links on a worker thread against its own connection to the file at
    /// `path`, so the window keeps painting while the browser is open.
    pub fn link_in_background(
        self: &Arc<Self>,
        path: PathBuf,
        app_id: String,
        country: String,
        bank_name: String,
        language: Option<String>,
    ) -> Result<(), BankFailure> {
        self.begin(BankActivity::Linking)?;
        let runtime = Arc::clone(self);
        std::thread::spawn(move || {
            // The busy flag is released even if this thread panics, so the
            // section can never stay stuck on "waiting for your bank".
            let mut guard = ActivityGuard::new(Arc::clone(&runtime));
            let result = Store::open(&path)
                .map_err(BankFailure::from)
                .and_then(|mut store| {
                    runtime.link_with(
                        &mut store,
                        &app_id,
                        &country,
                        &bank_name,
                        language.as_deref(),
                    )
                });
            guard.finish(match &result {
                Ok(connection) => link_message(&connection.bank_name),
                Err(failure) => failure.localized_now(),
            });
        });
        Ok(())
    }

    /// Syncs on a worker thread, against its own connection to the file.
    pub fn sync_in_background(
        self: &Arc<Self>,
        path: PathBuf,
        connection_id: String,
        today: NaiveDate,
    ) -> Result<(), BankFailure> {
        self.begin(BankActivity::Syncing)?;
        let runtime = Arc::clone(self);
        std::thread::spawn(move || {
            let mut guard = ActivityGuard::new(Arc::clone(&runtime));
            let result = Store::open(&path)
                .map_err(BankFailure::from)
                .and_then(|mut store| runtime.sync_with(&mut store, &connection_id, today));
            guard.finish(match &result {
                Ok(report) => report_message(report),
                Err(failure) => failure.localized_now(),
            });
        });
        Ok(())
    }

    /// Asks the bank to close the session of a link the user just unlinked, so
    /// the access does not sit open until the consent expires on its own. It is
    /// best-effort and never blocks the window: a bank that refuses (or a
    /// consent that already ran out) has nothing to close.
    pub fn close_session_in_background(
        self: &Arc<Self>,
        path: PathBuf,
        app_id: String,
        session_id: String,
    ) {
        let runtime = Arc::clone(self);
        std::thread::spawn(move || {
            let Ok(gateway) = runtime.gateway(&app_id) else {
                return;
            };
            // The file is only touched by the caller, which has already deleted
            // the link: this thread talks to the bank, nothing else.
            let _ = &path;
            let _ = gateway.delete_session(&session_id);
        });
    }
}

/// The one-line "linked" message, in the current language.
pub fn link_message(bank: &str) -> String {
    moxen_finances_ui::language::fill("settings.bank.linked", &[("{bank}", bank)])
}

/// Releases a background run's busy flag when it is dropped, so a panic in the
/// worker cannot leave the settings section waiting for a bank forever.
struct ActivityGuard {
    runtime: Arc<BankRuntime>,
    message: Option<String>,
}

impl ActivityGuard {
    fn new(runtime: Arc<BankRuntime>) -> Self {
        Self {
            runtime,
            message: None,
        }
    }

    /// The run's result line, released with the flag.
    fn finish(&mut self, message: String) {
        self.message = Some(message);
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.runtime.finish(self.message.take());
    }
}

/// The bank sync state the Settings screen draws, built from the store and the
/// runtime's status.
pub fn state(store: &Store, runtime: &BankRuntime) -> BankSyncState {
    let app_id = app_id(store);
    let now = Utc::now();
    let connections = store
        .bank_connections()
        .unwrap_or_default()
        .iter()
        .map(|connection| connection_info(store, connection, now))
        .collect::<Vec<_>>();
    BankSyncState {
        key_stored: key_stored(runtime.secrets.as_ref(), &app_id),
        app_id,
        activity: runtime.activity(),
        message: runtime.message(),
        connections: connections.into(),
        interval: interval_from_setting(setting(store, INTERVAL_SETTING).as_deref()),
    }
}

#[cfg(test)]
mod tests;
