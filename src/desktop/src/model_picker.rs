use crate::theme::TypeScale;
use crate::ui::{self, Control};
use crate::{
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
pub const MODELS: [(&str, &str); 7] = [
    ("Fable 5.1", "1m"),
    ("Opus 5.5", "1m"),
    ("Sonnet 5.5", "1m"),
    ("Haiku 4.5", "200k"),
    ("Space Bunny Free", "1m"),
    ("Big Pickle", "200k"),
    ("Grok Code Fast 1", "256k"),
];
pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let mut pane = div()
        .absolute()
        .bottom(px(200.))
        .left(px(26.))
        .w(px(334.))
        .p(px(6.))
        .rounded(px(12.))
        .bg(color("raised"))
        .border_1()
        .border_color(color("rule"))
        .shadow(theme::float_shadow())
        .text_size(px(14.))
        .line_height(px(20.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(8.))
                .py(px(6.))
                .text_color(color("ink-2"))
                .child(ui::icon("search", "ink-2"))
                .child(div().flex_1().child(w.search.clone())),
        );
    let query = w.search.read(cx).text().to_lowercase();
    let mut provider = None;
    for (i, (name, context)) in MODELS.iter().enumerate() {
        if !name.to_lowercase().contains(&query) {
            continue;
        }
        if provider != Some(i < 4) {
            provider = Some(i < 4);
            pane = pane.child(
                div()
                    .px(px(8.))
                    .pt(px(8.))
                    .pb(px(4.))
                    .font_family(theme::MONO)
                    .text_size(px(11.))
                    .text_color(color(if i < 4 {
                        "provider-claude"
                    } else {
                        "provider-opencode"
                    }))
                    .child(if i < 4 { "CLAUDE CODE" } else { "OPENCODE" }),
            );
        }
        pane = pane.child(
            div()
                .id(("model", i))
                .control(format!("Select {name}"))
                .h(px(32.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(6.))
                .when(w.model == i, |s| s.bg(color("sunk")))
                .cursor_pointer()
                .child(div().flex_1().child(*name))
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .text_color(color("ink-2"))
                        .child(*context),
                )
                .child(
                    div()
                        .w(px(14.))
                        .when(w.model == i, |s| s.child(ui::icon("check", "ink"))),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.model = i;
                    this.picker_open = false;
                    window.focus(&this.model_focus, cx);
                    cx.notify();
                })),
        );
    }
    pane.child(
        div()
            .mt(px(6.))
            .pt(px(10.))
            .border_t_1()
            .border_color(color("rule"))
            .flex()
            .items_center()
            .gap(px(8.))
            .child(div().text_color(color("ink-2")).child("Effort"))
            .child(
                div().flex().bg(color("sunk")).rounded(px(8.)).children(
                    ["Low", "Medium", "High", "Extra", "Max"]
                        .into_iter()
                        .enumerate()
                        .map(|(i, label)| {
                            div()
                                .id(("effort", i))
                                .control(format!("{label} effort"))
                                .px(px(8.))
                                .py(px(4.))
                                .rounded(px(6.))
                                .type_scale("label")
                                .when(w.effort == i, |s| s.bg(color("ground")))
                                .cursor_pointer()
                                .child(label)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.effort = i;
                                    cx.notify();
                                }))
                        }),
                ),
            ),
    )
    .with_animation("picker-reveal", ui::reveal(), |s, v| {
        s.opacity(v).w(px(328. + 6. * v)).bottom(px(194. + 6. * v))
    })
}
