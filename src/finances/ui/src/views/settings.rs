//! Settings: the interface language and theme, the data section (the database
//! path, JSON backup export/restore, CSV export), the bank sync (LOCAL-031) and
//! the account management (create, rename, archive, delete, transfers). The
//! data actions go through the same [`FinancesMutations`] commands as the
//! pages; the demo shows them disabled.
//!
//! The bank section never sees a key: it asks for an application id (public), a
//! PEM file path (read once by the data source, then forgotten) and the bank to
//! link. Everything it draws comes from [`crate::data::BankSyncState`], the
//! plain DTO the app's adapter fills, so this crate links neither the banking
//! crate nor SQLite nor a keychain.

use crate::commands::{BANK_SYNC_INTERVALS, CsvSheet};
use crate::data::{BankConnectionInfo, BankConsent, BankSyncState};
use crate::dialog::{self, Dialog};
use crate::kit::{self, Control};
use crate::language::{Language, fill, message};
use crate::shell::FinancesApp;
use crate::theme::{self, ThemeMode, TypeScale, color};
use crate::views::{icon_button, scroll_page};
use gpui::{prelude::*, *};

fn setting_row(label: &str, description: &str, control: impl IntoElement) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(16.))
        .py(px(12.))
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
                // A rule between two rows, never after the last one.
                .children(children.into_iter().enumerate().map(|(i, child)| {
                    div()
                        .when(i > 0, |s| s.border_t_1().border_color(color("rule")))
                        .child(child)
                })),
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

/// The label of one automatic-sync period.
fn interval_label(minutes: Option<u32>) -> &'static str {
    match minutes {
        None => "settings.bank.interval.off",
        Some(15) => "settings.bank.interval.15",
        Some(60) => "settings.bank.interval.60",
        Some(360) => "settings.bank.interval.360",
        Some(1_440) => "settings.bank.interval.1440",
        // A period a later build wrote keeps its place in the picker.
        Some(_) => "settings.bank.interval.off",
    }
}

/// The line a linked bank shows about its consent, in the token that says how
/// urgent it is. Expiring and expired both ask for a new link.
fn consent_line(connection: &BankConnectionInfo) -> Div {
    let (key, token, icon_name) = match connection.consent {
        BankConsent::Valid => ("settings.bank.consent.valid", "added", "action-check"),
        BankConsent::Expiring => ("settings.bank.consent.expiring", "held", "alert"),
        BankConsent::Expired => ("settings.bank.consent.expired", "broken", "alert"),
        BankConsent::Unknown => ("settings.bank.consent.unknown", "label-8", "calendar-days"),
    };
    let text = match connection.consent_until {
        Some(date) => fill(key, &[("{date}", &crate::format::iso_date(date))]),
        None => message(key).to_string(),
    };
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .py(px(6.))
        .px(px(8.))
        .rounded(px(theme::radius("radius-sm")))
        .bg(color("sunk"))
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(color(token))
        .child(kit::icon(icon_name, token, 13.))
        .child(div().flex_1().min_w_0().truncate().child(text))
}

/// One linked bank: its consent, what it last did, the mapping of each of its
/// accounts onto a local account, and the actions that change any of that.
fn connection_block(
    app: &FinancesApp,
    connection: &BankConnectionInfo,
    index: usize,
    cx: &mut Context<FinancesApp>,
) -> AnyElement {
    let can_mutate = app.can_mutate();
    let accounts = app.data.accounts();
    let local: Vec<String> = accounts
        .iter()
        .filter(|account| !account.archived)
        .map(|account| account.id.clone())
        .collect();
    // The picker's first entry is "not imported", then every active account.
    let mut options: Vec<SharedString> = vec![message("settings.bank.account.none").into()];
    for account in accounts.iter().filter(|account| !account.archived) {
        options.push(account.name.clone().into());
    }

    let last_sync = match connection.last_sync {
        Some(date) => fill(
            "settings.bank.last-sync",
            &[("{date}", &crate::format::iso_date(date))],
        ),
        None => message("settings.bank.never-synced").to_string(),
    };
    let imported = fill(
        "settings.bank.imported",
        &[("{count}", &connection.imported.to_string())],
    );

    let account_rows: Vec<AnyElement> = connection
        .accounts
        .iter()
        .enumerate()
        .map(|(account_row, account)| {
            let selected = account
                .account_id
                .as_ref()
                .and_then(|id| local.iter().position(|candidate| candidate == id))
                .map(|position| position + 1)
                .unwrap_or(0);
            let connection_id = connection.id.clone();
            let external_uid = account.external_uid.clone();
            let local_ids = local.clone();
            let label = if account.name.trim().is_empty() {
                account.currency.clone()
            } else {
                format!("{} · {}", account.name, account.currency)
            };
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .py(px(8.))
                .border_t_1()
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
                                .truncate()
                                .text_size(px(13.))
                                .line_height(px(17.))
                                .text_color(color("ink"))
                                .child(label),
                        )
                        .child(
                            div()
                                .font_family(theme::FONT)
                                .text_size(px(12.))
                                .line_height(px(17.))
                                .text_color(color("ink-2"))
                                .child(message(match account.account_id {
                                    Some(_) => "settings.bank.account",
                                    None => "settings.bank.account.unmapped",
                                })),
                        ),
                )
                // One chooser per account row: `segmented_at` keeps their
                // element ids apart.
                .child(kit::segmented_at(
                    "bank-map",
                    index * 32 + account_row,
                    &options,
                    selected,
                    cx,
                    move |this, choice, cx| {
                        let account_id = if choice == 0 {
                            None
                        } else {
                            local_ids.get(choice - 1).map(String::as_str)
                        };
                        this.map_bank_account(&connection_id, &external_uid, account_id, cx);
                    },
                ))
                .into_any_element()
        })
        .collect();

    let sync_id = connection.id.clone();
    let unlink_id = connection.id.clone();
    let busy = app.data.bank_sync().is_busy();
    let sync_enabled = can_mutate && !busy && connection.consent != BankConsent::Expired;
    let sync_button = if sync_enabled {
        kit::button(
            ("bank-sync", index),
            message("settings.bank.sync").to_string(),
        )
        .control(message("settings.bank.sync"))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.sync_bank_now(&sync_id, cx);
        }))
    } else {
        kit::button(
            ("bank-sync", index),
            message("settings.bank.sync").to_string(),
        )
        .disabled(message(if connection.consent == BankConsent::Expired {
            "settings.bank.consent.expired"
        } else {
            "settings.readonly"
        }))
    };
    let unlink_button = kit::button(
        ("bank-unlink", index),
        message("settings.bank.unlink").to_string(),
    )
    .control(message("settings.bank.unlink"))
    .when(can_mutate, |button| {
        button.on_click(cx.listener(move |this, _, _, cx| {
            this.unlink_bank(&unlink_id, cx);
        }))
    });
    // "Link again" is the link flow with the bank prefilled: the consent that
    // ran out is replaced by a fresh one, and the mapping is redone for the new
    // session's uids.
    let bank_country = connection.country.clone();
    let bank_name = connection.bank_name.clone();
    let link_again = connection.consent.needs_link_again().then(|| {
        kit::button(
            ("bank-link-again", index),
            message("settings.bank.link-again").to_string(),
        )
        .control(message("settings.bank.link-again"))
        .when(
            can_mutate && app.data.bank_sync().is_ready_to_link(),
            |button| {
                button.on_click(cx.listener(move |this, _, _, cx| {
                    this.bank.country = bank_country.clone();
                    this.bank.bank_name = bank_name.clone();
                    this.link_bank(cx);
                }))
            },
        )
    });

    div()
        .id(("bank-connection", index))
        .debug_selector(move || format!("bank-connection-{index}"))
        .flex()
        .flex_col()
        .gap(px(6.))
        .py(px(12.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(12.))
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
                                .text_size(px(13.))
                                .line_height(px(17.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(color("ink"))
                                .child(format!(
                                    "{} · {}",
                                    connection.bank_name, connection.country
                                )),
                        )
                        .child(
                            div()
                                .font_family(theme::FONT)
                                .text_size(px(12.))
                                .line_height(px(17.))
                                .text_color(color("ink-2"))
                                .child(format!("{last_sync} · {imported}")),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(8.))
                        .child(sync_button)
                        .children(link_again)
                        .child(unlink_button),
                ),
        )
        .child(consent_line(connection))
        .children(account_rows)
        .into_any_element()
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
                                    .font_family(theme::FONT)
                                    .text_size(px(11.5))
                                    .text_color(color("ink-2"))
                                    .child(message("accounts.archived")),
                            )
                        }),
                )
                .child(
                    div()
                        .font_family(theme::FONT)
                        .text_size(px(12.))
                        .line_height(px(17.))
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

/// The Bank sync section: the application and its key, the linked banks with
/// their mapping, the interval and the results of the last run.
fn bank_section(
    app: &FinancesApp,
    state: &BankSyncState,
    window: &Window,
    cx: &mut Context<FinancesApp>,
) -> Vec<AnyElement> {
    let can_mutate = app.can_mutate();
    let mut children: Vec<AnyElement> = Vec::new();

    // -- the application and its key ------------------------------------------
    let app_id_control = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.))
        .w(px(420.))
        .child(div().flex_1().min_w_0().child(kit::text_field(
            "bank-app-id",
            &app.bank.app_id,
            message("settings.bank.app.id.placeholder"),
            window,
            cx,
            |this, value, cx| {
                this.bank.app_id = value;
                cx.notify();
            },
        )))
        .child(row_button(
            ("bank-app-save", 0usize),
            "settings.bank.app.save",
            can_mutate,
            cx,
            |this, cx| this.save_bank_application(cx),
        ));
    children.push(
        setting_row(
            message("settings.bank.app.id"),
            message("settings.bank.app.description"),
            app_id_control,
        )
        .into_any_element(),
    );

    let key_state = message(if state.key_stored {
        "settings.bank.key.stored"
    } else {
        "settings.bank.key.missing"
    });
    let key_control = div()
        .flex()
        .flex_col()
        .items_end()
        .gap(px(6.))
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .child(div().w(px(240.)).child(kit::text_field(
                    "bank-key-path",
                    &app.bank.key_path,
                    message("settings.bank.key.path.placeholder"),
                    window,
                    cx,
                    |this, value, cx| {
                        this.bank.key_path = value;
                        cx.notify();
                    },
                )))
                .child(row_button(
                    ("bank-key-import", 0usize),
                    "settings.bank.key.import",
                    can_mutate,
                    cx,
                    |this, cx| this.import_bank_key(cx),
                ))
                .child(row_button(
                    ("bank-key-remove", 0usize),
                    "settings.bank.key.remove",
                    can_mutate && state.key_stored,
                    cx,
                    |this, cx| this.remove_bank_key(cx),
                )),
        )
        .child(
            div()
                .font_family(theme::FONT)
                .text_size(px(12.))
                .line_height(px(17.))
                .text_color(color("ink-2"))
                .child(key_state),
        );
    children.push(
        setting_row(
            message("settings.bank.key"),
            message("settings.bank.key.path"),
            key_control,
        )
        .into_any_element(),
    );

    // -- what is running right now --------------------------------------------
    if let Some(activity) = state.activity {
        children.push(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .py(px(8.))
                .text_size(px(12.))
                .line_height(px(16.))
                .text_color(color("ink-2"))
                .child(kit::icon("rotate-ccw", "live", 13.))
                .child(message(match activity {
                    crate::data::BankActivity::Linking => "settings.bank.linking",
                    crate::data::BankActivity::Syncing => "settings.bank.syncing",
                }))
                .into_any_element(),
        );
    }
    if let Some(text) = &state.message {
        children.push(
            div()
                .py(px(6.))
                .text_size(px(12.))
                .line_height(px(16.))
                .text_color(color("ink-2"))
                .child(text.clone())
                .into_any_element(),
        );
    }

    // -- linking ---------------------------------------------------------------
    // Linking needs both pieces of the application: without them the button
    // says which one is missing instead of opening a browser that cannot work.
    let can_link = state.is_ready_to_link();
    let link_control = div()
        .flex()
        .flex_col()
        .items_end()
        .gap(px(6.))
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .child(div().w(px(90.)).child(kit::text_field(
                    "bank-country",
                    &app.bank.country,
                    message("settings.bank.country.placeholder"),
                    window,
                    cx,
                    |this, value, cx| {
                        this.bank.country = value;
                        cx.notify();
                    },
                )))
                .child(div().w(px(180.)).child(kit::text_field(
                    "bank-name",
                    &app.bank.bank_name,
                    message("settings.bank.bank.placeholder"),
                    window,
                    cx,
                    |this, value, cx| {
                        this.bank.bank_name = value;
                        cx.notify();
                    },
                )))
                .child(row_button(
                    ("bank-link", 0usize),
                    "settings.bank.link.button",
                    can_mutate && can_link && !state.is_busy(),
                    cx,
                    |this, cx| this.link_bank(cx),
                )),
        )
        // The row's description already says what linking does; this line is
        // only for what is missing.
        .when(!can_link, |s| {
            s.child(
                div()
                    .font_family(theme::FONT)
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(color("ink-2"))
                    .child(message("settings.bank.link.needs-application")),
            )
        });
    children.push(
        setting_row(
            message("settings.bank.link"),
            message("settings.bank.link.description"),
            link_control,
        )
        .into_any_element(),
    );

    // -- the automatic sync interval ------------------------------------------
    let selected = BANK_SYNC_INTERVALS
        .iter()
        .position(|minutes| *minutes == state.interval)
        .unwrap_or(0);
    let options: Vec<SharedString> = BANK_SYNC_INTERVALS
        .iter()
        .map(|minutes| message(interval_label(*minutes)).into())
        .collect();
    let interval_control = kit::segmented("bank-interval", &options, selected, cx, {
        let enabled = can_mutate;
        move |this, choice, cx| {
            if !enabled {
                return;
            }
            let minutes = BANK_SYNC_INTERVALS.get(choice).copied().unwrap_or(None);
            this.set_bank_sync_interval(minutes, cx);
        }
    });
    children.push(
        setting_row(
            message("settings.bank.interval"),
            message("settings.bank.interval.description"),
            interval_control,
        )
        .into_any_element(),
    );

    // -- the linked banks ------------------------------------------------------
    if state.connections.is_empty() {
        children.push(
            div()
                .py(px(10.))
                .text_size(px(13.))
                .line_height(px(17.))
                .text_color(color("ink-2"))
                .child(message("settings.bank.empty"))
                .into_any_element(),
        );
    }
    for (index, connection) in state.connections.iter().enumerate() {
        children.push(connection_block(app, connection, index, cx));
    }
    // The consent banner of an expired link is also the page's own notice: it
    // is what the "link again" button above acts on.
    children
}

pub fn render(
    app: &mut FinancesApp,
    window: &mut Window,
    cx: &mut Context<FinancesApp>,
) -> impl IntoElement {
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

    // -- the bank section (LOCAL-031) -------------------------------------------
    let bank_state = app.data.bank_sync();
    let bank_children = bank_section(app, &bank_state, window, cx);

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
            .py(px(10.))
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
            section("settings.section.bank", bank_children).into_any_element(),
            section("settings.section.accounts", account_children).into_any_element(),
            div()
                .text_size(px(12.5))
                .line_height(px(18.))
                .text_color(color("ink-2"))
                .child(message("settings.hint"))
                .into_any_element(),
        ],
    )
}
