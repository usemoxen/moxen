//! The neutral shapes the rest of Finances consumes: no HTTP, no JWT, no
//! Enable Banking vocabulary beyond what a caller needs to persist.
//!
//! These are plain `serde` structs so a caller can keep them as JSON next to
//! its database; mapping them into the Finances store is a later step. Every
//! one of them masks its identifiers in `Debug`, because account uids, IBANs
//! and session ids end up in log files more often than anyone plans for.

use std::fmt;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::redact;

/// A transaction, as a ledger wants it: a signed amount in minor units, the
/// two dates, who it was with, what it said, and a key that makes a second
/// import of the same operation a no-op.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BankTransaction {
    /// The account this belongs to, which the API calls its `uid`.
    pub account_uid: String,
    /// The day the bank recorded it.
    pub booking_date: NaiveDate,
    /// The day the money became available, when the bank says.
    pub value_date: Option<NaiveDate>,
    /// The amount in minor units of [`BankTransaction::currency`], negative
    /// for a debit.
    pub amount_minor: i64,
    /// The ISO 4217 code the amount is in.
    pub currency: String,
    /// The other party's name, when the bank gives one.
    pub counterparty: Option<String>,
    /// The remittance lines, joined with a newline.
    pub remittance: Option<String>,
    /// Booked, or still pending at the bank.
    pub status: TransactionStatus,
    /// The bank's own immutable id for the operation, when it sends one.
    pub entry_reference: Option<String>,
    /// [`dedupe_key`] of this transaction: stable across imports.
    pub dedupe_key: String,
}

impl fmt::Debug for BankTransaction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BankTransaction")
            .field("account_uid", &redact::mask(&self.account_uid))
            .field("booking_date", &self.booking_date)
            .field("value_date", &self.value_date)
            .field("amount_minor", &self.amount_minor)
            .field("currency", &self.currency)
            .field("counterparty", &self.counterparty)
            .field("remittance", &self.remittance)
            .field("status", &self.status)
            .field(
                "entry_reference",
                &self.entry_reference.as_deref().map(redact::mask),
            )
            .field("dedupe_key", &self.dedupe_key)
            .finish()
    }
}

/// Where a transaction is in the bank's books.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransactionStatus {
    /// Recorded on the account. Only these belong in a ledger.
    Booked,
    /// Announced but not accounted for yet.
    Pending,
}

/// The fields joined by the ASCII unit separator, which no bank puts in a
/// name, so two fields cannot blur into one.
const SEPARATOR: char = '\u{1f}';

/// A stable de-duplication key for one transaction.
///
/// When the bank sends an entry reference, the key is built from the account
/// uid and that reference: it is the same identifier the bank showed the user
/// in its own app, it is immutable, and it survives re-authorising the
/// account. When there is no reference, the key falls back to the booking
/// date, the signed amount, the counterparty and the remittance, which is the
/// best identity a bank gives for a card payment.
///
/// Both are a SHA-256 digest of the joined fields, truncated to 16 hex
/// characters: short enough for a unique index, long enough that a collision
/// inside one account's history is not something to reason about. The prefix
/// says which rule produced the key, so a change of rule is visible.
pub fn dedupe_key(
    account_uid: &str,
    entry_reference: Option<&str>,
    booking_date: Option<NaiveDate>,
    amount_minor: i64,
    counterparty: Option<&str>,
    remittance: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_uid.trim().as_bytes());
    hasher.update(SEPARATOR.to_string().as_bytes());
    if let Some(reference) = entry_reference
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        hasher.update(b"reference");
        hasher.update(SEPARATOR.to_string().as_bytes());
        hasher.update(reference.as_bytes());
        return format!("er-{}", short_hex(&hasher.finalize()));
    }
    hasher.update(b"synthetic");
    hasher.update(SEPARATOR.to_string().as_bytes());
    hasher.update(
        booking_date
            .map(|date| date.to_string())
            .unwrap_or_default()
            .as_bytes(),
    );
    hasher.update(SEPARATOR.to_string().as_bytes());
    hasher.update(amount_minor.to_string().as_bytes());
    hasher.update(SEPARATOR.to_string().as_bytes());
    hasher.update(counterparty.map(str::trim).unwrap_or_default().as_bytes());
    hasher.update(SEPARATOR.to_string().as_bytes());
    hasher.update(remittance.map(str::trim).unwrap_or_default().as_bytes());
    format!("syn-{}", short_hex(&hasher.finalize()))
}

/// The first 16 hex characters of a digest.
fn short_hex(digest: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// One bank account inside a session.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BankAccount {
    /// The session-scoped id every later call uses.
    pub uid: String,
    /// The IBAN, when the account has one.
    pub iban: Option<String>,
    /// The name the bank shows for it.
    pub name: Option<String>,
    /// Its currency, which the bank may report as the account's, not a
    /// balance's.
    pub currency: Option<String>,
    /// The bank's product name ("Cuenta Nómina").
    pub product: Option<String>,
    /// The account type, in ISO 20022 codes (`CACC` for a current account).
    pub account_type: Option<String>,
    /// `PRIV` or `ORGA` when the bank says.
    pub usage: Option<String>,
}

impl fmt::Debug for BankAccount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BankAccount")
            .field("uid", &redact::mask(&self.uid))
            .field("iban", &self.iban.as_deref().map(redact::mask))
            .field("name", &self.name)
            .field("currency", &self.currency)
            .field("product", &self.product)
            .field("account_type", &self.account_type)
            .field("usage", &self.usage)
            .finish()
    }
}

/// One balance of an account: a booked balance, an available one, a card's
/// credit line.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BankBalance {
    /// The account the balance belongs to.
    pub account_uid: String,
    /// The bank's label for it ("Saldo disponible").
    pub name: Option<String>,
    /// The ISO 20022 balance type (`CLAV`, `ITBD`, `XPCD`).
    pub balance_type: Option<String>,
    /// The amount in minor units, negative when the account is overdrawn.
    pub amount_minor: i64,
    /// Its currency.
    pub currency: String,
    /// The day the amount refers to.
    pub reference_date: Option<NaiveDate>,
}

impl fmt::Debug for BankBalance {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BankBalance")
            .field("account_uid", &redact::mask(&self.account_uid))
            .field("name", &self.name)
            .field("balance_type", &self.balance_type)
            .field("amount_minor", &self.amount_minor)
            .field("currency", &self.currency)
            .field("reference_date", &self.reference_date)
            .finish()
    }
}

/// A linked bank: what a session returned, kept because the API shows some of
/// it only once.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BankLink {
    /// The session id every call uses.
    pub session_id: String,
    /// The bank it is with.
    pub bank: BankRef,
    /// The accounts the user allowed, as uids.
    pub account_uids: Vec<String>,
    /// When the bank consent stops working. Past it, the app links again.
    pub consent_valid_until: DateTime<Utc>,
    /// When this crate recorded the link.
    pub linked_at: DateTime<Utc>,
}

impl fmt::Debug for BankLink {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BankLink")
            .field("session_id", &redact::mask(&self.session_id))
            .field("bank", &self.bank)
            .field(
                "account_uids",
                &self
                    .account_uids
                    .iter()
                    .map(|uid| redact::mask(uid))
                    .collect::<Vec<_>>(),
            )
            .field("consent_valid_until", &self.consent_valid_until)
            .field("linked_at", &self.linked_at)
            .finish()
    }
}

/// A bank, by name and country, the pair the API identifies it by.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BankRef {
    /// The name exactly as `/aspsps` spells it.
    pub name: String,
    /// The two-letter ISO 3166 country code.
    pub country: String,
}

/// One bank from the list of a country: what a bank picker shows and what the
/// link flow needs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BankEntry {
    /// The name, which `/auth` has to repeat exactly.
    pub name: String,
    /// The two-letter country code.
    pub country: String,
    /// A logo URL, when the bank has one.
    pub logo: Option<String>,
    /// `private`, `business`, or both.
    pub psu_types: Vec<String>,
    /// The longest consent this bank allows, in seconds. A request may ask for
    /// less; a bank may grant less.
    pub maximum_consent_validity: Option<std::time::Duration>,
    /// Whether the bank's integration is in beta.
    pub beta: bool,
}

impl BankEntry {
    /// The bank as a reference, for `start_auth`.
    pub fn bank_ref(&self) -> BankRef {
        BankRef {
            name: self.name.clone(),
            country: self.country.clone(),
        }
    }
}
