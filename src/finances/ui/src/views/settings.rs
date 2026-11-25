//! Settings: the interface language (English/Spanish) and the theme, both
//! applied live.

use crate::kit;
use crate::language::{Language, message};
use crate::shell::FinancesApp;
use crate::theme::{self, ThemeMode, TypeScale, color};
use gpui::{prelude::*, *};

fn setting_row(label: &str, description: &str, control: Div) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(16.))
        .py(px(12.))
        .border_b_1()
        .border_color(color("rule"))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(17.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(color("ink"))
                        .child(label.to_string()),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .text_color(color("ink-2"))
                        .child(description.to_string()),
                ),
        )
        .child(control)
}

pub fn render(app: &FinancesApp, cx: &mut Context<FinancesApp>) -> impl IntoElement {
    let languages = [
        Language::English.label().into(),
        Language::Spanish.label().into(),
    ];
    let language_selected = match app.language() {
        Language::English => 0,
        Language::Spanish => 1,
    };
    let themes = [
        message("settings.theme.dark").into(),
        message("settings.theme.light").into(),
    ];
    let theme_selected = match app.theme {
        ThemeMode::Dark => 0,
        ThemeMode::Light => 1,
    };
    div()
        .id("settings")
        .debug_selector(|| "settings".into())
        .size_full()
        .overflow_y_scroll()
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(24.))
                .max_w(px(720.))
                .child(
                    div()
                        .type_scale("display")
                        .text_color(color("ink"))
                        .child(message(app.page.nav_key())),
                )
                .child(kit::caps(message("settings.section.interface")))
                .child(
                    div()
                        .bg(color("raised"))
                        .rounded(px(theme::radius("radius-md")))
                        .px(px(16.))
                        .child(setting_row(
                            message("settings.language"),
                            message("settings.language.description"),
                            kit::segmented(
                                "language",
                                &languages,
                                language_selected,
                                cx,
                                |this, i, cx| {
                                    let language = if i == 1 {
                                        Language::Spanish
                                    } else {
                                        Language::English
                                    };
                                    this.set_language(language, cx);
                                },
                            ),
                        ))
                        .child(setting_row(
                            message("settings.theme"),
                            message("settings.theme.description"),
                            kit::segmented("theme", &themes, theme_selected, cx, |this, i, cx| {
                                this.set_theme(
                                    if i == 1 {
                                        ThemeMode::Light
                                    } else {
                                        ThemeMode::Dark
                                    },
                                    cx,
                                );
                            }),
                        )),
                ),
        )
}
