//! Subscriptions: the list on the left, the selected one's detail on the
//! right. Pause/resume/cancel are shown as disabled actions until the store
//! crate can apply them.

use crate::data::{Subscription, SubscriptionStatus};
use crate::format;
use crate::kit::{self, Control};
use crate::language::{fill, message};
use crate::shell::FinancesApp;
use crate::theme::{self, TypeScale, color};
use gpui::{prelude::*, *};

const LABELS: [&str; 8] = [
    "label-2", "label-6", "label-4", "label-3", "label-1", "label-5", "label-7", "label-8",
];

fn status_chip(status: SubscriptionStatus) -> Div {
    div()
        .h(px(20.))
        .px(px(8.))
        .flex()
        .items_center()
        .rounded_full()
        .bg(color(status.token()))
        .font_family(theme::MONO)
        .text_size(px(10.5))
        .line_height(px(14.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(color("on-ink"))
        .child(message(status.key()))
}

fn list_row(
    sub: &Subscription,
    index: usize,
    selected: bool,
    cx: &mut Context<FinancesApp>,
) -> Stateful<Div> {
    let id = sub.id.clone();
    div()
        .id(("sub", index))
        .mx(px(8.))
        .h(px(56.))
        .px(px(10.))
        .flex()
        .items_center()
        .gap(px(10.))
        .rounded(px(theme::radius("radius-sm")))
        .cursor_pointer()
        .when(selected, |s| s.bg(color("sunk")))
        .hover(|s| s.bg(color("sunk")))
        .child(
            div()
                .size(px(8.))
                .flex_shrink_0()
                .rounded_full()
                .bg(color(LABELS[index % LABELS.len()])),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .truncate()
                        .text_size(px(13.5))
                        .line_height(px(17.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(color("ink"))
                        .child(sub.name.clone()),
                )
                .child(
                    div()
                        .truncate()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .line_height(px(15.))
                        .text_color(color("ink-2"))
                        .child(message(sub.status.key())),
                ),
        )
        .child(
            div()
                .flex_shrink_0()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(13.))
                .line_height(px(17.))
                .text_color(color("ink"))
                .child(match sub.price {
                    Some(price) => format::money(price),
                    None => message("sub.price.pending").to_string(),
                }),
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select_subscription(&id, cx);
        }))
}

fn field(label: &str, value: String) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(kit::caps(label))
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(13.))
                .line_height(px(17.))
                .text_color(color("ink"))
                .child(value),
        )
}

/// A disabled action button: dimmed, with a tooltip saying why.
fn disabled_action(id: (&'static str, usize), icon: &'static str, label: &str) -> Stateful<Div> {
    kit::button(id, label.to_string())
        .child(kit::icon(icon, "ink-2", 13.))
        .disabled(message("sub.action.disabled"))
}

fn detail(sub: &Subscription, index: usize) -> Div {
    let action = match sub.status {
        SubscriptionStatus::Paused => ("action-play", "sub.action.resume"),
        SubscriptionStatus::Active => ("action-pause", "sub.action.pause"),
        _ => ("action-pause", "sub.action.pause"),
    };
    div()
        .flex_1()
        .min_w_0()
        .p(px(24.))
        .flex()
        .flex_col()
        .gap(px(16.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .size(px(10.))
                        .flex_shrink_0()
                        .rounded_full()
                        .bg(color(LABELS[index % LABELS.len()])),
                )
                .child(
                    div()
                        .type_scale("headline")
                        .text_color(color("ink"))
                        .child(sub.name.clone()),
                )
                .child(div().flex_1())
                .child(status_chip(sub.status)),
        )
        .child(
            div()
                .text_size(px(13.5))
                .line_height(px(18.))
                .text_color(color("ink-2"))
                .child(sub.description.get()),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .gap(px(24.))
                .flex_wrap()
                .child(field(
                    message("sub.price"),
                    match sub.price {
                        Some(price) => format::money(price),
                        None => message("sub.price.pending").to_string(),
                    },
                ))
                .child(field(
                    message("sub.frequency"),
                    message(sub.frequency.key()).to_string(),
                ))
                .child(field(
                    message("sub.next_charge"),
                    sub.next_charge
                        .map(format::short_date)
                        .unwrap_or_else(|| message("sub.next.none").to_string()),
                )),
        )
        .child(kit::caps(message("sub.actions")))
        .child(
            div()
                .flex()
                .flex_row()
                .gap(px(8.))
                .child(disabled_action(
                    ("resume", index),
                    action.0,
                    message(action.1),
                ))
                .when(
                    sub.status == SubscriptionStatus::Active
                        || sub.status == SubscriptionStatus::Paused,
                    |s| {
                        s.child(disabled_action(
                            ("cancel", index),
                            "action-x",
                            message("sub.action.cancel"),
                        ))
                    },
                ),
        )
}

pub fn render(
    app: &mut FinancesApp,
    _window: &mut Window,
    cx: &mut Context<FinancesApp>,
) -> impl IntoElement {
    let subs = app.data.subscriptions();
    let active = subs
        .iter()
        .filter(|s| s.status == SubscriptionStatus::Active)
        .count();
    let paused = subs
        .iter()
        .filter(|s| s.status == SubscriptionStatus::Paused)
        .count();
    let selected_id = app
        .selected_subscription()
        .map(str::to_string)
        .or_else(|| subs.first().map(|s| s.id.clone()));
    let selected = subs
        .iter()
        .position(|s| Some(s.id.as_str()) == selected_id.as_deref());

    div()
        .id("subscriptions")
        .debug_selector(|| "subscriptions".into())
        .size_full()
        .flex()
        .flex_col()
        .child(
            div()
                .flex_shrink_0()
                .p(px(24.))
                .pb(px(16.))
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
                        .child(fill(
                            "subscriptions.subtitle",
                            &[
                                ("{active}", &active.to_string()),
                                ("{paused}", &paused.to_string()),
                            ],
                        )),
                ),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .flex_1()
                .min_h_0()
                .border_t_1()
                .border_color(color("rule"))
                .child(
                    div()
                        .id("sub-list")
                        .w(px(380.))
                        .flex_shrink_0()
                        .h_full()
                        .border_r_1()
                        .border_color(color("rule"))
                        .overflow_y_scroll()
                        .py(px(8.))
                        .when(subs.is_empty(), |s| {
                            s.child(
                                div()
                                    .p(px(16.))
                                    .text_size(px(13.))
                                    .text_color(color("ink-2"))
                                    .child(message("subscriptions.empty")),
                            )
                        })
                        .children(
                            subs.iter()
                                .enumerate()
                                .map(|(i, sub)| list_row(sub, i, selected == Some(i), cx)),
                        ),
                )
                .child(
                    div()
                        .id("sub-detail")
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .overflow_y_scroll()
                        .child(match selected.and_then(|i| subs.get(i)) {
                            Some(sub) => {
                                detail(sub, subs.iter().position(|s| s.id == sub.id).unwrap_or(0))
                            }
                            None => div()
                                .p(px(24.))
                                .text_size(px(13.))
                                .text_color(color("ink-2"))
                                .child(message("subscriptions.empty")),
                        }),
                ),
        )
}
