//! The multi-account pieces LOCAL-025 adds: the account scope that the
//! projection and the statistics take, and the conversion of balances across
//! accounts. None of this exists in the TypeScript reference (which has a
//! single account), so everything here is new specification, pinned by
//! `tests/vectors/accounts.json` rather than by the reference's vectors.

use serde::{Deserialize, Serialize};

use crate::exchange::convert_to_account_currency;
use crate::types::{Account, Currency, ExchangeRate};

/// Which accounts a projection or a statistic is about.
///
/// - [`AccountScope::All`]: every account together, a total whose amounts are
///   converted to the target currency with the effective-dated rates of
///   [`crate::exchange`]. Rows without an account (schema-1 data) are the
///   whole state, exactly what the reference's single-account logic did.
/// - [`AccountScope::One`]: one account's own movements; rows of other
///   accounts are not collected.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AccountScope {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "account")]
    One(#[serde(rename = "accountId")] String),
}

impl AccountScope {
    /// Whether a row of `account_id` belongs to the scope. A row without an
    /// account (`""`, the reference's data) belongs to [`AccountScope::All`]
    /// only — the same rows the single-account logic saw.
    pub fn in_scope(&self, account_id: &str) -> bool {
        match self {
            AccountScope::All => true,
            AccountScope::One(id) => account_id == id,
        }
    }
}

/// The balance of several accounts converted into one currency. `approximate`
/// is true when some balance had no exchange rate in force on the date (the
/// unconverted amount still counts, flagged, so a mixed-currency total never
/// goes missing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalBalance {
    pub total_minor: i64,
    pub approximate: bool,
}

/// The sum of the accounts' balances on `date`, converted into `target` with
/// the rates in force (each account's balance at the same date, so the total
/// is the total at one moment).
pub fn total_balance_minor(
    accounts: &[Account],
    target: Currency,
    rates: &[ExchangeRate],
    date: &str,
) -> TotalBalance {
    let mut total_minor: i64 = 0;
    let mut approximate = false;
    for account in accounts {
        if account.archived {
            continue;
        }
        let converted = convert_to_account_currency(
            account.balance_minor,
            account.currency,
            target,
            date,
            rates,
        );
        total_minor += converted.amount_minor;
        approximate |= converted.approximate;
    }
    TotalBalance {
        total_minor,
        approximate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AccountKind;

    fn account(id: &str, currency: Currency, balance_minor: i64, balance_date: &str) -> Account {
        Account {
            id: id.to_string(),
            name: id.to_string(),
            kind: AccountKind::Checking,
            currency,
            balance_minor,
            balance_date: balance_date.to_string(),
            balance_set: true,
            opening_balance_minor: 0,
            opening_balance_date: None,
            opening_balance_set: false,
            archived: false,
            sort_order: 0,
            notes: String::new(),
        }
    }

    fn rate(id: &str, from: Currency, to: Currency, scaled: i64, from_date: &str) -> ExchangeRate {
        ExchangeRate {
            id: id.to_string(),
            from_currency: from,
            to_currency: to,
            rate_scaled: scaled,
            effective_from: from_date.to_string(),
            source: "Test".to_string(),
            note: String::new(),
            created_at: String::new(),
        }
    }

    #[test]
    fn the_scope_of_a_row_depends_on_its_account() {
        let all = AccountScope::All;
        assert!(all.in_scope("a"));
        assert!(all.in_scope(""));
        let checking = AccountScope::One("checking".to_string());
        assert!(checking.in_scope("checking"));
        assert!(!checking.in_scope("savings"));
        assert!(!checking.in_scope(""), "a row without an account is out");
    }

    #[test]
    fn a_single_currency_total_needs_no_rate() {
        let accounts = [
            account("checking", Currency::Eur, 100_000, "2026-12-01"),
            account("cash", Currency::Eur, 5_000, "2026-12-01"),
        ];
        let total = total_balance_minor(&accounts, Currency::Eur, &[], "2026-12-02");
        assert_eq!(total.total_minor, 105_000);
        assert!(!total.approximate);
    }

    #[test]
    fn a_mixed_currency_total_converts_and_archived_accounts_do_not_count() {
        let mut card = account("card", Currency::Usd, 1_200, "2026-12-01");
        card.archived = true;
        let accounts = [
            account("checking", Currency::Eur, 100_000, "2026-12-01"),
            account("savings", Currency::Usd, 10_000, "2026-12-01"),
            card,
        ];
        let rates = [rate(
            "r1",
            Currency::Usd,
            Currency::Eur,
            909_091,
            "2026-11-01",
        )];
        let total = total_balance_minor(&accounts, Currency::Eur, &rates, "2026-12-02");
        assert_eq!(total.total_minor, 100_000 + 9_091);
        assert!(!total.approximate);
    }

    #[test]
    fn a_missing_rate_flags_the_total_approximate() {
        let accounts = [
            account("checking", Currency::Eur, 100_000, "2026-12-01"),
            account("savings", Currency::Usd, 10_000, "2026-12-01"),
        ];
        let total = total_balance_minor(&accounts, Currency::Eur, &[], "2026-12-02");
        // The USD balance counts unconverted rather than disappearing.
        assert_eq!(total.total_minor, 110_000);
        assert!(total.approximate);
    }
}
