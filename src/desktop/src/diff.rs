use crate::{
    git::DiffLine,
    theme::{self, color},
    ui,
};
use gpui::{prelude::*, *};

/// Mono 12.5 at 1.65, as in the mockup's commit diff.
const LINE: f32 = 12.5 * 1.65;
/// Lines drawn for one file; the rest are counted, not drawn, so a vast
/// patch cannot stall the window.
const SHOWN: usize = 500;

/// One file's hunks: line numbers, sign and text, added lines tinted green and
/// removed ones red.
pub fn render(id: SharedString, lines: &[DiffLine]) -> impl IntoElement {
    let drawn = lines.len().min(SHOWN);
    let hidden = lines.len() - drawn;
    let height = (drawn + usize::from(hidden > 0)) as f32 * LINE + 12.;
    let number = |n: &str| {
        div()
            .w(px(32.))
            .flex_shrink_0()
            .pr(px(8.))
            .text_right()
            .text_color(color("ink-2"))
            .opacity(0.7)
            .child(n.to_string())
    };
    div()
        .id(ElementId::Name(id.clone()))
        .overflow_x_scroll()
        .pt(px(2.))
        .pb(px(10.))
        .font_family(theme::MONO)
        .text_size(px(12.5))
        .line_height(px(LINE))
        .children(lines[..drawn].iter().map(|line| {
            if line.sign == '@' {
                return div()
                    .min_w(px(430.))
                    .pl(px(16.))
                    .pr(px(12.))
                    .bg(color("sunk"))
                    .text_color(color("ink-2"))
                    .child(line.text.clone());
            }
            let token = match line.sign {
                '+' => "added",
                '-' => "broken",
                _ => "ink-2",
            };
            div()
                .flex()
                .min_w(px(430.))
                .pr(px(16.))
                .when(line.sign != ' ', |s| s.bg(color(token).opacity(0.1)))
                .child(number(&line.old))
                .child(number(&line.new))
                .child(
                    div()
                        .w(px(16.))
                        .flex_shrink_0()
                        .text_color(color(token))
                        .child(if line.sign == '-' {
                            "−".to_string()
                        } else {
                            line.sign.to_string()
                        }),
                )
                .child(line.text.clone())
        }))
        .when(hidden > 0, |s| {
            s.child(
                div()
                    .pl(px(16.))
                    .text_color(color("ink-2"))
                    .child(crate::language::fill(
                        "timeline.moreLines",
                        &[("{count}", &hidden.to_string())],
                    )),
            )
        })
        .with_animation(
            ElementId::Name(format!("{id}-reveal").into()),
            ui::expand(),
            move |s, v| s.opacity(v).max_h(px(height * v)),
        )
}
