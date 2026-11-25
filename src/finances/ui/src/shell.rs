//! The root view: window chrome (title bar), left navigation and the current
//! page, all reading data through [`FinancesData`].

use crate::data::FinancesData;
use crate::language::{self, Language};
use crate::model::{self, EventKind, GroupBy, KindFilter, SortOrder, StatusFilter};
use crate::theme::{self, ThemeMode, color};
use crate::{sidebar, title_bar, views};
use chrono::{Datelike, Duration, NaiveDate};
use gpui::{prelude::*, *};
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
    pub fn new(data: Rc<dyn FinancesData>, language_setting: Option<&str>) -> Self {
        let today = data.today();
        Self {
            page: Page::Dashboard,
            theme: ThemeMode::Dark,
            data,
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
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(color("ground"))
            .font_family(theme::FONT)
            .text_color(color("ink"))
            .child(title_bar::render(self, cx))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .child(sidebar::render(self, cx))
                    .child(views::render(self, window, cx)),
            )
    }
}

#[cfg(all(test, feature = "render-harness"))]
mod tests {
    // Not a glob of `super`: with `test-support`, `gpui::test` would shadow
    // the built-in `#[test]` the macro emits.
    use super::{FinancesApp, Page};
    use crate::data::{
        BalancePoint, Currency, FinancesData, Money, MonthSummary, Movement, Subscription,
        UpcomingCharge,
    };
    use crate::demo::DemoData;
    use crate::language::Language;
    use chrono::NaiveDate;
    use gpui::{Entity, TestAppContext, VisualTestContext};
    use std::rc::Rc;

    fn app<'a>(
        cx: &'a mut TestAppContext,
        language: Option<&str>,
    ) -> (Entity<FinancesApp>, &'a mut VisualTestContext) {
        cx.add_window_view(|_window, _cx| FinancesApp::new(Rc::new(DemoData::new()), language))
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
        fn upcoming_charges(&self) -> &[UpcomingCharge] {
            self.0.upcoming_charges()
        }
        fn subscriptions(&self) -> &[Subscription] {
            self.0.subscriptions()
        }
        fn balance_history(&self) -> &[BalancePoint] {
            self.0.balance_history()
        }
        fn exchange_rate(&self, from: Currency, to: Currency) -> f64 {
            self.0.exchange_rate(from, to)
        }
        fn movements(&self) -> &[Movement] {
            self.0.movements()
        }
        fn is_ready(&self) -> bool {
            false
        }
    }

    #[gpui::test]
    fn pages_show_a_loading_state_until_the_data_is_ready(cx: &mut TestAppContext) {
        let (app, cx) = cx.add_window_view(|_window, _cx| {
            FinancesApp::new(Rc::new(NotReady(DemoData::new())), Some("en"))
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
}
