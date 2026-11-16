use crate::ui::{self, Control};
use crate::{
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
pub fn render(
    name: String,
    summary: String,
    output: String,
    id: usize,
    index: usize,
    entity: Entity<Workspace>,
    open: bool,
) -> impl IntoElement {
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
        .child(
            div()
                .id(("step", index))
                .control(summary.clone())
                .h(px(32.))
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(8.))
                .rounded(px(6.))
                .when(open, |s| s.bg(color("sunk")))
                .cursor_pointer()
                .child(ui::icon(icon, token))
                .child(
                    div()
                        .w(px(58.))
                        .text_size(px(14.))
                        .text_color(color("ink-2"))
                        .child(verb),
                )
                .child(
                    div()
                        .flex_1()
                        .truncate()
                        .text_size(px(13.5))
                        .font_family(if thought { theme::FONT } else { theme::MONO })
                        .when(thought, |s| s.italic().text_color(color("ink-2")))
                        .child(target),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .font_family(theme::MONO)
                        .text_color(color("ink-2"))
                        .child(meta),
                )
                .on_click(move |_, _, cx| {
                    entity.update(cx, |this, cx| {
                        if !this.expanded.remove(&(id, index)) {
                            this.expanded.insert((id, index));
                        }
                        this.lists[id].splice(index..index + 1, 1);
                        cx.notify();
                    });
                }),
        )
        .when(open, |s| {
            s.child(
                div()
                    .id(("step-output", index))
                    .overflow_y_scroll()
                    .ml(px(25.))
                    .my(px(4.))
                    .pl(px(14.))
                    .border_l_1()
                    .border_color(color("rule"))
                    .font_family(if thought { theme::FONT } else { theme::MONO })
                    .text_size(px(13.))
                    .text_color(color("ink-2"))
                    .when(thought, |s| s.italic())
                    .child(output)
                    .with_animation(("step-reveal", index), ui::reveal(), |s, v| {
                        s.opacity(v).max_h(px(240. * v))
                    }),
            )
        })
}
