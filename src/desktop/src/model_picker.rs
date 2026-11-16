use crate::ui::{self, Control};
use crate::{
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
actions!(model_picker, [TogglePicker]);
pub const MODELS: [(&str, &str); 7] = [
    ("Fable 5.1", "1m"),
    ("Opus 5.5", "1m"),
    ("Sonnet 5.5", "1m"),
    ("Haiku 4.5", "200k"),
    ("Space Bunny Free", "1m"),
    ("Big Pickle", "200k"),
    ("Grok Code Fast 1", "256k"),
];
pub const EFFORTS: [&str; 5] = ["Low", "Medium", "High", "Extra", "Max"];
/// The mockup's 320 lets the effort control overhang the popover's edge;
/// 344, with tighter options, holds all five inside it.
const WIDTH: f32 = 344.;

pub fn render(w: &Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    // Fades in and grows from 96% over 120ms, anchored at its bottom left.
    let p = ui::progress(w.picker_at, 120, window);
    let scale = 0.96 + 0.04 * p;
    let mut pane = div()
        .id("model-picker")
        .occlude()
        // Anchored 8pt above the composer box, which is its parent.
        .absolute()
        .bottom(relative(1.))
        .mb(px(8. - 4. * (1. - p)))
        .left(px(-2.))
        .w(px(WIDTH * scale))
        .opacity(p)
        .p(px(6.))
        .rounded(px(12.))
        .bg(color("raised"))
        .shadow(theme::float_shadow())
        .text_size(px(14.))
        .line_height(px(18.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(8.))
                .pt(px(6.))
                .pb(px(8.))
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
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(8.))
                    .pt(px(8.))
                    .pb(px(4.))
                    .child(div().size(px(6.)).rounded(px(2.)).bg(color(if i < 4 {
                        "provider-claude"
                    } else {
                        "provider-opencode"
                    })))
                    .child(ui::caps(if i < 4 { "Claude Code" } else { "OpenCode" })),
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
    pane.child(div().h(px(1.)).mx(px(2.)).my(px(6.)).bg(color("rule")))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .pl(px(8.))
                .pr(px(6.))
                .py(px(4.))
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(color("ink-2"))
                        .child("Effort"),
                )
                .child(div().flex_1())
                .child(ui::segmented(
                    "effort",
                    &EFFORTS,
                    w.effort,
                    8.,
                    cx,
                    |this, i| this.effort = i,
                )),
        )
}
