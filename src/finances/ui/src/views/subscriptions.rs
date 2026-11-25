//! Subscriptions: the list on the left, the selected one's detail on the
//! right. When the data source accepts commands (the store does), the header
//! opens the create form and the detail pane can pause, resume, cancel,
//! reactivate, edit and delete; the demo keeps them disabled.

use crate::commands::SubscriptionAction;
use crate::data::{Subscription, SubscriptionStatus};
use crate::dialog::{self, Dialog};
use crate::format;
use crate::kit::{self, Control};
use crate::language::{fill, message};
use crate::shell::FinancesApp;
use crate::theme::{self, TypeScale, color};
use crate::views::disabled_action;
use gpui::{prelude::*, *};

const LABELS: [&str; 8] = [
    "label-2", "label-6", "label-4", "label-3", "label-1", "label-5", "label-7", "label-8",
];

/// The design system's `Chip`: a `rule` outline with a square dot in the
/// status colour.
fn status_chip(status: SubscriptionStatus) -> Div {
    div()
        .h(px(24.))
        .px(px(9.))
        .flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(6.))
        .rounded(px(theme::radius("radius-sm")))
        .border(px(theme::px_token("stroke", "stroke-rule")))
        .border_color(color("rule"))
        .text_size(px(12.5))
        .line_height(px(16.))
        .text_color(color("ink"))
        .child(div().size(px(8.)).rounded(px(2.)).bg(color(status.token())))
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
        .mx(px(12.))
        .mb(px(2.))
        .h(px(58.))
        .px(px(12.))
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
                        .font_family(theme::FONT)
                        .text_size(px(12.5))
                        .line_height(px(18.))
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
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(kit::caps(label))
        .child(
            div()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(18.))
                .line_height(px(24.))
                .text_color(color("ink"))
                .truncate()
                .child(value),
        )
}

/// A live action button, or its disabled twin when the data source is
/// read-only (the demo).
fn action_button(
    id: (&'static str, usize),
    icon: &'static str,
    label_key: &'static str,
    can_mutate: bool,
    cx: &mut Context<FinancesApp>,
    on_click: impl Fn(&mut FinancesApp, &mut Context<FinancesApp>) + Clone + 'static,
) -> Stateful<Div> {
    if can_mutate {
        kit::icon_label_button(id, icon, message(label_key).to_string())
            .control(message(label_key))
            .on_click(cx.listener(move |this, _, _, cx| on_click(this, cx)))
    } else {
        disabled_action(id, icon, label_key)
    }
}

fn detail(
    app: &FinancesApp,
    sub: &Subscription,
    index: usize,
    cx: &mut Context<FinancesApp>,
) -> Div {
    let can_mutate = app.can_mutate();
    let (primary_icon, primary_action, primary_key) = match sub.status {
        SubscriptionStatus::Paused => (
            "action-play",
            SubscriptionAction::Resume,
            "sub.action.resume",
        ),
        SubscriptionStatus::Active => (
            "action-pause",
            SubscriptionAction::Pause,
            "sub.action.pause",
        ),
        SubscriptionStatus::Cancelled | SubscriptionStatus::Finished => (
            "action-play",
            SubscriptionAction::Reactivate,
            "sub.action.reactivate",
        ),
    };
    let id = sub.id.clone();
    let cancel_id = sub.id.clone();
    let edit_id = sub.id.clone();
    let delete_id = sub.id.clone();
    div()
        .flex_1()
        .min_w_0()
        .max_w(px(760.))
        .p(px(24.))
        .flex()
        .flex_col()
        .gap(px(20.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
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
                ),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .gap(px(16.))
                .p(px(16.))
                .rounded(px(theme::radius("radius-md")))
                .bg(color("raised"))
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
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(kit::caps(message("sub.actions")))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .flex_wrap()
                        .gap(px(8.))
                        .child(action_button(
                            ("sub-primary", index),
                            primary_icon,
                            primary_key,
                            can_mutate,
                            cx,
                            move |this, cx| this.subscription_action(&id, primary_action, cx),
                        ))
                        .when(
                            sub.status == SubscriptionStatus::Active
                                || sub.status == SubscriptionStatus::Paused,
                            |s| {
                                s.child(action_button(
                                    ("cancel", index),
                                    "action-x",
                                    "sub.action.cancel",
                                    can_mutate,
                                    cx,
                                    move |this, cx| {
                                        this.subscription_action(
                                            &cancel_id,
                                            SubscriptionAction::Cancel,
                                            cx,
                                        )
                                    },
                                ))
                            },
                        )
                        .child(action_button(
                            ("edit", index),
                            "action-edit",
                            "sub.action.edit",
                            can_mutate,
                            cx,
                            move |this, cx| {
                                dialog::open(this, Dialog::EditSubscription(edit_id.clone()), cx)
                            },
                        ))
                        .child(action_button(
                            ("delete", index),
                            "action-x",
                            "sub.action.delete",
                            can_mutate,
                            cx,
                            move |this, cx| {
                                this.subscription_action(&delete_id, SubscriptionAction::Delete, cx)
                            },
                        )),
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
    let can_mutate = app.can_mutate();
    let selected_id = app
        .selected_subscription()
        .map(str::to_string)
        .or_else(|| subs.first().map(|s| s.id.clone()));
    let selected = subs
        .iter()
        .position(|s| Some(s.id.as_str()) == selected_id.as_deref());

    let new_button = if can_mutate {
        kit::primary_button(
            ("new-sub", 0usize),
            Some("plus"),
            message("sub.new").to_string(),
        )
        .primary_control(message("sub.new"))
        .on_click(cx.listener(|this, _, _, cx| {
            dialog::open(this, Dialog::NewSubscription, cx);
        }))
        .into_any_element()
    } else {
        disabled_action(("new-sub", 0usize), "plus", "sub.new").into_any_element()
    };
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
                .flex_row()
                .items_center()
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
                                .font_family(theme::FONT)
                                .text_size(px(13.5))
                                .line_height(px(19.))
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
                .child(new_button),
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
                        .w(px(340.))
                        .flex_shrink_0()
                        .h_full()
                        .border_r_1()
                        .border_color(color("rule"))
                        .overflow_y_scroll()
                        .py(px(12.))
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
                            Some(sub) => detail(
                                app,
                                sub,
                                subs.iter().position(|s| s.id == sub.id).unwrap_or(0),
                                cx,
                            ),
                            None => div()
                                .p(px(24.))
                                .text_size(px(13.))
                                .text_color(color("ink-2"))
                                .child(message("subscriptions.empty")),
                        }),
                ),
        )
}
