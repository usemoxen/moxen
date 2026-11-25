//! Analysis: the effective spend of the period against the normalized
//! (monthly-equivalent) cost, the distribution by category, the monthly
//! income/expense/net evolution and the most expensive subscriptions.

use crate::data::{Currency, Money};
use crate::format;
use crate::kit;
use crate::language::{fill, message};
use crate::model;
use crate::shell::FinancesApp;
use crate::theme::{self, color};
use crate::views::{self, card, card_header, empty_state, page_header, scroll_page, stat_tile};
use chrono::Datelike;
use gpui::{prelude::*, *};

fn money(account: Currency, minor: i64) -> String {
    format::money(Money {
        minor,
        currency: account,
    })
}

const LABELS: [&str; 8] = [
    "label-2", "label-6", "label-4", "label-3", "label-1", "label-5", "label-7", "label-8",
];

/// A labelled horizontal bar: name, value and a bar scaled to `max`.
fn bar_row(name: String, value: String, share: f64, index: usize) -> Div {
    let width = if share > 0. {
        (share * 100.).round().max(3.) as i32
    } else {
        3
    };
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            div()
                .flex()
                .items_baseline()
                .justify_between()
                .gap(px(8.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .min_w_0()
                        .child(
                            div()
                                .size(px(7.))
                                .flex_shrink_0()
                                .rounded_full()
                                .bg(color(LABELS[index % LABELS.len()])),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(px(12.5))
                                .line_height(px(16.))
                                .text_color(color("ink"))
                                .child(name),
                        ),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .line_height(px(15.))
                        .text_color(color("ink-2"))
                        .child(value),
                ),
        )
        .child(
            div()
                .h(px(6.))
                .w_full()
                .rounded_full()
                .bg(color("sunk"))
                .overflow_hidden()
                .child(
                    div()
                        .h_full()
                        .w(relative((width as f32 / 100.).clamp(0., 1.)))
                        .rounded_full()
                        .bg(color(LABELS[index % LABELS.len()]).opacity(0.7)),
                ),
        )
}

pub fn render(
    app: &FinancesApp,
    _window: &mut Window,
    cx: &mut Context<FinancesApp>,
) -> AnyElement {
    if !app.data.is_ready() {
        return views::loading_page(app.page);
    }
    let data = &app.data;
    let today = data.today();
    let account = data.account_currency();
    let rate = |from, to| data.exchange_rate(from, to);
    let months = app.analysis.months;

    // The period: the last `months` months up to today.
    let first_month = model::add_months(model::start_of_month(today), -(months as i32 - 1));
    let from = model::start_of_month(first_month);
    let to = model::end_of_month(today);
    let events = model::collect_events(
        &data.subscriptions(),
        &data.movements(),
        account,
        &rate,
        from,
        to,
    );
    let month_list = model::month_list(from, to);
    let monthly: Vec<model::MonthTotals> = month_list
        .iter()
        .map(|(y, m)| model::totals_for_month(&events, *y, *m))
        .collect();
    let period_expense: i64 = monthly.iter().map(|t| t.expense).sum();
    let period_income: i64 = monthly.iter().map(|t| t.income).sum();
    let period_net: i64 = period_income - period_expense;
    let period_count: usize = monthly.iter().map(|t| t.count).sum();
    let avg_monthly = if months > 0 {
        period_expense / months as i64
    } else {
        0
    };

    let normalized = model::normalized_monthly_cost(&data.subscriptions(), account, &rate);
    let savings = model::savings_from_inactive(&data.subscriptions(), account, &rate);
    let ranking = model::subscription_ranking(&data.subscriptions(), account, &rate);
    let categories = model::category_distribution(&events, from, to);
    let evolution = model::cost_evolution(&events, &month_list, normalized);

    let confirmed: i64 = events
        .iter()
        .filter(|e| e.kind == model::EventKind::Expense && !e.estimated)
        .map(|e| e.amount)
        .sum();
    let estimated = period_expense - confirmed;

    let range_options: Vec<SharedString> = [6usize, 12, 24]
        .iter()
        .map(|m| {
            message(match m {
                6 => "analysis.range.6",
                12 => "analysis.range.12",
                _ => "analysis.range.24",
            })
            .into()
        })
        .collect();
    let range_selected = [6usize, 12, 24]
        .iter()
        .position(|m| *m == months)
        .unwrap_or(1);

    // The monthly chart's groups and labels.
    let bars: Vec<views::chart::BarGroup> = monthly
        .iter()
        .map(|t| views::chart::BarGroup {
            income: t.income as f64,
            expense: t.expense as f64,
            net: t.net as f64,
        })
        .collect();
    let stride = (bars.len() / 12).max(1);
    let labels: Vec<AnyElement> = month_list
        .iter()
        .enumerate()
        .map(|(i, (y, m))| {
            div()
                .flex_1()
                .text_center()
                .truncate()
                .font_family(theme::MONO)
                .text_size(px(9.5))
                .line_height(px(12.))
                .text_color(color("ink-2"))
                .child(if i % stride == 0 {
                    format::short_month_label(*y, *m)
                } else {
                    String::new()
                })
                .into_any_element()
        })
        .collect();

    let mut children: Vec<AnyElement> = vec![
        page_header(app, "analysis.subtitle", vec![]).into_any_element(),
        // The header action: the period choice.
        div()
            .flex()
            .justify_end()
            .mt(px(-16.))
            .child(kit::segmented(
                "analysis-range",
                &range_options,
                range_selected,
                cx,
                |this, i, cx| {
                    if let Some(m) = [6usize, 12, 24].get(i) {
                        this.set_analysis_months(*m, cx);
                    }
                },
            ))
            .into_any_element(),
        // The summary stats.
        card()
            .child(
                div()
                    .grid()
                    .grid_cols(4)
                    .gap(px(12.))
                    .child(stat_tile(
                        message("analysis.expense.period"),
                        money(account, period_expense),
                        Some(fill(
                            "analysis.movements",
                            &[("{count}", &period_count.to_string())],
                        )),
                        Some("broken"),
                    ))
                    .child(stat_tile(
                        message("analysis.avg"),
                        money(account, avg_monthly),
                        Some(message("analysis.avg.hint").to_string()),
                        None,
                    ))
                    .child(stat_tile(
                        message("analysis.normalized"),
                        money(account, normalized),
                        Some(fill(
                            "analysis.normalized.year",
                            &[("{amount}", &money(account, normalized * 12))],
                        )),
                        Some("live"),
                    ))
                    .child(stat_tile(
                        message("analysis.savings"),
                        money(account, savings),
                        Some(message("analysis.savings.hint").to_string()),
                        Some("added"),
                    )),
            )
            .child(div().h(px(1.)).bg(color("rule")))
            .child(
                div()
                    .grid()
                    .grid_cols(3)
                    .gap(px(12.))
                    .child(stat_tile(
                        message("analysis.income.period"),
                        money(account, period_income),
                        None,
                        Some("added"),
                    ))
                    .child(stat_tile(
                        message("analysis.net.period"),
                        format::signed_money(Money {
                            minor: period_net,
                            currency: account,
                        }),
                        None,
                        Some(if period_net >= 0 { "added" } else { "broken" }),
                    ))
                    .child(stat_tile(
                        message("analysis.diff"),
                        money(account, period_expense - normalized * months as i64),
                        Some(message("analysis.diff.hint").to_string()),
                        None,
                    )),
            )
            .into_any_element(),
        // Income and expenses by month.
        card()
            .child(card_header(
                "analysis.chart.months",
                Some("analysis.chart.months.subtitle"),
            ))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(12.))
                    .child(legend_dot("added", "analysis.legend.income"))
                    .child(legend_dot("broken", "analysis.legend.expense"))
                    .child(legend_dot("live", "analysis.legend.net")),
            )
            .child(if period_count == 0 {
                empty_state(
                    "chart-bars",
                    "analysis.chart.empty.title",
                    Some("analysis.chart.empty.body"),
                )
                .into_any_element()
            } else {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(views::chart::bars_chart(&bars, 220.))
                    .child(div().flex().flex_row().children(labels))
                    .into_any_element()
            })
            .into_any_element(),
    ];

    // The subscription cost evolution and the categories.
    let cost_bars: Vec<f64> = evolution.iter().map(|p| p.actual as f64).collect();
    let cost_line: Vec<f64> = evolution.iter().map(|p| p.normalized as f64).collect();
    let cost_empty = evolution.iter().all(|p| p.actual == 0 && p.normalized == 0);
    let category_total: i64 = categories.iter().map(|c| c.amount).sum();
    let category_rows: Vec<AnyElement> = categories
        .iter()
        .take(6)
        .enumerate()
        .map(|(i, c)| {
            let share = if category_total > 0 {
                c.amount as f64 / category_total as f64
            } else {
                0.
            };
            bar_row(
                c.category.get().to_string(),
                format!("{} · {}", format::percent(share), money(account, c.amount)),
                share,
                i,
            )
            .into_any_element()
        })
        .collect();

    children.push(
        div()
            .grid()
            .grid_cols(2)
            .gap(px(16.))
            .items_start()
            .child(
                card()
                    .child(card_header(
                        "analysis.chart.cost",
                        Some("analysis.chart.cost.subtitle"),
                    ))
                    .child(if cost_empty {
                        empty_state(
                            "chart-bars",
                            "analysis.chart.cost.empty.title",
                            Some("analysis.chart.cost.empty.body"),
                        )
                        .into_any_element()
                    } else {
                        views::chart::cost_chart(&cost_bars, &cost_line, 200.).into_any_element()
                    })
                    .child(
                        div()
                            .font_family(theme::MONO)
                            .text_size(px(10.5))
                            .line_height(px(14.))
                            .text_color(color("ink-2"))
                            .child(message("analysis.chart.cost.note")),
                    ),
            )
            .child(
                card()
                    .child(card_header(
                        "analysis.categories",
                        Some("analysis.categories.subtitle"),
                    ))
                    .child(if categories.is_empty() {
                        empty_state(
                            "chart-bars",
                            "analysis.categories.empty.title",
                            Some("analysis.categories.empty.body"),
                        )
                        .into_any_element()
                    } else {
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(10.))
                            .children(category_rows)
                            .into_any_element()
                    }),
            )
            .into_any_element(),
    );

    // The most expensive subscriptions and the effective vs normalized card.
    let max_top = ranking.first().map(|r| r.monthly).unwrap_or(1).max(1);
    let top_rows: Vec<AnyElement> = ranking
        .iter()
        .take(8)
        .enumerate()
        .map(|(i, row)| {
            let share = row.monthly as f64 / max_top as f64;
            bar_row(
                row.name.clone(),
                fill(
                    "analysis.permonth",
                    &[("{amount}", &money(account, row.monthly))],
                ),
                share,
                i,
            )
            .into_any_element()
        })
        .collect();

    children.push(
        div()
            .grid()
            .grid_cols(2)
            .gap(px(16.))
            .items_start()
            .child(
                card()
                    .child(card_header("analysis.top", Some("analysis.top.subtitle")))
                    .child(if ranking.is_empty() {
                        empty_state("chart-bars", "analysis.top.empty", None).into_any_element()
                    } else {
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(10.))
                            .children(top_rows)
                            .into_any_element()
                    }),
            )
            .child(
                card()
                    .child(card_header("analysis.effective", None))
                    .child(
                        div()
                            .text_size(px(12.5))
                            .line_height(px(17.))
                            .text_color(color("ink-2"))
                            .child(message("analysis.effective.note")),
                    )
                    .child(
                        div()
                            .grid()
                            .grid_cols(2)
                            .gap(px(8.))
                            .child(
                                div()
                                    .bg(color("sunk"))
                                    .rounded(px(theme::radius("radius-sm")))
                                    .p(px(10.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(kit::caps(&fill(
                                        "analysis.effective.cash",
                                        &[("{count}", &months.to_string())],
                                    )))
                                    .child(
                                        div()
                                            .font_family(theme::MONO)
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_size(px(15.))
                                            .line_height(px(19.))
                                            .text_color(color("ink"))
                                            .child(money(account, period_expense)),
                                    ),
                            )
                            .child(
                                div()
                                    .bg(color("sunk"))
                                    .rounded(px(theme::radius("radius-sm")))
                                    .p(px(10.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(kit::caps(message("analysis.effective.equiv")))
                                    .child(
                                        div()
                                            .font_family(theme::MONO)
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_size(px(15.))
                                            .line_height(px(19.))
                                            .text_color(color("live"))
                                            .child(money(account, normalized)),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(key_value("analysis.confirmed", money(account, confirmed)))
                            .child(key_value("analysis.estimated", money(account, estimated))),
                    )
                    .child(
                        div()
                            .font_family(theme::MONO)
                            .text_size(px(10.5))
                            .line_height(px(14.))
                            .text_color(color("ink-2"))
                            .child(fill(
                                "analysis.period",
                                &[
                                    (
                                        "{from}",
                                        &format::month_label(
                                            first_month.year(),
                                            first_month.month(),
                                        ),
                                    ),
                                    ("{to}", &format::month_label(today.year(), today.month())),
                                ],
                            )),
                    ),
            )
            .into_any_element(),
    );

    scroll_page(app.page, children).into_any_element()
}

fn legend_dot(token: &'static str, key: &'static str) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .child(div().size(px(7.)).rounded_full().bg(color(token)))
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(10.5))
                .line_height(px(14.))
                .text_color(color("ink-2"))
                .child(message(key)),
        )
}

fn key_value(key: &'static str, value: String) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.))
        .child(
            div()
                .text_size(px(12.))
                .line_height(px(16.))
                .text_color(color("ink-2"))
                .child(message(key)),
        )
        .child(
            div()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(12.))
                .line_height(px(16.))
                .text_color(color("ink"))
                .child(value),
        )
}
