use crate::theme::{self, color};
use crate::ui;
use gpui::{prelude::*, *};

const PARTS: [(&str, &str, &str, f32); 4] = [
    ("context-tools", "Tool calls", "280k", 0.28),
    ("context-system", "System and tools", "180k", 0.18),
    ("context-reasoning", "Reasoning", "120k", 0.12),
    ("context-messages", "Messages", "83k", 0.08),
];

pub fn meter(width: f32, height: f32) -> impl IntoElement {
    div()
        .w(px(width))
        .h(px(height))
        .flex_shrink_0()
        .flex()
        .rounded(px(height / 2.))
        .overflow_hidden()
        .bg(color("sunk"))
        .children(
            PARTS.into_iter().map(move |(token, _, _, part)| {
                div().h_full().w(px(width * part)).bg(color(token))
            }),
        )
}

fn mono(text: &'static str) -> Div {
    div()
        .font_family(theme::MONO)
        .text_size(px(12.))
        .text_color(color("ink-2"))
        .child(text)
}

pub fn render() -> impl IntoElement {
    div()
        .p(px(16.))
        .flex()
        .flex_col()
        .gap(px(24.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .flex()
                        .items_baseline()
                        .gap(px(10.))
                        .child(
                            div()
                                .text_size(px(15.))
                                .font_weight(FontWeight::BOLD)
                                .child("663k / 1m"),
                        )
                        .child(mono("66% of the window")),
                )
                .child(
                    div()
                        .h(px(10.))
                        .rounded(px(5.))
                        .overflow_hidden()
                        .bg(color("sunk"))
                        .flex()
                        .children(PARTS.into_iter().map(|(token, _, _, part)| {
                            div()
                                .h_full()
                                .w(relative(part))
                                .border_r_2()
                                .border_color(color("ground"))
                                .bg(color(token))
                        })),
                )
                .child(mono("Auto-compacts at 80%")),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(ui::caps("By category").pb(px(2.)))
                .children(PARTS.into_iter().map(|(token, label, value, _)| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .text_size(px(13.))
                        .child(div().size(px(8.)).rounded(px(2.)).bg(color(token)))
                        .child(
                            div()
                                .flex_1()
                                .child(crate::language::tr(label).into_owned()),
                        )
                        .child(mono(value))
                })),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(ui::caps(crate::language::message("side.plan_usage_48f7")))
                .children(
                    [("5-hour", 0.36, "36%"), ("Weekly", 0.43, "43%")]
                        .into_iter()
                        .map(|(name, used, label)| {
                            div()
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .font_family(theme::MONO)
                                .text_size(px(12.))
                                .child(
                                    div()
                                        .w(px(64.))
                                        .child(crate::language::tr(name).into_owned()),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .h(px(6.))
                                        .rounded(px(3.))
                                        .bg(color("sunk"))
                                        .child(
                                            div()
                                                .h_full()
                                                .w(relative(used))
                                                .rounded(px(3.))
                                                .bg(color("context-tools")),
                                        ),
                                )
                                .child(div().text_color(color("ink")).child(label))
                        }),
                ),
        )
}
