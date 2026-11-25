//! CSV export and import, ported from the reference's `src/server/export.ts`
//! (8aaad15b): the same headers, the same `;` separator, the same UTF-8 BOM at
//! the start of the file, the same `\r\n` between lines and the same
//! comma-decimal amounts, so a sheet exported by either app opens in the
//! other.
//!
//! Import is append-only: it creates the rows a file describes, and never
//! deletes or rewrites anything that is already there. Anything it cannot read
//! is counted as skipped instead of failing the whole file, and a file that is
//! not CSV at all is refused through [`StoreError::Csv`], not a panic.

use moxen_finances_core::dates::{is_valid_iso_date, today_madrid_now};
use moxen_finances_core::money::{parse_amount_to_minor, parse_rate_to_scaled};
use moxen_finances_core::projection::{EventCollectionInput, EventKind, EventSource};

use moxen_finances_core::types::{AppState, Currency, ExpenseStatus, Frequency, IncomeStatus};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ledger::{ExpenseInput, IncomeInput, RateInput};
use crate::repo::SubscriptionInput;

/// The byte-order mark the reference writes first, so Excel reads the UTF-8
/// accents instead of guessing a legacy code page.
const BOM: char = '\u{feff}';

/// The five sheets the app can export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CsvKind {
    Subscriptions,
    Incomes,
    Expenses,
    Rates,
    Movements,
}

impl CsvKind {
    /// The name the app and the API use.
    pub fn as_str(&self) -> &'static str {
        match self {
            CsvKind::Subscriptions => "subscriptions",
            CsvKind::Incomes => "incomes",
            CsvKind::Expenses => "expenses",
            CsvKind::Rates => "rates",
            CsvKind::Movements => "movements",
        }
    }

    /// The kind a name means, `None` when it is not one of the five.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "subscriptions" => Some(CsvKind::Subscriptions),
            "incomes" => Some(CsvKind::Incomes),
            "expenses" => Some(CsvKind::Expenses),
            "rates" => Some(CsvKind::Rates),
            "movements" => Some(CsvKind::Movements),
            _ => None,
        }
    }

    /// The header row, in the reference's order and language.
    fn headers(&self) -> &'static [&'static str] {
        match self {
            CsvKind::Subscriptions => &[
                "id",
                "nombre",
                "descripcion",
                "moneda",
                "precio",
                "frecuencia",
                "inicio",
                "dia_cobro",
                "fin",
                "estado",
                "plan",
                "notas",
            ],
            CsvKind::Incomes => &[
                "id",
                "concepto",
                "importe",
                "moneda",
                "fecha",
                "hora",
                "frecuencia",
                "fin",
                "estado",
                "pausado",
                "notas",
                "importe_real",
            ],
            CsvKind::Expenses => &[
                "id",
                "concepto",
                "categoria",
                "importe",
                "moneda",
                "fecha",
                "hora",
                "frecuencia",
                "fin",
                "estado",
                "notas",
                "importe_real",
            ],
            CsvKind::Rates => &[
                "id",
                "desde",
                "hasta",
                "tipo",
                "vigente_desde",
                "fuente",
                "notas",
            ],
            CsvKind::Movements => &[
                "fecha",
                "tipo",
                "origen",
                "nombre",
                "detalle",
                "importe_eur",
                "importe_original",
                "moneda_original",
                "estimado",
                "estado",
                "categoria",
            ],
        }
    }
}

/// How many rows an import created and how many it could not read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportSummary {
    pub created: usize,
    pub skipped: usize,
}

/// `(minor / 100).toFixed(2)` with a comma decimal separator, like the
/// reference's amounts: `1899` is `18,99`.
fn format_cents(minor: i64) -> String {
    let sign = if minor < 0 { "-" } else { "" };
    let magnitude = minor.unsigned_abs();
    format!("{sign}{},{:02}", magnitude / 100, magnitude % 100)
}

/// `(rateScaled / 1_000_000).toFixed(6)` with a comma: `1100000` is
/// `1,100000`.
fn format_scaled_rate(rate_scaled: i64) -> String {
    let sign = if rate_scaled < 0 { "-" } else { "" };
    let magnitude = rate_scaled.unsigned_abs();
    format!(
        "{sign}{},{:06}",
        magnitude / 1_000_000,
        magnitude % 1_000_000
    )
}

fn event_source_name(source: EventSource) -> &'static str {
    match source {
        EventSource::Subscription => "subscription",
        EventSource::Income => "income",
        EventSource::Expense => "expense",
    }
}

/// `toCsv`: the BOM, then the rows joined with `\r\n`, no trailing newline.
fn records_to_csv(rows: &[Vec<String>]) -> Result<String> {
    let mut writer = csv::WriterBuilder::new()
        .delimiter(b';')
        .terminator(csv::Terminator::CRLF)
        .quote_style(csv::QuoteStyle::Necessary)
        .from_writer(Vec::new());
    for row in rows {
        writer.write_record(row.iter().map(String::as_str))?;
    }
    // The writer targets a `Vec`, so this cannot fail in practice; the error
    // is still carried instead of unwrapped.
    let bytes = writer
        .into_inner()
        .map_err(|error| StoreError::Write(error.into_error()))?;
    let body = String::from_utf8(bytes)
        .map_err(|error| StoreError::MalformedBackup(format!("el CSV no es UTF-8: {error}")))?;
    // `csv` terminates every record, the reference only joins them.
    let body = body.strip_suffix("\r\n").unwrap_or(&body);
    Ok(format!("{BOM}{body}"))
}

/// `parseCsv`: BOM optional, `\r\n` and `\r` accepted, and the separator
/// sniffed from the header line (`;` when it has more of those than commas).
fn parse_csv(text: &str) -> Result<Vec<Vec<String>>> {
    let cleaned = text.strip_prefix(BOM).unwrap_or(text);
    let first_line = cleaned.split('\n').next().unwrap_or_default();
    let separator = if first_line.matches(';').count() > first_line.matches(',').count() {
        b';'
    } else {
        b','
    };
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(separator)
        .has_headers(false)
        .flexible(true)
        .from_reader(cleaned.as_bytes());
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record?;
        let row: Vec<String> = record.iter().map(str::to_string).collect();
        // The reference drops blank lines.
        if row.is_empty() || (row.len() == 1 && row[0].is_empty()) {
            continue;
        }
        rows.push(row);
    }
    Ok(rows)
}

fn cell(row: &[String], index: Option<usize>) -> String {
    index
        .and_then(|index| row.get(index))
        .cloned()
        .unwrap_or_default()
}

fn header_index(headers: &[String], name: &str) -> Option<usize> {
    headers.iter().position(|header| header == name)
}

/// The reference's `normalizeTime`: `HH:mm`, `H:mm` accepted, padded, anything
/// else means no time.
fn normalize_time(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let (hours, minutes) = trimmed.split_once(':')?;
    if hours.is_empty() || hours.len() > 2 || !hours.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if minutes.len() != 2 || !minutes.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let hours: u32 = hours.parse().ok()?;
    if hours > 23 || minutes.as_bytes()[0] > b'5' {
        return None;
    }
    Some(format!("{hours:02}:{minutes}"))
}

/// The reference's `normalizeDate`: a valid `YYYY-MM-DD` as is, or the Spanish
/// `d/m/yyyy` (and `-` or `.` separators) rewritten to ISO.
fn normalize_date(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if is_valid_iso_date(trimmed) {
        return Some(trimmed.to_string());
    }
    let parts: Vec<&str> = trimmed.split(['/', '-', '.']).collect();
    if parts.len() != 3 {
        return None;
    }
    let (day, month, year) = (parts[0], parts[1], parts[2]);
    let two_digits = |part: &str| {
        !part.is_empty() && part.len() <= 2 && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    if !two_digits(day)
        || !two_digits(month)
        || year.len() != 4
        || !year.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let day: i64 = day.parse().ok()?;
    let month: i64 = month.parse().ok()?;
    let iso = format!("{year}-{month:02}-{day:02}");
    if is_valid_iso_date(&iso) {
        Some(iso)
    } else {
        None
    }
}

fn currency_or(value: &str, fallback: Currency) -> Currency {
    match value.trim().to_uppercase().as_str() {
        "EUR" => Currency::Eur,
        "USD" => Currency::Usd,
        _ => fallback,
    }
}

fn frequency_or(value: &str, fallback: Frequency) -> Frequency {
    match value.trim() {
        "once" => Frequency::Once,
        "weekly" => Frequency::Weekly,
        "monthly" => Frequency::Monthly,
        "quarterly" => Frequency::Quarterly,
        "annual" => Frequency::Annual,
        _ => fallback,
    }
}

/// `exportCsv`: one sheet of the state as text.
///
/// `movements` needs the range (`from`…`to`) and comes from core's event
/// collection, exactly like the reference; the other sheets ignore it.
pub fn export_csv(state: &AppState, kind: CsvKind, from: &str, to: &str) -> Result<String> {
    let mut rows: Vec<Vec<String>> = vec![
        kind.headers()
            .iter()
            .map(|header| (*header).to_string())
            .collect(),
    ];

    match kind {
        CsvKind::Subscriptions => {
            for item in &state.subscriptions {
                let sub = &item.subscription;
                rows.push(vec![
                    sub.id.clone(),
                    sub.name.clone(),
                    sub.description.clone(),
                    sub.currency.as_str().to_string(),
                    sub.price_minor.map(format_cents).unwrap_or_default(),
                    sub.frequency.as_str().to_string(),
                    sub.start_date.clone().unwrap_or_default(),
                    sub.billing_day
                        .map(|day| day.to_string())
                        .unwrap_or_default(),
                    sub.end_date.clone().unwrap_or_default(),
                    sub.status.as_str().to_string(),
                    sub.plan.clone().unwrap_or_default(),
                    sub.notes.clone(),
                ]);
            }
        }
        CsvKind::Incomes => {
            for income in &state.incomes {
                rows.push(vec![
                    income.id.clone(),
                    income.concept.clone(),
                    format_cents(income.amount_minor),
                    income.currency.as_str().to_string(),
                    income.date.clone(),
                    income.time.clone().unwrap_or_default(),
                    income.frequency.as_str().to_string(),
                    income.end_date.clone().unwrap_or_default(),
                    income.status.as_str().to_string(),
                    if income.paused { "sí" } else { "no" }.to_string(),
                    income.notes.clone(),
                    income
                        .actual_amount_minor
                        .map(format_cents)
                        .unwrap_or_default(),
                ]);
            }
        }
        CsvKind::Expenses => {
            for expense in &state.expenses {
                rows.push(vec![
                    expense.id.clone(),
                    expense.concept.clone(),
                    expense.category.clone(),
                    format_cents(expense.amount_minor),
                    expense.currency.as_str().to_string(),
                    expense.date.clone(),
                    expense.time.clone().unwrap_or_default(),
                    expense.frequency.as_str().to_string(),
                    expense.end_date.clone().unwrap_or_default(),
                    expense.status.as_str().to_string(),
                    expense.notes.clone(),
                    expense
                        .actual_amount_minor
                        .map(format_cents)
                        .unwrap_or_default(),
                ]);
            }
        }
        CsvKind::Rates => {
            for rate in &state.rates {
                rows.push(vec![
                    rate.id.clone(),
                    rate.from_currency.as_str().to_string(),
                    rate.to_currency.as_str().to_string(),
                    format_scaled_rate(rate.rate_scaled),
                    rate.effective_from.clone(),
                    rate.source.clone(),
                    rate.note.clone(),
                ]);
            }
        }
        CsvKind::Movements => {
            let collected =
                moxen_finances_core::projection::collect_events(&EventCollectionInput {
                    account_currency: state.account.currency,
                    subscriptions: &state.subscriptions,
                    incomes: &state.incomes,
                    expenses: &state.expenses,
                    rates: &state.rates,
                    charges: &state.charges,
                    from_date: from,
                    to_date: to,
                    extra_events: &[],
                })?;
            for event in collected.events {
                rows.push(vec![
                    event.date.clone(),
                    match event.kind {
                        EventKind::Income => "ingreso",
                        EventKind::Expense => "gasto",
                    }
                    .to_string(),
                    event_source_name(event.source).to_string(),
                    event.name.clone(),
                    event.detail.clone(),
                    format_cents(event.amount_minor),
                    event
                        .original_amount_minor
                        .map(format_cents)
                        .unwrap_or_default(),
                    event
                        .original_currency
                        .map(|currency| currency.as_str().to_string())
                        .unwrap_or_default(),
                    if event.estimated { "estimado" } else { "real" }.to_string(),
                    event.status.clone().unwrap_or_default(),
                    event.category.clone().unwrap_or_default(),
                ]);
            }
        }
    }

    records_to_csv(&rows)
}

/// `importCsv`: create the rows a sheet describes; never delete or rewrite
/// anything already stored.
pub(crate) fn import_csv(
    conn: &rusqlite::Connection,
    kind: CsvKind,
    text: &str,
) -> Result<ImportSummary> {
    let rows = parse_csv(text)?;
    if rows.len() < 2 {
        return Ok(ImportSummary {
            created: 0,
            skipped: 0,
        });
    }
    let headers: Vec<String> = rows[0]
        .iter()
        .map(|header| header.trim().to_lowercase())
        .collect();
    let body = &rows[1..];
    let mut summary = ImportSummary {
        created: 0,
        skipped: 0,
    };

    match kind {
        CsvKind::Incomes | CsvKind::Expenses => {
            for row in body {
                let concept = cell(row, header_index(&headers, "concepto"))
                    .trim()
                    .to_string();
                let amount_text = cell(row, header_index(&headers, "importe"));
                let Some(amount) = parse_amount_to_minor(&amount_text) else {
                    summary.skipped += 1;
                    continue;
                };
                let Some(date) = normalize_date(&cell(row, header_index(&headers, "fecha"))) else {
                    summary.skipped += 1;
                    continue;
                };
                if concept.is_empty() {
                    summary.skipped += 1;
                    continue;
                }
                let time = normalize_time(&cell(row, header_index(&headers, "hora")));
                let currency =
                    currency_or(&cell(row, header_index(&headers, "moneda")), Currency::Eur);
                let frequency = frequency_or(
                    &cell(row, header_index(&headers, "frecuencia")),
                    Frequency::Once,
                );
                let status = cell(row, header_index(&headers, "estado"))
                    .trim()
                    .to_string();
                let notes = cell(row, header_index(&headers, "notas"))
                    .trim()
                    .to_string();
                let actual_text = cell(row, header_index(&headers, "importe_real")).clone();
                let actual_text = actual_text.trim();
                let actual = if actual_text.is_empty() {
                    None
                } else {
                    parse_amount_to_minor(actual_text)
                };
                let end_date = normalize_date(&cell(row, header_index(&headers, "fin")));

                if kind == CsvKind::Incomes {
                    let input = IncomeInput {
                        concept,
                        amount_minor: amount,
                        currency,
                        date,
                        time,
                        frequency,
                        end_date,
                        status: match status.as_str() {
                            // The export writes the English word and the
                            // reference's import only understands the Spanish
                            // one, so its own round trip turns a received
                            // income back into an expected one. Both are
                            // accepted here: every file the reference reads
                            // means the same thing, and ours round-trips.
                            "recibido" | "received" => IncomeStatus::Received,
                            _ => IncomeStatus::Expected,
                        },
                        paused: cell(row, header_index(&headers, "pausado"))
                            .trim()
                            .to_lowercase()
                            == "sí",
                        notes,
                        actual_amount_minor: actual,
                    };
                    crate::ledger::create_income(conn, &input)?;
                } else {
                    let category = cell(row, header_index(&headers, "categoria"));
                    let category = category.trim();
                    let input = ExpenseInput {
                        concept,
                        category: if category.is_empty() {
                            "Otros".to_string()
                        } else {
                            category.to_string()
                        },
                        amount_minor: amount,
                        currency,
                        date,
                        time,
                        frequency,
                        end_date,
                        status: match status.as_str() {
                            "realizado" | "done" => ExpenseStatus::Done,
                            "pendiente" | "pending" => ExpenseStatus::Pending,
                            _ => ExpenseStatus::Planned,
                        },
                        notes,
                        actual_amount_minor: actual,
                    };
                    crate::ledger::create_expense(conn, &input)?;
                }
                summary.created += 1;
            }
        }
        CsvKind::Subscriptions => {
            for row in body {
                let name = cell(row, header_index(&headers, "nombre"))
                    .trim()
                    .to_string();
                if name.is_empty() {
                    summary.skipped += 1;
                    continue;
                }
                let price = parse_amount_to_minor(&cell(row, header_index(&headers, "precio")));
                let currency =
                    currency_or(&cell(row, header_index(&headers, "moneda")), Currency::Eur);
                let start_date = normalize_date(&cell(row, header_index(&headers, "inicio")));
                let billing_day_text = cell(row, header_index(&headers, "dia_cobro"));
                let billing_day_text = billing_day_text.trim();
                let plan = cell(row, header_index(&headers, "plan"));
                let plan = plan.trim();
                let description = cell(row, header_index(&headers, "descripcion"));

                let input = SubscriptionInput {
                    name,
                    description: Some(description.trim().to_string()),
                    currency: Some(currency),
                    price_minor: price,
                    frequency: Some(frequency_or(
                        &cell(row, header_index(&headers, "frecuencia")),
                        Frequency::Monthly,
                    )),
                    start_date,
                    billing_day: if billing_day_text.is_empty() {
                        None
                    } else {
                        billing_day_text.parse().ok()
                    },
                    next_billing_override: None,
                    end_date: normalize_date(&cell(row, header_index(&headers, "fin"))),
                    plan: if plan.is_empty() {
                        None
                    } else {
                        Some(plan.to_string())
                    },
                    notes: Some(
                        cell(row, header_index(&headers, "notas"))
                            .trim()
                            .to_string(),
                    ),
                    external_payment: None,
                    status: Some(moxen_finances_core::types::SubscriptionStatus::Active),
                };
                crate::repo::create_subscription(conn, &input)?;
                summary.created += 1;
            }
        }
        CsvKind::Rates => {
            for row in body {
                let from = currency_or(&cell(row, header_index(&headers, "desde")), Currency::Eur);
                let to = currency_or(&cell(row, header_index(&headers, "hasta")), Currency::Usd);
                let rate = parse_rate_to_scaled(&cell(row, header_index(&headers, "tipo")));
                let effective_from =
                    normalize_date(&cell(row, header_index(&headers, "vigente_desde")))
                        .unwrap_or_else(today_madrid_now);
                let Some(rate_scaled) = rate else {
                    summary.skipped += 1;
                    continue;
                };
                if from == to || rate_scaled <= 0 {
                    summary.skipped += 1;
                    continue;
                }
                let input = RateInput {
                    from_currency: from,
                    to_currency: to,
                    rate_scaled,
                    effective_from,
                    source: Some(
                        cell(row, header_index(&headers, "fuente"))
                            .trim()
                            .to_string(),
                    ),
                    note: Some(
                        cell(row, header_index(&headers, "notas"))
                            .trim()
                            .to_string(),
                    ),
                };
                crate::ledger::add_rate(conn, &input)?;
                summary.created += 1;
            }
        }
        // The movements sheet is a report of the projection, not a table that
        // can be read back, which the reference also leaves unimported.
        CsvKind::Movements => {}
    }

    Ok(summary)
}

impl Store {
    /// One sheet of the current state (`movements` covers `from`…`to`; the
    /// others ignore the range).
    pub fn export_csv(&self, kind: CsvKind, from: &str, to: &str) -> Result<String> {
        let state = self.app_state()?;
        export_csv(&state, kind, from, to)
    }

    /// Create the rows a sheet describes; append-only.
    pub fn import_csv(&mut self, kind: CsvKind, text: &str) -> Result<ImportSummary> {
        import_csv(self.connection(), kind, text)
    }
}
