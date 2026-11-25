//! The root view: window chrome (title bar), left navigation and the current
//! page, all reading data through [`FinancesData`].

use crate::data::FinancesData;
use crate::language::{self, Language};
use crate::theme::{self, ThemeMode, color};
use crate::{sidebar, title_bar, views};
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

pub struct FinancesApp {
    pub page: Page,
    pub theme: ThemeMode,
    pub data: Rc<dyn FinancesData>,
    /// The selected subscription in the detail pane, if any.
    selected_subscription: Option<String>,
    language_setting: Option<String>,
    on_language: Option<Rc<dyn Fn(Language)>>,
}

impl FinancesApp {
    pub fn new(data: Rc<dyn FinancesData>, language_setting: Option<&str>) -> Self {
        Self {
            page: Page::Dashboard,
            theme: ThemeMode::Dark,
            data,
            selected_subscription: None,
            language_setting: language_setting.map(str::to_string),
            on_language: None,
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
    use crate::demo::DemoData;
    use crate::language::Language;
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
}
