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

/// The title bar's tasks tally: compact in English, in the TUI's words in Spanish.
pub fn of_total(count: usize, total: usize) -> String {
    if !spanish() {
        return format!("{count}/{total}");
    }
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

/// A GUI word: buttons, chips, tabs and headings start with a capital letter
/// in both languages, while the TUI catalog keeps its own casing ("hold",
/// "retener"). Capitalizing the first character is a no-op for strings that
/// already start capital, for counts ("2 en marcha") and for glyph-led
/// strings ("■ stop", "+5 más"), so it is safe at every render edge it wraps.
pub fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

/// One `{count}` thing in the TUI's words: the `.one` key for a single item,
/// `.other` past it (git files, ago units, run summaries).
pub fn plural(one: &'static str, other: &'static str, count: usize) -> String {
    let count = count.to_string();
    fill(
        if count == "1" { one } else { other },
        &[("{count}", count.as_str())],
    )
}

/// An action that opens outside the window: the TUI's word without its
/// terminal `↗` (the desktop buttons show no external-link glyph) and the
/// terminal padding trimmed, capitalized as a GUI button. English is
/// unaffected ("Open"); Spanish reads "Abrir".
pub fn open_label(key: &'static str) -> String {
    let text = message(key).trim_start().trim_end_matches('↗').trim_end();
    capitalized(text)
}

/// The sidebar's age column, rendered raw like the TUI sidebar renders it:
/// the model writes compact tokens (`relative_age`: `0s`, `45s`, `12m`,
/// `3h`, `4d`), and the TUI shows them untranslated in both languages, so
/// the desktop does the same — no translation, no spacing.
pub fn age(raw: &str) -> String {
    raw.to_string()
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
        "Show archived threads" => "Mostrar hilos archivados",
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
        "Updates" => "Actualizaciones",
        "Close" => "Cerrar",
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
        // own Spanish rather than inventing its own: the counters, the mode,
        // the branches toggle, the git words, the run header, the background
        // count and the idle badge. The Actions chip is not one of those: it
        // is a desktop word (`desktop_word`) that happens to match the TUI's
        // wording, and the TUI catalog names no "Actions" string.
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
        apply(Some("en"), None);
        assert_eq!(step_count(3, 6), "3 of 6");
        assert_eq!(of_total(3, 6), "3/6");
        assert_eq!(show_more_branches(2), "Show 2 more (remotes included)");
    }

    #[test]
    fn queue_git_and_age_strings_resolve_to_the_tuis_spanish() {
        // Every desktop string the MXN-345 round-3 review routes through the
        // TUI's own Spanish: the queue row, the PR card, the git panel words
        // and the sidebar ages. Values the code compares against (`track()`'s
        // "in sync") stay English; only the render edge translates.
        use crate::git::{Branch, Request, RequestState, Tone};
        apply(Some("es-ES"), None);
        // The queue row lowercases the queued token and keeps the TUI's chip
        // casing (retener/retirar lowercase, Editar capitalized).
        assert_eq!(message("queued.queued_7b2f").to_lowercase(), "en cola");
        assert_eq!(message("queue.action.hold"), "retener");
        assert_eq!(message("skills.edit"), "Editar");
        assert_eq!(message("queue.action.remove"), "retirar");
        // The PR card states and review outcome.
        assert_eq!(RequestState::Open.label(), "Abierta");
        assert_eq!(RequestState::Draft.label(), "Borrador");
        assert_eq!(RequestState::Merged.label(), "Fusionada");
        assert_eq!(RequestState::Closed.label(), "Cerrada");
        assert_eq!(message("git.review_required_d01e"), "falta revisión");
        let review = |decision: &str| Request {
            number: 1,
            title: "t".into(),
            state: RequestState::Open,
            url: None,
            target: None,
            review: Some(decision.into()),
            checks: None,
        };
        assert_eq!(
            review("REVIEW_REQUIRED").review_label(),
            Some((message("git.review_required_d01e"), Tone::Pending))
        );
        assert_eq!(fill("git.into", &[("{branch}", "main")]), " · a main");
        // The git panel words.
        assert_eq!(
            fill("git.otherOpen", &[("{what}", "PR")]),
            "Otros PR abiertos"
        );
        assert_eq!(message("git.branches_dfc7"), "Ramas");
        assert_eq!(message("git.in_sync_1199"), "sincronizado");
        assert_eq!(
            message("git.checks_some_failing_590a").trim_start(),
            "comprobaciones, alguna falla"
        );
        assert_eq!(message("forge.commentField"), "Comentario");
        assert_eq!(message("git.refresh_fc78").trim_start(), "Actualizar");
        assert_eq!(fill("git.localCount", &[("{count}", "5")]), "5 locales");
        assert_eq!(
            fill("git.showMoreCommits", &[("{count}", "5")]).trim_start(),
            "Mostrar 5 más"
        );
        assert_eq!(
            message("git.open_the_failing_run_733c").trim_start(),
            "abrir la ejecución que falla ↗"
        );
        // The compared-against value stays English; only the render edge
        // translates it through the key above.
        assert_eq!(
            Branch {
                name: "main".into(),
                current: true,
                remote: false,
                ahead: Some(0),
                behind: Some(0),
            }
            .track(),
            "in sync"
        );
        // The sidebar ages render raw like the TUI sidebar does: compact
        // tokens (`relativeAge`) in both languages, never translated.
        assert_eq!(age("0s"), "0s");
        assert_eq!(age("45s"), "45s");
        assert_eq!(age("5m"), "5m");
        assert_eq!(age("2h"), "2h");
        assert_eq!(age("3d"), "3d");
        apply(Some("en"), None);
        assert_eq!(RequestState::Open.label(), "Open");
        assert_eq!(
            review("REVIEW_REQUIRED").review_label().unwrap().0,
            "review required"
        );
        assert_eq!(fill("git.into", &[("{branch}", "main")]), " · into main");
        assert_eq!(fill("git.otherOpen", &[("{what}", "PR")]), "Other open PRs");
        assert_eq!(fill("git.localCount", &[("{count}", "5")]), "5 local");
        assert_eq!(
            fill("git.showMoreCommits", &[("{count}", "5")]).trim_start(),
            "Show 5 more"
        );
        assert_eq!(message("git.refresh_fc78").trim_start(), "Refresh");
        assert_eq!(
            message("git.open_the_failing_run_733c").trim_start(),
            "open the failing run ↗"
        );
        // English keeps the sidebar's compact tokens, as the TUI does.
        assert_eq!(age("0s"), "0s");
        assert_eq!(age("5m"), "5m");
        assert_eq!(age("2h"), "2h");
    }

    #[test]
    fn spanish_sweep_routes_settings_live_and_chrome() {
        // The settings, live-notice and chrome strings the MXN-345 Spanish
        // sweep routes through the TUI's own wording.
        apply(Some("es-ES"), None);
        assert_eq!(message("continue.start"), "Continuar");
        assert_eq!(message("continue.cancel"), "Cancelar");
        assert_eq!(message("settings.inForce"), "Lo que vale ahora");
        assert_eq!(message("mem.empty"), "Aún no hay memorias.");
        assert_eq!(message("guide.saving"), "Guardando…");
        assert_eq!(message("guide.back"), "Atrás");
        assert_eq!(
            message("remote.turn_remote_access_off_bbaa"),
            "Desactivar el acceso remoto"
        );
        assert_eq!(
            message("remote.turn_remote_access_on_7134"),
            "Activar el acceso remoto"
        );
        // Work and git chrome added after the round-3 review.
        assert_eq!(message("subagent.word"), "subagente");
        assert_eq!(message("bgm.prompt_45d7"), "Prompt");
        assert_eq!(message("timeline.plan"), "Plan");
        assert_eq!(message("task.running"), "en marcha");
        assert_eq!(message("run.phase.finished"), "Terminada");
        assert_eq!(message("bgm.monitors_8c22"), "Monitors");
        assert_eq!(
            message("bgm.nothing_running_in_the_f068"),
            "No hay nada corriendo en segundo plano."
        );
        assert_eq!(
            capitalized(message("bgm.no_output_yet_b7d2")),
            "Todavía no hay salida"
        );
        assert_eq!(message("git.show_fewer_faab").trim_start(), "Mostrar menos");
        assert_eq!(
            fill("git.runsMore", &[("{count}", "3")]).trim_start(),
            "+3 más"
        );
        assert_eq!(message("side.plan_usage_48f7"), "Uso del plan");
        assert_eq!(
            message("app.no_matching_models_74d5"),
            "Ningún modelo coincide."
        );
        assert_eq!(message("forge.titleField"), "Título");
        assert_eq!(message("timeline.thinking"), "Pensando…");
        assert_eq!(message("git.detachedWord"), "HEAD suelto");
        assert_eq!(message("git.no_remote_b921"), "sin remoto");
        // Desktop chrome with no TUI key keeps the desktop's own words.
        assert_eq!(tr("Remote access"), "Acceso remoto");
        assert_eq!(tr("Updates"), "Actualizaciones");
        assert_eq!(tr("Close"), "Cerrar");
        assert_eq!(tr("Show archived threads"), "Mostrar hilos archivados");
        assert_eq!(tr("New thread"), "Hilo nuevo");
        assert_eq!(tr("Providers"), "Proveedores");
        assert_eq!(tr("Output"), "Salida");
        assert_eq!(tr("Save"), "Guardar");
        assert_eq!(tr("Full access"), "Acceso total");
        assert_eq!(tr("Auto"), "Automático");
        assert_eq!(tr("Tasks"), "Tareas");
        assert_eq!(tr("Turns"), "Turnos");
        assert_eq!(tr("Checks"), "Comprobaciones");
        assert_eq!(tr("Files"), "Archivos");
        assert_eq!(tr("Settled"), "Cerrados");
        assert_eq!(tr("Background"), "Segundo plano");
        assert_eq!(tr("Project"), "Proyecto");
        apply(Some("en"), None);
        assert_eq!(message("continue.start"), "Continue");
        assert_eq!(message("settings.inForce"), "In force");
        assert_eq!(tr("Updates"), "Updates");
        assert_eq!(tr("Close"), "Close");
        assert_eq!(tr("Show archived threads"), "Show archived threads");
        assert_eq!(tr("Remote access"), "Remote access");
        assert_eq!(message("bgm.no_output_yet_b7d2"), "no output yet");
    }

    #[test]
    fn gui_words_capitalize_in_both_languages() {
        // Buttons, chips and badges start capital on the desktop; the TUI
        // catalog keeps terminal casing, so the render edge capitalizes it.
        // `open_label` also drops the TUI's terminal `↗`.
        apply(Some("es-ES"), None);
        assert_eq!(capitalized(message("queue.action.hold")), "Retener");
        assert_eq!(open_label("git.open_7d26"), "Abrir");
        assert_eq!(plural("git.files.one", "git.files.other", 1), "1 archivo");
        assert_eq!(plural("git.files.one", "git.files.other", 2), "2 archivos");
        assert_eq!(capitalized(message("picker.defaultBadge")), "Por defecto");
        assert_eq!(capitalized(message("run.state.working")), "Trabajando");
        apply(Some("en"), None);
        assert_eq!(capitalized(message("queue.action.hold")), "Hold");
        assert_eq!(open_label("git.open_7d26"), "Open");
        assert_eq!(plural("git.files.one", "git.files.other", 2), "2 files");
        assert_eq!(capitalized(message("picker.defaultBadge")), "Default");
        assert_eq!(capitalized(message("run.state.working")), "Working");
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
