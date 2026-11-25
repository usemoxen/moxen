//! The wire shapes of the API reference, as `serde` structs.
//!
//! These mirror [the official reference](https://enablebanking.com/docs/api/reference/)
//! and nothing more: every field the crate does not read is simply absent, and
//! `serde` ignores the fields the API adds later, so a new key in a response
//! never breaks a sync. The conversions to [`crate::model`] live at the bottom
//! of the file: one place where a decimal string becomes minor units, where
//! `CRDT`/`DBIT` becomes a sign, and where a bank's status becomes booked,
//! pending or "not a transaction that happened".

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::model::{
    BankAccount, BankBalance, BankEntry, BankRef, BankTransaction, TransactionStatus,
};
use crate::money;
use crate::{BankError, model};

/// The API's error body: `message` always, `code` and the textual `error` when
/// it has them, and a free-form `detail`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ErrorResponse {
    /// A human-readable message.
    pub message: Option<String>,
    /// The HTTP status code, repeated in the body.
    pub code: Option<u16>,
    /// The machine-readable code, e.g. `EXPIRED_SESSION`.
    pub error: Option<String>,
    /// Extra detail, a string or an object.
    pub detail: Option<serde_json::Value>,
}

impl ErrorResponse {
    /// The textual code, when the body named one.
    pub fn error_code(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// The message, falling back to the detail field.
    pub fn description(&self) -> String {
        if let Some(message) = self.message.as_deref().filter(|text| !text.is_empty()) {
            return message.to_string();
        }
        match &self.detail {
            Some(serde_json::Value::String(text)) if !text.is_empty() => text.clone(),
            Some(detail) if !detail.is_null() => detail.to_string(),
            _ => "sin detalle".to_string(),
        }
    }
}

/// `GET /aspsps`.
#[derive(Debug, Clone, Deserialize)]
pub struct AspspsResponse {
    /// The banks of the requested country.
    #[serde(default)]
    pub aspsps: Vec<AspspData>,
}

/// One bank in [`AspspsResponse`]; only the fields the picker and the link
/// need.
#[derive(Debug, Clone, Deserialize)]
pub struct AspspData {
    /// The bank's name, which `/auth` has to repeat exactly.
    pub name: String,
    /// Its two-letter country code.
    pub country: String,
    /// A logo URL, for the picker.
    pub logo: Option<String>,
    /// `private`, `business`, or both.
    #[serde(default)]
    pub psu_types: Vec<String>,
    /// The longest consent this bank allows, in seconds.
    pub maximum_consent_validity: Option<i64>,
    /// Whether the integration is in beta.
    pub beta: Option<bool>,
    /// The BIC, when the bank sends one.
    pub bic: Option<String>,
}

impl AspspData {
    /// The neutral shape the picker uses.
    pub fn to_model(&self) -> BankEntry {
        BankEntry {
            name: self.name.clone(),
            country: self.country.clone(),
            logo: self.logo.clone(),
            psu_types: self.psu_types.clone(),
            maximum_consent_validity: self
                .maximum_consent_validity
                .and_then(|seconds| u64::try_from(seconds).ok())
                .map(std::time::Duration::from_secs),
            beta: self.beta.unwrap_or(false),
        }
    }
}

/// A bank by name and country: what `/auth` takes and what a session returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AspspRef {
    /// The name exactly as `/aspsps` spells it.
    pub name: String,
    /// The two-letter country code.
    pub country: String,
}

impl From<&BankRef> for AspspRef {
    fn from(bank: &BankRef) -> Self {
        Self {
            name: bank.name.clone(),
            country: bank.country.clone(),
        }
    }
}

impl From<&AspspRef> for BankRef {
    fn from(bank: &AspspRef) -> Self {
        Self {
            name: bank.name.clone(),
            country: bank.country.clone(),
        }
    }
}

/// The scope of access asked for in `POST /auth`.
#[derive(Debug, Clone, Serialize)]
pub struct Access {
    /// When the consent should stop, RFC 3339. The bank may shorten it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
}

/// `POST /auth`.
#[derive(Debug, Clone, Serialize)]
pub struct StartAuthRequest {
    /// The consent scope.
    pub access: Access,
    /// The bank.
    pub aspsp: AspspRef,
    /// Ours, echoed back on the redirect.
    pub state: String,
    /// Where the user comes back to: a loopback URL.
    pub redirect_url: String,
    /// `private` or `business`; the bank shows a different login for each.
    pub psu_type: String,
    /// A two-letter lowercase language code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// The answer to `POST /auth`.
#[derive(Debug, Clone, Deserialize)]
pub struct StartAuthResponse {
    /// The URL to open in the browser.
    pub url: String,
    /// The authorization id, which names the attempt but not the session.
    pub authorization_id: String,
    /// A hash the API uses to match attempts of the same person.
    pub psu_id_hash: Option<String>,
}

/// `POST /sessions`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRequest {
    /// The `code` the browser came back with.
    pub code: String,
}

/// The answer to `POST /sessions`. Part of this is shown ONCE.
#[derive(Debug, Clone, Deserialize)]
pub struct AuthorizeSessionResponse {
    /// The session id every later call uses.
    pub session_id: String,
    /// The accounts the user allowed, with their details.
    #[serde(default)]
    pub accounts: Vec<AccountResource>,
    /// The bank.
    pub aspsp: Option<AspspRef>,
    /// The consent scope the bank actually granted.
    pub access: Option<AccessResponse>,
    /// The PSU type the bank used.
    pub psu_type: Option<String>,
}

/// The consent scope of a session.
#[derive(Debug, Clone, Deserialize)]
pub struct AccessResponse {
    /// When the consent stops, RFC 3339 with an offset.
    pub valid_until: Option<String>,
}

impl AccessResponse {
    /// `valid_until` as an instant, when it parses.
    pub fn valid_until(&self) -> Option<DateTime<Utc>> {
        self.valid_until.as_deref().and_then(parse_instant)
    }
}

/// `GET /sessions/{id}`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetSessionResponse {
    /// The consent scope.
    pub access: Option<AccessResponse>,
    /// The account uids, unlike the objects `POST /sessions` returns.
    #[serde(default)]
    pub accounts: Vec<String>,
    /// The bank.
    pub aspsp: Option<AspspRef>,
    /// `AUTHORIZED`, `REVOKED`, ...
    pub status: Option<String>,
    /// When the user authorized it.
    pub authorized: Option<String>,
    /// When the session was created.
    pub created: Option<String>,
    /// The PSU type.
    pub psu_type: Option<String>,
}

/// An account, in the `POST /sessions` and `GET /accounts/{uid}/details`
/// shapes.
#[derive(Debug, Clone, Deserialize)]
pub struct AccountResource {
    /// The session-scoped id.
    pub uid: String,
    /// The IBAN, when the account has one.
    pub account_id: Option<AccountIdentification>,
    /// The name the bank shows.
    pub name: Option<String>,
    /// The account's currency.
    pub currency: Option<String>,
    /// The bank's product name.
    pub product: Option<String>,
    /// The ISO 20022 account type (`CACC`, `SVGS`, ...).
    pub cash_account_type: Option<String>,
    /// `PRIV` or `ORGA`.
    pub usage: Option<String>,
    /// Free text about the account.
    pub details: Option<String>,
}

/// An account's identification: an IBAN or another scheme.
#[derive(Debug, Clone, Deserialize)]
pub struct AccountIdentification {
    /// The IBAN.
    pub iban: Option<String>,
    /// Another identifier.
    pub other: Option<GenericIdentification>,
}

/// A non-IBAN account identifier.
#[derive(Debug, Clone, Deserialize)]
pub struct GenericIdentification {
    /// The identifier.
    pub identification: Option<String>,
    /// Its scheme (`BBAN`, `CPAN`, ...).
    pub scheme_name: Option<String>,
}

impl AccountResource {
    /// The neutral account.
    pub fn to_model(&self) -> BankAccount {
        BankAccount {
            uid: self.uid.clone(),
            iban: self
                .account_id
                .as_ref()
                .and_then(|identification| identification.iban.clone()),
            name: self.name.clone(),
            currency: self.currency.clone(),
            product: self.product.clone(),
            account_type: self.cash_account_type.clone(),
            usage: self.usage.clone(),
        }
    }
}

/// `GET /accounts/{uid}/balances`.
#[derive(Debug, Clone, Deserialize)]
pub struct BalancesResponse {
    /// The balances the bank reports.
    #[serde(default)]
    pub balances: Vec<BalanceResource>,
}

/// One balance.
#[derive(Debug, Clone, Deserialize)]
pub struct BalanceResource {
    /// The bank's label.
    pub name: Option<String>,
    /// The amount, as a decimal string and a currency.
    pub balance_amount: AmountType,
    /// The ISO 20022 balance type (`CLAV`, `ITBD`, `XPCD`).
    pub balance_type: Option<String>,
    /// The day the amount refers to.
    pub reference_date: Option<String>,
    /// When the amount last changed, RFC 3339.
    pub last_change_date_time: Option<String>,
}

/// An amount: a decimal string and a currency, never a float.
#[derive(Debug, Clone, Deserialize)]
pub struct AmountType {
    /// The decimal string, e.g. `"1.23"`.
    pub amount: String,
    /// The ISO 4217 code.
    pub currency: String,
}

impl BalanceResource {
    /// The neutral balance, with the amount in minor units.
    pub fn to_model(&self, account_uid: &str) -> Result<BankBalance, BankError> {
        let amount_minor = money::parse(&self.balance_amount.amount, &self.balance_amount.currency)
            .map_err(|error| {
                BankError::invalid(None, format!("un saldo del banco no se pudo leer: {error}"))
            })?;
        Ok(BankBalance {
            account_uid: account_uid.to_string(),
            name: self.name.clone(),
            balance_type: self.balance_type.clone(),
            amount_minor,
            currency: self.balance_amount.currency.clone(),
            reference_date: self.reference_date.as_deref().and_then(parse_date),
        })
    }
}

/// `GET /accounts/{uid}/transactions`.
#[derive(Debug, Clone, Deserialize)]
pub struct TransactionsResponse {
    /// This page.
    #[serde(default)]
    pub transactions: Vec<Transaction>,
    /// The key for the next page, absent on the last one.
    pub continuation_key: Option<String>,
}

/// One transaction, in the API's shape.
#[derive(Debug, Clone, Deserialize)]
pub struct Transaction {
    /// The bank's immutable id for the operation, when it sends one.
    pub entry_reference: Option<String>,
    /// The amount, signed by `credit_debit_indicator` rather than by the text.
    pub transaction_amount: AmountType,
    /// `CRDT` (money in) or `DBIT` (money out).
    pub credit_debit_indicator: Option<String>,
    /// `BOOK`, `PDNG`, `HOLD`, `SCHD`, `CNCL`, `RJCT`, `OTHR`.
    pub status: Option<String>,
    /// The day the bank recorded it.
    pub booking_date: Option<String>,
    /// The day the money became available.
    pub value_date: Option<String>,
    /// The day the operation happened (card purchases).
    pub transaction_date: Option<String>,
    /// The party that received the money.
    pub creditor: Option<PartyIdentification>,
    /// The party that sent the money.
    pub debtor: Option<PartyIdentification>,
    /// The payment details, one string per line.
    #[serde(default)]
    pub remittance_information: Vec<String>,
    /// A structured reference, when the bank has one.
    pub reference_number: Option<String>,
    /// The internal note, when the user made one.
    pub note: Option<String>,
}

/// A party in a transaction.
#[derive(Debug, Clone, Deserialize)]
pub struct PartyIdentification {
    /// The name.
    pub name: Option<String>,
}

impl Transaction {
    /// Convert one wire transaction into the neutral shape.
    ///
    /// `Ok(None)` means the bank reported something that is not a movement of
    /// money: a cancelled or rejected transaction, which a ledger must not
    /// import. A booked one becomes [`TransactionStatus::Booked`]; a hold, a
    /// pending or a scheduled one becomes [`TransactionStatus::Pending`].
    ///
    /// `Err` is a transaction whose amount or date this crate cannot read. It
    /// fails the whole page on purpose: dropping it would silently lose a
    /// movement, and importing it with a guessed amount would be worse.
    pub fn to_model(&self, account_uid: &str) -> Result<Option<BankTransaction>, BankError> {
        let status = match self
            .status
            .as_deref()
            .unwrap_or("BOOK")
            .to_ascii_uppercase()
            .as_str()
        {
            "BOOK" => TransactionStatus::Booked,
            "CNCL" | "RJCT" => return Ok(None),
            _ => TransactionStatus::Pending,
        };

        let currency = self.transaction_amount.currency.trim().to_ascii_uppercase();
        if currency.is_empty() {
            return Err(BankError::invalid(
                None,
                "una transacción del banco no indica su moneda",
            ));
        }
        let magnitude =
            money::parse(&self.transaction_amount.amount, &currency).map_err(|error| {
                BankError::invalid(
                    None,
                    format!("un importe del banco no se pudo leer: {error}"),
                )
            })?;
        // The indicator decides the sign; the amount text only says how much,
        // and a bank that already signed it is not double-negated.
        let amount_minor = match self
            .credit_debit_indicator
            .as_deref()
            .map(|indicator| indicator.trim().to_ascii_uppercase())
            .as_deref()
        {
            Some("DBIT") => -magnitude.abs(),
            Some("CRDT") => magnitude.abs(),
            _ => magnitude,
        };

        let booking_date = self
            .booking_date
            .as_deref()
            .and_then(parse_date)
            .or_else(|| self.value_date.as_deref().and_then(parse_date))
            .or_else(|| self.transaction_date.as_deref().and_then(parse_date))
            .ok_or_else(|| {
                BankError::invalid(None, "una transacción del banco no trae ninguna fecha")
            })?;
        let value_date = self.value_date.as_deref().and_then(parse_date);

        // Who the money was with: for a debit the creditor received it, for a
        // credit the debtor sent it.
        let party = if amount_minor < 0 {
            self.creditor.as_ref()
        } else {
            self.debtor.as_ref()
        };
        let counterparty = party
            .and_then(|party| party.name.as_deref())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string);

        let mut remittance: Vec<&str> = self
            .remittance_information
            .iter()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect();
        if remittance.is_empty()
            && let Some(reference) = self
                .reference_number
                .as_deref()
                .map(str::trim)
                .filter(|reference| !reference.is_empty())
        {
            remittance.push(reference);
        }
        if remittance.is_empty()
            && let Some(note) = self
                .note
                .as_deref()
                .map(str::trim)
                .filter(|note| !note.is_empty())
        {
            remittance.push(note);
        }
        let remittance = if remittance.is_empty() {
            None
        } else {
            Some(remittance.join("\n"))
        };

        let entry_reference = self
            .entry_reference
            .as_deref()
            .map(str::trim)
            .filter(|reference| !reference.is_empty())
            .map(str::to_string);

        let dedupe_key = model::dedupe_key(
            account_uid,
            entry_reference.as_deref(),
            Some(booking_date),
            amount_minor,
            counterparty.as_deref(),
            remittance.as_deref(),
        );

        Ok(Some(BankTransaction {
            account_uid: account_uid.to_string(),
            booking_date,
            value_date,
            amount_minor,
            currency,
            counterparty,
            remittance,
            status,
            entry_reference,
            dedupe_key,
        }))
    }
}

/// A date as the API types it (`YYYY-MM-DD`), accepting a full RFC 3339
/// timestamp too, because some banks send one in a date field.
pub fn parse_date(value: &str) -> Option<NaiveDate> {
    let value = value.trim();
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date);
    }
    parse_instant(value).map(|instant| instant.date_naive())
}

/// An RFC 3339 instant with an offset, as every `valid_until` is.
pub fn parse_instant(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if let Ok(instant) = DateTime::parse_from_rfc3339(value) {
        return Some(instant.with_timezone(&Utc));
    }
    // Some banks omit the offset's colon or the seconds' fraction rules that
    // RFC 3339 accepts; the explicit format catches the common shape.
    DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%:z")
        .ok()
        .map(|instant| instant.with_timezone(&Utc))
}
