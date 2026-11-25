//! Movements: incomes, expenses and real charges of the subscriptions, with
//! type and status filters, text search, sorting, grouping by month or day
//! and the month's totals. When the data source accepts commands (the store
//! does), the add buttons open the form dialog and every row can be
//! confirmed, edited or deleted; the demo keeps them disabled.

use crate::data::{Movement, MovementKind, MovementStatus};
use crate::dialog::{self, Dialog};
use crate::format;
use crate::kit::{self, Control};
use crate::language::{capitalized, fill, message};
use crate::model::{self, GroupBy, GroupKey, KindFilter, SortOrder, StatusFilter};
use crate::shell::FinancesApp;
use crate::theme::{self, TypeScale, color};
use crate::views::{
    self, card, disabled_action, empty_state, icon_button, page_header, scroll_page, stat_tile,
};
use chrono::Datelike;
use gpui::{prelude::*, *};

fn kind_icon(kind: MovementKind) -> (&'static str, &'static str) {
    match kind {
        MovementKind::Income => ("trend-up", "added"),
        MovementKind::Charge => ("card", "live"),
        MovementKind::Expense => ("wallet", "ink-2"),
    }
}

fn amount_color(kind: MovementKind) -> &'static str {
    match kind {
        MovementKind::Income => "added",
        MovementKind::Charge => "live",
        MovementKind::Expense => "ink",
    }
}

fn status_label(movement: &Movement) -> &'static str {
    if movement.paused {
        "mov.status.paused"
    } else {
        movement.status.key()
    }
}

fn movement_row(
    movement: &Movement,
    index: usize,
    last: bool,
    today: chrono::NaiveDate,
    can_mutate: bool,
    cx: &mut Context<FinancesApp>,
) -> Div {
    let (icon, icon_token) = kind_icon(movement.kind);
    let recurring = movement.frequency != crate::data::Frequency::Once;
    let status_token = if movement.paused {
        "held"
    } else {
        movement.status.token()
    };
    let confirmable = model::matches_status(movement, StatusFilter::Pending);
    let id = movement.id.clone();
    let kind = movement.kind;
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(12.))
        .py(px(8.))
        .when(!last, |s| s.border_b_1().border_color(color("rule")))
        .child(
            div()
                .size(px(28.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(theme::radius("radius-sm")))
                .bg(color("sunk"))
                .border_1()
                .border_color(color("rule"))
                .child(kit::icon(icon, icon_token, 14.)),
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
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(
                            div()
                                .truncate()
                                .text_size(px(13.5))
                                .line_height(px(17.5))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(color("ink"))
                                .child(movement.name.clone()),
                        )
                        .child(div().size(px(6.)).rounded_full().bg(color(status_token)))
                        .child(
                            div()
                                .font_family(theme::FONT)
                                .text_size(px(12.))
                                .line_height(px(17.))
                                .text_color(color("ink-2"))
                                .child(message(status_label(movement))),
                        )
                        .when(recurring, |s| {
                            s.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(3.))
                                    .font_family(theme::FONT)
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .text_color(color("ink-2"))
                                    .child(kit::icon("repeat", "ink-2", 10.))
                                    .child(message(movement.frequency.key())),
                            )
                        }),
                )
                .child(
                    div()
                        .truncate()
                        .font_family(theme::FONT)
                        .text_size(px(12.))
                        .line_height(px(17.))
                        .text_color(color("ink-2"))
                        .child(row_subtitle(movement, today)),
                ),
        )
        .child(
            div()
                .flex_shrink_0()
                .text_right()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(13.))
                .line_height(px(17.))
                .text_color(color(amount_color(movement.kind)))
                .child(
                    if movement.kind == MovementKind::Charge
                        && movement.status == MovementStatus::NotCharged
                    {
                        "—".to_string()
                    } else {
                        // Incomes are positive, expenses and charges negative.
                        let minor = if movement.kind == MovementKind::Income {
                            movement.amount.minor
                        } else {
                            -movement.amount.minor
                        };
                        format::signed_money(crate::data::Money {
                            minor,
                            currency: movement.amount.currency,
                        })
                    },
                ),
        )
        .when(can_mutate, |s| {
            let edit_id = id.clone();
            let delete_id = id.clone();
            s.child(
                div()
                    .flex()
                    .flex_row()
                    .flex_shrink_0()
                    .gap(px(2.))
                    .when(confirmable, |d| {
                        d.child(icon_button(
                            ("mov-confirm", index),
                            "action-check",
                            message("movements.action.confirm").to_string(),
                            cx,
                            move |this, cx| this.confirm_movement(&id, kind, cx),
                        ))
                    })
                    .child(icon_button(
                        ("mov-edit", index),
                        "action-edit",
                        message("movements.action.edit").to_string(),
                        cx,
                        move |this, cx| {
                            dialog::open(
                                this,
                                Dialog::EditMovement {
                                    id: edit_id.clone(),
                                    kind,
                                },
                                cx,
                            );
                        },
                    ))
                    .child(icon_button(
                        ("mov-delete", index),
                        "action-x",
                        message("movements.action.delete").to_string(),
                        cx,
                        move |this, cx| this.delete_movement(&delete_id, kind, cx),
                    )),
            )
        })
}

/// "Category · 25 nov 2026 · 18:30 · Today — notes".
fn row_subtitle(movement: &Movement, today: chrono::NaiveDate) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(category) = &movement.category {
        parts.push(category.get().to_string());
    }
    parts.push(format::short_date(movement.date));
    if let Some(time) = &movement.time {
        parts.push(time.clone());
    }
    let recurring = movement.frequency != crate::data::Frequency::Once;
    if recurring {
        parts.push(fill(
            "mov.from",
            &[("{date}", &format::short_date(movement.date))],
        ));
    } else {
        let relative = format::relative_day_label(movement.date, today);
        if relative != format::short_date(movement.date) {
            parts.push(relative);
        }
    }
    if let Some(notes) = &movement.notes {
        parts.push(format!("— {}", notes.get()));
    }
    parts.join(" · ")
}

fn group_label(key: &GroupKey) -> String {
    match key {
        GroupKey::Month(year, month) => format::month_label(*year, *month),
        GroupKey::Day(date) => capitalized(&format::long_date(*date)),
    }
}

/// The header's add buttons: live dialogs when the data source accepts
/// commands, disabled with a tooltip otherwise.
fn movement_actions(app: &FinancesApp, cx: &mut Context<FinancesApp>) -> Vec<AnyElement> {
    [
        (
            "add-income",
            "trend-up",
            "movements.action.income",
            MovementKind::Income,
        ),
        (
            "add-expense",
            "plus",
            "movements.action.expense",
            MovementKind::Expense,
        ),
        (
            "add-charge",
            "card",
            "movements.action.charge",
            MovementKind::Charge,
        ),
    ]
    .iter()
    .map(|(id, icon, key, kind)| {
        if app.can_mutate() {
            let kind = *kind;
            kit::icon_label_button((*id, 0usize), icon, message(key).to_string())
                .control(message(key))
                .on_click(cx.listener(move |this, _, _, cx| {
                    dialog::open(this, Dialog::NewMovement(kind), cx);
                }))
                .into_any_element()
        } else {
            disabled_action((*id, 0usize), icon, key).into_any_element()
        }
    })
    .collect()
}

pub fn render(app: &FinancesApp, window: &mut Window, cx: &mut Context<FinancesApp>) -> AnyElement {
    if !app.data.is_ready() {
        return views::loading_page(app.page);
    }
    let data = &app.data;
    let today = data.today();
    let account = data.account_currency();
    let rate = |from, to| data.exchange_rate(from, to);
    let movements = data.movements();
    let filter = app.movements.filter.clone();
    let can_mutate = app.can_mutate();

    let incomes_count = movements
        .iter()
        .filter(|m| m.kind == MovementKind::Income)
        .count();
    let expenses_count = movements.len() - incomes_count;
    let pending_count = movements
        .iter()
        .filter(|m| model::matches_status(m, StatusFilter::Pending))
        .count();

    // The month's totals come from the projected events, like the reference.
    let month_events = model::collect_events(
        &data.subscriptions(),
        &movements,
        account,
        &rate,
        model::start_of_month(today),
        model::end_of_month(today),
    );
    let totals = model::totals_for_month(&month_events, today.year(), today.month());

    let filtered = model::filter_movements(&movements, &filter, account, &rate);
    let groups = model::group_movements(&filtered, filter.group_by);

    let kind_options = [
        format!("{} ({})", message("movements.tab.all"), movements.len()),
        format!("{} ({incomes_count})", message("movements.tab.incomes")),
        format!("{} ({expenses_count})", message("movements.tab.expenses")),
    ]
    .map(SharedString::from);
    let kind_selected = match filter.kind {
        KindFilter::All => 0,
        KindFilter::Incomes => 1,
        KindFilter::Expenses => 2,
    };
    let status_options: [SharedString; 4] = [
        message("movements.status.all"),
        message("movements.status.pending"),
        message("movements.status.done"),
        message("movements.status.paused"),
    ]
    .map(SharedString::from);
    let status_selected = match filter.status {
        StatusFilter::All => 0,
        StatusFilter::Pending => 1,
        StatusFilter::Done => 2,
        StatusFilter::Paused => 3,
    };
    let sort_options: [SharedString; 2] = [
        message("movements.sort.date"),
        message("movements.sort.amount"),
    ]
    .map(SharedString::from);
    let sort_selected = match filter.sort {
        SortOrder::Date => 0,
        SortOrder::Amount => 1,
    };
    let group_options: [SharedString; 2] = [
        message("movements.group.month"),
        message("movements.group.day"),
    ]
    .map(SharedString::from);
    let group_selected = match filter.group_by {
        GroupBy::Month => 0,
        GroupBy::Day => 1,
    };

    let mut children: Vec<AnyElement> = vec![
        page_header(app, "movements.subtitle", movement_actions(app, cx)).into_any_element(),
        // The month's totals.
        div()
            .flex()
            .flex_row()
            .gap(px(12.))
            .child(stat_tile(
                message("movements.income.month"),
                format::money(crate::data::Money {
                    minor: totals.income,
                    currency: account,
                }),
                Some(message("movements.income.note").to_string()),
                Some("added"),
            ))
            .child(stat_tile(
                message("movements.expense.month"),
                format::money(crate::data::Money {
                    minor: totals.expense,
                    currency: account,
                }),
                Some(if totals.subscriptions > 0 {
                    fill(
                        "movements.expense.note.subs",
                        &[(
                            "{amount}",
                            &format::money(crate::data::Money {
                                minor: totals.subscriptions,
                                currency: account,
                            }),
                        )],
                    )
                } else {
                    message("movements.expense.note.none").to_string()
                }),
                None,
            ))
            .child(stat_tile(
                message("movements.net"),
                format::signed_money(crate::data::Money {
                    minor: totals.net,
                    currency: account,
                }),
                Some(fill(
                    if pending_count == 1 {
                        "movements.pending.one"
                    } else {
                        "movements.pending.other"
                    },
                    &[("{count}", &pending_count.to_string())],
                )),
                Some(if totals.net >= 0 { "added" } else { "broken" }),
            ))
            .into_any_element(),
        // The toolbar, in two rows: what is listed (kind and search), then
        // how it is narrowed (status) and arranged (sort and grouping).
        {
            let row = || div().flex().flex_wrap().items_center().gap(px(8.));
            let kind = kit::segmented(
                "movements-kind",
                &kind_options,
                kind_selected,
                cx,
                |this, i, cx| {
                    this.set_movements_kind(
                        match i {
                            1 => KindFilter::Incomes,
                            2 => KindFilter::Expenses,
                            _ => KindFilter::All,
                        },
                        cx,
                    );
                },
            );
            let search = div().flex_1().min_w(px(200.)).child(kit::search_field(
                "movements-search",
                &filter.query,
                message("movements.search.placeholder"),
                window,
                cx,
                |this, query, cx| this.set_movements_query(query, cx),
            ));
            let status = kit::segmented(
                "movements-status",
                &status_options,
                status_selected,
                cx,
                |this, i, cx| {
                    this.set_movements_status(
                        match i {
                            1 => StatusFilter::Pending,
                            2 => StatusFilter::Done,
                            3 => StatusFilter::Paused,
                            _ => StatusFilter::All,
                        },
                        cx,
                    );
                },
            );
            let sort = kit::segmented(
                "movements-sort",
                &sort_options,
                sort_selected,
                cx,
                |this, i, cx| {
                    this.set_movements_sort(
                        if i == 1 {
                            SortOrder::Amount
                        } else {
                            SortOrder::Date
                        },
                        cx,
                    )
                },
            );
            let group = kit::segmented(
                "movements-group",
                &group_options,
                group_selected,
                cx,
                |this, i, cx| {
                    this.set_movements_group_by(
                        if i == 1 { GroupBy::Day } else { GroupBy::Month },
                        cx,
                    )
                },
            );
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(row().child(kind).child(search))
                .child(
                    row()
                        .child(status)
                        .child(div().flex_1())
                        .child(sort)
                        .child(group),
                )
                .into_any_element()
        },
    ];

    if movements.is_empty() {
        children.push(
            card()
                .child(empty_state(
                    "nav-movements",
                    "movements.empty.title",
                    Some("movements.empty.body"),
                ))
                .into_any_element(),
        );
    } else if filtered.is_empty() {
        children.push(
            card()
                .child(empty_state(
                    "search",
                    "movements.noresults.title",
                    Some("movements.noresults.body"),
                ))
                .into_any_element(),
        );
    } else {
        for group in &groups {
            let net = model::group_net(&group.items, account, &rate);
            let rows: Vec<AnyElement> = group
                .items
                .iter()
                .enumerate()
                .map(|(i, m)| {
                    movement_row(m, i, i + 1 == group.items.len(), today, can_mutate, cx)
                        .into_any_element()
                })
                .collect();
            children.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .px(px(2.))
                            .child(
                                div()
                                    .type_scale("mono-caps")
                                    .text_color(color("ink-2"))
                                    .child(group_label(&group.key)),
                            )
                            .child(div().flex_1().h(px(1.)).bg(color("rule")))
                            .child(
                                div()
                                    .font_family(theme::MONO)
                                    .text_size(px(10.5))
                                    .line_height(px(14.))
                                    .text_color(color("ink-2"))
                                    .child(fill(
                                        "mov.count",
                                        &[("{count}", &group.items.len().to_string())],
                                    )),
                            )
                            .child(
                                div()
                                    .font_family(theme::MONO)
                                    .text_size(px(10.5))
                                    .line_height(px(14.))
                                    .text_color(color(if net >= 0 { "added" } else { "broken" }))
                                    .child(format::signed_money(crate::data::Money {
                                        minor: net,
                                        currency: account,
                                    })),
                            ),
                    )
                    .child(card().p(px(0.)).gap(px(0.)).children(rows))
                    .into_any_element(),
            );
        }
    }

    children.push(
        div()
            .font_family(theme::FONT)
            .text_size(px(12.))
            .line_height(px(17.))
            .text_color(color("ink-2"))
            .child(message("movements.footer"))
            .into_any_element(),
    );

    scroll_page(app.page, children).into_any_element()
}
