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
    (
        "sub.action.disabled",
        "Available once the store is connected",
    ),
    ("freq.once", "Once"),
    ("freq.weekly", "Weekly"),
    ("freq.monthly", "Monthly"),
    ("freq.quarterly", "Quarterly"),
    ("freq.annual", "Annual"),
    ("placeholder.body", "This page is under construction."),
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
        "Disponible cuando el almacén esté conectado",
    ),
    ("freq.once", "Una vez"),
    ("freq.weekly", "Semanal"),
    ("freq.monthly", "Mensual"),
    ("freq.quarterly", "Trimestral"),
    ("freq.annual", "Anual"),
    ("placeholder.body", "Esta página está en construcción."),
    ("settings.section.interface", "Interfaz"),
    ("settings.language", "Idioma"),
    ("settings.language.description", "El idioma de la interfaz."),
    ("settings.theme", "Tema"),
    ("settings.theme.description", "La apariencia de la ventana."),
    ("settings.theme.dark", "Oscuro"),
    ("settings.theme.light", "Claro"),
    ("language.en", "English"),
    ("language.es", "Español"),
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
        apply(None);
    }
}
