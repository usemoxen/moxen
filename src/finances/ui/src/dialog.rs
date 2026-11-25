//! The modal forms the live actions open: create/edit a subscription, add or
//! edit a movement, manage accounts, record a transfer, restore a backup.
//! Each dialog reads its fields from [`FormState`], validates them, builds a
//! plain-DTO draft from [`crate::commands`] and hands it to
//! [`FinancesApp::run_mutation`], which refreshes the views on success and
//! shows the error banner on failure.

use crate::commands::{AccountDraft, MovementDraft, SubscriptionDraft, TransferDraft};
use crate::data::{AccountKind, Currency, Frequency, MovementKind, MovementStatus};
use crate::format;
use crate::kit::{self, Control};
use crate::language::message;
use crate::model;
use crate::shell::FinancesApp;
use crate::theme::{self, TypeScale, color};
use chrono::Datelike;
use gpui::{prelude::*, *};

/// The open dialog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Dialog {
    NewSubscription,
    EditSubscription(String),
    NewMovement(MovementKind),
    EditMovement { id: String, kind: MovementKind },
    NewAccount,
    RenameAccount(String),
    Transfer,
    RestoreBackup,
}

/// The fields of whichever dialog is open.
#[derive(Clone, Debug, Default)]
pub struct FormState {
    pub name: String,
    pub description: String,
    pub amount: String,
    pub currency: usize,
    pub frequency: usize,
    pub date: String,
    pub end_date: String,
    pub time: String,
    pub category: String,
    pub status: usize,
    pub notes: String,
    pub kind: usize,
    pub balance: String,
    pub from_account: usize,
    pub to_account: usize,
    pub subscription: usize,
    pub path: String,
    pub error: Option<String>,
}

/// The status options a movement kind offers, in picker order.
fn status_options(kind: MovementKind) -> Vec<MovementStatus> {
    match kind {
        MovementKind::Income => vec![MovementStatus::Expected, MovementStatus::Received],
        MovementKind::Expense => vec![
            MovementStatus::Planned,
            MovementStatus::Pending,
            MovementStatus::Done,
        ],
        MovementKind::Charge => vec![MovementStatus::Done, MovementStatus::NotCharged],
    }
}

/// Opens a dialog, prefilling the form for the edit variants.
pub fn open(app: &mut FinancesApp, dialog: Dialog, cx: &mut Context<FinancesApp>) {
    let today = format::iso_date(app.data.today());
    let mut form = FormState {
        date: today.clone(),
        currency: 0,
        frequency: 2, // monthly
        ..Default::default()
    };
    match &dialog {
        Dialog::EditSubscription(id) => {
            if let Some(sub) = app.data.subscriptions().iter().find(|s| &s.id == id) {
                form.name = sub.name.clone();
                form.description = sub.description.get().to_string();
                form.amount = sub
                    .price
                    .map(|price| format::amount_text(price.minor))
                    .unwrap_or_default();
                form.currency = Currency::ALL
                    .iter()
                    .position(|c| *c == sub.price.map(|p| p.currency).unwrap_or(Currency::Eur))
                    .unwrap_or(0);
                form.frequency = Frequency::ALL
                    .iter()
                    .position(|f| *f == sub.frequency)
                    .unwrap_or(2);
                form.date = sub
                    .next_charge
                    .map(format::iso_date)
                    .unwrap_or_else(|| today.clone());
                form.end_date = sub.end_date.map(format::iso_date).unwrap_or_default();
            }
        }
        Dialog::EditMovement { id, kind } => {
            if let Some(movement) = app.data.movements().iter().find(|m| &m.id == id) {
                form.name = movement.name.clone();
                form.amount = format::amount_text(movement.amount.minor);
                form.currency = Currency::ALL
                    .iter()
                    .position(|c| *c == movement.amount.currency)
                    .unwrap_or(0);
                form.date = format::iso_date(movement.date);
                form.end_date = movement.end_date.map(format::iso_date).unwrap_or_default();
                form.time = movement.time.clone().unwrap_or_default();
                form.category = movement
                    .category
                    .map(|c| c.get().to_string())
                    .unwrap_or_default();
                form.notes = movement
                    .notes
                    .map(|n| n.get().to_string())
                    .unwrap_or_default();
                form.frequency = Frequency::ALL
                    .iter()
                    .position(|f| *f == movement.frequency)
                    .unwrap_or(0);
                let statuses = status_options(*kind);
                form.status = statuses
                    .iter()
                    .position(|s| *s == movement.status)
                    .unwrap_or(0);
                form.subscription = movement
                    .subscription_id
                    .as_ref()
                    .and_then(|sub_id| {
                        app.data
                            .subscriptions()
                            .iter()
                            .position(|s| &s.id == sub_id)
                            .map(|i| i + 1)
                    })
                    .unwrap_or(0);
            }
        }
        Dialog::RenameAccount(id) => {
            if let Some(account) = app.data.accounts().iter().find(|a| &a.id == id) {
                form.name = account.name.clone();
            }
        }
        Dialog::NewMovement(kind) => {
            form.status = 0;
            let _ = kind;
        }
        _ => {}
    }
    app.form = form;
    app.dialog = Some(dialog);
    cx.notify();
}

/// Closes the dialog and clears the form.
pub fn close(app: &mut FinancesApp, cx: &mut Context<FinancesApp>) {
    app.dialog = None;
    app.form = FormState::default();
    cx.notify();
}

/// Validates the form and runs the command the dialog stands for. Returns
/// true when the command succeeded (the caller closes the dialog).
pub fn submit(app: &mut FinancesApp, cx: &mut Context<FinancesApp>) -> bool {
    let Some(dialog) = app.dialog.clone() else {
        return false;
    };
    let form = app.form.clone();
    // -- validation ------------------------------------------------------------
    let needs_name = matches!(
        dialog,
        Dialog::NewSubscription
            | Dialog::EditSubscription(_)
            | Dialog::NewMovement(_)
            | Dialog::EditMovement { .. }
            | Dialog::NewAccount
            | Dialog::RenameAccount(_)
    );
    if needs_name && form.name.trim().is_empty() {
        app.form.error = Some(message("dialog.error.name").to_string());
        cx.notify();
        return false;
    }
    let amount = model::parse_amount_minor(&form.amount);
    let needs_amount = matches!(
        dialog,
        Dialog::NewMovement(_) | Dialog::EditMovement { .. } | Dialog::Transfer
    );
    if needs_amount && amount.is_none() {
        app.form.error = Some(message("dialog.error.amount").to_string());
        cx.notify();
        return false;
    }
    let needs_date = matches!(
        dialog,
        Dialog::NewMovement(_) | Dialog::EditMovement { .. } | Dialog::Transfer
    );
    let date = model::parse_required_date(&form.date);
    if needs_date && date.is_none() {
        app.form.error = Some(message("dialog.error.date").to_string());
        cx.notify();
        return false;
    }
    app.form.error = None;

    // -- build the draft and run it ---------------------------------------------
    match dialog {
        Dialog::NewSubscription | Dialog::EditSubscription(_) => {
            let draft = SubscriptionDraft {
                name: form.name.trim().to_string(),
                description: non_empty(&form.description),
                price_minor: model::parse_amount_minor(&form.amount),
                currency: Currency::ALL[form.currency.min(Currency::ALL.len() - 1)],
                frequency: Frequency::ALL[form.frequency.min(Frequency::ALL.len() - 1)],
                start_date: model::parse_iso_date(&form.date),
                billing_day: model::parse_iso_date(&form.date).map(|d| d.day() as i64),
                end_date: model::parse_iso_date(&form.end_date),
            };
            match dialog {
                Dialog::EditSubscription(id) => {
                    let id = id.clone();
                    app.run_mutation(cx, move |m| m.update_subscription(&id, &draft))
                }
                _ => app.run_mutation(cx, move |m| m.create_subscription(&draft)),
            }
        }
        Dialog::NewMovement(kind) | Dialog::EditMovement { kind, .. } => {
            let statuses = status_options(kind);
            let status = statuses[form.status.min(statuses.len() - 1)];
            let subscriptions = app.data.subscriptions();
            let subscription_id = if kind == MovementKind::Charge && form.subscription > 0 {
                subscriptions
                    .get(form.subscription - 1)
                    .map(|s| s.id.clone())
            } else {
                None
            };
            let draft = MovementDraft {
                id: match &dialog {
                    Dialog::EditMovement { id, .. } => Some(id.clone()),
                    _ => None,
                },
                kind,
                name: form.name.trim().to_string(),
                subscription_id,
                category: non_empty(&form.category),
                amount_minor: amount.unwrap_or(0),
                currency: Currency::ALL[form.currency.min(Currency::ALL.len() - 1)],
                date: date.unwrap_or_else(|| app.data.today()),
                time: non_empty(&form.time),
                frequency: Frequency::ALL[form.frequency.min(Frequency::ALL.len() - 1)],
                end_date: model::parse_iso_date(&form.end_date),
                status,
                notes: non_empty(&form.notes),
            };
            match &dialog {
                Dialog::EditMovement { .. } => {
                    app.run_mutation(cx, move |m| m.update_movement(&draft))
                }
                _ => app.run_mutation(cx, move |m| m.create_movement(&draft)),
            }
        }
        Dialog::NewAccount => {
            let draft = AccountDraft {
                name: form.name.trim().to_string(),
                kind: AccountKind::ALL[form.kind.min(AccountKind::ALL.len() - 1)],
                currency: Currency::ALL[form.currency.min(Currency::ALL.len() - 1)],
                balance_minor: model::parse_amount_minor(&form.balance),
            };
            app.run_mutation(cx, move |m| m.create_account(&draft))
        }
        Dialog::RenameAccount(id) => {
            let name = form.name.trim().to_string();
            app.run_mutation(cx, move |m| m.rename_account(&id, &name))
        }
        Dialog::Transfer => {
            let accounts: Vec<String> = app
                .data
                .accounts()
                .iter()
                .filter(|a| !a.archived)
                .map(|a| a.id.clone())
                .collect();
            let from = accounts.get(form.from_account).cloned();
            let to = accounts.get(form.to_account).cloned();
            let (Some(from), Some(to)) = (from, to) else {
                app.form.error = Some(message("dialog.error.accounts").to_string());
                cx.notify();
                return false;
            };
            if from == to {
                app.form.error = Some(message("dialog.error.accounts").to_string());
                cx.notify();
                return false;
            }
            let draft = TransferDraft {
                from_account_id: from,
                to_account_id: to,
                amount_minor: amount.unwrap_or(0),
                currency: Currency::ALL[form.currency.min(Currency::ALL.len() - 1)],
                date: date.unwrap_or_else(|| app.data.today()),
                note: non_empty(&form.notes),
            };
            app.run_mutation(cx, move |m| m.create_transfer(&draft))
        }
        Dialog::RestoreBackup => {
            let path = form.path.trim().to_string();
            app.restore_backup(&path, cx);
            app.error.is_none()
        }
    }
}

fn non_empty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn field(label: &str, control: impl IntoElement) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(kit::caps(label))
        .child(control)
}

fn text_input(
    id: &'static str,
    value: &str,
    placeholder: &str,
    window: &Window,
    cx: &mut Context<FinancesApp>,
    set: fn(&mut FinancesApp, String),
) -> Stateful<Div> {
    kit::text_field(
        id,
        value,
        placeholder,
        window,
        cx,
        move |this, value, cx| {
            set(this, value);
            cx.notify();
        },
    )
}

/// The dialog's title key.
fn title_key(dialog: &Dialog) -> &'static str {
    match dialog {
        Dialog::NewSubscription => "dialog.subscription.new",
        Dialog::EditSubscription(_) => "dialog.subscription.edit",
        Dialog::NewMovement(MovementKind::Income) => "dialog.movement.new.income",
        Dialog::NewMovement(MovementKind::Expense) => "dialog.movement.new.expense",
        Dialog::NewMovement(MovementKind::Charge) => "dialog.movement.new.charge",
        Dialog::EditMovement { .. } => "dialog.movement.edit",
        Dialog::NewAccount => "dialog.account.new",
        Dialog::RenameAccount(_) => "dialog.account.rename",
        Dialog::Transfer => "dialog.transfer",
        Dialog::RestoreBackup => "dialog.restore",
    }
}

pub fn render(
    app: &mut FinancesApp,
    dialog: Dialog,
    window: &mut Window,
    cx: &mut Context<FinancesApp>,
) -> AnyElement {
    let form = app.form.clone();
    let mut fields: Vec<AnyElement> = Vec::new();

    match &dialog {
        Dialog::NewSubscription | Dialog::EditSubscription(_) => {
            fields.push(
                field(
                    message("dialog.field.name"),
                    text_input("form-name", &form.name, "…", window, cx, |this, v| {
                        this.form.name = v
                    }),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.description"),
                    text_input(
                        "form-description",
                        &form.description,
                        "…",
                        window,
                        cx,
                        |this, v| this.form.description = v,
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.amount"),
                    text_input(
                        "form-amount",
                        &form.amount,
                        "0.00",
                        window,
                        cx,
                        |this, v| this.form.amount = v,
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.currency"),
                    kit::segmented(
                        "form-currency",
                        &Currency::ALL.map(|c| c.code().into()),
                        form.currency.min(Currency::ALL.len() - 1),
                        cx,
                        |this, i, cx| {
                            this.form.currency = i;
                            cx.notify();
                        },
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.frequency"),
                    kit::segmented(
                        "form-frequency",
                        &Frequency::ALL.map(|f| message(f.key()).into()),
                        form.frequency.min(Frequency::ALL.len() - 1),
                        cx,
                        |this, i, cx| {
                            this.form.frequency = i;
                            cx.notify();
                        },
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.date"),
                    text_input(
                        "form-date",
                        &form.date,
                        "2026-11-25",
                        window,
                        cx,
                        |this, v| this.form.date = v,
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.end"),
                    text_input("form-end", &form.end_date, "…", window, cx, |this, v| {
                        this.form.end_date = v
                    }),
                )
                .into_any_element(),
            );
        }
        Dialog::NewMovement(kind) | Dialog::EditMovement { kind, .. } => {
            let kind = *kind;
            fields.push(
                field(
                    message("dialog.field.name"),
                    text_input("form-name", &form.name, "…", window, cx, |this, v| {
                        this.form.name = v
                    }),
                )
                .into_any_element(),
            );
            if kind == MovementKind::Charge {
                let mut options: Vec<SharedString> = vec![message("dialog.field.none").into()];
                options.extend(
                    app.data
                        .subscriptions()
                        .iter()
                        .map(|s| s.name.clone().into()),
                );
                fields.push(
                    field(
                        message("dialog.field.subscription"),
                        kit::segmented(
                            "form-subscription",
                            &options,
                            form.subscription.min(options.len() - 1),
                            cx,
                            |this, i, cx| {
                                this.form.subscription = i;
                                cx.notify();
                            },
                        ),
                    )
                    .into_any_element(),
                );
            } else {
                fields.push(
                    field(
                        message("dialog.field.category"),
                        text_input(
                            "form-category",
                            &form.category,
                            "…",
                            window,
                            cx,
                            |this, v| this.form.category = v,
                        ),
                    )
                    .into_any_element(),
                );
            }
            fields.push(
                field(
                    message("dialog.field.amount"),
                    text_input(
                        "form-amount",
                        &form.amount,
                        "0.00",
                        window,
                        cx,
                        |this, v| this.form.amount = v,
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.currency"),
                    kit::segmented(
                        "form-currency",
                        &Currency::ALL.map(|c| c.code().into()),
                        form.currency.min(Currency::ALL.len() - 1),
                        cx,
                        |this, i, cx| {
                            this.form.currency = i;
                            cx.notify();
                        },
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.date"),
                    text_input(
                        "form-date",
                        &form.date,
                        "2026-11-25",
                        window,
                        cx,
                        |this, v| this.form.date = v,
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.time"),
                    text_input("form-time", &form.time, "18:30", window, cx, |this, v| {
                        this.form.time = v
                    }),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.frequency"),
                    kit::segmented(
                        "form-frequency",
                        &Frequency::ALL.map(|f| message(f.key()).into()),
                        form.frequency.min(Frequency::ALL.len() - 1),
                        cx,
                        |this, i, cx| {
                            this.form.frequency = i;
                            cx.notify();
                        },
                    ),
                )
                .into_any_element(),
            );
            let statuses = status_options(kind);
            fields.push(
                field(
                    message("dialog.field.status"),
                    kit::segmented(
                        "form-status",
                        &statuses
                            .iter()
                            .map(|s| message(s.key()).into())
                            .collect::<Vec<_>>(),
                        form.status.min(statuses.len() - 1),
                        cx,
                        |this, i, cx| {
                            this.form.status = i;
                            cx.notify();
                        },
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.end"),
                    text_input("form-end", &form.end_date, "…", window, cx, |this, v| {
                        this.form.end_date = v
                    }),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.notes"),
                    text_input("form-notes", &form.notes, "…", window, cx, |this, v| {
                        this.form.notes = v
                    }),
                )
                .into_any_element(),
            );
        }
        Dialog::NewAccount | Dialog::RenameAccount(_) => {
            fields.push(
                field(
                    message("dialog.field.name"),
                    text_input("form-name", &form.name, "…", window, cx, |this, v| {
                        this.form.name = v
                    }),
                )
                .into_any_element(),
            );
            if matches!(dialog, Dialog::NewAccount) {
                fields.push(
                    field(
                        message("dialog.field.kind"),
                        kit::segmented(
                            "form-kind",
                            &AccountKind::ALL.map(|k| message(k.key()).into()),
                            form.kind.min(AccountKind::ALL.len() - 1),
                            cx,
                            |this, i, cx| {
                                this.form.kind = i;
                                cx.notify();
                            },
                        ),
                    )
                    .into_any_element(),
                );
                fields.push(
                    field(
                        message("dialog.field.currency"),
                        kit::segmented(
                            "form-currency",
                            &Currency::ALL.map(|c| c.code().into()),
                            form.currency.min(Currency::ALL.len() - 1),
                            cx,
                            |this, i, cx| {
                                this.form.currency = i;
                                cx.notify();
                            },
                        ),
                    )
                    .into_any_element(),
                );
                fields.push(
                    field(
                        message("dialog.field.balance"),
                        text_input(
                            "form-balance",
                            &form.balance,
                            "0.00",
                            window,
                            cx,
                            |this, v| this.form.balance = v,
                        ),
                    )
                    .into_any_element(),
                );
            }
        }
        Dialog::Transfer => {
            let accounts: Vec<SharedString> = app
                .data
                .accounts()
                .iter()
                .filter(|a| !a.archived)
                .map(|a| a.name.clone().into())
                .collect();
            let from_selected = form.from_account.min(accounts.len().saturating_sub(1));
            let to_selected = form.to_account.min(accounts.len().saturating_sub(1));
            fields.push(
                field(
                    message("dialog.field.from"),
                    kit::segmented("form-from", &accounts, from_selected, cx, |this, i, cx| {
                        this.form.from_account = i;
                        cx.notify();
                    }),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.to"),
                    kit::segmented("form-to", &accounts, to_selected, cx, |this, i, cx| {
                        this.form.to_account = i;
                        cx.notify();
                    }),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.amount"),
                    text_input(
                        "form-amount",
                        &form.amount,
                        "0.00",
                        window,
                        cx,
                        |this, v| this.form.amount = v,
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.currency"),
                    kit::segmented(
                        "form-currency",
                        &Currency::ALL.map(|c| c.code().into()),
                        form.currency.min(Currency::ALL.len() - 1),
                        cx,
                        |this, i, cx| {
                            this.form.currency = i;
                            cx.notify();
                        },
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.date"),
                    text_input(
                        "form-date",
                        &form.date,
                        "2026-11-25",
                        window,
                        cx,
                        |this, v| this.form.date = v,
                    ),
                )
                .into_any_element(),
            );
            fields.push(
                field(
                    message("dialog.field.notes"),
                    text_input("form-notes", &form.notes, "…", window, cx, |this, v| {
                        this.form.notes = v
                    }),
                )
                .into_any_element(),
            );
        }
        Dialog::RestoreBackup => {
            fields.push(
                field(
                    message("dialog.field.path"),
                    text_input("form-path", &form.path, "…", window, cx, |this, v| {
                        this.form.path = v
                    }),
                )
                .into_any_element(),
            );
        }
    }

    let error_line = form.error.clone().map(|error| {
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(12.))
            .line_height(px(16.))
            .text_color(color("broken"))
            .child(kit::icon("alert", "broken", 13.))
            .child(error)
            .into_any_element()
    });

    let title = message(title_key(&dialog)).to_string();
    let is_restore = matches!(dialog, Dialog::RestoreBackup);
    let card = div()
        .id("dialog")
        .debug_selector(|| "dialog".into())
        .w(px(460.))
        .max_h_full()
        .overflow_y_scroll()
        .bg(color("raised"))
        .rounded(px(theme::radius("radius-lg")))
        .shadow(theme::float_shadow())
        .p(px(20.))
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .type_scale("headline")
                .text_color(color("ink"))
                .child(title),
        )
        .children(fields)
        .when_some(error_line, |s, line| s.child(line))
        .child(
            div()
                .flex()
                .flex_row()
                .justify_end()
                .gap(px(8.))
                .child(
                    kit::button(
                        ("dialog-cancel", 0usize),
                        message("dialog.cancel").to_string(),
                    )
                    .on_click(cx.listener(|this, _, _, cx| close(this, cx))),
                )
                .child(
                    kit::button(
                        ("dialog-save", 0usize),
                        message(if is_restore {
                            "dialog.restore.action"
                        } else {
                            "dialog.save"
                        })
                        .to_string(),
                    )
                    .control(message("dialog.save"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if submit(this, cx) && !matches!(this.dialog, Some(Dialog::RestoreBackup)) {
                            close(this, cx);
                        }
                    })),
                ),
        );

    div()
        .id("dialog-backdrop")
        .absolute()
        .inset_0()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(color("ground").opacity(0.55))
        .child(card)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    // Not a glob of `super`: with `test-support` linked, `gpui::test` would
    // shadow the built-in `#[test]` the macro emits.
    use super::{Dialog, non_empty, status_options, title_key};
    use crate::data::{MovementKind, MovementStatus};
    use crate::language::{self, message};

    #[test]
    fn status_options_follow_the_movement_kind() {
        assert_eq!(
            status_options(MovementKind::Income),
            vec![MovementStatus::Expected, MovementStatus::Received]
        );
        assert_eq!(
            status_options(MovementKind::Charge),
            vec![MovementStatus::Done, MovementStatus::NotCharged]
        );
        assert_eq!(status_options(MovementKind::Expense).len(), 3);
    }

    #[test]
    fn non_empty_maps_blank_to_none() {
        assert_eq!(non_empty("  "), None);
        assert_eq!(non_empty(" Café "), Some("Café".to_string()));
    }

    #[test]
    fn dialog_titles_resolve_in_both_languages() {
        language::apply(Some("en"));
        assert_eq!(
            message(title_key(&Dialog::NewSubscription)),
            "New subscription"
        );
        assert_eq!(message(title_key(&Dialog::Transfer)), "New transfer");
        language::apply(Some("es-ES"));
        assert_eq!(
            message(title_key(&Dialog::NewSubscription)),
            "Nueva suscripción"
        );
        assert_eq!(message(title_key(&Dialog::Transfer)), "Nuevo traspaso");
        language::apply(Some("en"));
    }
}
