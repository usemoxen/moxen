use crate::theme::{self, color};
use gpui::{prelude::*, *};
pub fn meter(width: f32, height: f32) -> impl IntoElement {
    div()
        .w(px(width))
        .h(px(height))
        .flex()
        .rounded(px(2.))
        .overflow_hidden()
        .bg(color("sunk"))
        .children(
            [
                ("context-tools", 0.28),
                ("context-system", 0.18),
                ("context-reasoning", 0.12),
                ("context-messages", 0.08),
            ]
            .into_iter()
            .map(move |(token, part)| div().h_full().w(px(width * part)).bg(color(token))),
        )
}
pub fn render() -> impl IntoElement {
    div()
        .p(px(20.))
        .flex()
        .flex_col()
        .gap(px(16.))
        .child(div().font_weight(FontWeight::BOLD).child("Context usage"))
        .child(meter(360., 8.))
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child("663k / 1m · Auto-compact at 80%"),
        )
        .children(
            [
                ("context-tools", "Tool calls", "280k"),
                ("context-system", "System and tools", "180k"),
                ("context-reasoning", "Reasoning", "120k"),
                ("context-messages", "Messages", "83k"),
            ]
            .into_iter()
            .map(|(token, label, value)| {
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .child(div().size(px(6.)).rounded(px(2.)).bg(color(token)))
                    .child(div().flex_1().child(label))
                    .child(
                        div()
                            .font_family(theme::MONO)
                            .text_color(color("ink-2"))
                            .child(value),
                    )
            }),
        )
        .child(
            div()
                .mt(px(8.))
                .font_weight(FontWeight::SEMIBOLD)
                .child("Plan usage"),
        )
        .child(
            div()
                .text_size(px(13.))
                .text_color(color("context-tools"))
                .child("5-hour window · 36% used"),
        )
        .child(
            div()
                .text_size(px(13.))
                .text_color(color("context-system"))
                .child("Weekly window · 43% used"),
        )
}
