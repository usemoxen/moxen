//! The pages. Dashboard and Subscriptions are fully built; Movements,
//! Projection, Calendar and Analysis read the same [`crate::data`] view-model;
//! Settings is the shell's own.

mod analysis;
mod calendar;
mod chart;
mod dashboard;
mod movements;
mod projection;
mod settings;
mod subscriptions;

use crate::kit::{self, Control};
use crate::language::message;
use crate::shell::{FinancesApp, Page};
use crate::theme::{self, TypeScale, color};
use gpui::{prelude::*, *};

pub fn render(
    app: &mut FinancesApp,
    window: &mut Window,
    cx: &mut Context<FinancesApp>,
) -> AnyElement {
    let page = match app.page {
        Page::Dashboard => dashboard::render(app, window, cx).into_any_element(),
        Page::Subscriptions => subscriptions::render(app, window, cx).into_any_element(),
        Page::Movements => movements::render(app, window, cx),
        Page::Projection => projection::render(app, window, cx),
        Page::Calendar => calendar::render(app, window, cx),
        Page::Analysis => analysis::render(app, window, cx),
        Page::Settings => settings::render(app, cx).into_any_element(),
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

/// The shared page header: the display title, a mono subtitle and
/// right-aligned action buttons.
pub fn page_header(app: &FinancesApp, subtitle_key: &'static str, actions: Vec<AnyElement>) -> Div {
    div()
        .flex()
        .items_end()
        .justify_between()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(
                    div()
                        .type_scale("display")
                        .text_color(color("ink"))
                        .child(message(app.page.nav_key())),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .text_color(color("ink-2"))
                        .child(message(subtitle_key)),
                ),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .gap(px(8.))
                .flex_shrink_0()
                .children(actions),
        )
}

/// A raised card.
pub fn card() -> Div {
    div()
        .bg(color("raised"))
        .rounded(px(theme::radius("radius-md")))
        .p(px(16.))
        .flex()
        .flex_col()
        .gap(px(12.))
}

/// A card's heading: a `mono-caps` title and an optional mono subtitle.
pub fn card_header(title_key: &'static str, subtitle_key: Option<&'static str>) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(kit::caps(message(title_key)))
        .when_some(subtitle_key, |s, key| {
            s.child(
                div()
                    .font_family(theme::MONO)
                    .text_size(px(11.5))
                    .line_height(px(15.))
                    .text_color(color("ink-2"))
                    .child(message(key)),
            )
        })
}

/// The tone of a money value: `added` for income/positive, `broken` for
/// expenses/negative, `None` for neutral.
pub fn tone_color(tone: Option<&str>) -> Hsla {
    color(tone.unwrap_or("ink"))
}

/// A stat tile for the summary cards.
pub fn stat_tile(label: &str, value: String, note: Option<String>, tone: Option<&str>) -> Div {
    div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(kit::caps(label))
        .child(
            div()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(20.))
                .line_height(px(26.))
                .text_color(tone_color(tone))
                .truncate()
                .child(value),
        )
        .when_some(note, |s, note| {
            s.child(
                div()
                    .font_family(theme::MONO)
                    .text_size(px(11.))
                    .line_height(px(14.))
                    .text_color(color("ink-2"))
                    .truncate()
                    .child(note),
            )
        })
}

/// The scrollable page scaffold: a padded, width-capped column inside the
/// page's scrolling root.
pub fn scroll_page(page: Page, children: Vec<AnyElement>) -> Stateful<Div> {
    div()
        .id(page.id())
        .debug_selector(move || page.id().into())
        .size_full()
        .overflow_y_scroll()
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(24.))
                .p(px(24.))
                .max_w(px(1080.))
                .children(children),
        )
}

/// The loading state the pages show while the data is not ready: skeleton
/// blocks in `sunk`.
pub fn loading_page(page: Page) -> AnyElement {
    let skeleton = |h: f32, w: f32| {
        div()
            .h(px(h))
            .w(px(w))
            .rounded(px(theme::radius("radius-md")))
            .bg(color("sunk"))
            .into_any_element()
    };
    div()
        .id(page.id())
        .debug_selector(move || page.id().into())
        .size_full()
        .flex()
        .flex_col()
        .gap(px(16.))
        .p(px(24.))
        .max_w(px(1080.))
        .child(skeleton(34., 240.))
        .child(
            div()
                .flex()
                .flex_row()
                .gap(px(12.))
                .children((0..4).map(|_| skeleton(96., 240.))),
        )
        .child(skeleton(300., 1080.))
        .child(skeleton(180., 1080.))
        .into_any_element()
}

/// A centered empty state with an icon, a title and an optional body.
pub fn empty_state(
    icon_name: &'static str,
    title_key: &'static str,
    body_key: Option<&'static str>,
) -> Div {
    div()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(8.))
        .py(px(32.))
        .px(px(16.))
        .text_center()
        .child(kit::icon(icon_name, "ink-2", 22.))
        .child(
            div()
                .text_size(px(14.))
                .line_height(px(18.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(color("ink"))
                .child(message(title_key)),
        )
        .when_some(body_key, |s, key| {
            s.child(
                div()
                    .text_size(px(12.5))
                    .line_height(px(17.))
                    .text_color(color("ink-2"))
                    .max_w(px(400.))
                    .child(message(key)),
            )
        })
}

/// A disabled action button: dimmed, with a tooltip saying why.
pub fn disabled_action(
    id: (&'static str, usize),
    icon: &'static str,
    label_key: &'static str,
) -> Stateful<Div> {
    kit::button(id, message(label_key).to_string())
        .child(kit::icon(icon, "ink-2", 13.))
        .disabled(message("sub.action.disabled"))
}

/// A small icon button with a tooltip.
pub fn icon_button<E: 'static>(
    id: (&'static str, usize),
    icon: &'static str,
    tooltip: String,
    cx: &mut Context<E>,
    on_click: impl Fn(&mut E, &mut Context<E>) + Clone + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .size(px(26.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(theme::radius("radius-sm")))
        .cursor_pointer()
        .text_color(color("ink-2"))
        .hover(|s| s.bg(color("sunk")).text_color(color("ink")))
        .child(kit::icon(icon, "ink-2", 15.))
        .tooltip(move |_, cx| cx.new(|_| kit::Tooltip(tooltip.clone().into())).into())
        .on_click(cx.listener(move |this, _, _, cx| on_click(this, cx)))
}
