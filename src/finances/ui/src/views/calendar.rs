//! Calendar: the month grid with the charges, income and expenses of each
//! day and the projected closing balance, plus previous/next month and a
//! detail panel for the selected day. Read-only until the store is
//! connected: the add actions stay disabled with a tooltip.

use crate::data::{Currency, Money};
use crate::format;
use crate::kit::{self, Control};
use crate::language::{self, fill, message};
use crate::model::{self, DayEvent, EventKind, EventSource};
use crate::shell::FinancesApp;
use crate::theme::{self, TypeScale, color};
use crate::views::{
    self, card, disabled_action, empty_state, icon_button, page_header, scroll_page, stat_tile,
};
use chrono::{Datelike, NaiveDate};
use gpui::{prelude::*, *};

fn money(account: Currency, minor: i64) -> String {
    format::money(Money {
        minor,
        currency: account,
    })
}

fn source_key(source: EventSource) -> &'static str {
    match source {
        EventSource::Subscription => "projection.source.subscription",
        EventSource::Income => "projection.source.income",
        EventSource::Expense => "projection.source.expense",
        EventSource::Scenario => "projection.source.scenario",
    }
}

/// One event chip inside a calendar cell.
fn cell_event(event: &DayEvent) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(4.))
        .min_w_0()
        .rounded(px(theme::radius("radius-xs")))
        .px(px(4.))
        .py(px(1.))
        .bg(color("sunk"))
        .child(div().size(px(5.)).flex_shrink_0().rounded_full().bg(color(
            if event.kind == EventKind::Income {
                "added"
            } else {
                "broken"
            },
        )))
        .child(
            div()
                .truncate()
                .text_size(px(9.5))
                .line_height(px(12.))
                .text_color(color("ink-2"))
                .child(event.name.clone()),
        )
}

/// What one calendar cell shows, bundled so `day_cell` stays readable.
struct CellInput<'a> {
    date: NaiveDate,
    in_month: bool,
    today: NaiveDate,
    selected: Option<NaiveDate>,
    events: Vec<&'a DayEvent>,
    balance_label: Option<String>,
    balance_negative: bool,
}

fn day_cell(input: CellInput, cx: &mut Context<FinancesApp>) -> Stateful<Div> {
    let CellInput {
        date,
        in_month,
        today,
        selected,
        events,
        balance_label,
        balance_negative,
    } = input;
    let is_today = date == today;
    let is_selected = selected == Some(date);
    div()
        .id(("cal-day", date.num_days_from_ce() as usize))
        .min_h(px(72.))
        .p(px(6.))
        .flex()
        .flex_col()
        .gap(px(3.))
        .cursor_pointer()
        .bg(color(if is_selected { "sunk" } else { "raised" }))
        .opacity(if in_month { 1. } else { 0.45 })
        .hover(|s| s.bg(color("sunk")))
        .child(
            div()
                .flex()
                .items_start()
                .justify_between()
                .gap(px(2.))
                .child(
                    div()
                        .size(px(18.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .when(is_today, |s| s.bg(color("live")))
                        .font_family(theme::MONO)
                        .text_size(px(10.5))
                        .font_weight(if is_today {
                            FontWeight::BOLD
                        } else {
                            FontWeight::NORMAL
                        })
                        .text_color(color(if is_today { "on-live" } else { "ink-2" }))
                        .child(date.day().to_string()),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(9.5))
                        .line_height(px(12.))
                        .text_color(color(if balance_negative { "broken" } else { "ink-2" }))
                        .child(balance_label.unwrap_or_default()),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .children(events.iter().take(2).map(|e| cell_event(e)))
                .when(events.len() > 2, |s| {
                    s.child(
                        div()
                            .font_family(theme::MONO)
                            .text_size(px(9.))
                            .line_height(px(12.))
                            .text_color(color("ink-2"))
                            .child(format!("+{}", events.len() - 2)),
                    )
                }),
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select_calendar_day(Some(date), cx);
        }))
}

fn event_row(event: &DayEvent, account: Currency) -> Div {
    let income = event.kind == EventKind::Income;
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(12.))
        .py(px(8.))
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
                        .font_family(theme::MONO)
                        .text_size(px(10.5))
                        .line_height(px(14.))
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

    let year = app.calendar.year;
    let month = app.calendar.month;
    let grid = model::month_grid(year, month);
    let grid_from = grid.first().and_then(|w| w.first()).copied();
    let grid_to = grid.last().and_then(|w| w.last()).copied();
    let (Some(grid_from), Some(grid_to)) = (grid_from, grid_to) else {
        return scroll_page(
            app.page,
            vec![page_header(app, "calendar.subtitle", vec![]).into_any_element()],
        )
        .into_any_element();
    };

    let events = model::collect_events(
        &data.subscriptions(),
        &data.movements(),
        account,
        &rate,
        grid_from,
        grid_to,
    );
    let mut by_date: std::collections::BTreeMap<NaiveDate, Vec<&DayEvent>> =
        std::collections::BTreeMap::new();
    for event in &events {
        by_date.entry(event.date).or_default().push(event);
    }
    let anchor_minor = model::to_account_minor(data.balance(), account, &rate);
    let projection = model::project(
        anchor_minor,
        data.balance_date(),
        &events,
        grid_from,
        grid_to,
        &[],
    );
    let balances: std::collections::BTreeMap<NaiveDate, i64> = projection
        .days
        .iter()
        .map(|d| (d.date, d.balance))
        .collect();

    // The month's totals and month-end balance.
    let month_events = model::collect_events(
        &data.subscriptions(),
        &data.movements(),
        account,
        &rate,
        model::start_of_month(NaiveDate::from_ymd_opt(year, month, 1).expect("month")),
        model::end_of_month(NaiveDate::from_ymd_opt(year, month, 1).expect("month")),
    );
    let totals = model::totals_for_month(&month_events, year, month);
    let month_projection = model::project(
        anchor_minor,
        data.balance_date(),
        &month_events,
        model::start_of_month(NaiveDate::from_ymd_opt(year, month, 1).expect("month")),
        model::end_of_month(NaiveDate::from_ymd_opt(year, month, 1).expect("month")),
        &[],
    );
    let month_end = if month_projection.days.is_empty() {
        None
    } else {
        Some(month_projection.end_balance)
    };
    let month_event_count = month_events
        .iter()
        .filter(|e| e.date.year() == year && e.date.month() == month)
        .count();

    let selected = app.calendar.selected;
    let selected_events: Vec<&DayEvent> = selected
        .and_then(|d| by_date.get(&d))
        .cloned()
        .unwrap_or_default();
    let selected_balance = selected.and_then(|d| balances.get(&d)).copied();

    // The month grid.
    let cells: Vec<AnyElement> = grid
        .iter()
        .flatten()
        .map(|date| {
            let in_month = date.year() == year && date.month() == month;
            let day_events: Vec<&DayEvent> = by_date.get(date).cloned().unwrap_or_default();
            let balance = balances.get(date).copied();
            day_cell(
                CellInput {
                    date: *date,
                    in_month,
                    today,
                    selected,
                    events: day_events,
                    balance_label: balance.map(|b| {
                        format::compact_money(Money {
                            minor: b,
                            currency: account,
                        })
                    }),
                    balance_negative: balance.map(|b| b < 0).unwrap_or(false),
                },
                cx,
            )
            .into_any_element()
        })
        .collect();

    let weekday_header = div()
        .grid()
        .grid_cols(7)
        .gap(px(1.))
        .bg(color("rule"))
        .border_t_1()
        .border_color(color("rule"))
        .children(language::weekdays_short().iter().map(|d| {
            div()
                .bg(color("sunk"))
                .py(px(6.))
                .text_center()
                .type_scale("mono-caps")
                .text_color(color("ink-2"))
                .child(d.to_string())
                .into_any_element()
        }));

    let grid_el = div()
        .grid()
        .grid_cols(7)
        .gap(px(1.))
        .bg(color("rule"))
        .border_t_1()
        .border_color(color("rule"))
        .children(cells);

    let month_card = card()
        .p(px(0.))
        .gap(px(0.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .p(px(12.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(icon_button(
                            ("cal-prev", 0),
                            "chevron-left",
                            message("calendar.prev").to_string(),
                            cx,
                            |this, cx| this.step_calendar_month(-1, cx),
                        ))
                        .child(
                            div()
                                .min_w(px(150.))
                                .text_center()
                                .text_size(px(14.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(color("ink"))
                                .child(format::month_label(year, month)),
                        )
                        .child(icon_button(
                            ("cal-next", 0),
                            "chevron-right",
                            message("calendar.next").to_string(),
                            cx,
                            |this, cx| this.step_calendar_month(1, cx),
                        )),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .h(px(20.))
                                .px(px(8.))
                                .flex()
                                .items_center()
                                .rounded_full()
                                .bg(color("sunk"))
                                .font_family(theme::MONO)
                                .text_size(px(10.5))
                                .line_height(px(14.))
                                .text_color(color("ink-2"))
                                .child(fill(
                                    "calendar.count",
                                    &[("{count}", &month_event_count.to_string())],
                                )),
                        )
                        .child(
                            kit::button(
                                ("cal-today", 0usize),
                                message("calendar.today").to_string(),
                            )
                            .control(message("calendar.today").to_string())
                            .on_click(cx.listener(|this, _, _, cx| this.go_calendar_today(cx))),
                        ),
                ),
        )
        .child(weekday_header)
        .child(grid_el)
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(12.))
                .p(px(12.))
                .border_t_1()
                .border_color(color("rule"))
                .child(legend_dot("added", "calendar.legend.income"))
                .child(legend_dot("broken", "calendar.legend.expense"))
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(10.5))
                        .line_height(px(14.))
                        .text_color(color("ink-2"))
                        .child(message("calendar.legend.balance")),
                ),
        );

    // The selected day's panel.
    let day_panel = card().w(px(320.)).flex_shrink_0().child(match selected {
        Some(date) => {
            let rows: Vec<AnyElement> = selected_events
                .iter()
                .map(|e| event_row(e, account).into_any_element())
                .collect();
            div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(
                    div()
                        .flex()
                        .items_start()
                        .justify_between()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.))
                                .child(
                                    div()
                                        .text_size(px(13.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(color("ink"))
                                        .child(format::long_date(date)),
                                )
                                .child(
                                    div()
                                        .font_family(theme::MONO)
                                        .text_size(px(11.))
                                        .line_height(px(15.))
                                        .text_color(color("ink-2"))
                                        .child(format!(
                                            "{} · {}",
                                            format::weekday_short(date),
                                            format::relative_day_label(date, today)
                                        )),
                                ),
                        )
                        .child(
                            div()
                                .text_right()
                                .child(kit::caps(message("calendar.day.balance")))
                                .child(
                                    div()
                                        .font_family(theme::MONO)
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_size(px(14.))
                                        .line_height(px(18.))
                                        .text_color(color(
                                            if selected_balance.map(|b| b < 0).unwrap_or(false) {
                                                "broken"
                                            } else {
                                                "ink"
                                            },
                                        ))
                                        .child(match selected_balance {
                                            Some(b) => money(account, b),
                                            None => "—".to_string(),
                                        }),
                                ),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(8.))
                        .child(
                            disabled_action(
                                ("cal-add-expense", 0),
                                "plus",
                                "calendar.action.expense",
                            )
                            .into_any_element(),
                        )
                        .child(
                            disabled_action(
                                ("cal-add-income", 0),
                                "plus",
                                "calendar.action.income",
                            )
                            .into_any_element(),
                        ),
                )
                .child(div().h(px(1.)).bg(color("rule")))
                .child(if rows.is_empty() {
                    empty_state(
                        "calendar-days",
                        "calendar.day.none.title",
                        Some("calendar.day.none.body"),
                    )
                    .into_any_element()
                } else {
                    div()
                        .id("cal-day-events")
                        .max_h(px(360.))
                        .overflow_y_scroll()
                        .flex()
                        .flex_col()
                        .children(rows)
                        .into_any_element()
                })
                .when_some(selected_balance.filter(|b| *b < 0), |s, _| {
                    s.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .p(px(10.))
                            .rounded(px(theme::radius("radius-sm")))
                            .bg(color("sunk"))
                            .border_1()
                            .border_color(color("broken"))
                            .child(kit::icon("alert", "broken", 14.))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(color("ink"))
                                    .child(message("calendar.day.negative")),
                            ),
                    )
                })
                .into_any_element()
        }
        None => empty_state(
            "calendar-days",
            "calendar.day.empty.title",
            Some("calendar.day.empty.body"),
        )
        .into_any_element(),
    });

    let children: Vec<AnyElement> = vec![
        page_header(
            app,
            "calendar.subtitle",
            vec![
                disabled_action(("add-expense", 0), "plus", "calendar.action.expense")
                    .into_any_element(),
                disabled_action(("add-income", 0), "plus", "calendar.action.income")
                    .into_any_element(),
            ],
        )
        .into_any_element(),
        div()
            .grid()
            .grid_cols(4)
            .gap(px(12.))
            .child(stat_tile(
                message("calendar.income"),
                money(account, totals.income),
                None,
                Some("added"),
            ))
            .child(stat_tile(
                message("calendar.expense"),
                money(account, totals.expense),
                None,
                None,
            ))
            .child(stat_tile(
                message("calendar.subscriptions"),
                money(account, totals.subscriptions),
                None,
                None,
            ))
            .child(stat_tile(
                message("calendar.monthend"),
                match month_end {
                    Some(b) => money(account, b),
                    None => "—".to_string(),
                },
                None,
                Some(match month_end {
                    Some(b) if b < 0 => "broken",
                    _ => "ink",
                }),
            ))
            .into_any_element(),
        div()
            .flex()
            .flex_row()
            .gap(px(16.))
            .items_start()
            .child(month_card.flex_1().min_w_0())
            .child(day_panel)
            .into_any_element(),
        div()
            .font_family(theme::MONO)
            .text_size(px(11.))
            .line_height(px(15.))
            .text_color(color("ink-2"))
            .child(message("calendar.footer"))
            .into_any_element(),
    ];

    scroll_page(app.page, children).into_any_element()
}

fn legend_dot(token: &'static str, key: &'static str) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .child(div().size(px(6.)).rounded_full().bg(color(token)))
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(10.5))
                .line_height(px(14.))
                .text_color(color("ink-2"))
                .child(message(key)),
        )
}
