//! The pages. Dashboard and Subscriptions are fully built; the rest are
//! labelled placeholders until their data lands.

mod chart;
mod dashboard;
mod placeholder;
mod settings;
mod subscriptions;

use crate::shell::{FinancesApp, Page};
use crate::theme::color;
use gpui::{prelude::*, *};

pub fn render(
    app: &mut FinancesApp,
    window: &mut Window,
    cx: &mut Context<FinancesApp>,
) -> AnyElement {
    let page = match app.page {
        Page::Dashboard => dashboard::render(app, window, cx).into_any_element(),
        Page::Subscriptions => subscriptions::render(app, window, cx).into_any_element(),
        Page::Settings => settings::render(app, cx).into_any_element(),
        page => placeholder::render(page).into_any_element(),
    };
    div()
        .id("content")
        .debug_selector(|| "content".into())
        .flex_1()
        .min_w_0()
        .h_full()
        .bg(color("ground"))
        .child(page)
        .into_any_element()
}
