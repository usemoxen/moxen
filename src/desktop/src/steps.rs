use crate::ui::{self, Control};
use crate::{
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

/// A step row's height (`.b-row` in the mockup: min-height 32px).
pub const STEP: f32 = 32.;
/// The tallest an opened step's output grows before it scrolls.
const OUTPUT_MAX: f32 = 240.;

pub struct Step {
    pub name: String,
    pub summary: String,
    pub output: String,
    pub id: usize,
    pub index: usize,
    /// How far the row itself has appeared, 0 to 1 (the fold opening).
    pub shown: f32,
    /// How far its output has opened, 0 to 1, or `None` when closed.
    pub open: Option<f32>,
}

pub fn render(step: Step, entity: Entity<Workspace>) -> impl IntoElement {
    let Step {
        name,
        summary,
        output,
        id,
        index,
        shown,
        open,
    } = step;
    let (icon, verb, token, meta) = match name.as_str() {
        "thought" => ("asterisk", "Thought", "ink-2", "6s"),
        "command" => ("dollar-sign", "Ran", "tool-command", "3.4s"),
        "edit" => ("pencil", "Edited", "tool-edit", "+5 −1"),
        _ => ("file", "Read", "tool-read", "551 lines"),
    };
    let thought = name == "thought";
    let meta = if name == "read" {
        output
            .lines()
            .next()
            .unwrap_or(meta)
            .split(" · ")
            .next()
            .unwrap_or(meta)
    } else {
        meta
    };
    let mut highlights = vec![];
    if name == "command" {
        highlights.push((
            0..summary.find(' ').unwrap_or(summary.len()),
            HighlightStyle {
                color: Some(color("syntax-command")),
                ..Default::default()
            },
        ));
        if let Some(start) = summary.find('\'')
            && let Some(end) = summary[start + 1..].find('\'')
        {
            highlights.push((
                start..start + end + 2,
                HighlightStyle {
                    color: Some(color("syntax-string")),
                    ..Default::default()
                },
            ));
        }
    }
    let target = StyledText::new(summary.clone()).with_highlights(highlights);
    let meta = meta.to_string();
    div()
        .flex()
        .flex_col()
        .opacity(shown)
        .child(
            div()
                .id(("step", index))
                .control(summary.clone())
                .h(px(STEP * shown))
                .overflow_hidden()
                // The row's hover fill reaches 8pt past the reading column,
                // so its icon lines up with the prose.
                .mx(px(-8.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(10.))
                .rounded(px(6.))
                .when(open.is_some(), |s| s.bg(color("sunk")))
                .child(
                    div()
                        .w(px(16.))
                        .flex_shrink_0()
                        .flex()
                        .justify_center()
                        .child(ui::icon(icon, token)),
                )
                .child(
                    div()
                        .w(px(58.))
                        .flex_shrink_0()
                        .font_family(theme::FONT)
                        .text_size(px(14.))
                        .text_color(color("ink-2"))
                        .child(verb),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .when(thought, |s| {
                            s.font_family(theme::FONT)
                                .text_size(px(14.))
                                .italic()
                                .text_color(color("ink-2"))
                        })
                        .when(!thought, |s| s.font_family(theme::MONO).text_size(px(13.5)))
                        .child(target),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .font_family(theme::MONO)
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child(meta),
                )
                .on_click(move |_, _, cx| {
                    entity.update(cx, |this, cx| {
                        if this.expanded.remove(&(id, index)).is_none() {
                            this.expanded.insert((id, index), std::time::Instant::now());
                        }
                        this.lists[id].splice(index..index + 1, 1);
                        cx.notify();
                    });
                }),
        )
        .when_some(open, |s, p| {
            s.child(
                div()
                    .id(("step-output", index))
                    .overflow_y_scroll()
                    .max_h(px(OUTPUT_MAX * p))
                    .opacity(p)
                    .ml(px(25.))
                    .mt(px(2. * p))
                    .mb(px(8. * p))
                    .py(px(4.))
                    .pl(px(14.))
                    .border_l_2()
                    .border_color(color("rule"))
                    .text_color(color("ink-2"))
                    .when(thought, |s| {
                        s.font_family(theme::FONT)
                            .text_size(px(14.))
                            .line_height(px(14. * 1.6))
                            .italic()
                    })
                    .when(!thought, |s| {
                        s.font_family(theme::MONO)
                            .text_size(px(13.))
                            .line_height(px(13. * 1.6))
                    })
                    .child(output),
            )
        })
}
