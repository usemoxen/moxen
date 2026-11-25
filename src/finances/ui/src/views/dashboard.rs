//! The Dashboard: real balance, month-end forecast, spent this month,
//! recurring cost, the balance chart and the upcoming charges.

use crate::data::SubscriptionStatus;
use crate::format;
use crate::kit;
use crate::language::{fill, message};
use crate::shell::FinancesApp;
use crate::theme::{self, TypeScale, color};
use crate::views::chart;
use gpui::{prelude::*, *};

fn stat(label: &str, value: String, note: Option<String>) -> Div {
    div()
        .flex_1()
        .min_w_0()
        .bg(color("raised"))
        .rounded(px(theme::radius("radius-md")))
        .p(px(16.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(kit::caps(label))
        .child(
            div()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(24.))
                .line_height(px(30.))
                .text_color(color("ink"))
                .truncate()
                .child(value),
        )
        .when_some(note, |s, note| {
            s.child(
                div()
                    .font_family(theme::MONO)
                    .text_size(px(11.5))
                    .line_height(px(15.))
                    .text_color(color("ink-2"))
                    .truncate()
                    .child(note),
            )
        })
}

fn header(app: &FinancesApp) -> Div {
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
                .child(format::long_date(app.data.today())),
        )
}

fn warning() -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .p(px(12.))
        .rounded(px(theme::radius("radius-md")))
        .bg(color("sunk"))
        .border_1()
        .border_color(color("held"))
        .child(kit::icon("alert", "held", 15.))
        .child(
            div()
                .text_size(px(13.))
                .line_height(px(17.))
                .text_color(color("ink"))
                .child(message("dashboard.incomplete")),
        )
}

fn upcoming_row(charge: &crate::data::UpcomingCharge, index: usize) -> Div {
    let label = ["label-2", "label-6", "label-4", "label-3", "label-1"][index % 5];
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .h(px(36.))
        .child(
            div()
                .size(px(8.))
                .flex_shrink_0()
                .rounded_full()
                .bg(color(label)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(13.5))
                .line_height(px(17.5))
                .text_color(color("ink"))
                .child(charge.name.clone()),
        )
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(11.5))
                .line_height(px(15.))
                .text_color(color("ink-2"))
                .child(fill(
                    "dashboard.upcoming.on",
                    &[("{date}", &format::short_date(charge.date))],
                )),
        )
        .child(
            div()
                .w(px(110.))
                .flex_shrink_0()
                .text_right()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(13.))
                .line_height(px(17.))
                .text_color(color("ink"))
                .child(match charge.amount {
                    Some(amount) => format::money(amount),
                    None => message("dashboard.upcoming.pending").to_string(),
                }),
        )
}

pub fn render(
    app: &FinancesApp,
    _window: &mut Window,
    _cx: &mut Context<FinancesApp>,
) -> impl IntoElement {
    let data = &app.data;
    let summary = data.month_summary();
    let upcoming = data.upcoming_charges();
    let incomplete = data
        .subscriptions()
        .iter()
        .any(|s| s.status == SubscriptionStatus::Active && s.price.is_none());
    let history = data.balance_history();
    let days = history
        .last()
        .map(|last| {
            last.date
                .signed_duration_since(history.first().unwrap().date)
                .num_days()
        })
        .unwrap_or(0);
    let high = history
        .iter()
        .max_by_key(|p| p.balance.minor)
        .map(|p| p.balance)
        .unwrap_or(data.balance());
    let low = history
        .iter()
        .min_by_key(|p| p.balance.minor)
        .map(|p| p.balance)
        .unwrap_or(data.balance());

    div()
        .id("dashboard")
        .debug_selector(|| "dashboard".into())
        .size_full()
        .overflow_y_scroll()
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(24.))
                .p(px(24.))
                .max_w(px(1080.))
                .child(header(app))
                .when(incomplete, |s| s.child(warning()))
                .child(div().flex().flex_row().gap(px(12.)).children([
                    stat(
                        message("dashboard.balance"),
                        format::money(data.balance()),
                        Some(fill(
                            "dashboard.balance.asof",
                            &[("{date}", &format::short_date(data.balance_date()))],
                        )),
                    ),
                    stat(
                        message("dashboard.forecast"),
                        format::money(data.month_end_forecast()),
                        Some(message("dashboard.forecast.note").to_string()),
                    ),
                    stat(
                        message("dashboard.spent"),
                        format::money(summary.spent),
                        Some(format::month_label(summary.year, summary.month)),
                    ),
                    stat(
                        message("dashboard.recurring"),
                        format::money(summary.recurring),
                        Some(message("dashboard.recurring.per").to_string()),
                    ),
                ]))
                .child(
                    div()
                        .bg(color("raised"))
                        .rounded(px(theme::radius("radius-md")))
                        .p(px(16.))
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .child(kit::caps(message("dashboard.chart")))
                                .child(div().flex_1())
                                .child(
                                    div()
                                        .font_family(theme::MONO)
                                        .text_size(px(11.5))
                                        .line_height(px(15.))
                                        .text_color(color("ink-2"))
                                        .child(fill(
                                            "dashboard.chart.range",
                                            &[("{count}", &days.to_string())],
                                        )),
                                ),
                        )
                        .child(chart::balance_chart(&history))
                        .child(
                            div().flex().justify_between().children([
                                div()
                                    .font_family(theme::MONO)
                                    .text_size(px(11.5))
                                    .line_height(px(15.))
                                    .text_color(color("ink-2"))
                                    .child(fill(
                                        "dashboard.chart.low",
                                        &[("{amount}", &format::money(low))],
                                    )),
                                div()
                                    .font_family(theme::MONO)
                                    .text_size(px(11.5))
                                    .line_height(px(15.))
                                    .text_color(color("ink-2"))
                                    .child(fill(
                                        "dashboard.chart.high",
                                        &[("{amount}", &format::money(high))],
                                    )),
                            ]),
                        ),
                )
                .child(
                    div()
                        .bg(color("raised"))
                        .rounded(px(theme::radius("radius-md")))
                        .p(px(16.))
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .child(kit::caps(message("dashboard.upcoming")))
                                .child(div().flex_1())
                                .child(
                                    div()
                                        .font_family(theme::MONO)
                                        .text_size(px(11.5))
                                        .line_height(px(15.))
                                        .text_color(color("ink-2"))
                                        .child(fill(
                                            "dashboard.upcoming.count",
                                            &[("{count}", &upcoming.len().to_string())],
                                        )),
                                ),
                        )
                        .when(upcoming.is_empty(), |s| {
                            s.child(
                                div()
                                    .py(px(8.))
                                    .text_size(px(13.))
                                    .text_color(color("ink-2"))
                                    .child(message("dashboard.upcoming.empty")),
                            )
                        })
                        .children(
                            upcoming
                                .iter()
                                .enumerate()
                                .map(|(i, charge)| upcoming_row(charge, i)),
                        ),
                ),
        )
}
