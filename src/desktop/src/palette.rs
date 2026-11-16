use crate::{
    theme::color,
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
actions!(palette, [OpenPalette, Dismiss, NextFocus, PreviousFocus]);

pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let query = w.search.read(cx).text().to_lowercase();
    div()
        .absolute()
        .top(px(72.))
        .left(px(300.))
        .w(px(520.))
        .p(px(8.))
        .rounded(px(10.))
        .bg(color("raised"))
        .border_1()
        .border_color(color("rule"))
        .shadow(crate::theme::float_shadow())
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            div()
                .p(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .child(ui::icon("search", "ink-2"))
                .child(div().flex_1().child(w.search.clone())),
        )
        .children(
            w.source
                .list_threads()
                .into_iter()
                .filter(|t| t.title.to_lowercase().contains(&query))
                .map(|t| {
                    div()
                        .id(("palette-thread", t.id))
                        .control(t.title.clone())
                        .px(px(8.))
                        .py(px(6.))
                        .rounded(px(6.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_size(px(13.))
                        .child(ui::state(t.status))
                        .child(t.title)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.palette_open = false;
                            this.select(t.id, cx);
                            window.focus(&this.sidebar_focus, cx);
                        }))
                }),
        )
        .with_animation("palette-reveal", ui::reveal(), |s, v| s.opacity(v))
}
