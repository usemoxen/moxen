//! Bank sync persistence: the linked banks, the mapping of their accounts
//! onto local Finances accounts, and the ledger of what was already imported.
//!
//! What a link keeps, and what it does not:
//!
//! - **The connection row** holds the Enable Banking application id (public: it
//!   is the JWT's `kid`), the bank's name and country, the session id, the
//!   consent deadline and the last sync. It NEVER holds the private key: that
//!   lives in the OS keychain, through `moxen-finances-banking`, and the store
//!   has no operation that could write it.
//! - **The external account row** maps the session-scoped account uid onto a
//!   local `accounts.id`, so imported movements land in the account the user
//!   chose.
//! - **The imported-transaction row** is keyed by the dedupe key the banking
//!   crate derives from the bank's own entry reference (or, failing that, the
//!   booking date, amount, counterparty and remittance). A second sync of the
//!   same window finds the key and creates nothing, so a sync is idempotent by
//!   construction rather than by bookkeeping that could drift.
//!
//! An import runs in ONE transaction per call: every movement it creates, the
//! dedupe row that makes it final, and the audit entry that records it are
//! written together or not at all.

use rusqlite::{Connection, params};

use moxen_finances_core::types::{Account, Currency, ExpenseStatus, Frequency, IncomeStatus};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::repo::{AccountPatch, read_account_row, resolve_account_id, update_account_row};
use crate::row::{log_audit, new_id, now, text};

/// The provider name the connection row records. One linked-bank
/// implementation today; the column exists so a later one is not a migration.
pub const PROVIDER_ENABLE_BANKING: &str = "enable-banking";

/// One linked bank: the metadata of a session, never the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BankConnection {
    pub id: String,
    pub provider: String,
    /// The Enable Banking application id. Public: it names the application in
    /// every JWT, and it is never the private key.
    pub app_id: String,
    pub bank_name: String,
    pub bank_country: String,
    pub session_id: String,
    /// When the bank's consent stops working (an RFC 3339 instant), when the
    /// bank said.
    pub consent_valid_until: Option<String>,
    /// When the last successful sync finished.
    pub last_sync_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One linked account of one connection, and the local account it feeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalAccount {
    pub connection_id: String,
    /// The session-scoped uid every API call uses.
    pub external_uid: String,
    /// The local `accounts.id`, empty when the user has not mapped it yet.
    pub account_id: String,
    /// The name the bank shows for it.
    pub name: String,
    /// Its currency, as the bank reports it.
    pub currency: String,
}

/// What linking a bank writes: the session and the accounts it grants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BankConnectionInput {
    pub app_id: String,
    pub bank_name: String,
    pub bank_country: String,
    pub session_id: String,
    pub consent_valid_until: Option<String>,
    pub accounts: Vec<ExternalAccountInput>,
}

/// One account of a freshly linked session, on the local account the user
/// picked for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalAccountInput {
    pub external_uid: String,
    /// The local account it feeds; empty leaves it unmapped for now.
    pub account_id: String,
    pub name: String,
    pub currency: String,
}

/// One bank movement to import, already reduced to what the ledger needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BankMovement {
    /// The dedupe key from `moxen_finances_banking`'s model: the reason a
    /// second import of the same operation is a no-op.
    pub dedupe_key: String,
    /// The bank account it belongs to (the connection's external uid).
    pub external_uid: String,
    /// `YYYY-MM-DD`, the bank's booking date.
    pub booking_date: String,
    /// Signed, in minor units: positive for money in, negative for money out.
    pub amount_minor: i64,
    /// The ISO 4217 code; only the currencies this ledger knows are imported.
    pub currency: String,
    /// The other party, or the remittance's first line: the concept.
    pub concept: String,
    /// The remittance, when the bank sent one.
    pub notes: String,
}

/// What one import did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BankImportSummary {
    /// Movements created by this call.
    pub imported: usize,
    /// Movements the dedupe key already knew: the idempotent part.
    pub duplicates: usize,
    /// Movements in a currency this ledger does not hold (GBP, SEK, ...): they
    /// are not imported and never counted as duplicates.
    pub unsupported_currency: usize,
    /// Movements whose account has no local mapping yet.
    pub unmapped: usize,
}

impl BankImportSummary {
    /// Everything this call saw.
    pub fn total(&self) -> usize {
        self.imported + self.duplicates + self.unsupported_currency + self.unmapped
    }
}

fn map_connection(row: &rusqlite::Row<'_>) -> BankConnection {
    BankConnection {
        id: text(row, "id", ""),
        provider: text(row, "provider", PROVIDER_ENABLE_BANKING),
        app_id: text(row, "app_id", ""),
        bank_name: text(row, "bank_name", ""),
        bank_country: text(row, "bank_country", ""),
        session_id: text(row, "session_id", ""),
        consent_valid_until: optional(row, "consent_valid_until"),
        last_sync_at: optional(row, "last_sync_at"),
        created_at: text(row, "created_at", ""),
        updated_at: text(row, "updated_at", ""),
    }
}

fn optional(row: &rusqlite::Row<'_>, column: &str) -> Option<String> {
    match row.get_ref(column) {
        Ok(rusqlite::types::ValueRef::Text(bytes)) if !bytes.is_empty() => {
            Some(String::from_utf8_lossy(bytes).into_owned())
        }
        _ => None,
    }
}

fn map_external_account(row: &rusqlite::Row<'_>) -> ExternalAccount {
    ExternalAccount {
        connection_id: text(row, "connection_id", ""),
        external_uid: text(row, "external_uid", ""),
        account_id: text(row, "account_id", ""),
        name: text(row, "name", ""),
        currency: text(row, "currency", "EUR"),
    }
}

/// Every linked bank, oldest first.
pub(crate) fn read_connections(conn: &Connection) -> Result<Vec<BankConnection>> {
    let mut statement =
        conn.prepare("SELECT * FROM bank_connections ORDER BY created_at ASC, rowid ASC")?;
    let mut rows = statement.query([])?;
    let mut connections = Vec::new();
    while let Some(row) = rows.next()? {
        connections.push(map_connection(row));
    }
    Ok(connections)
}

pub(crate) fn read_connection(conn: &Connection, id: &str) -> Result<Option<BankConnection>> {
    let mut statement = conn.prepare("SELECT * FROM bank_connections WHERE id = ?")?;
    let mut rows = statement.query([id])?;
    Ok(rows.next()?.map(map_connection))
}

/// The accounts of one connection, in the order the bank listed them.
pub(crate) fn read_external_accounts(
    conn: &Connection,
    connection_id: &str,
) -> Result<Vec<ExternalAccount>> {
    let mut statement = conn.prepare(
        "SELECT * FROM bank_external_accounts WHERE connection_id = ?
         ORDER BY created_at ASC, rowid ASC",
    )?;
    let mut rows = statement.query([connection_id])?;
    let mut accounts = Vec::new();
    while let Some(row) = rows.next()? {
        accounts.push(map_external_account(row));
    }
    Ok(accounts)
}

/// Link a bank: write the connection and its accounts, replacing an earlier
/// session of the same bank (linking again is the fix for an expired consent,
/// so the old session's rows go in the same transaction). The private key is
/// not part of this and has no column to go in.
pub(crate) fn link_connection(
    conn: &Connection,
    input: &BankConnectionInput,
) -> Result<BankConnection> {
    let transaction = conn.unchecked_transaction()?;
    // A re-link of the bank replaces the previous session: its consent is the
    // one that expired, and its mappings belong to the session that is gone.
    transaction.execute(
        "DELETE FROM bank_connections WHERE provider = ? AND bank_name = ? AND bank_country = ?",
        params![
            PROVIDER_ENABLE_BANKING,
            input.bank_name.trim(),
            input.bank_country.trim().to_ascii_uppercase()
        ],
    )?;
    let id = new_id(&transaction)?;
    let stamped = now();
    transaction.execute(
        "INSERT INTO bank_connections
          (id, provider, app_id, bank_name, bank_country, session_id, consent_valid_until,
           last_sync_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
        params![
            id,
            PROVIDER_ENABLE_BANKING,
            input.app_id.trim(),
            input.bank_name.trim(),
            input.bank_country.trim().to_ascii_uppercase(),
            input.session_id.trim(),
            input.consent_valid_until,
            stamped,
            stamped
        ],
    )?;
    for account in &input.accounts {
        transaction.execute(
            "INSERT INTO bank_external_accounts
              (connection_id, external_uid, account_id, name, currency, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                id,
                account.external_uid,
                account.account_id,
                account.name,
                account.currency.to_ascii_uppercase(),
                stamped
            ],
        )?;
    }
    transaction.commit()?;
    match read_connection(conn, &id)? {
        Some(connection) => Ok(connection),
        None => Err(StoreError::NotFound {
            entity: "conexión bancaria",
            id,
        }),
    }
}

/// Point one external account at a local account (or at none, with an empty
/// id). Linking a bank the second time keeps the user's choices where the
/// same uid comes back.
pub(crate) fn set_external_account_mapping(
    conn: &Connection,
    connection_id: &str,
    external_uid: &str,
    account_id: &str,
) -> Result<()> {
    let resolved = if account_id.trim().is_empty() {
        String::new()
    } else {
        resolve_account_id(conn, account_id)?
    };
    let changed = conn.execute(
        "UPDATE bank_external_accounts SET account_id = ?
         WHERE connection_id = ? AND external_uid = ?",
        params![resolved, connection_id, external_uid],
    )?;
    if changed == 0 {
        return Err(StoreError::NotFound {
            entity: "cuenta externa",
            id: external_uid.to_string(),
        });
    }
    Ok(())
}

/// Forget a linked bank: its accounts and its import ledger go with it (the
/// foreign keys cascade for the accounts, and the ledger rows name the
/// connection). Movements already imported stay: they are the user's history,
/// not the link's.
pub(crate) fn delete_connection(conn: &Connection, id: &str) -> Result<bool> {
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "DELETE FROM bank_external_accounts WHERE connection_id = ?",
        [id],
    )?;
    transaction.execute(
        "DELETE FROM bank_imported_transactions WHERE connection_id = ?",
        [id],
    )?;
    let removed = transaction.execute("DELETE FROM bank_connections WHERE id = ?", [id])?;
    transaction.commit()?;
    Ok(removed > 0)
}

/// Record a finished sync's instant.
pub(crate) fn touch_sync(conn: &Connection, connection_id: &str, instant: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE bank_connections SET last_sync_at = ?, updated_at = ? WHERE id = ?",
        params![instant, instant, connection_id],
    )?;
    if changed == 0 {
        return Err(StoreError::NotFound {
            entity: "conexión bancaria",
            id: connection_id.to_string(),
        });
    }
    Ok(())
}

/// Whether this movement was imported before: the question the whole sync
/// turns on.
pub(crate) fn has_imported(conn: &Connection, dedupe_key: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM bank_imported_transactions WHERE dedupe_key = ?",
        [dedupe_key],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(count > 0)
}

/// How many movements one connection has imported, for a status line.
pub(crate) fn imported_count(conn: &Connection, connection_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM bank_imported_transactions WHERE connection_id = ?",
        [connection_id],
        |row| row.get::<_, i64>(0),
    )?)
}

/// The ledger currency of a bank currency code: only EUR and USD are rows in
/// this database, so anything else is reported instead of being reshaped.
fn ledger_currency(code: &str) -> Option<Currency> {
    match code.trim().to_ascii_uppercase().as_str() {
        "EUR" => Some(Currency::Eur),
        "USD" => Some(Currency::Usd),
        _ => None,
    }
}

/// The local account an external uid feeds, if the user mapped it.
fn mapped_account(
    conn: &Connection,
    connection_id: &str,
    external_uid: &str,
) -> Result<Option<String>> {
    let mut statement = conn.prepare(
        "SELECT account_id FROM bank_external_accounts
         WHERE connection_id = ? AND external_uid = ?",
    )?;
    let mut rows = statement.query(params![connection_id, external_uid])?;
    let account_id: Option<String> = rows.next()?.map(|row| text(row, "account_id", ""));
    Ok(account_id.filter(|id| !id.is_empty()))
}

/// Import bank movements into the ledger, idempotently.
///
/// One transaction for the whole batch: each movement's `incomes`/`expenses`
/// row (money in is an income, money out an expense, both `Done`/`Received`),
/// its dedupe row and its audit entry. A key that is already there makes the
/// movement a duplicate: nothing is created, nothing is overwritten, so the
/// second sync of a window leaves the ledger exactly as the first one left it.
pub(crate) fn import_movements(
    conn: &Connection,
    connection_id: &str,
    movements: &[BankMovement],
) -> Result<BankImportSummary> {
    let mut summary = BankImportSummary::default();
    if movements.is_empty() {
        return Ok(summary);
    }
    let transaction = conn.unchecked_transaction()?;
    let connection = read_connection(&transaction, connection_id)?;
    let connection_id = match connection {
        Some(connection) => connection.id,
        None => {
            return Err(StoreError::NotFound {
                entity: "conexión bancaria",
                id: connection_id.to_string(),
            });
        }
    };
    let stamped = now();
    for movement in movements {
        if has_imported(&transaction, &movement.dedupe_key)? {
            summary.duplicates += 1;
            continue;
        }
        let Some(currency) = ledger_currency(&movement.currency) else {
            summary.unsupported_currency += 1;
            continue;
        };
        let Some(account_id) =
            mapped_account(&transaction, &connection_id, &movement.external_uid)?
        else {
            summary.unmapped += 1;
            continue;
        };
        if read_account_row(&transaction, &account_id)?.is_none() {
            // The local account was deleted since it was mapped.
            summary.unmapped += 1;
            continue;
        }
        let id = new_id(&transaction)?;
        let (kind, movement_id) = if movement.amount_minor >= 0 {
            let balance = IncomeInputRow {
                id: &id,
                concept: &movement.concept,
                amount_minor: movement.amount_minor,
                currency,
                date: &movement.booking_date,
                notes: &movement.notes,
                account_id: &account_id,
                created_at: &stamped,
            };
            balance.insert_income(&transaction)?;
            ("income", id.clone())
        } else {
            let expense = ExpenseInputRow {
                id: &id,
                concept: &movement.concept,
                amount_minor: movement.amount_minor,
                currency,
                date: &movement.booking_date,
                notes: &movement.notes,
                account_id: &account_id,
                created_at: &stamped,
            };
            expense.insert_expense(&transaction)?;
            ("expense", id.clone())
        };
        transaction.execute(
            "INSERT INTO bank_imported_transactions
              (dedupe_key, connection_id, external_uid, movement_kind, movement_id,
               booking_date, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                movement.dedupe_key,
                connection_id,
                movement.external_uid,
                kind,
                movement_id,
                movement.booking_date,
                stamped
            ],
        )?;
        summary.imported += 1;
    }
    transaction.commit()?;
    Ok(summary)
}

/// The `incomes` row one imported movement becomes. Written here rather than
/// through [`crate::ledger`] because the ledger's own operations take their
/// own transaction, and the import has to be one transaction: movement,
/// dedupe row and audit entry together.
struct IncomeInputRow<'a> {
    id: &'a str,
    concept: &'a str,
    amount_minor: i64,
    currency: Currency,
    date: &'a str,
    notes: &'a str,
    account_id: &'a str,
    created_at: &'a str,
}

impl IncomeInputRow<'_> {
    fn insert_income(&self, conn: &Connection) -> Result<()> {
        conn.execute(
            "INSERT INTO incomes
              (id, concept, amount_minor, currency, date, time, frequency, end_date, status,
               paused, notes, actual_amount_minor, created_at, account_id)
             VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, 0, ?, NULL, ?, ?)",
            params![
                self.id,
                self.concept,
                self.amount_minor,
                self.currency.as_str(),
                self.date,
                Frequency::Once.as_str(),
                IncomeStatus::Received.as_str(),
                self.notes,
                self.created_at,
                self.account_id
            ],
        )?;
        log_audit(
            conn,
            "income",
            self.id,
            "import",
            &ImportedAudit {
                concept: self.concept,
                amount_minor: self.amount_minor,
                currency: self.currency,
                date: self.date,
                account_id: self.account_id,
            },
            self.created_at,
        )
    }
}

/// The `expenses` row one imported movement becomes.
struct ExpenseInputRow<'a> {
    id: &'a str,
    concept: &'a str,
    amount_minor: i64,
    currency: Currency,
    date: &'a str,
    notes: &'a str,
    account_id: &'a str,
    created_at: &'a str,
}

impl ExpenseInputRow<'_> {
    fn insert_expense(&self, conn: &Connection) -> Result<()> {
        conn.execute(
            "INSERT INTO expenses
              (id, concept, category, amount_minor, currency, date, time, frequency, end_date,
               status, notes, actual_amount_minor, created_at, account_id)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, ?)",
            params![
                self.id,
                self.concept,
                "Otros",
                self.amount_minor.abs(),
                self.currency.as_str(),
                self.date,
                Frequency::Once.as_str(),
                ExpenseStatus::Done.as_str(),
                self.notes,
                self.created_at,
                self.account_id
            ],
        )?;
        log_audit(
            conn,
            "expense",
            self.id,
            "import",
            &ImportedAudit {
                concept: self.concept,
                amount_minor: self.amount_minor,
                currency: self.currency,
                date: self.date,
                account_id: self.account_id,
            },
            self.created_at,
        )
    }
}

/// What the audit log records for an imported movement: enough to explain it,
/// never a bank credential.
#[derive(serde::Serialize)]
struct ImportedAudit<'a> {
    concept: &'a str,
    amount_minor: i64,
    currency: Currency,
    date: &'a str,
    account_id: &'a str,
}

/// Record a bank balance on the local account it belongs to, with the day it
/// refers to.
pub(crate) fn apply_balance(
    conn: &Connection,
    account_id: &str,
    balance_minor: i64,
    balance_date: &str,
) -> Result<Option<Account>> {
    let patch = AccountPatch {
        balance_minor: Some(balance_minor),
        balance_date: Some(balance_date.to_string()),
        balance_set: Some(true),
        ..Default::default()
    };
    update_account_row(conn, account_id, &patch)
}

impl Store {
    /// Every linked bank.
    pub fn bank_connections(&self) -> Result<Vec<BankConnection>> {
        read_connections(self.connection())
    }

    /// One linked bank, `None` when it is gone.
    pub fn bank_connection(&self, id: &str) -> Result<Option<BankConnection>> {
        read_connection(self.connection(), id)
    }

    /// The accounts of one connection.
    pub fn bank_accounts(&self, connection_id: &str) -> Result<Vec<ExternalAccount>> {
        read_external_accounts(self.connection(), connection_id)
    }

    /// Link a bank: one transaction for the session and its accounts, which
    /// replaces an earlier session of the same bank.
    pub fn link_bank(&mut self, input: &BankConnectionInput) -> Result<BankConnection> {
        link_connection(self.connection(), input)
    }

    /// Point one linked account at a local account, or at none.
    pub fn set_bank_account_mapping(
        &mut self,
        connection_id: &str,
        external_uid: &str,
        account_id: &str,
    ) -> Result<()> {
        set_external_account_mapping(self.connection(), connection_id, external_uid, account_id)
    }

    /// Forget a linked bank and its import ledger. Imported movements stay.
    pub fn delete_bank_connection(&mut self, id: &str) -> Result<bool> {
        delete_connection(self.connection(), id)
    }

    /// Import a batch of bank movements, once each.
    pub fn import_bank_movements(
        &mut self,
        connection_id: &str,
        movements: &[BankMovement],
    ) -> Result<BankImportSummary> {
        import_movements(self.connection(), connection_id, movements)
    }

    /// Whether one movement (by its dedupe key) was imported before.
    pub fn has_bank_movement(&self, dedupe_key: &str) -> Result<bool> {
        has_imported(self.connection(), dedupe_key)
    }

    /// How many movements this connection has imported.
    pub fn bank_movement_count(&self, connection_id: &str) -> Result<i64> {
        imported_count(self.connection(), connection_id)
    }

    /// Record a finished sync's instant.
    pub fn set_bank_last_sync(&mut self, connection_id: &str, instant: &str) -> Result<()> {
        touch_sync(self.connection(), connection_id, instant)
    }

    /// Write a bank balance onto its local account.
    pub fn set_bank_balance(
        &mut self,
        account_id: &str,
        balance_minor: i64,
        balance_date: &str,
    ) -> Result<Option<Account>> {
        apply_balance(self.connection(), account_id, balance_minor, balance_date)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let mut store = Store::open_in_memory().expect("memory store");
        store
            .create_account(&crate::AccountInput {
                name: "Cuenta de pruebas".into(),
                balance_minor: Some(0),
                ..Default::default()
            })
            .expect("account");
        store
    }

    fn linked(store: &mut Store) -> (String, String) {
        let account_id = store.accounts().expect("accounts")[0].id.clone();
        let connection = store
            .link_bank(&BankConnectionInput {
                app_id: "fictional-application".into(),
                bank_name: "Banco Ficticio".into(),
                bank_country: "ES".into(),
                session_id: "fictional-session".into(),
                consent_valid_until: Some("2026-06-01T00:00:00Z".into()),
                accounts: vec![ExternalAccountInput {
                    external_uid: "fictional-uid".into(),
                    account_id: account_id.clone(),
                    name: "Cuenta".into(),
                    currency: "EUR".into(),
                }],
            })
            .expect("link");
        (connection.id, account_id)
    }

    fn movement(key: &str, amount_minor: i64) -> BankMovement {
        BankMovement {
            dedupe_key: key.into(),
            external_uid: "fictional-uid".into(),
            booking_date: "2026-01-05".into(),
            amount_minor,
            currency: "EUR".into(),
            concept: "Supermercado Imaginario".into(),
            notes: "Compra ficticia".into(),
        }
    }

    #[test]
    fn a_link_keeps_the_public_metadata_and_its_accounts() {
        let mut store = store();
        let (id, account_id) = linked(&mut store);
        let connection = store.bank_connection(&id).expect("read").expect("there");
        assert_eq!(connection.app_id, "fictional-application");
        assert_eq!(connection.bank_country, "ES");
        assert_eq!(
            connection.consent_valid_until.as_deref(),
            Some("2026-06-01T00:00:00Z")
        );
        assert_eq!(connection.last_sync_at, None);
        let accounts = store.bank_accounts(&id).expect("accounts");
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account_id, account_id);
        // Nothing in the schema can hold a private key.
        let columns: Vec<String> = {
            let mut statement = store
                .connection()
                .prepare("PRAGMA table_info(bank_connections)")
                .expect("prepare");
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query")
                .map(std::result::Result::unwrap)
                .collect()
        };
        assert!(
            !columns
                .iter()
                .any(|name| name.contains("key") || name.contains("secret")),
            "no column may hold a key: {columns:?}"
        );
    }

    #[test]
    fn importing_the_same_movements_twice_creates_none_the_second_time() {
        let mut store = store();
        let (id, account_id) = linked(&mut store);
        let movements = vec![movement("er-0001", -1_230), movement("er-0002", 250_000)];

        let first = store
            .import_bank_movements(&id, &movements)
            .expect("import");
        assert_eq!(first.imported, 2);
        assert_eq!(first.duplicates, 0);
        let state = store
            .account_state(&account_id)
            .expect("state")
            .expect("there");
        assert_eq!(state.expenses.len(), 1);
        assert_eq!(state.incomes.len(), 1);
        // The expense keeps the magnitude, the income its sign.
        assert_eq!(state.expenses[0].amount_minor, 1_230);
        assert_eq!(state.incomes[0].amount_minor, 250_000);
        assert_eq!(state.expenses[0].date, "2026-01-05");
        assert_eq!(state.expenses[0].concept, "Supermercado Imaginario");

        let second = store
            .import_bank_movements(&id, &movements)
            .expect("re-import");
        assert_eq!(second.imported, 0);
        assert_eq!(second.duplicates, 2);
        let state = store
            .account_state(&account_id)
            .expect("state")
            .expect("there");
        assert_eq!(state.expenses.len(), 1, "no duplicate movement");
        assert_eq!(state.incomes.len(), 1);
        assert_eq!(store.bank_movement_count(&id).expect("count"), 2);
    }

    #[test]
    fn a_movement_in_another_currency_is_reported_not_reshaped() {
        let mut store = store();
        let (id, _account_id) = linked(&mut store);
        let mut gbp = movement("er-gbp", -500);
        gbp.currency = "GBP".into();
        let summary = store.import_bank_movements(&id, &[gbp]).expect("import");
        assert_eq!(summary.unsupported_currency, 1);
        assert_eq!(summary.imported, 0);
    }

    #[test]
    fn an_unmapped_account_imports_nothing_and_says_so() {
        let mut store = store();
        let (id, _account_id) = linked(&mut store);
        store
            .set_bank_account_mapping(&id, "fictional-uid", "")
            .expect("unmap");
        let summary = store
            .import_bank_movements(&id, &[movement("er-1", -100)])
            .expect("import");
        assert_eq!(summary.unmapped, 1);
        assert_eq!(summary.imported, 0);
        // Mapping it back lets the same movement in.
        let account_id = store.accounts().expect("accounts")[0].id.clone();
        store
            .set_bank_account_mapping(&id, "fictional-uid", &account_id)
            .expect("map");
        let summary = store
            .import_bank_movements(&id, &[movement("er-1", -100)])
            .expect("import");
        assert_eq!(summary.imported, 1);
    }

    #[test]
    fn a_balance_lands_on_the_account_with_its_date() {
        let mut store = store();
        let (_id, account_id) = linked(&mut store);
        let updated = store
            .set_bank_balance(&account_id, 123_456, "2026-01-31")
            .expect("balance")
            .expect("the account");
        assert_eq!(updated.balance_minor, 123_456);
        assert_eq!(updated.balance_date, "2026-01-31");
        assert!(updated.balance_set);
    }

    #[test]
    fn deleting_a_connection_forgets_the_link_and_keeps_the_movements() {
        let mut store = store();
        let (id, account_id) = linked(&mut store);
        store
            .import_bank_movements(&id, &[movement("er-1", -100)])
            .expect("import");
        assert!(store.delete_bank_connection(&id).expect("delete"));
        assert!(store.bank_connection(&id).expect("read").is_none());
        assert!(store.bank_accounts(&id).expect("accounts").is_empty());
        assert_eq!(store.bank_movement_count(&id).expect("count"), 0);
        let state = store
            .account_state(&account_id)
            .expect("state")
            .expect("there");
        assert_eq!(state.expenses.len(), 1, "the history stays");
    }

    #[test]
    fn linking_the_same_bank_again_replaces_the_old_session() {
        let mut store = store();
        let (first, _account_id) = linked(&mut store);
        let (second, _account_id) = linked(&mut store);
        assert_ne!(first, second);
        assert_eq!(store.bank_connections().expect("connections").len(), 1);
        assert_eq!(
            store
                .bank_connection(&second)
                .expect("read")
                .expect("there")
                .session_id,
            "fictional-session"
        );
    }
}
