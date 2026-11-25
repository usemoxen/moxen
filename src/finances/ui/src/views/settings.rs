//! Settings: the interface language and theme, the data section (the database
//! path, JSON backup export/restore, CSV export) and the account management
//! (create, rename, archive, delete, transfers). The data actions go through
//! the same [`FinancesMutations`] commands as the pages; the demo shows them
//! disabled.

use crate::commands::CsvSheet;
use crate::dialog::{self, Dialog};
use crate::kit::{self, Control};
use crate::language::{Language, message};
use crate::shell::FinancesApp;
use crate::theme::{self, ThemeMode, TypeScale, color};
use crate::views::{card, icon_button, scroll_page};
use gpui::{prelude::*, *};

fn setting_row(label: &str, description: &str, control: impl IntoElement) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(16.))
        .py(px(12.))
        .border_b_1()
        .border_color(color("rule"))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(17.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(color("ink"))
                        .child(label.to_string()),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .text_color(color("ink-2"))
                        .child(description.to_string()),
                ),
        )
        .child(control)
}

fn section(title_key: &'static str, children: Vec<AnyElement>) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(kit::caps(message(title_key)))
        .child(
            div()
                .bg(color("raised"))
                .rounded(px(theme::radius("radius-md")))
                .px(px(16.))
                .children(children),
        )
}

/// A small labeled button for the settings rows.
fn row_button(
    id: (&'static str, usize),
    label_key: &'static str,
    enabled: bool,
    cx: &mut Context<FinancesApp>,
    on_click: impl Fn(&mut FinancesApp, &mut Context<FinancesApp>) + Clone + 'static,
) -> Stateful<Div> {
    if enabled {
        kit::button(id, message(label_key).to_string())
            .control(message(label_key))
            .on_click(cx.listener(move |this, _, _, cx| on_click(this, cx)))
    } else {
        kit::button(id, message(label_key).to_string()).disabled(message("settings.readonly"))
    }
}

/// One account's row in the management list.
fn account_row(app: &FinancesApp, index: usize, cx: &mut Context<FinancesApp>) -> Div {
    let account = app.data.accounts()[index].clone();
    let can_mutate = app.can_mutate();
    let rename_id = account.id.clone();
    let archive_id = account.id.clone();
    let delete_id = account.id.clone();
    let archived = account.archived;
    div()
        .flex()
        .items_center()
        .gap(px(12.))
        .py(px(10.))
        .border_b_1()
        .border_color(color("rule"))
        .when(archived, |s| s.opacity(0.55))
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
                        .gap(px(8.))
                        .child(
                            div()
                                .truncate()
                                .text_size(px(13.))
                                .line_height(px(17.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(color("ink"))
                                .child(account.name.clone()),
                        )
                        .when(archived, |s| {
                            s.child(
                                div()
                                    .px(px(6.))
                                    .py(px(1.))
                                    .rounded_full()
                                    .bg(color("sunk"))
                                    .font_family(theme::MONO)
                                    .text_size(px(10.))
                                    .text_color(color("ink-2"))
                                    .child(message("accounts.archived")),
                            )
                        }),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(11.))
                        .line_height(px(14.))
                        .text_color(color("ink-2"))
                        .child(format!(
                            "{} · {}",
                            message(account.kind.key()),
                            account.currency.code()
                        )),
                ),
        )
        .child(
            div()
                .flex_shrink_0()
                .font_family(theme::MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(12.5))
                .text_color(color("ink"))
                .child(crate::format::money(account.balance)),
        )
        .when(can_mutate, |s| {
            s.child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(2.))
                    .child(icon_button(
                        ("acc-rename", index),
                        "action-edit",
                        message("accounts.rename").to_string(),
                        cx,
                        move |this, cx| {
                            dialog::open(this, Dialog::RenameAccount(rename_id.clone()), cx)
                        },
                    ))
                    .child(icon_button(
                        ("acc-archive", index),
                        if archived {
                            "rotate-ccw"
                        } else {
                            "action-pause"
                        },
                        message(if archived {
                            "accounts.unarchive"
                        } else {
                            "accounts.archive"
                        })
                        .to_string(),
                        cx,
                        move |this, cx| {
                            let id = archive_id.clone();
                            let archived = !archived;
                            this.run_mutation(cx, move |m| m.set_account_archived(&id, archived));
                        },
                    ))
                    .child(icon_button(
                        ("acc-delete", index),
                        "action-x",
                        message("accounts.delete").to_string(),
                        cx,
                        move |this, cx| {
                            let id = delete_id.clone();
                            this.run_mutation(cx, move |m| m.delete_account(&id));
                        },
                    )),
            )
        })
}

pub fn render(app: &mut FinancesApp, cx: &mut Context<FinancesApp>) -> impl IntoElement {
    let languages = [
        Language::English.label().into(),
        Language::Spanish.label().into(),
    ];
    let language_selected = match app.language() {
        Language::English => 0,
        Language::Spanish => 1,
    };
    let themes = [
        message("settings.theme.dark").into(),
        message("settings.theme.light").into(),
    ];
    let theme_selected = match app.theme {
        ThemeMode::Dark => 0,
        ThemeMode::Light => 1,
    };

    // -- the data section -------------------------------------------------------
    let can_mutate = app.can_mutate();
    let db_path = app
        .data
        .database_path()
        .unwrap_or_else(|| message("settings.db.none").to_string());
    let csv_options: [SharedString; 5] = CsvSheet::ALL.map(|sheet| message(sheet.key()).into());
    let csv_selected = app.csv_sheet.min(CsvSheet::ALL.len() - 1);

    let data_children: Vec<AnyElement> = vec![
        setting_row(
            message("settings.db"),
            message("settings.db.description"),
            div()
                .max_w(px(360.))
                .truncate()
                .font_family(theme::MONO)
                .text_size(px(11.5))
                .line_height(px(15.))
                .text_color(color("ink-2"))
                .child(db_path),
        )
        .into_any_element(),
        setting_row(
            message("settings.backup"),
            message("settings.backup.description"),
            div()
                .flex()
                .flex_row()
                .gap(px(8.))
                .child(row_button(
                    ("backup-export", 0usize),
                    "settings.backup.export",
                    can_mutate && app.data.database_path().is_some(),
                    cx,
                    |this, cx| this.export_backup(cx),
                ))
                .child(row_button(
                    ("backup-restore", 0usize),
                    "settings.backup.restore",
                    can_mutate,
                    cx,
                    |this, cx| dialog::open(this, Dialog::RestoreBackup, cx),
                )),
        )
        .into_any_element(),
        setting_row(
            message("settings.csv"),
            message("settings.csv.description"),
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .child(kit::segmented(
                    "csv-sheet",
                    &csv_options,
                    csv_selected,
                    cx,
                    |this, i, cx| {
                        this.csv_sheet = i;
                        cx.notify();
                    },
                ))
                .child(row_button(
                    ("csv-export", 0usize),
                    "settings.csv.export",
                    can_mutate && app.data.database_path().is_some(),
                    cx,
                    |this, cx| this.export_csv(cx),
                )),
        )
        .into_any_element(),
    ];

    // -- the accounts section ---------------------------------------------------
    let accounts = app.data.accounts();
    let mut account_children: Vec<AnyElement> = Vec::new();
    for index in 0..accounts.len() {
        account_children.push(account_row(app, index, cx).into_any_element());
    }
    if accounts.is_empty() {
        account_children.push(
            div()
                .py(px(8.))
                .text_size(px(13.))
                .text_color(color("ink-2"))
                .child(message("accounts.empty"))
                .into_any_element(),
        );
    }
    account_children.push(
        div()
            .flex()
            .flex_row()
            .gap(px(8.))
            .pt(px(4.))
            .child(row_button(
                ("account-new", 0usize),
                "accounts.new",
                can_mutate,
                cx,
                |this, cx| dialog::open(this, Dialog::NewAccount, cx),
            ))
            .child(row_button(
                ("account-transfer", 0usize),
                "accounts.transfer",
                can_mutate && accounts.iter().filter(|a| !a.archived).count() >= 2,
                cx,
                |this, cx| dialog::open(this, Dialog::Transfer, cx),
            ))
            .into_any_element(),
    );
    // The selector itself lives in the sidebar; this section manages the
    // accounts.
    scroll_page(
        app.page,
        vec![
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
                .into_any_element(),
            section(
                "settings.section.interface",
                vec![
                    setting_row(
                        message("settings.language"),
                        message("settings.language.description"),
                        kit::segmented(
                            "language",
                            &languages,
                            language_selected,
                            cx,
                            |this, i, cx| {
                                let language = if i == 1 {
                                    Language::Spanish
                                } else {
                                    Language::English
                                };
                                this.set_language(language, cx);
                            },
                        ),
                    )
                    .into_any_element(),
                    setting_row(
                        message("settings.theme"),
                        message("settings.theme.description"),
                        kit::segmented("theme", &themes, theme_selected, cx, |this, i, cx| {
                            this.set_theme(
                                if i == 1 {
                                    ThemeMode::Light
                                } else {
                                    ThemeMode::Dark
                                },
                                cx,
                            );
                        }),
                    )
                    .into_any_element(),
                ],
            )
            .into_any_element(),
            section("settings.section.data", data_children).into_any_element(),
            section("settings.section.accounts", account_children).into_any_element(),
            card().child(message("settings.hint")).into_any_element(),
        ],
    )
}
