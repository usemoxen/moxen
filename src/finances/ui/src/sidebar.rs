//! The left navigation: the account selector on top (every active account
//! plus the "all accounts" aggregate, with the approximate badge when a
//! conversion rate is missing), then the grouped pages with an icon and a
//! label, the selected one on a `sunk` row.

use crate::data::AccountSelection;
use crate::kit;
use crate::language::message;
use crate::shell::{FinancesApp, Page};
use crate::theme::{self, color};
use gpui::{prelude::*, *};

const GROUPS: &[(&str, &[Page])] = &[
    ("group.overview", &[Page::Dashboard]),
    (
        "group.tracking",
        &[
            Page::Subscriptions,
            Page::Movements,
            Page::Projection,
            Page::Calendar,
            Page::Analysis,
        ],
    ),
    ("group.system", &[Page::Settings]),
];

/// One row of the account selector.
#[allow(clippy::too_many_arguments)]
fn account_row(
    index: usize,
    icon_name: &'static str,
    label: String,
    right: Option<String>,
    approximate: bool,
    selected: bool,
    selection: AccountSelection,
    cx: &mut Context<FinancesApp>,
) -> Stateful<Div> {
    let mut row = div()
        .id(("account", index))
        .h(px(30.))
        .px(px(10.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(theme::radius("radius-sm")))
        .cursor_pointer()
        .text_size(px(13.5))
        .line_height(px(17.5))
        .text_color(color(if selected { "ink" } else { "ink-2" }))
        .when(selected, |s| s.bg(color("sunk")))
        .hover(|s| s.bg(color("sunk")))
        .child(kit::icon(
            icon_name,
            if selected { "ink" } else { "ink-2" },
            15.,
        ))
        .child(div().flex_1().min_w_0().truncate().child(label))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select_account(selection.clone(), cx);
        }));
    if let Some(right) = right {
        row = row.child(
            div()
                .flex_shrink_0()
                .font_family(theme::MONO)
                .text_size(px(10.5))
                .line_height(px(14.))
                .text_color(color("ink-2"))
                .child(right),
        );
    }
    if approximate {
        row = row.child(
            div()
                .id(("account-approx", index))
                .h(px(18.))
                .px(px(5.))
                .flex()
                .items_center()
                .rounded_full()
                .bg(color("held"))
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(11.))
                .text_color(color("on-ink"))
                .tooltip(move |_, cx| {
                    cx.new(|_| kit::Tooltip(message("accounts.approx").to_string().into()))
                        .into()
                })
                .child("≈"),
        );
    }
    row
}

pub fn render(app: &FinancesApp, cx: &mut Context<FinancesApp>) -> impl IntoElement {
    let mut nav = div()
        .id("nav")
        .debug_selector(|| "nav".into())
        .w(px(theme::SIDEBAR))
        .flex_shrink_0()
        .h_full()
        .border_r_1()
        .border_color(color("rule"))
        .bg(color("ground"))
        .flex()
        .flex_col()
        .overflow_y_scroll()
        .px(px(8.))
        .py(px(8.));

    // -- the account selector ---------------------------------------------------
    let accounts = app.data.accounts();
    let approximate = app.account.is_all() && app.data.total_approximate();
    nav =
        nav.child(
            div()
                .id("account-selector")
                .debug_selector(|| "account-selector".into())
                .child(
                    div()
                        .px(px(10.))
                        .pt(px(10.))
                        .pb(px(4.))
                        .child(kit::caps(message("accounts.title"))),
                )
                .child(account_row(
                    0,
                    "layers",
                    message("accounts.all").to_string(),
                    None,
                    approximate,
                    app.account.is_all(),
                    AccountSelection::All,
                    cx,
                ))
                .children(accounts.iter().filter(|a| !a.archived).enumerate().map(
                    |(i, account)| {
                        let icon_name = match account.kind {
                            crate::data::AccountKind::CreditCard => "card",
                            _ => "wallet",
                        };
                        account_row(
                            i + 1,
                            icon_name,
                            account.name.clone(),
                            Some(account.currency.code().to_string()),
                            false,
                            app.account == AccountSelection::One(account.id.clone()),
                            AccountSelection::One(account.id.clone()),
                            cx,
                        )
                    },
                )),
        );

    for (group_key, pages) in GROUPS {
        nav = nav.child(
            div()
                .px(px(10.))
                .pt(px(10.))
                .pb(px(4.))
                .child(kit::caps(message(group_key))),
        );
        for page in pages.iter().copied() {
            let selected = app.page == page;
            nav = nav.child(
                div()
                    .id((page.id(), 0usize))
                    .h(px(30.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(theme::radius("radius-sm")))
                    .cursor_pointer()
                    .text_size(px(13.5))
                    .line_height(px(17.5))
                    .text_color(color(if selected { "ink" } else { "ink-2" }))
                    .when(selected, |s| s.bg(color("sunk")))
                    .hover(|s| s.bg(color("sunk")))
                    .child(kit::icon(
                        page.icon(),
                        if selected { "ink" } else { "ink-2" },
                        15.,
                    ))
                    .child(message(page.nav_key()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.set_page(page, cx);
                    })),
            );
        }
    }
    nav
}
