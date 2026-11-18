use std::{borrow::Cow, cell::Cell, collections::HashMap, sync::LazyLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    English,
    Spanish,
}

impl Language {
    fn resolve(setting: Option<&str>, locales: impl IntoIterator<Item = String>) -> Self {
        match setting {
            Some("en") => return Self::English,
            Some("es-ES") => return Self::Spanish,
            _ => {}
        }
        for locale in locales {
            let tag = locale
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if matches!(tag.as_str(), "" | "c" | "posix") {
                continue;
            }
            return if tag == "es" || tag.starts_with("es-") || tag.starts_with("es_") {
                Self::Spanish
            } else {
                Self::English
            };
        }
        Self::English
    }
}

thread_local! { static LANGUAGE: Cell<Language> = const { Cell::new(Language::English) }; }

pub fn apply(setting: Option<&str>, system: Option<String>) {
    LANGUAGE.set(Language::resolve(
        setting,
        ["LC_ALL", "LC_MESSAGES", "LANG"]
            .into_iter()
            .filter_map(|key| std::env::var(key).ok())
            .chain(system),
    ));
}

pub fn spanish() -> bool {
    LANGUAGE.get() == Language::Spanish
}

type Catalog = HashMap<String, String>;

// The TUI catalogs keep one JSON-string pair per line, inside a TS object.
// Reading those pairs keeps this client on the same words without requiring
// Bun or a generated artifact to compile the desktop.
fn catalog(source: &str) -> Catalog {
    let rows = source
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('"'));
    let entries = rows
        .map(|line| line.trim_end_matches(','))
        .collect::<Vec<_>>()
        .join(",");
    serde_json::from_str(&format!("{{{entries}}}")).expect("shared message catalog")
}

static EN: LazyLock<Catalog> = LazyLock::new(|| catalog(include_str!("../../tui/i18n/en.ts")));
static ES: LazyLock<Catalog> = LazyLock::new(|| catalog(include_str!("../../tui/i18n/es.ts")));
static SETTINGS: LazyLock<Catalog> =
    LazyLock::new(|| catalog(include_str!("../../tui/i18n/settings.es.ts")));
static BY_ENGLISH: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut entries = EN.iter().collect::<Vec<_>>();
    entries.sort_unstable_by_key(|(key, _)| *key);
    entries
        .into_iter()
        .filter_map(|(key, english)| Some((english.as_str(), ES.get(key)?.as_str())))
        .collect()
});

pub fn message(key: &'static str) -> &'static str {
    (if spanish() { ES.get(key) } else { None })
        .or_else(|| EN.get(key))
        .map_or(key, String::as_str)
}

/// One TUI message with its `{placeholder}`s filled:
/// `fill("git.staged", &[("{count}", "2")])` reads "2 staged" in English and
/// "2 preparados" in Spanish.
pub fn fill(key: &'static str, values: &[(&str, &str)]) -> String {
    let mut text = message(key).to_string();
    for (name, value) in values {
        text = text.replace(name, value);
    }
    text
}

/// A "3 of 6" count in the TUI's words (`guide.stepCount`): the tasks panel's
/// own done-of-total line.
pub fn step_count(done: usize, total: usize) -> String {
    let (done, total) = (done.to_string(), total.to_string());
    fill(
        "guide.stepCount",
        &[("{n}", done.as_str()), ("{total}", total.as_str())],
    )
}

/// A "3 of 6" count in the TUI's words (`settings.ofTotal`): the title bar's
/// tasks tally.
pub fn of_total(count: usize, total: usize) -> String {
    let (count, total) = (count.to_string(), total.to_string());
    fill(
        "settings.ofTotal",
        &[("{count}", count.as_str()), ("{total}", total.as_str())],
    )
}

/// The Git panel's branches toggle in the TUI's words
/// (`git.showMoreBranches`). The TUI value carries terminal indentation; the
/// desktop supplies its own padding, so it is trimmed.
pub fn show_more_branches(hidden: usize) -> String {
    let hidden = hidden.to_string();
    fill("git.showMoreBranches", &[("{count}", hidden.as_str())])
        .trim_start()
        .to_string()
}

/// The Git panel's collapse toggle in the TUI's words
/// (`git.show_fewer_branches_3aea`): the other half of the branches toggle,
/// so it never reads half-translated.
pub fn show_fewer_branches() -> String {
    message("git.show_fewer_branches_3aea")
        .trim_start()
        .to_string()
}

pub fn tr(text: &str) -> Cow<'_, str> {
    if spanish() {
        // The settings catalog names exact settings strings, so it stays
        // first. The desktop's own words name its own concepts (the thread
        // group "All" is the TUI sidebar's "todos", not the stats range
        // "Todo"), so they win over the reverse-catalog guess, which only
        // covers dynamic strings the desktop did not write itself.
        if let Some(word) = SETTINGS.get(text).map(String::as_str) {
            return Cow::Borrowed(word);
        }
        if let Some(word) = desktop_word(text) {
            return Cow::Borrowed(word);
        }
        if let Some(translated) = BY_ENGLISH.get(text).copied() {
            return Cow::Borrowed(translated);
        }
    }
    Cow::Borrowed(text)
}

/// The desktop's own words: what its fixed labels say in Spanish. Every one
/// is pinned by `doctor_labels_have_spanish_strings` and
/// `desktop_words_win_over_the_reverse_catalog` below.
fn desktop_word(text: &str) -> Option<&'static str> {
    Some(match text {
        "All" => "Todos",
        "Projects" => "Proyectos",
        "This project" => "Este proyecto",
        "Archived" => "Archivados",
        "Jump to thread…" => "Ir a un hilo…",
        "Jump to thread or action" => "Ir a un hilo o acción",
        "New thread in this project" => "Nuevo hilo en este proyecto",
        "Show settled threads" => "Mostrar hilos cerrados",
        "Search threads and actions" => "Buscar hilos y acciones",
        "What should the agent do?" => "¿Qué debe hacer el agente?",
        "Steer the agent…" => "Orienta al agente…",
        "No threads yet" => "Todavía no hay hilos",
        "Working" => "En curso",
        "Done" => "Terminado",
        "Stuck" => "Bloqueado",
        "Your turn" => "Tu turno",
        "Up next" => "En cola",
        "Snoozed" => "Aplazado",
        "Actions" => "Acciones",
        "Background" => "Segundo plano",
        "Inspector" => "Inspector",
        "Queue" => "Poner en cola",
        "Attach" => "Adjuntar",
        "Default model" => "Modelo predeterminado",
        // The Doctor panel rows have no TUI wording (the TUI has no doctor),
        // so these are the desktop's own words.
        "Store" => "Almacén",
        "Authentication" => "Autenticación",
        _ => return None,
    })
}

pub fn desktop(english: &'static str, spanish_text: &'static str) -> &'static str {
    if spanish() { spanish_text } else { english }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_words_win_over_the_reverse_catalog() {
        apply(Some("es-ES"), None);
        // The thread group is the TUI sidebar mode's "todos", not the stats
        // range's "Todo"; the thread status is the desktop's own wording,
        // not the update stage's "Hecho".
        assert_eq!(tr("All"), "Todos");
        assert_eq!(tr("Done"), "Terminado");
        // Agreements with the TUI catalogs keep working through every layer.
        assert_eq!(tr("This project"), "Este proyecto");
        assert_eq!(tr("Background"), "Segundo plano");
        apply(Some("en"), None);
        assert_eq!(tr("All"), "All");
        assert_eq!(tr("Done"), "Done");
    }

    #[test]
    fn doctor_labels_have_spanish_strings() {
        // Every row of the Doctor panel, in panel order; proper names stay
        // as they are, everything else has a Spanish string.
        let labels = [
            "Runtime",
            "Git",
            "Claude Code",
            "OpenCode",
            "Codex",
            "Store",
            "Authentication",
        ];
        apply(Some("es-ES"), None);
        assert_eq!(
            labels.map(|label| tr(label).into_owned()),
            [
                "Motor",
                "Git",
                "Claude Code",
                "OpenCode",
                "Codex",
                "Almacén",
                "Autenticación",
            ]
        );
        apply(Some("en"), None);
        assert_eq!(
            labels.map(|label| tr(label).into_owned()),
            labels.map(str::to_string)
        );
    }

    #[test]
    fn review_strings_resolve_to_the_tuis_spanish() {
        // Every desktop string the MXN-345 review routes through the TUI's
        // own Spanish rather than inventing its own: the chip, the counters,
        // the mode, the branches toggle, the git words, the run header, the
        // background count and the idle badge.
        apply(Some("es-ES"), None);
        assert_eq!(tr("Actions"), "Acciones");
        assert_eq!(step_count(3, 6), "3 de 6");
        assert_eq!(of_total(3, 6), "3 de 6");
        assert_eq!(tr("Build"), "Construcción");
        assert_eq!(show_more_branches(2), "Mostrar 2 más (con las remotas)");
        assert_eq!(show_fewer_branches(), "Mostrar menos ramas");
        assert_eq!(fill("git.staged", &[("{count}", "1")]), "1 preparados");
        assert_eq!(fill("git.changed", &[("{count}", "2")]), "2 cambiados");
        assert_eq!(fill("git.untracked", &[("{count}", "3")]), "3 sin seguir");
        assert_eq!(
            fill("git.conflicted", &[("{count}", "1")]),
            "1 en conflicto"
        );
        assert_eq!(message("git.clean"), "limpio");
        assert_eq!(tr("working"), "trabajando");
        assert_eq!(fill("bg.runningCount", &[("{count}", "2")]), "2 en marcha");
        assert_eq!(message("status.idle"), "inactivo");
        // Desktop-only words with no TUI equivalent stay as they are.
        assert_eq!(tr("Improve draft"), "Improve draft");
        apply(Some("en"), None);
        assert_eq!(step_count(3, 6), "3 of 6");
        assert_eq!(of_total(3, 6), "3 of 6");
        assert_eq!(show_more_branches(2), "Show 2 more (remotes included)");
    }

    #[test]
    fn language_precedence_and_the_shared_spanish_copy() {
        let locales = || ["C.UTF-8".to_owned(), "es_ES.UTF-8".to_owned()];
        assert_eq!(Language::resolve(Some("en"), locales()), Language::English);
        assert_eq!(Language::resolve(None, locales()), Language::Spanish);
        assert_eq!(Language::resolve(Some("es-ES"), []), Language::Spanish);
        apply(Some("es-ES"), None);
        assert_eq!(tr("Theme"), "Tema");
        assert_eq!(message("guide.open"), "Primeros pasos");
        apply(Some("en"), None);
        assert_eq!(message("guide.open"), "Getting started");
    }
}
