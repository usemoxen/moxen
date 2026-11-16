use crate::{
    theme::{self, color},
    ui,
};
use gpui::{prelude::*, *};

/// Mono 12.5 at 1.65, as in the mockup's commit diff.
const LINE: f32 = 12.5 * 1.65;

pub fn render(id: usize, lines: Vec<crate::model::DiffLine>) -> impl IntoElement {
    let height = (lines.len() + 1) as f32 * LINE + 12.;
    let hunk = lines.first().map_or(String::new(), |first| {
        let start = |n: &str| {
            if n.is_empty() {
                "0".to_string()
            } else {
                n.to_string()
            }
        };
        format!("@@ -{} +{} @@", start(first.old), start(first.new))
    });
    div()
        .id(("diff-scroll", id))
        .overflow_x_scroll()
        .pt(px(2.))
        .pb(px(10.))
        .font_family(theme::MONO)
        .text_size(px(12.5))
        .line_height(px(LINE))
        .child(
            div()
                .pl(px(16.))
                .pr(px(12.))
                .bg(color("sunk"))
                .text_color(color("ink-2"))
                .child(hunk),
        )
        .children(lines.into_iter().map(
            |crate::model::DiffLine {
                 old,
                 new,
                 sign,
                 text,
             }| {
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
                let number = |n: &'static str| {
                    div()
                        .w(px(32.))
                        .flex_shrink_0()
                        .pr(px(8.))
                        .text_right()
                        .text_color(color("ink-2"))
                        .opacity(0.7)
                        .child(n)
                };
                div()
                    .flex()
                    .min_w(px(430.))
                    .pr(px(16.))
                    .when(sign != " ", |s| s.bg(color(token).opacity(0.1)))
                    .child(number(old))
                    .child(number(new))
                    .child(
                        div()
                            .w(px(16.))
                            .flex_shrink_0()
                            .text_color(color(token))
                            .child(if sign == "-" { "−" } else { sign }),
                    )
                    .child(StyledText::new(text).with_highlights(highlights))
            },
        ))
        .with_animation(("diff-reveal", id), ui::expand(), move |s, v| {
            s.opacity(v).max_h(px(height * v))
        })
}
