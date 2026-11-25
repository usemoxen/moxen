//! The domain types of Moxen Finances, ported from the TypeScript
//! reference (`src/core/types.ts` at 8aaad15b). Money is always integer
//! minor units (cents); dates are `YYYY-MM-DD` strings. The JSON field
//! names are camelCase to stay interchangeable with the reference app
//! and the SQLite store that reads the same rows.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Currency {
    Eur,
    Usd,
}

impl Currency {
    /// The wire/JSON name, identical to the serde rename.
    pub fn as_str(&self) -> &'static str {
        match self {
            Currency::Eur => "EUR",
            Currency::Usd => "USD",
        }
    }
}

pub const CURRENCIES: [Currency; 2] = [Currency::Eur, Currency::Usd];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Frequency {
    Once,
    Weekly,
    Monthly,
    Quarterly,
    Annual,
}

impl Frequency {
    pub fn as_str(&self) -> &'static str {
        match self {
            Frequency::Once => "once",
            Frequency::Weekly => "weekly",
            Frequency::Monthly => "monthly",
            Frequency::Quarterly => "quarterly",
            Frequency::Annual => "annual",
        }
    }
}

pub fn frequency_label(frequency: Frequency) -> &'static str {
    match frequency {
        Frequency::Once => "Puntual",
        Frequency::Weekly => "Semanal",
        Frequency::Monthly => "Mensual",
        Frequency::Quarterly => "Trimestral",
        Frequency::Annual => "Anual",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubscriptionStatus {
    Active,
    Paused,
    Cancelled,
    Finished,
}

impl SubscriptionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SubscriptionStatus::Active => "active",
            SubscriptionStatus::Paused => "paused",
            SubscriptionStatus::Cancelled => "cancelled",
            SubscriptionStatus::Finished => "finished",
        }
    }
}

pub fn subscription_status_label(status: SubscriptionStatus) -> &'static str {
    match status {
        SubscriptionStatus::Active => "Activa",
        SubscriptionStatus::Paused => "Pausada",
        SubscriptionStatus::Cancelled => "Cancelada",
        SubscriptionStatus::Finished => "Finalizada",
    }
}

/// Estado de un gasto: previsto, pendiente o realizado.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExpenseStatus {
    Planned,
    Pending,
    Done,
}

impl ExpenseStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ExpenseStatus::Planned => "planned",
            ExpenseStatus::Pending => "pending",
            ExpenseStatus::Done => "done",
        }
    }
}

/// Estado de un ingreso: previsto o recibido.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IncomeStatus {
    Expected,
    Received,
}

impl IncomeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            IncomeStatus::Expected => "expected",
            IncomeStatus::Received => "received",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub currency: Currency,
    /// Saldo en unidades menores (céntimos) de la moneda de la cuenta.
    pub balance_minor: i64,
    /// Fecha a la que corresponde el saldo (YYYY-MM-DD).
    pub balance_date: String,
    /// false mientras el usuario no haya introducido su saldo real.
    pub balance_set: bool,
    /// Saldo de apertura opcional para reconstruir meses anteriores al saldo actual.
    pub opening_balance_minor: i64,
    pub opening_balance_date: Option<String>,
    pub opening_balance_set: bool,
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub name: String,
    pub description: String,
    pub currency: Currency,
    /// Precio actual o de respaldo. null = pendiente de confirmar.
    pub price_minor: Option<i64>,
    pub frequency: Frequency,
    /// Fecha de inicio del contrato. null = pendiente.
    pub start_date: Option<String>,
    /// Día de cobro mensual/anual. null = usar el día de startDate.
    pub billing_day: Option<i64>,
    /// Próximo cobro configurado manualmente (tiene prioridad si es futuro).
    pub next_billing_override: Option<String>,
    /// A partir de esta fecha no se genera ningún cargo (exclusive).
    pub end_date: Option<String>,
    pub status: SubscriptionStatus,
    /// Fecha a partir de la cual la cancelación impide cobros (inclusive).
    pub cancelled_at: Option<String>,
    pub plan: Option<String>,
    pub notes: String,
    /// Se paga con otra cuenta/tarjeta: cuenta en estadísticas pero no en el
    /// saldo de esta cuenta.
    pub external_payment: bool,
    pub archived: bool,
    /// Si está archivada, fecha a partir de la cual deja de proyectar cargos.
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceHistoryEntry {
    pub id: String,
    pub subscription_id: String,
    pub price_minor: i64,
    pub currency: Currency,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanHistoryEntry {
    pub id: String,
    pub subscription_id: String,
    pub plan: String,
    pub effective_from: String,
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseEntry {
    pub id: String,
    pub subscription_id: String,
    /// Inicio de la pausa (inclusive).
    pub start_date: String,
    /// Fin de la pausa (inclusive). null = pausa en curso.
    pub end_date: Option<String>,
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusHistoryEntry {
    pub id: String,
    pub subscription_id: String,
    pub status: SubscriptionStatus,
    pub date: String,
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingDayEntry {
    pub id: String,
    pub subscription_id: String,
    pub billing_day: i64,
    pub effective_from: String,
    pub note: String,
    pub created_at: String,
}

/// A subscription plus its effective-dated history. Flat in JSON, exactly
/// like the reference's `SubscriptionWithHistory extends Subscription`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionWithHistory {
    #[serde(flatten)]
    pub subscription: Subscription,
    pub prices: Vec<PriceHistoryEntry>,
    pub plans: Vec<PlanHistoryEntry>,
    pub pauses: Vec<PauseEntry>,
    #[serde(rename = "statusHistory")]
    pub status_history: Vec<StatusHistoryEntry>,
    #[serde(rename = "billingDays")]
    pub billing_days: Vec<BillingDayEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Income {
    pub id: String,
    pub concept: String,
    pub amount_minor: i64,
    pub currency: Currency,
    pub date: String,
    /// Hora local opcional (HH:mm) para ordenar movimientos del mismo día.
    pub time: Option<String>,
    pub frequency: Frequency,
    pub end_date: Option<String>,
    pub status: IncomeStatus,
    pub paused: bool,
    pub notes: String,
    /// Importe final real en la moneda de la cuenta, si difiere del estimado.
    pub actual_amount_minor: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expense {
    pub id: String,
    pub concept: String,
    pub category: String,
    pub amount_minor: i64,
    pub currency: Currency,
    pub date: String,
    /// Hora local opcional (HH:mm) para ordenar movimientos del mismo día.
    pub time: Option<String>,
    pub frequency: Frequency,
    pub end_date: Option<String>,
    pub status: ExpenseStatus,
    pub notes: String,
    pub actual_amount_minor: Option<i64>,
    pub created_at: String,
}

/// Importe real cobrado por el banco para un cargo concreto de una
/// suscripción. Permite reflejar comisiones o el cambio aplicado sin
/// alterar el precio original.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActualCharge {
    pub id: String,
    pub subscription_id: String,
    /// Fecha del cargo, en formato YYYY-MM-DD.
    pub charge_date: String,
    /// Hora local opcional del cargo (HH:mm).
    pub time: Option<String>,
    /// Importe real en la moneda de la cuenta.
    pub amount_minor: i64,
    pub currency: Currency,
    /// Tipo de cambio implícito aplicado, si se conoce.
    pub rate_scaled: Option<i64>,
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRate {
    pub id: String,
    pub from_currency: Currency,
    pub to_currency: Currency,
    /// 1 fromCurrency = rateScaled / 1e6 toCurrency.
    pub rate_scaled: i64,
    pub effective_from: String,
    pub source: String,
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub account: Account,
    pub subscriptions: Vec<SubscriptionWithHistory>,
    pub incomes: Vec<Income>,
    pub expenses: Vec<Expense>,
    pub rates: Vec<ExchangeRate>,
    pub charges: Vec<ActualCharge>,
    pub settings: BTreeMap<String, String>,
}
