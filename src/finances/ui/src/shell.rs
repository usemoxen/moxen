//! The root view: window chrome (title bar), left navigation (with the
//! account selector) and the current page, all reading data through
//! [`FinancesData`] and writing through [`FinancesMutations`] when the data
//! source offers it (the store does; the demo does not).

use crate::commands::{CsvSheet, DataError, FinancesMutations, SubscriptionAction};
use crate::data::{AccountSelection, FinancesData, MovementKind};
use crate::dialog::{self, Dialog, FormState};
use crate::kit;
use crate::language::{self, Language};
use crate::model::{self, EventKind, GroupBy, KindFilter, SortOrder, StatusFilter};
use crate::theme::{self, ThemeMode, color};
use crate::{format, sidebar, title_bar, views};
use chrono::{Datelike, Duration, NaiveDate};
use gpui::{prelude::*, *};
use std::path::PathBuf;
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Dashboard,
    Subscriptions,
    Movements,
    Projection,
    Calendar,
    Analysis,
    Settings,
}

impl Page {
    pub const ALL: [Page; 7] = [
        Page::Dashboard,
        Page::Subscriptions,
        Page::Movements,
        Page::Projection,
        Page::Calendar,
        Page::Analysis,
        Page::Settings,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Page::Dashboard => "dashboard",
            Page::Subscriptions => "subscriptions",
            Page::Movements => "movements",
            Page::Projection => "projection",
            Page::Calendar => "calendar",
            Page::Analysis => "analysis",
            Page::Settings => "settings",
        }
    }

    pub fn from_id(id: &str) -> Option<Page> {
        Self::ALL.iter().copied().find(|page| page.id() == id)
    }

    pub fn nav_key(self) -> &'static str {
        match self {
            Page::Dashboard => "nav.dashboard",
            Page::Subscriptions => "nav.subscriptions",
            Page::Movements => "nav.movements",
            Page::Projection => "nav.projection",
            Page::Calendar => "nav.calendar",
            Page::Analysis => "nav.analysis",
            Page::Settings => "nav.settings",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Page::Dashboard => "nav-dashboard",
            Page::Subscriptions => "nav-subscriptions",
            Page::Movements => "nav-movements",
            Page::Projection => "nav-projection",
            Page::Calendar => "nav-calendar",
            Page::Analysis => "nav-analysis",
            Page::Settings => "nav-settings",
        }
    }
}

/// The projection page's interval choices, from 30 days to 2 years.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectionRange {
    D30,
    D90,
    M6,
    Y1,
    Y2,
}

impl ProjectionRange {
    pub const ALL: [ProjectionRange; 5] = [
        ProjectionRange::D30,
        ProjectionRange::D90,
        ProjectionRange::M6,
        ProjectionRange::Y1,
        ProjectionRange::Y2,
    ];

    pub fn label_key(self) -> &'static str {
        match self {
            ProjectionRange::D30 => "projection.range.30d",
            ProjectionRange::D90 => "projection.range.90d",
            ProjectionRange::M6 => "projection.range.6m",
            ProjectionRange::Y1 => "projection.range.1y",
            ProjectionRange::Y2 => "projection.range.2y",
        }
    }

    /// The `[from, to]` window, starting today.
    pub fn bounds(self, today: NaiveDate) -> (NaiveDate, NaiveDate) {
        let to = match self {
            ProjectionRange::D30 => today + Duration::days(30),
            ProjectionRange::D90 => today + Duration::days(90),
            ProjectionRange::M6 => model::add_months(today, 6),
            ProjectionRange::Y1 => model::add_months(today, 12),
            ProjectionRange::Y2 => model::add_months(today, 24),
        };
        (today, to)
    }
}

/// One scenario event on the projection page: local UI state, never real
/// data.
#[derive(Clone, Debug)]
pub struct ScenarioEvent {
    pub id: u64,
    pub name: String,
    pub date: NaiveDate,
    pub amount: i64,
    pub kind: EventKind,
}

/// The Movements page's filter state.
#[derive(Clone, Debug, Default)]
pub struct MovementsState {
    pub filter: model::MovementFilter,
}

/// The Projection page's state.
#[derive(Clone, Debug)]
pub struct ProjectionState {
    pub range: ProjectionRange,
    pub selected: Option<NaiveDate>,
    pub scenario: Vec<ScenarioEvent>,
    pub draft_name: String,
    pub draft_amount: String,
    pub draft_date: NaiveDate,
    pub draft_kind: EventKind,
    pub next_id: u64,
    /// Set when the last draft amount did not parse.
    pub draft_invalid: bool,
}

/// The Calendar page's state.
#[derive(Clone, Debug)]
pub struct CalendarState {
    pub year: i32,
    pub month: u32,
    pub selected: Option<NaiveDate>,
}

/// The Analysis page's state.
#[derive(Clone, Copy, Debug)]
pub struct AnalysisState {
    pub months: usize,
}

pub struct FinancesApp {
    pub page: Page,
    pub theme: ThemeMode,
    pub data: Rc<dyn FinancesData>,
    /// The write side of the boundary, when the data source has one: the
    /// store-backed `StoreData` does, the demo does not (its actions stay
    /// disabled).
    pub mutations: Option<Rc<dyn FinancesMutations>>,
    /// The account the pages are currently looking at.
    pub account: AccountSelection,
    /// The last failed command's message, shown in a banner until dismissed.
    pub error: Option<String>,
    /// A transient info line (e.g. where a file was written), until dismissed.
    pub notice: Option<String>,
    /// The open form dialog, if any.
    pub dialog: Option<Dialog>,
    /// The open dialog's fields.
    pub form: FormState,
    /// The CSV sheet the Settings page exports.
    pub csv_sheet: usize,
    /// The selected subscription in the detail pane, if any.
    selected_subscription: Option<String>,
    language_setting: Option<String>,
    on_language: Option<Rc<dyn Fn(Language)>>,
    pub movements: MovementsState,
    pub projection: ProjectionState,
    pub calendar: CalendarState,
    pub analysis: AnalysisState,
}

impl FinancesApp {
    pub fn new(
        data: Rc<dyn FinancesData>,
        language_setting: Option<&str>,
        mutations: Option<Rc<dyn FinancesMutations>>,
    ) -> Self {
        let today = data.today();
        Self {
            page: Page::Dashboard,
            theme: ThemeMode::Dark,
            data,
            mutations,
            account: AccountSelection::All,
            error: None,
            notice: None,
            dialog: None,
            form: FormState::default(),
            csv_sheet: 4, // the movements report
            selected_subscription: None,
            language_setting: language_setting.map(str::to_string),
            on_language: None,
            movements: MovementsState::default(),
            projection: ProjectionState {
                range: ProjectionRange::D90,
                selected: None,
                scenario: Vec::new(),
                draft_name: String::new(),
                draft_amount: String::new(),
                draft_date: today,
                draft_kind: EventKind::Expense,
                next_id: 1,
                draft_invalid: false,
            },
            calendar: CalendarState {
                year: today.year(),
                month: today.month(),
                selected: Some(today),
            },
            analysis: AnalysisState { months: 12 },
        }
    }

    // -- the write side (LOCAL-030) -------------------------------------------

    /// Whether the data source accepts commands right now.
    pub fn can_mutate(&self) -> bool {
        self.mutations.is_some()
    }

    /// Runs one command against the data source. On success the data is
    /// refreshed and the views repaint immediately; on failure the error is
    /// localized and shown in the banner. Never panics.
    pub fn run_mutation(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&dyn FinancesMutations) -> Result<(), DataError>,
    ) -> bool {
        let Some(mutations) = self.mutations.clone() else {
            return false;
        };
        let result = f(mutations.as_ref()).and_then(|()| mutations.refresh());
        match result {
            Ok(()) => {
                self.error = None;
                cx.notify();
                true
            }
            Err(error) => {
                self.error = Some(error.localized());
                cx.notify();
                false
            }
        }
    }

    /// Switches the account every page looks at, live.
    pub fn select_account(&mut self, selection: AccountSelection, cx: &mut Context<Self>) {
        self.account = selection.clone();
        if let Some(mutations) = self.mutations.clone() {
            let result = mutations
                .select_account(selection)
                .and_then(|()| mutations.refresh());
            if let Err(error) = result {
                self.error = Some(error.localized());
            }
        }
        cx.notify();
    }

    /// Sets the banner from outside (e.g. the database failing to open at
    /// startup, when the app fell back to the demo data).
    pub fn set_error(&mut self, message: String, cx: &mut Context<Self>) {
        self.error = Some(message);
        cx.notify();
    }

    pub fn dismiss_feedback(&mut self, cx: &mut Context<Self>) {
        self.error = None;
        self.notice = None;
        cx.notify();
    }

    pub fn subscription_action(
        &mut self,
        id: &str,
        action: SubscriptionAction,
        cx: &mut Context<Self>,
    ) {
        let id = id.to_string();
        self.run_mutation(cx, move |m| m.apply_subscription_action(&id, action));
    }

    pub fn confirm_movement(&mut self, id: &str, kind: MovementKind, cx: &mut Context<Self>) {
        let id = id.to_string();
        self.run_mutation(cx, move |m| m.confirm_movement(&id, kind));
    }

    pub fn delete_movement(&mut self, id: &str, kind: MovementKind, cx: &mut Context<Self>) {
        let id = id.to_string();
        self.run_mutation(cx, move |m| m.delete_movement(&id, kind));
    }

    /// The folder the JSON backups go to: `<db folder>/backups`.
    fn backups_dir(&self) -> Option<PathBuf> {
        let parent = PathBuf::from(self.data.database_path()?)
            .parent()?
            .to_path_buf();
        Some(parent.join("backups"))
    }

    /// The folder the CSV exports go to: `<db folder>/exports`.
    fn exports_dir(&self) -> Option<PathBuf> {
        let parent = PathBuf::from(self.data.database_path()?)
            .parent()?
            .to_path_buf();
        Some(parent.join("exports"))
    }

    /// A fresh file name in `dir` for `stem` and `ext`, dated today.
    fn fresh_path(&self, dir: &std::path::Path, stem: &str, ext: &str) -> PathBuf {
        let today = format::iso_date(self.data.today());
        let mut path = dir.join(format!("{stem}-{today}.{ext}"));
        let mut n = 2;
        while path.exists() {
            path = dir.join(format!("{stem}-{today}-{n}.{ext}"));
            n += 1;
        }
        path
    }

    /// Exports the JSON backup next to the database and says where it went.
    pub fn export_backup(&mut self, cx: &mut Context<Self>) {
        let (Some(dir), Some(mutations)) = (self.backups_dir(), self.mutations.clone()) else {
            return;
        };
        match mutations.export_backup_json() {
            Ok(json) => {
                let path = self.fresh_path(&dir, "finances-backup", "json");
                match std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, json)) {
                    Ok(()) => {
                        self.notice = Some(language::fill(
                            "settings.saved",
                            &[("{path}", &path.display().to_string())],
                        ));
                    }
                    Err(source) => {
                        self.error = Some(
                            DataError::new(crate::commands::DataErrorKind::Io, source.to_string())
                                .localized(),
                        );
                    }
                }
            }
            Err(error) => self.error = Some(error.localized()),
        }
        cx.notify();
    }

    /// Restores the JSON backup at `path` (the newest one in the backups
    /// folder when `path` is empty).
    pub fn restore_backup(&mut self, path: &str, cx: &mut Context<Self>) {
        if self.mutations.is_none() {
            return;
        }
        let path = path.trim();
        let resolved = if path.is_empty() {
            self.newest_backup()
        } else {
            Some(PathBuf::from(path))
        };
        let Some(path) = resolved else {
            self.error = Some(
                DataError::new(
                    crate::commands::DataErrorKind::Io,
                    language::message("dialog.error.path"),
                )
                .localized(),
            );
            cx.notify();
            return;
        };
        let text = std::fs::read_to_string(&path).map_err(|source| {
            DataError::new(
                crate::commands::DataErrorKind::Io,
                format!("{}: {source}", path.display()),
            )
        });
        let ok = match text {
            Ok(text) => self.run_mutation(cx, move |m| m.restore_backup_json(&text)),
            Err(error) => {
                self.error = Some(error.localized());
                cx.notify();
                false
            }
        };
        if ok {
            self.notice = Some(language::fill(
                "settings.restored",
                &[("{path}", &path.display().to_string())],
            ));
        }
    }

    /// The newest `*.json` in the backups folder, if any.
    fn newest_backup(&self) -> Option<PathBuf> {
        let dir = self.backups_dir()?;
        std::fs::read_dir(dir)
            .ok()?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .max()
    }

    /// Exports the chosen CSV sheet next to the database.
    pub fn export_csv(&mut self, cx: &mut Context<Self>) {
        let (Some(dir), Some(mutations)) = (self.exports_dir(), self.mutations.clone()) else {
            return;
        };
        let sheet = CsvSheet::ALL[self.csv_sheet.min(CsvSheet::ALL.len() - 1)];
        match mutations.export_csv(sheet) {
            Ok(csv) => {
                let path = self.fresh_path(&dir, sheet.name(), "csv");
                match std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, csv)) {
                    Ok(()) => {
                        self.notice = Some(language::fill(
                            "settings.saved",
                            &[("{path}", &path.display().to_string())],
                        ));
                    }
                    Err(source) => {
                        self.error = Some(
                            DataError::new(crate::commands::DataErrorKind::Io, source.to_string())
                                .localized(),
                        );
                    }
                }
            }
            Err(error) => self.error = Some(error.localized()),
        }
        cx.notify();
    }

    /// Called when the user picks a language, so the app can persist it.
    pub fn on_language_change(mut self, f: impl Fn(Language) + 'static) -> Self {
        self.on_language = Some(Rc::new(f));
        self
    }

    pub fn language(&self) -> Language {
        Language::from_setting(self.language_setting.as_deref())
    }

    pub fn set_page(&mut self, page: Page, cx: &mut Context<Self>) {
        self.page = page;
        cx.notify();
    }

    /// Applies the language live: the next frame renders in it.
    pub fn set_language(&mut self, language: Language, cx: &mut Context<Self>) {
        self.language_setting = Some(language.code().to_string());
        language::apply(Some(language.code()));
        if let Some(persist) = &self.on_language {
            persist(language);
        }
        cx.notify();
    }

    pub fn set_theme(&mut self, mode: ThemeMode, cx: &mut Context<Self>) {
        self.theme = mode;
        theme::apply(mode);
        cx.notify();
    }

    pub fn select_subscription(&mut self, id: &str, cx: &mut Context<Self>) {
        self.selected_subscription = Some(id.to_string());
        cx.notify();
    }

    pub fn selected_subscription(&self) -> Option<&str> {
        self.selected_subscription.as_deref()
    }

    // -- Movements page -------------------------------------------------------

    pub fn set_movements_kind(&mut self, kind: KindFilter, cx: &mut Context<Self>) {
        self.movements.filter.kind = kind;
        cx.notify();
    }

    pub fn set_movements_status(&mut self, status: StatusFilter, cx: &mut Context<Self>) {
        self.movements.filter.status = status;
        cx.notify();
    }

    pub fn set_movements_query(&mut self, query: String, cx: &mut Context<Self>) {
        self.movements.filter.query = query;
        cx.notify();
    }

    pub fn set_movements_sort(&mut self, sort: SortOrder, cx: &mut Context<Self>) {
        self.movements.filter.sort = sort;
        cx.notify();
    }

    pub fn set_movements_group_by(&mut self, group_by: GroupBy, cx: &mut Context<Self>) {
        self.movements.filter.group_by = group_by;
        cx.notify();
    }

    // -- Projection page ------------------------------------------------------

    pub fn set_projection_range(&mut self, range: ProjectionRange, cx: &mut Context<Self>) {
        self.projection.range = range;
        self.projection.selected = None;
        cx.notify();
    }

    pub fn select_projection_day(&mut self, day: Option<NaiveDate>, cx: &mut Context<Self>) {
        self.projection.selected = day;
        cx.notify();
    }

    pub fn set_scenario_draft_name(&mut self, name: String, cx: &mut Context<Self>) {
        self.projection.draft_name = name;
        cx.notify();
    }

    pub fn set_scenario_draft_amount(&mut self, amount: String, cx: &mut Context<Self>) {
        self.projection.draft_amount = amount;
        self.projection.draft_invalid = false;
        cx.notify();
    }

    pub fn set_scenario_draft_kind(&mut self, kind: EventKind, cx: &mut Context<Self>) {
        self.projection.draft_kind = kind;
        cx.notify();
    }

    pub fn step_scenario_draft_date(&mut self, days: i64, cx: &mut Context<Self>) {
        self.projection.draft_date += Duration::days(days);
        cx.notify();
    }

    /// Adds the draft as a scenario event. Returns false (and flags the
    /// draft) when the amount does not parse. Never touches real data.
    pub fn add_scenario_event(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(amount) = model::parse_amount_minor(&self.projection.draft_amount) else {
            self.projection.draft_invalid = true;
            cx.notify();
            return false;
        };
        let name = if self.projection.draft_name.trim().is_empty() {
            format!(
                "{} {}",
                language::message("projection.scenario"),
                self.projection.next_id
            )
        } else {
            self.projection.draft_name.trim().to_string()
        };
        let event = ScenarioEvent {
            id: self.projection.next_id,
            name,
            date: self.projection.draft_date,
            amount,
            kind: self.projection.draft_kind,
        };
        self.projection.next_id += 1;
        self.projection.scenario.push(event);
        self.projection.draft_name = String::new();
        self.projection.draft_amount = String::new();
        self.projection.draft_invalid = false;
        cx.notify();
        true
    }

    pub fn remove_scenario_event(&mut self, id: u64, cx: &mut Context<Self>) {
        self.projection.scenario.retain(|e| e.id != id);
        cx.notify();
    }

    pub fn clear_scenario(&mut self, cx: &mut Context<Self>) {
        self.projection.scenario.clear();
        cx.notify();
    }

    // -- Calendar page --------------------------------------------------------

    pub fn step_calendar_month(&mut self, delta: i32, cx: &mut Context<Self>) {
        let cursor = model::add_months(
            NaiveDate::from_ymd_opt(self.calendar.year, self.calendar.month, 1)
                .expect("calendar month"),
            delta,
        );
        self.calendar.year = cursor.year();
        self.calendar.month = cursor.month();
        self.calendar.selected = None;
        cx.notify();
    }

    pub fn go_calendar_today(&mut self, cx: &mut Context<Self>) {
        let today = self.data.today();
        self.calendar.year = today.year();
        self.calendar.month = today.month();
        self.calendar.selected = Some(today);
        cx.notify();
    }

    pub fn select_calendar_day(&mut self, day: Option<NaiveDate>, cx: &mut Context<Self>) {
        self.calendar.selected = day;
        cx.notify();
    }

    // -- Analysis page --------------------------------------------------------

    pub fn set_analysis_months(&mut self, months: usize, cx: &mut Context<Self>) {
        self.analysis.months = months;
        cx.notify();
    }
}

impl Render for FinancesApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        theme::apply(self.theme);
        language::apply(self.language_setting.as_deref());
        let feedback = if let Some(error) = &self.error {
            Some(feedback_bar("alert", "held", error.clone(), cx))
        } else {
            self.notice
                .as_ref()
                .map(|notice| feedback_bar("action-check", "added", notice.clone(), cx))
        };
        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(color("ground"))
            .font_family(theme::FONT)
            .text_color(color("ink"))
            .child(title_bar::render(self, cx))
            .when_some(feedback, |s, bar| s.child(bar))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .child(sidebar::render(self, cx))
                    .child(views::render(self, window, cx)),
            )
            .when_some(self.dialog.clone(), |s, dialog| {
                s.child(dialog::render(self, dialog, window, cx))
            })
    }
}

/// The banner a failed command or a saved file leaves at the top of the
/// window, until dismissed.
fn feedback_bar(
    icon_name: &'static str,
    token: &'static str,
    text: String,
    cx: &mut Context<FinancesApp>,
) -> Stateful<Div> {
    div()
        .id("feedback")
        .debug_selector(|| "feedback".into())
        .flex_shrink_0()
        .px(px(16.))
        .py(px(8.))
        .flex()
        .items_center()
        .gap(px(8.))
        .border_b_1()
        .border_color(color("rule"))
        .bg(color("sunk"))
        .child(kit::icon(icon_name, token, 14.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.5))
                .line_height(px(16.))
                .text_color(color("ink"))
                .child(text),
        )
        .child(
            div()
                .id("feedback-dismiss")
                .size(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(theme::radius("radius-sm")))
                .cursor_pointer()
                .text_color(color("ink-2"))
                .hover(|s| s.bg(color("rule")))
                .child(kit::icon("action-x", "ink-2", 11.))
                .on_click(cx.listener(|this, _, _, cx| this.dismiss_feedback(cx))),
        )
}

#[cfg(all(test, feature = "render-harness"))]
mod tests {
    // Not a glob of `super`: with `test-support`, `gpui::test` would shadow
    // the built-in `#[test]` the macro emits.
    use super::{FinancesApp, Page};
    use crate::commands::{
        AccountDraft, CsvSheet, DataError, DataErrorKind, FinancesMutations, MovementDraft,
        SubscriptionAction, SubscriptionDraft, TransferDraft,
    };
    use crate::data::{
        AccountSelection, BalancePoint, Currency, FinancesData, Money, MonthSummary, Movement,
        MovementKind, Subscription, UpcomingCharge,
    };
    use crate::demo::DemoData;
    use crate::language::Language;
    use chrono::NaiveDate;
    use gpui::{Entity, TestAppContext, VisualTestContext};
    use std::cell::RefCell;
    use std::rc::Rc;

    fn app<'a>(
        cx: &'a mut TestAppContext,
        language: Option<&str>,
    ) -> (Entity<FinancesApp>, &'a mut VisualTestContext) {
        cx.add_window_view(|_window, _cx| {
            FinancesApp::new(Rc::new(DemoData::new()), language, None)
        })
    }

    /// Draws a frame, so `debug_bounds` sees the rendered elements.
    fn draw(cx: &mut VisualTestContext) {
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }

    #[gpui::test]
    fn the_shell_renders_the_dashboard_and_switches_page_and_language(cx: &mut TestAppContext) {
        let (app, cx) = app(cx, Some("en"));
        cx.run_until_parked();
        draw(cx);
        #[cfg(debug_assertions)]
        {
            assert!(cx.debug_bounds("nav").is_some());
            assert!(cx.debug_bounds("dashboard").is_some());
            assert!(cx.debug_bounds("content").is_some());
            // The account selector is part of the sidebar.
            assert!(cx.debug_bounds("account-selector").is_some());
        }
        cx.update(|_, cx| {
            app.update(cx, |app, cx| {
                app.set_page(Page::Subscriptions, cx);
            });
        });
        cx.run_until_parked();
        draw(cx);
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("subscriptions").is_some());
        cx.update(|_, cx| {
            app.update(cx, |app, cx| {
                app.set_language(Language::Spanish, cx);
            });
        });
        cx.run_until_parked();
        cx.update(|_, cx| assert_eq!(app.read(cx).language(), Language::Spanish));
        cx.update(|_, cx| {
            app.update(cx, |app, cx| {
                app.set_page(Page::Settings, cx);
            });
        });
        cx.run_until_parked();
        draw(cx);
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("settings").is_some());
    }

    #[gpui::test]
    fn every_page_renders_in_both_languages(cx: &mut TestAppContext) {
        let (app, cx) = app(cx, Some("en"));
        cx.run_until_parked();
        for page in Page::ALL {
            cx.update(|_, cx| {
                app.update(cx, |app, cx| app.set_page(page, cx));
            });
            cx.run_until_parked();
            draw(cx);
            #[cfg(debug_assertions)]
            assert!(
                cx.debug_bounds(page.id()).is_some(),
                "page {} did not render",
                page.id()
            );
            cx.update(|_, cx| {
                app.update(cx, |app, cx| app.set_language(Language::Spanish, cx));
            });
            cx.run_until_parked();
            draw(cx);
            #[cfg(debug_assertions)]
            assert!(
                cx.debug_bounds(page.id()).is_some(),
                "page {} did not render in Spanish",
                page.id()
            );
            cx.update(|_, cx| {
                app.update(cx, |app, cx| app.set_language(Language::English, cx));
            });
        }
    }

    /// A data source that is not ready: the pages show their loading state.
    struct NotReady(DemoData);

    impl FinancesData for NotReady {
        fn today(&self) -> NaiveDate {
            self.0.today()
        }
        fn balance(&self) -> Money {
            self.0.balance()
        }
        fn balance_date(&self) -> NaiveDate {
            self.0.balance_date()
        }
        fn month_end_forecast(&self) -> Money {
            self.0.month_end_forecast()
        }
        fn month_summary(&self) -> MonthSummary {
            self.0.month_summary()
        }
        fn upcoming_charges(&self) -> Rc<[UpcomingCharge]> {
            self.0.upcoming_charges()
        }
        fn subscriptions(&self) -> Rc<[Subscription]> {
            self.0.subscriptions()
        }
        fn balance_history(&self) -> Rc<[BalancePoint]> {
            self.0.balance_history()
        }
        fn exchange_rate(&self, from: Currency, to: Currency) -> f64 {
            self.0.exchange_rate(from, to)
        }
        fn movements(&self) -> Rc<[Movement]> {
            self.0.movements()
        }
        fn is_ready(&self) -> bool {
            false
        }
    }

    #[gpui::test]
    fn pages_show_a_loading_state_until_the_data_is_ready(cx: &mut TestAppContext) {
        let (app, cx) = cx.add_window_view(|_window, _cx| {
            FinancesApp::new(Rc::new(NotReady(DemoData::new())), Some("en"), None)
        });
        cx.run_until_parked();
        for page in [
            Page::Movements,
            Page::Projection,
            Page::Calendar,
            Page::Analysis,
        ] {
            cx.update(|_, cx| {
                app.update(cx, |app, cx| app.set_page(page, cx));
            });
            cx.run_until_parked();
            draw(cx);
            // The loading scaffold carries the page's own id.
            #[cfg(debug_assertions)]
            assert!(
                cx.debug_bounds(page.id()).is_some(),
                "page {} did not render its loading state",
                page.id()
            );
        }
    }

    // -- mutations behind the trait (LOCAL-030) --------------------------------

    /// A mutations stub that records what the shell asked for and can be told
    /// to fail, so the shell's success/error paths are both exercised.
    struct StubMutations {
        calls: RefCell<Vec<String>>,
        fail: bool,
    }

    impl StubMutations {
        fn recording(fail: bool) -> Rc<Self> {
            Rc::new(Self {
                calls: RefCell::new(Vec::new()),
                fail,
            })
        }

        fn record(&self, call: String) -> Result<(), DataError> {
            self.calls.borrow_mut().push(call);
            if self.fail {
                Err(DataError::new(DataErrorKind::Database, "stub failure"))
            } else {
                Ok(())
            }
        }
    }

    impl FinancesMutations for StubMutations {
        fn refresh(&self) -> Result<(), DataError> {
            self.record("refresh".into())
        }
        fn select_account(&self, selection: AccountSelection) -> Result<(), DataError> {
            self.record(format!("select_account:{selection:?}"))
        }
        fn create_account(&self, _draft: &AccountDraft) -> Result<(), DataError> {
            self.record("create_account".into())
        }
        fn rename_account(&self, id: &str, _name: &str) -> Result<(), DataError> {
            self.record(format!("rename_account:{id}"))
        }
        fn set_account_archived(&self, id: &str, archived: bool) -> Result<(), DataError> {
            self.record(format!("archive:{id}:{archived}"))
        }
        fn delete_account(&self, id: &str) -> Result<(), DataError> {
            self.record(format!("delete_account:{id}"))
        }
        fn create_transfer(&self, _draft: &TransferDraft) -> Result<(), DataError> {
            self.record("create_transfer".into())
        }
        fn create_subscription(&self, _draft: &SubscriptionDraft) -> Result<(), DataError> {
            self.record("create_subscription".into())
        }
        fn update_subscription(
            &self,
            id: &str,
            _draft: &SubscriptionDraft,
        ) -> Result<(), DataError> {
            self.record(format!("update_subscription:{id}"))
        }
        fn apply_subscription_action(
            &self,
            id: &str,
            action: SubscriptionAction,
        ) -> Result<(), DataError> {
            self.record(format!("sub_action:{id}:{action:?}"))
        }
        fn create_movement(&self, _draft: &MovementDraft) -> Result<(), DataError> {
            self.record("create_movement".into())
        }
        fn update_movement(&self, _draft: &MovementDraft) -> Result<(), DataError> {
            self.record("update_movement".into())
        }
        fn confirm_movement(&self, id: &str, kind: MovementKind) -> Result<(), DataError> {
            self.record(format!("confirm:{id}:{kind:?}"))
        }
        fn delete_movement(&self, id: &str, kind: MovementKind) -> Result<(), DataError> {
            self.record(format!("delete_movement:{id}:{kind:?}"))
        }
        fn export_backup_json(&self) -> Result<String, DataError> {
            self.record("export_backup".into())?;
            Ok("{}".to_string())
        }
        fn restore_backup_json(&self, _json: &str) -> Result<(), DataError> {
            self.record("restore_backup".into())
        }
        fn export_csv(&self, sheet: CsvSheet) -> Result<String, DataError> {
            self.record(format!("export_csv:{sheet:?}"))?;
            Ok("id\n".to_string())
        }
    }

    #[gpui::test]
    fn a_successful_mutation_runs_and_refreshes_without_error(cx: &mut TestAppContext) {
        let stub = StubMutations::recording(false);
        let (app, cx) = cx.add_window_view(|_window, _cx| {
            FinancesApp::new(Rc::new(DemoData::new()), Some("en"), Some(stub.clone()))
        });
        cx.run_until_parked();
        cx.update(|_, cx| {
            app.update(cx, |app, cx| {
                app.subscription_action("sub-1", SubscriptionAction::Pause, cx);
            });
        });
        cx.run_until_parked();
        let calls = stub.calls.borrow().clone();
        assert_eq!(
            calls,
            vec!["sub_action:sub-1:Pause".to_string(), "refresh".to_string()]
        );
        cx.update(|_, cx| {
            assert!(app.read(cx).error.is_none());
            // Account switching goes through the same path.
            app.update(cx, |app, cx| {
                app.select_account(AccountSelection::One("demo-account".into()), cx)
            });
        });
        cx.run_until_parked();
        assert!(
            stub.calls
                .borrow()
                .iter()
                .any(|c| c.starts_with("select_account"))
        );
        cx.update(|_, cx| {
            assert_eq!(
                app.read(cx).account,
                AccountSelection::One("demo-account".into())
            )
        });
    }

    #[gpui::test]
    fn a_failed_mutation_surfaces_a_localized_error_and_does_not_panic(cx: &mut TestAppContext) {
        let stub = StubMutations::recording(true);
        let (app, cx) = cx.add_window_view(|_window, _cx| {
            FinancesApp::new(Rc::new(DemoData::new()), Some("en"), Some(stub.clone()))
        });
        cx.run_until_parked();
        cx.update(|_, cx| {
            app.update(cx, |app, cx| {
                app.delete_movement("m-1", MovementKind::Expense, cx);
            });
        });
        cx.run_until_parked();
        // The error banner rendered and holds the localized message.
        draw(cx);
        cx.update(|_, cx| {
            let app = app.read(cx);
            assert_eq!(
                app.error.as_deref(),
                Some("Could not reach the database: stub failure")
            );
        });
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("feedback").is_some());
        // Dismissing clears it; the app keeps rendering.
        cx.update(|_, cx| {
            app.update(cx, |app, cx| app.dismiss_feedback(cx));
        });
        cx.run_until_parked();
        draw(cx);
        cx.update(|_, cx| assert!(app.read(cx).error.is_none()));
    }

    #[gpui::test]
    fn without_mutations_the_actions_stay_disabled(cx: &mut TestAppContext) {
        let (app, cx) = app(cx, Some("en"));
        cx.run_until_parked();
        cx.update(|_, cx| {
            app.update(cx, |app, cx| app.set_page(Page::Subscriptions, cx));
        });
        cx.run_until_parked();
        draw(cx);
        cx.update(|_, cx| assert!(!app.read(cx).can_mutate()));
        // run_mutation is a no-op that reports failure, never a panic.
        cx.update(|_, cx| {
            app.update(cx, |app, cx| {
                let ran = app.run_mutation(cx, |_| Ok(()));
                assert!(!ran);
            });
        });
        cx.run_until_parked();
    }
}
