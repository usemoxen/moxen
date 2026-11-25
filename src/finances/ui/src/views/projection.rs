//! Projection: the day-by-day balance over an interval from 30 days to 2
//! years, the minimum projected balance, the first negative day, a per-day
//! detail table, the hand-drawn chart and a scenario comparison that only
//! ever lives in the page's own state — it never touches real data.

use crate::data::{Currency, Money};
use crate::format;
use crate::kit::{self, Control};
use crate::language::{fill, message};
use crate::model::{self, DayEvent, EventKind, EventSource};
use crate::shell::{FinancesApp, ProjectionRange, ScenarioEvent};
use crate::theme::{self, color};
use crate::views::{
    self, card, card_header, empty_state, icon_button, page_header, scroll_page, stat_tile,
};
use chrono::NaiveDate;
use gpui::{prelude::*, *};

fn money(account: Currency, minor: i64) -> String {
    format::money(Money {
        minor,
        currency: account,
    })
}

fn scenario_events(scenario: &[ScenarioEvent]) -> Vec<DayEvent> {
    scenario
        .iter()
        .map(|e| DayEvent {
            id: format!("scenario-{}", e.id),
            date: e.date,
            kind: e.kind,
            source: EventSource::Scenario,
            name: e.name.clone(),
            category: None,
            amount: e.amount,
            original: None,
            estimated: true,
        })
        .collect()
}

fn source_key(source: EventSource) -> &'static str {
    match source {
        EventSource::Subscription => "projection.source.subscription",
        EventSource::Income => "projection.source.income",
        EventSource::Expense => "projection.source.expense",
        EventSource::Scenario => "projection.source.scenario",
    }
}

fn event_row(event: &DayEvent, account: Currency, index: usize) -> Stateful<Div> {
    let income = event.kind == EventKind::Income;
    div()
        .id(("proj-event", index))
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(10.))
        .py(px(7.))
        .border_b_1()
        .border_color(color("rule"))
        .child(
            div()
                .size(px(26.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(theme::radius("radius-sm")))
                .bg(color("sunk"))
                .child(kit::icon(
                    if income {
                        "arrow-up-right"
                    } else {
                        "arrow-down-right"
                    },
                    if income { "added" } else { "broken" },
                    13.,
                )),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .truncate()
                        .text_size(px(12.5))
                        .line_height(px(16.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(color("ink"))
                        .child(event.name.clone()),
                )
                .child(
                    div()
                        .truncate()
                        .font_family(theme::FONT)
                        .text_size(px(12.))
                        .line_height(px(17.))
                        .text_color(color("ink-2"))
                        .child(format!(
                            "{} · {}",
                            message(source_key(event.source)),
                            message(if event.estimated {
                                "projection.estimated"
                            } else {
                                "projection.real"
                            })
                        )),
                ),
        )
        .child(
            div()
                .flex_shrink_0()
                .text_right()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(12.5))
                .line_height(px(16.))
                .text_color(color(if income { "added" } else { "broken" }))
                .child(format::signed_money(Money {
                    minor: if income { event.amount } else { -event.amount },
                    currency: account,
                })),
        )
}

pub fn render(app: &FinancesApp, window: &mut Window, cx: &mut Context<FinancesApp>) -> AnyElement {
    if !app.data.is_ready() {
        return views::loading_page(app.page);
    }
    let data = &app.data;
    let today = data.today();
    let account = data.account_currency();
    let rate = |from, to| data.exchange_rate(from, to);
    let (from, to) = app.projection.range.bounds(today);

    // Events from the balance's anchor date, so the starting balance of the
    // window includes everything that happened before it.
    let anchor_date = data.balance_date();
    let events = model::collect_events(
        &data.subscriptions(),
        &data.movements(),
        account,
        &rate,
        anchor_date.min(from),
        to,
    );
    let scenario = scenario_events(&app.projection.scenario);
    let anchor_minor = model::to_account_minor(data.balance(), account, &rate);
    let base = model::project(anchor_minor, anchor_date, &events, from, to, &[]);
    let with_scenario = model::project(anchor_minor, anchor_date, &events, from, to, &scenario);

    // The selected day: the stored one if it is in range, else the first
    // negative day, else today.
    let selected = app
        .projection
        .selected
        .filter(|d| *d >= from && *d <= to)
        .or(base.first_negative.map(|(d, _)| d))
        .unwrap_or(today.clamp(from, to));
    let selected_index = base.days.iter().position(|d| d.date == selected);
    let selected_day = selected_index.and_then(|i| with_scenario.days.get(i));
    let base_day = selected_index.and_then(|i| base.days.get(i));
    let day_dates: Vec<NaiveDate> = base.days.iter().map(|d| d.date).collect();

    let range_options: Vec<SharedString> = ProjectionRange::ALL
        .iter()
        .map(|r| message(r.label_key()).into())
        .collect();
    let range_selected = ProjectionRange::ALL
        .iter()
        .position(|r| *r == app.projection.range)
        .unwrap_or(1);

    let values: Vec<f64> = base.days.iter().map(|d| d.balance as f64).collect();
    let scenario_values: Option<Vec<f64>> = (!scenario.is_empty()).then(|| {
        let by_date: std::collections::BTreeMap<NaiveDate, i64> = with_scenario
            .days
            .iter()
            .map(|d| (d.date, d.balance))
            .collect();
        base.days
            .iter()
            .map(|d| *by_date.get(&d.date).unwrap_or(&d.balance) as f64)
            .collect()
    });

    let mut children: Vec<AnyElement> = vec![
        page_header(app, "projection.subtitle", vec![]).into_any_element(),
        // The period.
        card()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_end()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(kit::caps(message("projection.period")))
                            .child(
                                div()
                                    .font_family(theme::FONT)
                                    .text_size(px(12.5))
                                    .line_height(px(18.))
                                    .text_color(color("ink-2"))
                                    .child(fill(
                                        "projection.period.range",
                                        &[
                                            ("{from}", &format::short_date(base.from)),
                                            ("{to}", &format::short_date(base.to)),
                                            ("{count}", &base.days.len().to_string()),
                                        ],
                                    )),
                            ),
                    )
                    .child(kit::segmented(
                        "projection-range",
                        &range_options,
                        range_selected,
                        cx,
                        |this, i, cx| {
                            if let Some(range) = ProjectionRange::ALL.get(i) {
                                this.set_projection_range(*range, cx);
                            }
                        },
                    )),
            )
            .into_any_element(),
        // The four summary tiles.
        div()
            .grid()
            .grid_cols(4)
            .gap(px(12.))
            .child(stat_tile(
                message("projection.start"),
                money(account, base.start_balance),
                Some(fill(
                    if base.from == data.balance_date() {
                        "projection.start.real"
                    } else {
                        "projection.start.close"
                    },
                    &[(
                        "{date}",
                        &format::short_date(if base.from == data.balance_date() {
                            data.balance_date()
                        } else {
                            base.from - chrono::Duration::days(1)
                        }),
                    )],
                )),
                None,
            ))
            .child(stat_tile(
                message("projection.end"),
                money(account, base.end_balance),
                Some(format::short_date(base.to)),
                Some(if base.end_balance < 0 {
                    "broken"
                } else {
                    "ink"
                }),
            ))
            .child(stat_tile(
                message("projection.min"),
                money(account, base.min_balance),
                Some(match base.min_date {
                    Some(d) => format::short_date(d),
                    None => message("projection.min.never").to_string(),
                }),
                Some(if base.min_balance < 0 {
                    "broken"
                } else {
                    "added"
                }),
            ))
            .child(stat_tile(
                message("projection.negative"),
                match base.first_negative {
                    Some((d, _)) => format::short_date(d),
                    None => message("projection.negative.none").to_string(),
                },
                Some(match base.first_negative {
                    Some((_, deficit)) => fill(
                        "projection.negative.hint",
                        &[("{amount}", &money(account, deficit))],
                    ),
                    None => message("projection.negative.ok").to_string(),
                }),
                Some(if base.first_negative.is_some() {
                    "broken"
                } else {
                    "added"
                }),
            ))
            .into_any_element(),
        // The chart.
        card()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(card_header(
                        "projection.chart",
                        Some("projection.chart.hint"),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(12.))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(
                                        div().h(px(2.)).w(px(14.)).rounded_full().bg(color("live")),
                                    )
                                    .child(
                                        div()
                                            .font_family(theme::MONO)
                                            .text_size(px(10.5))
                                            .text_color(color("ink-2"))
                                            .child(message("projection.legend.base")),
                                    ),
                            )
                            .when(!scenario.is_empty(), |s| {
                                s.child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        // Two dashes, as the line is drawn.
                                        .child(div().flex().gap(px(2.)).children(
                                            (0..2).map(|_| {
                                                div().h(px(2.)).w(px(6.)).bg(color("held"))
                                            }),
                                        ))
                                        .child(
                                            div()
                                                .font_family(theme::MONO)
                                                .text_size(px(10.5))
                                                .text_color(color("ink-2"))
                                                .child(message("projection.legend.scenario")),
                                        ),
                                )
                            }),
                    ),
            )
            .child(views::chart::series_chart(
                &day_dates,
                &values,
                scenario_values.as_deref(),
                selected_index,
                account,
                280.,
            ))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_between()
                    .gap(px(8.))
                    .border_t_1()
                    .border_color(color("rule"))
                    .pt(px(10.))
                    .child(
                        div()
                            .font_family(theme::FONT)
                            .text_size(px(12.))
                            .line_height(px(17.))
                            .text_color(color("ink-2"))
                            .child(message(if base.min_balance < 0 {
                                "projection.footer.negative"
                            } else {
                                "projection.footer.positive"
                            })),
                    )
                    .child(
                        div()
                            .font_family(theme::FONT)
                            .text_size(px(12.))
                            .line_height(px(17.))
                            .text_color(color("ink-2"))
                            .child(fill(
                                "projection.totals",
                                &[
                                    ("{income}", &money(account, base.total_income)),
                                    ("{expense}", &money(account, base.total_expense)),
                                ],
                            )),
                    ),
            )
            .into_any_element(),
    ];

    // The per-day table (left) and the scenario (right).
    let table_rows: Vec<AnyElement> = base
        .days
        .iter()
        .enumerate()
        .map(|(i, day)| {
            let is_selected = Some(i) == selected_index;
            let date = day.date;
            div()
                .id(("proj-day", i))
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(10.))
                .h(px(26.))
                .cursor_pointer()
                .when(is_selected, |s| s.bg(color("sunk")))
                .hover(|s| s.bg(color("sunk")))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .line_height(px(15.))
                        .text_color(color(if is_selected { "ink" } else { "ink-2" }))
                        .child(format::table_day(day.date, today)),
                )
                .child(
                    div()
                        .w(px(72.))
                        .text_right()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .line_height(px(15.))
                        .text_color(color("added"))
                        .child(if day.income > 0 {
                            money(account, day.income)
                        } else {
                            "—".to_string()
                        }),
                )
                .child(
                    div()
                        .w(px(72.))
                        .text_right()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .line_height(px(15.))
                        .text_color(color("broken"))
                        .child(if day.expense > 0 {
                            format!("-{}", money(account, day.expense))
                        } else {
                            "—".to_string()
                        }),
                )
                .child(
                    div()
                        .w(px(88.))
                        .flex_shrink_0()
                        .text_right()
                        .font_family(theme::MONO)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_size(px(11.5))
                        .line_height(px(15.))
                        .text_color(color(if day.balance < 0 { "broken" } else { "ink" }))
                        .child(money(account, day.balance)),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.select_projection_day(Some(date), cx);
                }))
                .into_any_element()
        })
        .collect();

    let selected_events: Vec<AnyElement> = selected_day
        .map(|d| {
            d.events
                .iter()
                .enumerate()
                .map(|(i, e)| event_row(e, account, i).into_any_element())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let day_detail = card()
        .child(card_header("projection.day", None))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(icon_button(
                            ("proj-prev-day", 0),
                            "chevron-left",
                            message("calendar.prev").to_string(),
                            cx,
                            {
                                let day_dates = day_dates.clone();
                                move |this, cx| {
                                    let prev = selected_index
                                        .and_then(|i| day_dates.get(i.wrapping_sub(1)))
                                        .copied();
                                    this.select_projection_day(prev, cx);
                                }
                            },
                        ))
                        .child(
                            div()
                                .font_family(theme::MONO)
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .text_color(color("ink"))
                                .child(format::long_date(selected)),
                        )
                        .child(icon_button(
                            ("proj-next-day", 0),
                            "chevron-right",
                            message("calendar.next").to_string(),
                            cx,
                            move |this, cx| {
                                let next =
                                    selected_index.and_then(|i| day_dates.get(i + 1)).copied();
                                this.select_projection_day(next, cx);
                            },
                        )),
                )
                .child(
                    div()
                        .text_right()
                        .child(kit::caps(message("projection.day.balance")))
                        .child(
                            div()
                                .font_family(theme::MONO)
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_size(px(16.))
                                .line_height(px(20.))
                                .text_color(color(
                                    if selected_day.map(|d| d.balance < 0).unwrap_or(false) {
                                        "broken"
                                    } else {
                                        "ink"
                                    },
                                ))
                                .child(match selected_day {
                                    Some(d) => money(account, d.balance),
                                    None => "—".to_string(),
                                }),
                        )
                        .when_some(
                            base_day.and_then(|b| selected_day.map(|s| (b.balance, s.balance))),
                            |s, (base_balance, scenario_balance)| {
                                s.when(base_balance != scenario_balance, |s| {
                                    s.child(
                                        div()
                                            .font_family(theme::MONO)
                                            .text_size(px(10.5))
                                            .text_color(color("held"))
                                            .child(format!(
                                                "{} {}",
                                                message("projection.legend.base"),
                                                money(account, base_balance)
                                            )),
                                    )
                                })
                            },
                        ),
                ),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .gap(px(8.))
                .px(px(10.))
                .font_family(theme::MONO)
                .text_size(px(10.5))
                .text_color(color("ink-2"))
                .child(div().flex_1().child(message("projection.table.date")))
                .child(
                    div()
                        .w(px(72.))
                        .text_right()
                        .child(message("projection.table.income")),
                )
                .child(
                    div()
                        .w(px(72.))
                        .text_right()
                        .child(message("projection.table.expense")),
                )
                .child(
                    div()
                        .w(px(88.))
                        .text_right()
                        .child(message("projection.table.balance")),
                ),
        )
        .child(
            div()
                .id("proj-days")
                .max_h(px(240.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .children(table_rows),
        )
        .child(div().h(px(1.)).bg(color("rule")))
        .child(if selected_events.is_empty() {
            empty_state(
                "calendar-days",
                "projection.day.empty.title",
                Some("projection.day.empty.body"),
            )
            .into_any_element()
        } else {
            div()
                .id("proj-day-events")
                .max_h(px(220.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .children(selected_events)
                .into_any_element()
        });

    // The scenario card.
    let scenario_rows: Vec<AnyElement> = app
        .projection
        .scenario
        .iter()
        .map(|e| {
            let income = e.kind == EventKind::Income;
            let id = e.id;
            let name = e.name.clone();
            let date = e.date;
            let amount = e.amount;
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(10.))
                .py(px(6.))
                .rounded(px(theme::radius("radius-sm")))
                .border_1()
                .border_color(color("rule"))
                .child(
                    div()
                        .size(px(22.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(theme::radius("radius-sm")))
                        .bg(color("sunk"))
                        .child(kit::icon(
                            if income { "trend-up" } else { "trend-down" },
                            if income { "added" } else { "broken" },
                            12.,
                        )),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .truncate()
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(color("ink"))
                                .child(name.clone()),
                        )
                        .child(
                            div()
                                .font_family(theme::MONO)
                                .text_size(px(10.5))
                                .line_height(px(14.))
                                .text_color(color("ink-2"))
                                .child(format!(
                                    "{} · {}",
                                    format::short_date(date),
                                    money(account, amount)
                                )),
                        ),
                )
                .child(icon_button(
                    ("scenario-remove", id as usize),
                    "action-x",
                    fill("projection.scenario.remove", &[("{name}", &name)]),
                    cx,
                    move |this, cx| this.remove_scenario_event(id, cx),
                ))
                .into_any_element()
        })
        .collect();

    let scenario_stats = if app.projection.scenario.is_empty() {
        None
    } else {
        let delta_end = with_scenario.end_balance - base.end_balance;
        let delta_min = with_scenario.min_balance - base.min_balance;
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .grid()
                        .grid_cols(2)
                        .gap(px(8.))
                        .child(scenario_stat(
                            "projection.scenario.stat.end",
                            account,
                            with_scenario.end_balance,
                            delta_end,
                        ))
                        .child(scenario_stat(
                            "projection.scenario.stat.min",
                            account,
                            with_scenario.min_balance,
                            delta_min,
                        )),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(11.))
                        .line_height(px(15.))
                        .text_color(color(
                            if with_scenario.first_negative.is_some()
                                && (base.first_negative.is_none()
                                    || with_scenario.first_negative.unwrap().0
                                        < base.first_negative.unwrap().0)
                            {
                                "broken"
                            } else {
                                "ink-2"
                            },
                        ))
                        .child(
                            if let Some((date, deficit)) = with_scenario.first_negative {
                                if base.first_negative.is_none()
                                    || date < base.first_negative.unwrap().0
                                {
                                    fill(
                                        "projection.scenario.negative",
                                        &[
                                            ("{date}", &format::short_date(date)),
                                            ("{amount}", &money(account, deficit)),
                                        ],
                                    )
                                } else {
                                    fill(
                                        "projection.scenario.delta",
                                        &[
                                            (
                                                "{final}",
                                                &format::signed_money(Money {
                                                    minor: delta_end,
                                                    currency: account,
                                                }),
                                            ),
                                            (
                                                "{min}",
                                                &format::signed_money(Money {
                                                    minor: delta_min,
                                                    currency: account,
                                                }),
                                            ),
                                        ],
                                    )
                                }
                            } else {
                                fill(
                                    "projection.scenario.delta",
                                    &[
                                        (
                                            "{final}",
                                            &format::signed_money(Money {
                                                minor: delta_end,
                                                currency: account,
                                            }),
                                        ),
                                        (
                                            "{min}",
                                            &format::signed_money(Money {
                                                minor: delta_min,
                                                currency: account,
                                            }),
                                        ),
                                    ],
                                )
                            },
                        ),
                ),
        )
    };

    let scenario_card = card()
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(card_header(
                    "projection.scenario",
                    Some("projection.scenario.subtitle"),
                ))
                .when(!app.projection.scenario.is_empty(), |s| {
                    s.child(
                        kit::button(
                            ("scenario-clear", 0usize),
                            message("projection.scenario.clear").to_string(),
                        )
                        .control(message("projection.scenario.clear").to_string())
                        .on_click(cx.listener(|this, _, _, cx| this.clear_scenario(cx))),
                    )
                }),
        )
        .when(app.projection.scenario.is_empty(), |s| {
            s.child(
                div()
                    .border_1()
                    .border_dashed()
                    .border_color(color("rule"))
                    .rounded(px(theme::radius("radius-md")))
                    .p(px(12.))
                    .text_center()
                    .child(
                        div()
                            .text_size(px(12.5))
                            .line_height(px(17.))
                            .text_color(color("ink-2"))
                            .child(message("projection.scenario.hint")),
                    ),
            )
        })
        .children(scenario_rows)
        .when_some(scenario_stats, |s, stats| s.child(stats))
        // The draft form.
        .child(div().h(px(1.)).bg(color("rule")))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(kit::caps(message("projection.scenario.form.name")))
                .child(div().w(px(220.)).child(kit::text_field(
                    "scenario-name",
                    &app.projection.draft_name,
                    message("projection.scenario.form.name"),
                    window,
                    cx,
                    |this, name, cx| this.set_scenario_draft_name(name, cx),
                )))
                .child(kit::caps(message("projection.scenario.form.amount")))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(div().w(px(120.)).child(kit::text_field(
                            "scenario-amount",
                            &app.projection.draft_amount,
                            "19.99",
                            window,
                            cx,
                            |this, amount, cx| this.set_scenario_draft_amount(amount, cx),
                        )))
                        .when(app.projection.draft_invalid, |s| {
                            s.child(
                                div()
                                    .text_size(px(11.))
                                    .line_height(px(14.))
                                    .text_color(color("broken"))
                                    .child(message("projection.scenario.form.invalid")),
                            )
                        }),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(kit::caps(message("projection.scenario.form.date")))
                        .child(icon_button(
                            ("scenario-prev-day", 0),
                            "chevron-left",
                            message("calendar.prev").to_string(),
                            cx,
                            |this, cx| this.step_scenario_draft_date(-1, cx),
                        ))
                        .child(
                            div()
                                .font_family(theme::MONO)
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .text_color(color("ink"))
                                .child(format::short_date(app.projection.draft_date)),
                        )
                        .child(icon_button(
                            ("scenario-next-day", 0),
                            "chevron-right",
                            message("calendar.next").to_string(),
                            cx,
                            |this, cx| this.step_scenario_draft_date(1, cx),
                        )),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(kit::caps(message("projection.scenario.form.kind")))
                        .child(kit::segmented(
                            "scenario-kind",
                            &[
                                message("projection.scenario.form.expense").into(),
                                message("projection.scenario.form.income").into(),
                            ],
                            match app.projection.draft_kind {
                                EventKind::Expense => 0,
                                EventKind::Income => 1,
                            },
                            cx,
                            |this, i, cx| {
                                this.set_scenario_draft_kind(
                                    if i == 1 {
                                        EventKind::Income
                                    } else {
                                        EventKind::Expense
                                    },
                                    cx,
                                )
                            },
                        )),
                )
                .child(
                    kit::button(
                        ("scenario-add", 0usize),
                        message("projection.scenario.form.add").to_string(),
                    )
                    .child(kit::icon("plus", "ink-2", 13.))
                    .control(message("projection.scenario.add").to_string())
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.add_scenario_event(cx);
                    })),
                ),
        );

    children.push(
        div()
            .grid()
            .grid_cols(2)
            .gap(px(16.))
            .items_start()
            .child(day_detail)
            .child(scenario_card)
            .into_any_element(),
    );

    // The overdraft banner.
    if let Some((date, deficit)) = base.first_negative {
        let day_balance = base
            .days
            .iter()
            .find(|d| d.date == date)
            .map(|d| d.balance)
            .unwrap_or(0);
        children.push(
            div()
                .flex()
                .items_start()
                .gap(px(10.))
                .p(px(14.))
                .rounded(px(theme::radius("radius-md")))
                .bg(color("sunk"))
                .border_1()
                .border_color(color("broken"))
                .child(kit::icon("alert", "broken", 16.))
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_size(px(13.5))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(color("broken"))
                                .child(fill(
                                    "projection.risk.title",
                                    &[("{date}", &format::long_date(date))],
                                )),
                        )
                        .child(
                            div()
                                .text_size(px(12.5))
                                .line_height(px(17.))
                                .text_color(color("ink-2"))
                                .child(fill(
                                    "projection.risk.body",
                                    &[
                                        ("{balance}", &money(account, day_balance)),
                                        ("{amount}", &money(account, deficit)),
                                    ],
                                )),
                        ),
                )
                .child(
                    kit::button(
                        ("risk-see-day", 0usize),
                        message("projection.risk.see").to_string(),
                    )
                    .control(message("projection.risk.see").to_string())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_projection_day(Some(date), cx);
                    })),
                )
                .into_any_element(),
        );
    } else {
        children.push(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .p(px(12.))
                .rounded(px(theme::radius("radius-md")))
                .bg(color("sunk"))
                .child(kit::icon("trend-up", "added", 15.))
                .child(
                    div()
                        .text_size(px(12.5))
                        .line_height(px(17.))
                        .text_color(color("ink-2"))
                        .child(fill(
                            "projection.ok",
                            &[("{date}", &format::short_date(base.to))],
                        )),
                )
                .into_any_element(),
        );
    }

    scroll_page(app.page, children).into_any_element()
}

fn scenario_stat(label_key: &'static str, account: Currency, value: i64, delta: i64) -> Div {
    div()
        .bg(color("sunk"))
        .rounded(px(theme::radius("radius-sm")))
        .p(px(10.))
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(kit::caps(message(label_key)))
        .child(
            div()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(14.))
                .line_height(px(18.))
                .text_color(color("ink"))
                .child(money(account, value)),
        )
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(10.5))
                .line_height(px(14.))
                .text_color(color(if delta < 0 { "broken" } else { "added" }))
                .child(format::signed_money(Money {
                    minor: delta,
                    currency: account,
                })),
        )
}
