use crate::{
    theme::{self, color},
    ui,
};
use gpui::{prelude::*, *};
pub fn render(id: usize) -> impl IntoElement {
    let lines = [
        ("26", "26", " ", "fn open_picker(&mut self) {"),
        ("27", "", "-", "    self.picker_open = true;"),
        ("", "27", "+", "    self.open_picker(window, cx);"),
        ("", "28", "+", "    self.search.focus(window, cx);"),
        ("28", "29", " ", "}"),
    ];
    div()
        .id(("diff-scroll", id))
        .overflow_x_scroll()
        .bg(color("raised"))
        .border_y_1()
        .border_color(color("rule"))
        .font_family(theme::MONO)
        .text_size(px(12.))
        .line_height(px(24.))
        .child(
            div()
                .px(px(12.))
                .text_color(color("ink-2"))
                .child("@@ -26,3 +26,4 @@"),
        )
        .children(lines.into_iter().map(|(old, new, sign, text)| {
            let token = match sign {
                "+" => "added",
                "-" => "broken",
                _ => "ink-2",
            };
            let mut highlights = vec![];
            for keyword in ["fn", "self", "true"] {
                for (start, _) in text.match_indices(keyword) {
                    highlights.push((
                        start..start + keyword.len(),
                        HighlightStyle {
                            color: Some(color("syntax-command")),
                            ..Default::default()
                        },
                    ));
                }
            }
            highlights.sort_by_key(|(r, _)| r.start);
            div()
                .flex()
                .gap(px(8.))
                .px(px(8.))
                .min_w(px(430.))
                .when(sign != " ", |s| s.bg(color(token).opacity(0.07)))
                .child(
                    div()
                        .w(px(24.))
                        .text_right()
                        .text_color(color("ink-2"))
                        .child(old),
                )
                .child(
                    div()
                        .w(px(24.))
                        .text_right()
                        .text_color(color("ink-2"))
                        .child(new),
                )
                .child(div().w(px(10.)).text_color(color(token)).child(sign))
                .child(StyledText::new(text).with_highlights(highlights))
        }))
        .with_animation(("diff-reveal", id), ui::reveal(), |s, v| {
            s.opacity(v).max_h(px(144. * v))
        })
}
