//! The interface language: English and Spanish (Spain, `tú` forms), from the
//! start. Follows the desktop's pattern: a setting code (`en` / `es-ES`), a
//! thread-local current language applied at every render, and key-based
//! catalogs with `{placeholder}` filling.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    English,
    Spanish,
}

impl Language {
    pub fn code(self) -> &'static str {
        match self {
            Language::English => "en",
            Language::Spanish => "es-ES",
        }
    }

    pub fn from_setting(setting: Option<&str>) -> Self {
        match setting {
            Some("es") | Some("es-ES") | Some("es_ES") => Language::Spanish,
            _ => Language::English,
        }
    }

    /// The language's own name, as shown in the language switch.
    pub fn label(self) -> &'static str {
        message(match self {
            Language::English => "language.en",
            Language::Spanish => "language.es",
        })
    }
}

thread_local! {
    static LANGUAGE: Cell<Language> = const { Cell::new(Language::English) };
}

/// Applies the language for the current render thread, like the desktop does
/// at the top of every frame.
pub fn apply(setting: Option<&str>) {
    LANGUAGE.set(Language::from_setting(setting));
}

pub fn current() -> Language {
    LANGUAGE.get()
}

pub fn spanish() -> bool {
    current() == Language::Spanish
}

const EN: &[(&str, &str)] = &[
    ("app.title", "Moxen Finances"),
    ("group.overview", "Overview"),
    ("group.tracking", "Tracking"),
    ("group.system", "System"),
    ("nav.dashboard", "Dashboard"),
    ("nav.subscriptions", "Subscriptions"),
    ("nav.movements", "Movements"),
    ("nav.projection", "Projection"),
    ("nav.calendar", "Calendar"),
    ("nav.analysis", "Analysis"),
    ("nav.settings", "Settings"),
    ("dashboard.balance", "Balance"),
    ("dashboard.balance.asof", "as of {date}"),
    ("dashboard.forecast", "Month-end forecast"),
    ("dashboard.forecast.note", "after the upcoming charges"),
    ("dashboard.spent", "Spent this month"),
    ("dashboard.recurring", "Recurring cost"),
    ("dashboard.recurring.per", "per month"),
    ("dashboard.chart", "Balance evolution"),
    ("dashboard.chart.range", "Last {count} days"),
    ("dashboard.chart.high", "High {amount}"),
    ("dashboard.chart.low", "Low {amount}"),
    ("dashboard.upcoming", "Upcoming charges"),
    ("dashboard.upcoming.count", "{count} scheduled"),
    ("dashboard.upcoming.empty", "No upcoming charges"),
    ("dashboard.upcoming.on", "on {date}"),
    ("dashboard.upcoming.pending", "amount pending"),
    (
        "dashboard.incomplete",
        "A subscription has no price yet, so the forecast is incomplete.",
    ),
    (
        "subscriptions.subtitle",
        "{active} active · {paused} paused",
    ),
    ("subscriptions.empty", "No subscriptions yet"),
    ("subscriptions.detail", "Details"),
    ("sub.status.active", "Active"),
    ("sub.status.paused", "Paused"),
    ("sub.status.cancelled", "Cancelled"),
    ("sub.status.finished", "Finished"),
    ("sub.price", "Price"),
    ("sub.price.pending", "Pending"),
    ("sub.frequency", "Billing"),
    ("sub.next_charge", "Next charge"),
    ("sub.next.none", "No upcoming charge"),
    ("sub.actions", "Actions"),
    ("sub.action.pause", "Pause"),
    ("sub.action.resume", "Resume"),
    ("sub.action.cancel", "Cancel subscription"),
    ("sub.action.disabled", "Read-only data source (the demo)"),
    ("sub.action.edit", "Edit"),
    ("sub.action.delete", "Delete"),
    ("sub.action.reactivate", "Reactivate"),
    ("sub.new", "New subscription"),
    ("freq.once", "Once"),
    ("freq.weekly", "Weekly"),
    ("freq.monthly", "Monthly"),
    ("freq.quarterly", "Quarterly"),
    ("freq.annual", "Annual"),
    ("settings.section.interface", "Interface"),
    ("settings.language", "Language"),
    (
        "settings.language.description",
        "The language of the interface.",
    ),
    ("settings.theme", "Theme"),
    (
        "settings.theme.description",
        "The appearance of the window.",
    ),
    ("settings.theme.dark", "Dark"),
    ("settings.theme.light", "Light"),
    ("language.en", "English"),
    ("language.es", "Español"),
    // Accounts (LOCAL-030)
    ("accounts.title", "Accounts"),
    ("accounts.all", "All accounts"),
    (
        "accounts.approx",
        "Some balances have no exchange rate, so this total is approximate.",
    ),
    ("accounts.archived", "Archived"),
    ("accounts.new", "New account"),
    ("accounts.rename", "Rename"),
    ("accounts.archive", "Archive"),
    ("accounts.unarchive", "Unarchive"),
    ("accounts.delete", "Delete"),
    ("accounts.transfer", "Transfer"),
    ("accounts.empty", "No accounts yet"),
    ("account.kind.checking", "Checking"),
    ("account.kind.savings", "Savings"),
    ("account.kind.credit-card", "Credit card"),
    ("account.kind.cash", "Cash"),
    // Movement actions
    ("movements.action.confirm", "Confirm"),
    ("movements.action.edit", "Edit"),
    ("movements.action.delete", "Delete"),
    ("mov.transfer", "Transfer"),
    // Settings: data and accounts
    ("settings.section.data", "Data"),
    ("settings.section.accounts", "Accounts"),
    ("settings.db", "Database"),
    (
        "settings.db.description",
        "The SQLite file this app reads and writes.",
    ),
    ("settings.db.none", "Demo data (no database)"),
    ("settings.backup", "JSON backup"),
    (
        "settings.backup.description",
        "Export everything to a JSON file, or restore a previous one.",
    ),
    ("settings.backup.export", "Export JSON"),
    ("settings.backup.restore", "Restore…"),
    ("settings.csv", "CSV export"),
    (
        "settings.csv.description",
        "Write one sheet to a CSV file next to the database.",
    ),
    ("settings.csv.export", "Export CSV"),
    ("settings.csv.subscriptions", "Subscriptions"),
    ("settings.csv.incomes", "Incomes"),
    ("settings.csv.expenses", "Expenses"),
    ("settings.csv.rates", "Exchange rates"),
    ("settings.csv.movements", "Movements report"),
    ("settings.saved", "Saved to {path}"),
    ("settings.restored", "Backup restored from {path}"),
    ("settings.readonly", "Read-only data source"),
    (
        "settings.hint",
        "Backups and CSV exports are written next to the database file, in the backups and exports folders.",
    ),
    // Dialogs
    ("dialog.save", "Save"),
    ("dialog.cancel", "Cancel"),
    ("dialog.restore.action", "Restore"),
    ("dialog.subscription.new", "New subscription"),
    ("dialog.subscription.edit", "Edit subscription"),
    ("dialog.movement.new.income", "New income"),
    ("dialog.movement.new.expense", "New expense"),
    ("dialog.movement.new.charge", "New charge"),
    ("dialog.movement.edit", "Edit movement"),
    ("dialog.account.new", "New account"),
    ("dialog.account.rename", "Rename account"),
    ("dialog.transfer", "New transfer"),
    ("dialog.restore", "Restore backup"),
    ("dialog.field.name", "Name"),
    ("dialog.field.description", "Description"),
    ("dialog.field.amount", "Amount"),
    ("dialog.field.currency", "Currency"),
    ("dialog.field.frequency", "Frequency"),
    ("dialog.field.date", "Date (YYYY-MM-DD)"),
    ("dialog.field.end", "End date (optional)"),
    ("dialog.field.time", "Time (HH:mm, optional)"),
    ("dialog.field.category", "Category (optional)"),
    ("dialog.field.status", "Status"),
    ("dialog.field.notes", "Notes"),
    ("dialog.field.kind", "Type"),
    ("dialog.field.balance", "Balance (optional)"),
    ("dialog.field.from", "From account"),
    ("dialog.field.to", "To account"),
    ("dialog.field.subscription", "Subscription"),
    ("dialog.field.none", "None"),
    ("dialog.field.path", "Backup file (empty = newest)"),
    ("dialog.error.name", "Enter a name."),
    ("dialog.error.amount", "Enter a valid amount."),
    ("dialog.error.date", "Enter a valid date (YYYY-MM-DD)."),
    ("dialog.error.accounts", "Pick two different accounts."),
    ("dialog.error.path", "There is no backup file to restore."),
    // Command errors
    ("error.database", "Could not reach the database: {detail}"),
    ("error.notfound", "Not found: {detail}"),
    ("error.invalid", "The data was refused: {detail}"),
    (
        "error.accountInUse",
        "The account still has movements and cannot be deleted; archive it instead.",
    ),
    ("error.backup", "The backup could not be read: {detail}"),
    (
        "error.newer",
        "The file was written by a newer version: {detail}",
    ),
    (
        "error.io",
        "The file could not be read or written: {detail}",
    ),
    ("error.other", "Something went wrong: {detail}"),
    // Movements
    (
        "movements.subtitle",
        "Income, expenses and real charges of your subscriptions.",
    ),
    ("movements.income.month", "Income this month"),
    ("movements.income.note", "Planned and received"),
    ("movements.expense.month", "Expenses this month"),
    (
        "movements.expense.note.subs",
        "Includes {amount} in subscriptions",
    ),
    ("movements.expense.note.none", "No subscriptions this month"),
    ("movements.net", "Net balance"),
    ("movements.pending.one", "{count} movement to confirm"),
    ("movements.pending.other", "{count} movements to confirm"),
    ("movements.tab.all", "All"),
    ("movements.tab.incomes", "Income"),
    ("movements.tab.expenses", "Expenses"),
    ("movements.search.placeholder", "Search…"),
    ("movements.status.all", "All statuses"),
    ("movements.status.pending", "To confirm"),
    ("movements.status.done", "Confirmed"),
    ("movements.status.paused", "Paused"),
    ("movements.sort.date", "Date (newest)"),
    ("movements.sort.amount", "Largest amount"),
    ("movements.group.month", "By month"),
    ("movements.group.day", "By day"),
    ("movements.empty.title", "No movements yet"),
    (
        "movements.empty.body",
        "Add income, expenses or real charges of your subscriptions. Subscriptions are projected on their own.",
    ),
    ("movements.noresults.title", "No results"),
    (
        "movements.noresults.body",
        "Try other filters or another search.",
    ),
    ("movements.action.income", "Income"),
    ("movements.action.expense", "Expense"),
    ("movements.action.charge", "Charge"),
    (
        "movements.footer",
        "A real charge replaces the estimate of that subscription and is counted once. If the bank splits a charge, record each part; parts of the same day are added together.",
    ),
    ("mov.kind.income", "Income"),
    ("mov.kind.expense", "Expense"),
    ("mov.kind.charge", "Charge"),
    ("mov.status.expected", "Planned"),
    ("mov.status.received", "Received"),
    ("mov.status.planned", "Planned"),
    ("mov.status.pending", "Pending"),
    ("mov.status.done", "Done"),
    ("mov.status.notcharged", "Not charged"),
    ("mov.status.paused", "Paused"),
    ("mov.from", "from {date}"),
    ("mov.count", "{count}"),
    // Projection
    (
        "projection.subtitle",
        "Day-by-day balance with the registered charges, income and expenses.",
    ),
    ("projection.period", "Period"),
    (
        "projection.period.range",
        "From {from} to {to} · {count} days",
    ),
    ("projection.range.30d", "30 days"),
    ("projection.range.90d", "90 days"),
    ("projection.range.6m", "6 months"),
    ("projection.range.1y", "1 year"),
    ("projection.range.2y", "2 years"),
    ("projection.start", "Starting balance"),
    ("projection.start.real", "Real at {date}"),
    ("projection.start.close", "Close of {date}"),
    ("projection.end", "Projected end balance"),
    ("projection.min", "Projected minimum"),
    ("projection.min.never", "Never below the start"),
    ("projection.negative", "First negative day"),
    ("projection.negative.none", "None"),
    ("projection.negative.hint", "Short by {amount}"),
    ("projection.negative.ok", "The balance stays positive"),
    ("projection.chart", "Daily evolution"),
    (
        "projection.chart.hint",
        "Pick a day in the table to inspect it.",
    ),
    ("projection.legend.base", "Projection"),
    ("projection.legend.scenario", "Scenario"),
    ("projection.totals", "Income {income} · Expenses {expense}"),
    (
        "projection.footer.positive",
        "The balance stays positive throughout the period shown.",
    ),
    (
        "projection.footer.negative",
        "The red line marks 0 and the shaded area, the negative balance.",
    ),
    ("projection.day", "Day detail"),
    ("projection.day.balance", "Closing balance"),
    ("projection.day.empty.title", "No movements"),
    (
        "projection.day.empty.body",
        "That day has no projected charges, income or expenses.",
    ),
    ("projection.source.subscription", "Subscription"),
    ("projection.source.income", "Income"),
    ("projection.source.expense", "Expense"),
    ("projection.source.scenario", "Scenario"),
    ("projection.estimated", "estimated"),
    ("projection.real", "real"),
    ("projection.table.date", "Day"),
    ("projection.table.income", "Income"),
    ("projection.table.expense", "Expenses"),
    ("projection.table.balance", "Balance"),
    ("projection.scenario", "Scenario"),
    (
        "projection.scenario.subtitle",
        "Simulate purchases or income without touching your data.",
    ),
    (
        "projection.scenario.hint",
        "What if you spent 350 € on a one-off day?",
    ),
    ("projection.scenario.add", "Add to the scenario"),
    ("projection.scenario.clear", "Clear"),
    ("projection.scenario.stat.end", "End balance"),
    ("projection.scenario.stat.min", "Minimum"),
    (
        "projection.scenario.delta",
        "Difference in the end balance: {final} · minimum: {min}.",
    ),
    (
        "projection.scenario.negative",
        "With the scenario the balance goes negative on {date} (short by {amount}).",
    ),
    ("projection.scenario.form.name", "Name"),
    ("projection.scenario.form.amount", "Amount"),
    ("projection.scenario.form.date", "Date"),
    ("projection.scenario.form.kind", "Type"),
    ("projection.scenario.form.expense", "Expense"),
    ("projection.scenario.form.income", "Income"),
    ("projection.scenario.form.add", "Add movement"),
    (
        "projection.scenario.form.invalid",
        "Enter a valid amount, for example 19.99.",
    ),
    ("projection.scenario.remove", "Remove {name}"),
    ("projection.risk.title", "Overdraft risk on {date}"),
    (
        "projection.risk.body",
        "The projection estimates a balance of {balance}. You would need {amount} more to avoid going negative. It is an estimate based on the current data.",
    ),
    ("projection.risk.see", "See that day"),
    (
        "projection.ok",
        "The projected balance stays positive until {date}.",
    ),
    ("projection.action.simulate", "Simulate a decision"),
    // Calendar
    (
        "calendar.subtitle",
        "Charges, income and expenses by day, with the projected balance.",
    ),
    ("calendar.income", "Income this month"),
    ("calendar.expense", "Expenses this month"),
    ("calendar.subscriptions", "Subscriptions"),
    ("calendar.monthend", "Month-end balance"),
    ("calendar.prev", "Previous month"),
    ("calendar.next", "Next month"),
    ("calendar.today", "Today"),
    ("calendar.count", "{count} movements"),
    ("calendar.legend.income", "Income"),
    ("calendar.legend.expense", "Expense or subscription"),
    (
        "calendar.legend.balance",
        "The small amount is the projected closing balance.",
    ),
    ("calendar.day.empty.title", "Select a day"),
    (
        "calendar.day.empty.body",
        "Check the movements and the projected balance of each date.",
    ),
    ("calendar.day.balance", "Closing balance"),
    ("calendar.day.none.title", "No movements"),
    (
        "calendar.day.none.body",
        "That day has no charges, income or expenses.",
    ),
    (
        "calendar.day.negative",
        "That day the projected balance is negative.",
    ),
    ("calendar.action.expense", "Expense"),
    ("calendar.action.income", "Income"),
    (
        "calendar.footer",
        "Subscription charges are computed from their frequency and end date.",
    ),
    // Analysis
    (
        "analysis.subtitle",
        "Effective spend, equivalent cost and the evolution of your subscriptions.",
    ),
    ("analysis.range.6", "6 months"),
    ("analysis.range.12", "12 months"),
    ("analysis.range.24", "24 months"),
    ("analysis.expense.period", "Spend in the period"),
    ("analysis.movements", "{count} movements"),
    ("analysis.avg", "Monthly average"),
    ("analysis.avg.hint", "Average effective spend"),
    ("analysis.normalized", "Current recurring cost"),
    ("analysis.normalized.year", "{amount} a year"),
    ("analysis.normalized.badge", "Normalized"),
    ("analysis.savings", "Savings from cancellations"),
    (
        "analysis.savings.hint",
        "Finished or cancelled subscriptions",
    ),
    ("analysis.income.period", "Income in the period"),
    ("analysis.net.period", "Net of the period"),
    ("analysis.diff", "Effective vs equivalent difference"),
    ("analysis.diff.hint", "Real spend minus the normalized cost"),
    ("analysis.chart.months", "Income and expenses by month"),
    (
        "analysis.chart.months.subtitle",
        "Effective spend of the month, not the equivalent cost.",
    ),
    ("analysis.legend.income", "Income"),
    ("analysis.legend.expense", "Expenses"),
    ("analysis.legend.net", "Net"),
    ("analysis.chart.empty.title", "No income or expenses"),
    (
        "analysis.chart.empty.body",
        "Add movements to see the monthly evolution.",
    ),
    ("analysis.chart.cost", "Subscription cost"),
    (
        "analysis.chart.cost.subtitle",
        "Charges of the month against the equivalent cost.",
    ),
    (
        "analysis.chart.cost.note",
        "A 120 € annual subscription shows as a spike in its billing month, but adds 10 € to the monthly equivalent.",
    ),
    ("analysis.chart.cost.empty.title", "No subscriptions"),
    (
        "analysis.chart.cost.empty.body",
        "Add a subscription to compare charges and equivalent cost.",
    ),
    ("analysis.categories", "Distribution by category"),
    (
        "analysis.categories.subtitle",
        "Expenses of the selected period.",
    ),
    (
        "analysis.categories.empty.title",
        "No expenses in the period",
    ),
    (
        "analysis.categories.empty.body",
        "Add expenses to see their distribution.",
    ),
    ("analysis.top", "Most expensive subscriptions"),
    ("analysis.top.subtitle", "Current monthly-equivalent cost."),
    ("analysis.top.empty", "No active subscriptions."),
    ("analysis.permonth", "{amount}/mo"),
    ("analysis.effective", "Effective spend vs normalized"),
    (
        "analysis.effective.note",
        "Effective spend is the money that leaves the account each month. The normalized cost spreads annual and quarterly payments into equivalent monthly instalments. Both are correct, but answer different questions.",
    ),
    ("analysis.effective.cash", "Effective ({count} months)"),
    ("analysis.effective.equiv", "Monthly equivalent"),
    ("analysis.confirmed", "Confirmed amounts"),
    ("analysis.estimated", "Estimated amounts"),
    ("analysis.period", "Period: {from} – {to}."),
    // Shared
    ("rel.today", "Today"),
    ("rel.tomorrow", "Tomorrow"),
    ("rel.yesterday", "Yesterday"),
    ("rel.in", "In {count} days"),
    ("rel.ago", "{count} days ago"),
    ("weekday.mon", "Mon"),
    ("weekday.tue", "Tue"),
    ("weekday.wed", "Wed"),
    ("weekday.thu", "Thu"),
    ("weekday.fri", "Fri"),
    ("weekday.sat", "Sat"),
    ("weekday.sun", "Sun"),
];

const ES: &[(&str, &str)] = &[
    ("app.title", "Moxen Finances"),
    ("group.overview", "Resumen"),
    ("group.tracking", "Seguimiento"),
    ("group.system", "Sistema"),
    ("nav.dashboard", "Panel"),
    ("nav.subscriptions", "Suscripciones"),
    ("nav.movements", "Movimientos"),
    ("nav.projection", "Proyección"),
    ("nav.calendar", "Calendario"),
    ("nav.analysis", "Análisis"),
    ("nav.settings", "Ajustes"),
    ("dashboard.balance", "Saldo"),
    ("dashboard.balance.asof", "a {date}"),
    ("dashboard.forecast", "Previsión a fin de mes"),
    ("dashboard.forecast.note", "tras los próximos cobros"),
    ("dashboard.spent", "Gastado este mes"),
    ("dashboard.recurring", "Coste recurrente"),
    ("dashboard.recurring.per", "al mes"),
    ("dashboard.chart", "Evolución del saldo"),
    ("dashboard.chart.range", "Últimos {count} días"),
    ("dashboard.chart.high", "Máximo {amount}"),
    ("dashboard.chart.low", "Mínimo {amount}"),
    ("dashboard.upcoming", "Próximos cobros"),
    ("dashboard.upcoming.count", "{count} programados"),
    ("dashboard.upcoming.empty", "No hay cobros próximos"),
    ("dashboard.upcoming.on", "el {date}"),
    ("dashboard.upcoming.pending", "importe pendiente"),
    (
        "dashboard.incomplete",
        "Una suscripción todavía no tiene precio, así que la previsión está incompleta.",
    ),
    (
        "subscriptions.subtitle",
        "{active} activas · {paused} en pausa",
    ),
    ("subscriptions.empty", "Todavía no hay suscripciones"),
    ("subscriptions.detail", "Detalles"),
    ("sub.status.active", "Activa"),
    ("sub.status.paused", "En pausa"),
    ("sub.status.cancelled", "Cancelada"),
    ("sub.status.finished", "Terminada"),
    ("sub.price", "Precio"),
    ("sub.price.pending", "Pendiente"),
    ("sub.frequency", "Cobro"),
    ("sub.next_charge", "Próximo cobro"),
    ("sub.next.none", "Sin próximo cobro"),
    ("sub.actions", "Acciones"),
    ("sub.action.pause", "Pausar"),
    ("sub.action.resume", "Reanudar"),
    ("sub.action.cancel", "Cancelar suscripción"),
    (
        "sub.action.disabled",
        "Fuente de datos de solo lectura (la demo)",
    ),
    ("sub.action.edit", "Editar"),
    ("sub.action.delete", "Borrar"),
    ("sub.action.reactivate", "Reactivar"),
    ("sub.new", "Nueva suscripción"),
    ("freq.once", "Una vez"),
    ("freq.weekly", "Semanal"),
    ("freq.monthly", "Mensual"),
    ("freq.quarterly", "Trimestral"),
    ("freq.annual", "Anual"),
    ("settings.section.interface", "Interfaz"),
    ("settings.language", "Idioma"),
    ("settings.language.description", "El idioma de la interfaz."),
    ("settings.theme", "Tema"),
    ("settings.theme.description", "La apariencia de la ventana."),
    ("settings.theme.dark", "Oscuro"),
    ("settings.theme.light", "Claro"),
    ("language.en", "English"),
    ("language.es", "Español"),
    // Cuentas (LOCAL-030)
    ("accounts.title", "Cuentas"),
    ("accounts.all", "Todas las cuentas"),
    (
        "accounts.approx",
        "A algunos saldos les falta un tipo de cambio, así que este total es aproximado.",
    ),
    ("accounts.archived", "Archivada"),
    ("accounts.new", "Nueva cuenta"),
    ("accounts.rename", "Renombrar"),
    ("accounts.archive", "Archivar"),
    ("accounts.unarchive", "Desarchivar"),
    ("accounts.delete", "Borrar"),
    ("accounts.transfer", "Traspaso"),
    ("accounts.empty", "Todavía no hay cuentas"),
    ("account.kind.checking", "Corriente"),
    ("account.kind.savings", "Ahorro"),
    ("account.kind.credit-card", "Tarjeta de crédito"),
    ("account.kind.cash", "Efectivo"),
    // Acciones de movimientos
    ("movements.action.confirm", "Confirmar"),
    ("movements.action.edit", "Editar"),
    ("movements.action.delete", "Borrar"),
    ("mov.transfer", "Traspaso"),
    // Ajustes: datos y cuentas
    ("settings.section.data", "Datos"),
    ("settings.section.accounts", "Cuentas"),
    ("settings.db", "Base de datos"),
    (
        "settings.db.description",
        "El archivo SQLite que la aplicación lee y escribe.",
    ),
    (
        "settings.db.none",
        "Datos de demostración (sin base de datos)",
    ),
    ("settings.backup", "Copia de seguridad JSON"),
    (
        "settings.backup.description",
        "Exporta todo a un archivo JSON o restaura una copia anterior.",
    ),
    ("settings.backup.export", "Exportar JSON"),
    ("settings.backup.restore", "Restaurar…"),
    ("settings.csv", "Exportar CSV"),
    (
        "settings.csv.description",
        "Escribe una hoja en un archivo CSV junto a la base de datos.",
    ),
    ("settings.csv.export", "Exportar CSV"),
    ("settings.csv.subscriptions", "Suscripciones"),
    ("settings.csv.incomes", "Ingresos"),
    ("settings.csv.expenses", "Gastos"),
    ("settings.csv.rates", "Tipos de cambio"),
    ("settings.csv.movements", "Informe de movimientos"),
    ("settings.saved", "Guardado en {path}"),
    ("settings.restored", "Copia restaurada desde {path}"),
    ("settings.readonly", "Fuente de datos de solo lectura"),
    (
        "settings.hint",
        "Las copias de seguridad y los CSV se escriben junto al archivo de la base de datos, en las carpetas backups y exports.",
    ),
    // Diálogos
    ("dialog.save", "Guardar"),
    ("dialog.cancel", "Cancelar"),
    ("dialog.restore.action", "Restaurar"),
    ("dialog.subscription.new", "Nueva suscripción"),
    ("dialog.subscription.edit", "Editar suscripción"),
    ("dialog.movement.new.income", "Nuevo ingreso"),
    ("dialog.movement.new.expense", "Nuevo gasto"),
    ("dialog.movement.new.charge", "Nuevo cobro"),
    ("dialog.movement.edit", "Editar movimiento"),
    ("dialog.account.new", "Nueva cuenta"),
    ("dialog.account.rename", "Renombrar cuenta"),
    ("dialog.transfer", "Nuevo traspaso"),
    ("dialog.restore", "Restaurar copia"),
    ("dialog.field.name", "Nombre"),
    ("dialog.field.description", "Descripción"),
    ("dialog.field.amount", "Importe"),
    ("dialog.field.currency", "Moneda"),
    ("dialog.field.frequency", "Frecuencia"),
    ("dialog.field.date", "Fecha (AAAA-MM-DD)"),
    ("dialog.field.end", "Fecha de fin (opcional)"),
    ("dialog.field.time", "Hora (HH:mm, opcional)"),
    ("dialog.field.category", "Categoría (opcional)"),
    ("dialog.field.status", "Estado"),
    ("dialog.field.notes", "Notas"),
    ("dialog.field.kind", "Tipo"),
    ("dialog.field.balance", "Saldo (opcional)"),
    ("dialog.field.from", "Cuenta de origen"),
    ("dialog.field.to", "Cuenta de destino"),
    ("dialog.field.subscription", "Suscripción"),
    ("dialog.field.none", "Ninguna"),
    (
        "dialog.field.path",
        "Archivo de copia (vacío = el más reciente)",
    ),
    ("dialog.error.name", "Escribe un nombre."),
    ("dialog.error.amount", "Escribe un importe válido."),
    (
        "dialog.error.date",
        "Escribe una fecha válida (AAAA-MM-DD).",
    ),
    ("dialog.error.accounts", "Elige dos cuentas distintas."),
    (
        "dialog.error.path",
        "No hay ningún archivo de copia que restaurar.",
    ),
    // Errores de comandos
    (
        "error.database",
        "No se pudo acceder a la base de datos: {detail}",
    ),
    ("error.notfound", "No encontrado: {detail}"),
    ("error.invalid", "Los datos no son válidos: {detail}"),
    (
        "error.accountInUse",
        "La cuenta todavía tiene movimientos y no se puede borrar; archívala.",
    ),
    (
        "error.backup",
        "No se pudo leer la copia de seguridad: {detail}",
    ),
    (
        "error.newer",
        "El archivo es de una versión más nueva: {detail}",
    ),
    (
        "error.io",
        "No se pudo leer o escribir el archivo: {detail}",
    ),
    ("error.other", "Algo falló: {detail}"),
    // Movimientos
    (
        "movements.subtitle",
        "Ingresos, gastos y cargos reales de tus suscripciones.",
    ),
    ("movements.income.month", "Ingresos del mes"),
    ("movements.income.note", "Previstos y recibidos"),
    ("movements.expense.month", "Gastos del mes"),
    (
        "movements.expense.note.subs",
        "Incluye {amount} en suscripciones",
    ),
    ("movements.expense.note.none", "Sin suscripciones este mes"),
    ("movements.net", "Balance neto"),
    ("movements.pending.one", "{count} movimiento sin confirmar"),
    (
        "movements.pending.other",
        "{count} movimientos sin confirmar",
    ),
    ("movements.tab.all", "Todos"),
    ("movements.tab.incomes", "Ingresos"),
    ("movements.tab.expenses", "Gastos"),
    ("movements.search.placeholder", "Buscar…"),
    ("movements.status.all", "Todos los estados"),
    ("movements.status.pending", "Sin confirmar"),
    ("movements.status.done", "Confirmados"),
    ("movements.status.paused", "En pausa"),
    ("movements.sort.date", "Fecha (reciente)"),
    ("movements.sort.amount", "Mayor importe"),
    ("movements.group.month", "Por mes"),
    ("movements.group.day", "Por día"),
    ("movements.empty.title", "Todavía no hay movimientos"),
    (
        "movements.empty.body",
        "Añade ingresos, gastos o cargos reales de tus suscripciones. Las suscripciones se proyectan solas.",
    ),
    ("movements.noresults.title", "Sin resultados"),
    (
        "movements.noresults.body",
        "Prueba con otros filtros u otra búsqueda.",
    ),
    ("movements.action.income", "Ingreso"),
    ("movements.action.expense", "Gasto"),
    ("movements.action.charge", "Cargo"),
    (
        "movements.footer",
        "Un cargo real sustituye a la estimación de esa suscripción y se cuenta una sola vez. Si el banco divide un cobro, registra cada parte; las partes del mismo día se suman.",
    ),
    ("mov.kind.income", "Ingreso"),
    ("mov.kind.expense", "Gasto"),
    ("mov.kind.charge", "Cargo"),
    ("mov.status.expected", "Previsto"),
    ("mov.status.received", "Recibido"),
    ("mov.status.planned", "Previsto"),
    ("mov.status.pending", "Pendiente"),
    ("mov.status.done", "Realizado"),
    ("mov.status.notcharged", "No cobrado"),
    ("mov.status.paused", "En pausa"),
    ("mov.from", "desde {date}"),
    ("mov.count", "{count}"),
    // Proyección
    (
        "projection.subtitle",
        "Saldo día a día con los cobros, ingresos y gastos registrados.",
    ),
    ("projection.period", "Período"),
    (
        "projection.period.range",
        "Del {from} al {to} · {count} días",
    ),
    ("projection.range.30d", "30 días"),
    ("projection.range.90d", "90 días"),
    ("projection.range.6m", "6 meses"),
    ("projection.range.1y", "1 año"),
    ("projection.range.2y", "2 años"),
    ("projection.start", "Saldo de partida"),
    ("projection.start.real", "Real a {date}"),
    ("projection.start.close", "Cierre del {date}"),
    ("projection.end", "Saldo final previsto"),
    ("projection.min", "Mínimo previsto"),
    ("projection.min.never", "Nunca por debajo del inicio"),
    ("projection.negative", "Primer día en negativo"),
    ("projection.negative.none", "Ninguno"),
    ("projection.negative.hint", "Faltan {amount}"),
    ("projection.negative.ok", "El saldo se mantiene positivo"),
    ("projection.chart", "Evolución diaria"),
    (
        "projection.chart.hint",
        "Elige un día en la tabla para inspeccionarlo.",
    ),
    ("projection.legend.base", "Previsión"),
    ("projection.legend.scenario", "Escenario"),
    ("projection.totals", "Ingresos {income} · Gastos {expense}"),
    (
        "projection.footer.positive",
        "El saldo se mantiene positivo durante todo el periodo mostrado.",
    ),
    (
        "projection.footer.negative",
        "La línea roja marca 0 y la zona sombreada, el saldo negativo.",
    ),
    ("projection.day", "Detalle del día"),
    ("projection.day.balance", "Saldo al cierre"),
    ("projection.day.empty.title", "Sin movimientos"),
    (
        "projection.day.empty.body",
        "Ese día no hay cobros, ingresos ni gastos previstos.",
    ),
    ("projection.source.subscription", "Suscripción"),
    ("projection.source.income", "Ingreso"),
    ("projection.source.expense", "Gasto"),
    ("projection.source.scenario", "Escenario"),
    ("projection.estimated", "estimado"),
    ("projection.real", "real"),
    ("projection.table.date", "Día"),
    ("projection.table.income", "Ingresos"),
    ("projection.table.expense", "Gastos"),
    ("projection.table.balance", "Saldo"),
    ("projection.scenario", "Escenario"),
    (
        "projection.scenario.subtitle",
        "Simula compras o ingresos sin tocar tus datos.",
    ),
    (
        "projection.scenario.hint",
        "¿Qué pasa si gastas 350 € en un día puntual?",
    ),
    ("projection.scenario.add", "Añadir al escenario"),
    ("projection.scenario.clear", "Limpiar"),
    ("projection.scenario.stat.end", "Saldo final"),
    ("projection.scenario.stat.min", "Mínimo"),
    (
        "projection.scenario.delta",
        "Diferencia en el saldo final: {final} · mínimo: {min}.",
    ),
    (
        "projection.scenario.negative",
        "Con el escenario el saldo entra en negativo el {date} (faltan {amount}).",
    ),
    ("projection.scenario.form.name", "Nombre"),
    ("projection.scenario.form.amount", "Importe"),
    ("projection.scenario.form.date", "Fecha"),
    ("projection.scenario.form.kind", "Tipo"),
    ("projection.scenario.form.expense", "Gasto"),
    ("projection.scenario.form.income", "Ingreso"),
    ("projection.scenario.form.add", "Añadir movimiento"),
    (
        "projection.scenario.form.invalid",
        "Introduce un importe válido, por ejemplo 19,99.",
    ),
    ("projection.scenario.remove", "Quitar {name}"),
    ("projection.risk.title", "Riesgo de descubierto el {date}"),
    (
        "projection.risk.body",
        "La previsión estima un saldo de {balance}. Necesitarías {amount} más para no entrar en negativo. Es una estimación basada en los datos actuales.",
    ),
    ("projection.risk.see", "Ver ese día"),
    (
        "projection.ok",
        "El saldo previsto se mantiene positivo hasta el {date}.",
    ),
    ("projection.action.simulate", "Simular una decisión"),
    // Calendario
    (
        "calendar.subtitle",
        "Cobros, ingresos y gastos por día, con el saldo proyectado.",
    ),
    ("calendar.income", "Ingresos del mes"),
    ("calendar.expense", "Gastos del mes"),
    ("calendar.subscriptions", "Suscripciones"),
    ("calendar.monthend", "Saldo a fin de mes"),
    ("calendar.prev", "Mes anterior"),
    ("calendar.next", "Mes siguiente"),
    ("calendar.today", "Hoy"),
    ("calendar.count", "{count} movimientos"),
    ("calendar.legend.income", "Ingreso"),
    ("calendar.legend.expense", "Gasto o suscripción"),
    (
        "calendar.legend.balance",
        "El importe pequeño es el saldo proyectado al cierre.",
    ),
    ("calendar.day.empty.title", "Selecciona un día"),
    (
        "calendar.day.empty.body",
        "Consulta los movimientos y el saldo previsto de cada fecha.",
    ),
    ("calendar.day.balance", "Saldo al cierre"),
    ("calendar.day.none.title", "Sin movimientos"),
    (
        "calendar.day.none.body",
        "Ese día no hay cobros, ingresos ni gastos.",
    ),
    (
        "calendar.day.negative",
        "Ese día el saldo proyectado es negativo.",
    ),
    ("calendar.action.expense", "Gasto"),
    ("calendar.action.income", "Ingreso"),
    (
        "calendar.footer",
        "Los cobros de las suscripciones se calculan con su frecuencia y su fecha de fin.",
    ),
    // Análisis
    (
        "analysis.subtitle",
        "Gasto efectivo, coste equivalente y evolución de tus suscripciones.",
    ),
    ("analysis.range.6", "6 meses"),
    ("analysis.range.12", "12 meses"),
    ("analysis.range.24", "24 meses"),
    ("analysis.expense.period", "Gasto del periodo"),
    ("analysis.movements", "{count} movimientos"),
    ("analysis.avg", "Media mensual"),
    ("analysis.avg.hint", "Gasto efectivo medio"),
    ("analysis.normalized", "Coste recurrente actual"),
    ("analysis.normalized.year", "{amount} al año"),
    ("analysis.normalized.badge", "Normalizado"),
    ("analysis.savings", "Ahorro por bajas"),
    (
        "analysis.savings.hint",
        "Suscripciones terminadas o canceladas",
    ),
    ("analysis.income.period", "Ingresos del periodo"),
    ("analysis.net.period", "Balance del periodo"),
    ("analysis.diff", "Diferencia efectivo vs equivalente"),
    (
        "analysis.diff.hint",
        "Desembolso real menos el coste normalizado",
    ),
    ("analysis.chart.months", "Ingresos y gastos por mes"),
    (
        "analysis.chart.months.subtitle",
        "Gasto efectivo del mes, no el coste equivalente.",
    ),
    ("analysis.legend.income", "Ingresos"),
    ("analysis.legend.expense", "Gastos"),
    ("analysis.legend.net", "Neto"),
    ("analysis.chart.empty.title", "Sin ingresos ni gastos"),
    (
        "analysis.chart.empty.body",
        "Añade movimientos para ver la evolución mensual.",
    ),
    ("analysis.chart.cost", "Coste de suscripciones"),
    (
        "analysis.chart.cost.subtitle",
        "Cobros del mes frente al coste equivalente.",
    ),
    (
        "analysis.chart.cost.note",
        "Una suscripción anual de 120 € aparece como un pico en su mes de cobro, pero suma 10 € al equivalente mensual.",
    ),
    ("analysis.chart.cost.empty.title", "Sin suscripciones"),
    (
        "analysis.chart.cost.empty.body",
        "Añade una suscripción para comparar cobros y coste equivalente.",
    ),
    ("analysis.categories", "Distribución por categorías"),
    (
        "analysis.categories.subtitle",
        "Gastos del periodo seleccionado.",
    ),
    (
        "analysis.categories.empty.title",
        "Sin gastos en el periodo",
    ),
    (
        "analysis.categories.empty.body",
        "Añade gastos para ver su distribución.",
    ),
    ("analysis.top", "Suscripciones más caras"),
    ("analysis.top.subtitle", "Coste mensual equivalente actual."),
    ("analysis.top.empty", "Sin suscripciones activas."),
    ("analysis.permonth", "{amount}/mes"),
    ("analysis.effective", "Gasto efectivo frente a normalizado"),
    (
        "analysis.effective.note",
        "El gasto efectivo es el dinero que sale de la cuenta cada mes. El coste normalizado reparte los pagos anuales y trimestrales en cuotas mensuales equivalentes. Ambos son correctos, pero responden a preguntas distintas.",
    ),
    ("analysis.effective.cash", "Efectivo ({count} meses)"),
    ("analysis.effective.equiv", "Equivalente mensual"),
    ("analysis.confirmed", "Importes confirmados"),
    ("analysis.estimated", "Importes estimados"),
    ("analysis.period", "Periodo: {from} – {to}."),
    // Compartido
    ("rel.today", "Hoy"),
    ("rel.tomorrow", "Mañana"),
    ("rel.yesterday", "Ayer"),
    ("rel.in", "En {count} días"),
    ("rel.ago", "Hace {count} días"),
    ("weekday.mon", "Lun"),
    ("weekday.tue", "Mar"),
    ("weekday.wed", "Mié"),
    ("weekday.thu", "Jue"),
    ("weekday.fri", "Vie"),
    ("weekday.sat", "Sáb"),
    ("weekday.sun", "Dom"),
];

static EN_MAP: LazyLock<HashMap<&'static str, &'static str>> =
    LazyLock::new(|| EN.iter().copied().collect());
static ES_MAP: LazyLock<HashMap<&'static str, &'static str>> =
    LazyLock::new(|| ES.iter().copied().collect());

/// One catalog message in the current language, falling back to English and
/// then to the key itself.
pub fn message(key: &'static str) -> &'static str {
    (if spanish() { ES_MAP.get(key) } else { None })
        .or_else(|| EN_MAP.get(key))
        .copied()
        .unwrap_or(key)
}

/// One message with its `{placeholder}`s filled:
/// `fill("dashboard.chart.range", &[("{count}", "83")])`.
pub fn fill(key: &'static str, values: &[(&str, &str)]) -> String {
    let mut text = message(key).to_string();
    for (name, value) in values {
        text = text.replace(name, value);
    }
    text
}

/// A GUI word: buttons, chips and headings start with a capital letter in both
/// languages.
pub fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

pub fn months_long() -> [&'static str; 12] {
    if spanish() {
        [
            "enero",
            "febrero",
            "marzo",
            "abril",
            "mayo",
            "junio",
            "julio",
            "agosto",
            "septiembre",
            "octubre",
            "noviembre",
            "diciembre",
        ]
    } else {
        [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ]
    }
}

pub fn months_short() -> [&'static str; 12] {
    if spanish() {
        [
            "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic",
        ]
    } else {
        [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ]
    }
}

/// Monday first, matching the calendar grid.
pub fn weekdays_short() -> [&'static str; 7] {
    if spanish() {
        ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
    } else {
        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    }
}

/// The `{placeholder}` names a catalog value carries, in order.
#[cfg(test)]
fn placeholders(value: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = value;
    while let Some(start) = rest.find('{') {
        rest = &rest[start + 1..];
        match rest.find('}') {
            Some(end) => {
                out.push(rest[..end].to_string());
                rest = &rest[end + 1..];
            }
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_is_present_in_both_languages() {
        let en: Vec<&str> = EN.iter().map(|(key, _)| *key).collect();
        let es: Vec<&str> = ES.iter().map(|(key, _)| *key).collect();
        let mut missing_in_es: Vec<&str> = en.iter().copied().filter(|k| !es.contains(k)).collect();
        let mut missing_in_en: Vec<&str> = es.iter().copied().filter(|k| !en.contains(k)).collect();
        missing_in_es.sort_unstable();
        missing_in_en.sort_unstable();
        assert_eq!(missing_in_es, Vec::<&str>::new(), "keys missing in Spanish");
        assert_eq!(missing_in_en, Vec::<&str>::new(), "keys missing in English");
        // No duplicate keys in either catalog.
        let mut sorted = en.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), en.len(), "duplicate English keys");
        let mut sorted = es.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), es.len(), "duplicate Spanish keys");
    }

    #[test]
    fn no_value_is_empty_and_placeholders_match_across_languages() {
        for (key, value) in EN {
            assert!(!value.is_empty(), "empty English value: {key}");
            let es_value = ES_MAP[key];
            assert!(!es_value.is_empty(), "empty Spanish value: {key}");
            assert_eq!(
                placeholders(value),
                placeholders(es_value),
                "placeholder mismatch for {key}: {value:?} vs {es_value:?}"
            );
        }
    }

    #[test]
    fn messages_resolve_in_both_languages_and_fall_back_to_english() {
        apply(Some("en"));
        assert_eq!(message("nav.dashboard"), "Dashboard");
        assert_eq!(message("sub.action.pause"), "Pause");
        assert_eq!(
            fill("dashboard.upcoming.count", &[("{count}", "5")]),
            "5 scheduled"
        );
        apply(Some("es-ES"));
        assert_eq!(message("nav.dashboard"), "Panel");
        assert_eq!(message("sub.action.pause"), "Pausar");
        assert_eq!(
            fill("dashboard.upcoming.count", &[("{count}", "5")]),
            "5 programados"
        );
        assert_eq!(
            fill("dashboard.chart.range", &[("{count}", "83")]),
            "Últimos 83 días"
        );
        // A key no catalog knows falls back to itself.
        assert_eq!(message("no.such.key"), "no.such.key");
        apply(Some("en"));
        assert_eq!(message("no.such.key"), "no.such.key");
    }

    #[test]
    fn language_codes_and_setting_resolution() {
        assert_eq!(Language::English.code(), "en");
        assert_eq!(Language::Spanish.code(), "es-ES");
        assert_eq!(Language::from_setting(Some("es-ES")), Language::Spanish);
        assert_eq!(Language::from_setting(Some("es")), Language::Spanish);
        assert_eq!(Language::from_setting(Some("en")), Language::English);
        assert_eq!(Language::from_setting(None), Language::English);
        apply(Some("es-ES"));
        assert!(spanish());
        assert_eq!(Language::Spanish.label(), "Español");
        assert_eq!(Language::English.label(), "English");
        apply(None);
        assert!(!spanish());
    }

    #[test]
    fn capitalized_works_in_both_languages() {
        assert_eq!(capitalized("pause"), "Pause");
        assert_eq!(capitalized("pausar"), "Pausar");
        assert_eq!(capitalized(""), "");
        assert_eq!(capitalized("2 más"), "2 más");
    }

    #[test]
    fn month_names_are_complete_in_both_languages() {
        apply(Some("en"));
        assert_eq!(months_long().len(), 12);
        assert_eq!(months_long()[10], "November");
        assert_eq!(months_short()[10], "Nov");
        apply(Some("es-ES"));
        assert_eq!(months_long().len(), 12);
        assert_eq!(months_long()[10], "noviembre");
        assert_eq!(months_short()[10], "nov");
        assert_eq!(weekdays_short().len(), 7);
        assert_eq!(weekdays_short()[0], "lun");
        assert_eq!(weekdays_short()[6], "dom");
        apply(Some("en"));
        assert_eq!(weekdays_short()[0], "Mon");
        assert_eq!(weekdays_short()[6], "Sun");
        apply(None);
    }
}
