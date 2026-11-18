use crate::ui::{self, Control};
use crate::{
    model::{
        INTERACTION_MODES, Message, QueueEdit, Queued, RUNTIME_MODES, Status, Thread, mode_label,
    },
    theme::{self, color},
    workspace::{Dropdown, Workspace},
};
use gpui::{prelude::*, *};

/// Space between turns in the transcript (the mockup's column gap).
const TURN_GAP: f32 = 22.;

/// The run of steps `index` belongs to: where it starts and how many steps it
/// has. A message that is not a step is a run of its own, of length 1.
pub fn run_of(messages: &[Message], index: usize) -> (usize, usize) {
    let is_step = |i: usize| matches!(messages.get(i), Some(Message::Tool { .. }));
    if !is_step(index) {
        return (index, 1);
    }
    let mut start = index;
    while start > 0 && is_step(start - 1) {
        start -= 1;
    }
    let mut end = index + 1;
    while is_step(end) {
        end += 1;
    }
    (start, end - start)
}

/// "Ran 3 commands, read 3 files, edited 1 file": the folded run's summary.
pub fn run_summary(messages: &[Message]) -> String {
    let count = |kind: &str| {
        messages
            .iter()
            .filter(|m| matches!(m, Message::Tool { name, .. } if name == kind))
            .count()
    };
    let plural =
        |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut parts = vec![];
    let (ran, read, edited) = (count("command"), count("read"), count("edit"));
    let (searched, used) = (count("search"), count("tool"));
    if ran > 0 {
        parts.push(format!("ran {}", plural(ran, "command", "commands")));
    }
    if read > 0 {
        parts.push(format!("read {}", plural(read, "file", "files")));
    }
    if searched > 0 {
        parts.push(format!("searched {}", plural(searched, "time", "times")));
    }
    if edited > 0 {
        parts.push(format!("edited {}", plural(edited, "file", "files")));
    }
    if used > 0 {
        parts.push(format!("used {}", plural(used, "tool", "tools")));
    }
    if parts.is_empty() {
        parts.push(format!(
            "thought {}",
            plural(count("thought"), "time", "times")
        ));
    }
    let mut text = parts.join(", ");
    if let Some(first) = text.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    text
}

pub fn render(w: &Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let id = w.selected;
    let creating = w.creating;
    let draft_empty = w.active_composer().read(cx).text().trim().is_empty();
    let thread = w.source.list_threads()[id].clone();
    let running = thread.status == Status::Running && !creating;
    let messages = w.source.messages(id);
    let last_reply = messages
        .iter()
        .rposition(|m| matches!(m, Message::Assistant { .. }));
    let entity = cx.entity();
    let state = w.lists[id].clone();
    let (model, model_tone) = w.model_label(w.source.selection(id).as_ref());
    let started = thread.started_at;
    div()
        .relative()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .bg(color("raised"))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .overflow_hidden()
                .child(if creating {
                    new_thread(w).into_any_element()
                } else {
                    list(state, move |index, window, cx| {
                        let this = entity.read(cx);
                        let Some(current) = messages.get(index) else {
                            return div().into_any_element();
                        };
                        // A run of steps folds under one summary row, at its first step.
                        let (start, len) = run_of(&messages, index);
                        let is_first = matches!(current, Message::Tool { .. }) && index == start;
                        let folded = matches!(current, Message::Tool { .. })
                            && this.run_folded(id, start, len, messages.len());
                        if folded && !is_first {
                            return div().into_any_element();
                        }
                        let summary: SharedString =
                            run_summary(&messages[start..start + len]).into();
                        let shown =
                            ui::progress(this.unfolded_at.get(&(id, start)).copied(), 150, window);
                        let open = this
                            .expanded
                            .get(&(id, index))
                            .map(|at| ui::progress(Some(*at), 150, window));
                        let body = match current.clone() {
                            Message::User { text } => div()
                                .flex()
                                .flex_col()
                                .items_end()
                                .child(
                                    div()
                                        .max_w(relative(0.82))
                                        .px(px(14.))
                                        .py(px(10.))
                                        .rounded(px(14.))
                                        .bg(color("sunk"))
                                        .text_size(px(theme::BODY))
                                        .line_height(px(theme::BODY * 1.55))
                                        .child(text),
                                )
                                .into_any_element(),
                            Message::Assistant { text, at } => div()
                                .flex()
                                .flex_col()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .flex()
                                        .items_baseline()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .text_size(px(13.5))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .text_color(color(model_tone))
                                                .child(model.clone()),
                                        )
                                        .child(
                                            div()
                                                .font_family(theme::MONO)
                                                .text_size(px(12.))
                                                .text_color(color("ink-2"))
                                                .child(at),
                                        )
                                        .when(running && Some(index) == last_reply, |s| {
                                            let seconds = started
                                                .map_or(0, |start| start.elapsed().as_secs());
                                            s.child(div().flex_1()).child(
                                                div()
                                                    .flex()
                                                    .items_center()
                                                    .gap(px(6.))
                                                    .font_family(theme::MONO)
                                                    .text_size(px(12.))
                                                    .text_color(color("live"))
                                                    .child(ui::state(Status::Running))
                                                    .child(format!(
                                                        "working · {}m {:02}s",
                                                        seconds / 60,
                                                        seconds % 60
                                                    )),
                                            )
                                        }),
                                )
                                .child(
                                    div()
                                        .text_size(px(theme::BODY))
                                        .line_height(px(theme::LINE))
                                        .when(text.is_empty(), |s| s.text_color(color("ink-2")))
                                        .child(if text.is_empty() {
                                            "Thinking…".into()
                                        } else {
                                            text
                                        }),
                                )
                                .into_any_element(),
                            Message::Plan {
                                text,
                                implemented,
                                at,
                            } => {
                                let toggle = entity.clone();
                                div()
                                    .flex()
                                    .flex_col()
                                    .child(
                                        div()
                                            .id(("plan", index))
                                            .quiet()
                                            .flex()
                                            .items_center()
                                            .gap(px(8.))
                                            .py(px(4.))
                                            .text_size(px(13.5))
                                            .text_color(color(if implemented {
                                                "ink-2"
                                            } else {
                                                "ink"
                                            }))
                                            .child(ui::icon(
                                                if open.is_some() {
                                                    "chevron-down"
                                                } else {
                                                    "chevron-right"
                                                },
                                                "ink-2",
                                            ))
                                            .child(div().font_weight(FontWeight::SEMIBOLD).child(
                                                if implemented {
                                                    "Plan implemented"
                                                } else {
                                                    "Plan proposed"
                                                },
                                            ))
                                            .child(
                                                div()
                                                    .font_family(theme::MONO)
                                                    .text_size(px(12.))
                                                    .text_color(color("ink-2"))
                                                    .child(at),
                                            )
                                            .on_click(move |_, _, cx| {
                                                toggle.update(cx, |this, cx| {
                                                    if this.expanded.remove(&(id, index)).is_none()
                                                    {
                                                        this.expanded.insert(
                                                            (id, index),
                                                            std::time::Instant::now(),
                                                        );
                                                    }
                                                    this.lists[id].splice(index..index + 1, 1);
                                                    cx.notify();
                                                });
                                            }),
                                    )
                                    .when(open.is_some(), |s| {
                                        s.child(
                                            div()
                                                .id(("plan-body", index))
                                                .max_h(px(360.))
                                                .overflow_y_scroll()
                                                .mt(px(4.))
                                                .py(px(4.))
                                                .pl(px(14.))
                                                .border_l_2()
                                                .border_color(color("rule"))
                                                .text_size(px(theme::BODY))
                                                .line_height(px(theme::LINE))
                                                .child(text),
                                        )
                                    })
                                    .into_any_element()
                            }
                            Message::UsageLimit {
                                label,
                                resets_at,
                                wrap_up,
                                at,
                            } => {
                                let now = crate::live::now_ms();
                                let window = label.clone().unwrap_or_else(|| "Plan".to_string());
                                let reset = match resets_at
                                    .as_deref()
                                    .and_then(crate::live::parse_iso_ms)
                                {
                                    None => "  ·  resets when the provider allows".to_string(),
                                    Some(target) if target <= now => {
                                        format!(
                                            "  ·  reset at {}",
                                            crate::transcript::clock(target)
                                        )
                                    }
                                    Some(target) => format!(
                                        "  ·  resets {} ({})",
                                        crate::transcript::clock(target),
                                        crate::usage::until_label(target, now)
                                            .trim_start_matches("in "),
                                    ),
                                };
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_baseline()
                                            .gap(px(8.))
                                            .text_size(px(13.))
                                            .child(
                                                div()
                                                    .text_color(color(if wrap_up {
                                                        "held"
                                                    } else {
                                                        "broken"
                                                    }))
                                                    .child("◔"),
                                            )
                                            .child(
                                                div()
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .text_color(color(if wrap_up {
                                                        "held"
                                                    } else {
                                                        "broken"
                                                    }))
                                                    .child(if wrap_up {
                                                        "Usage limit reached, wrapping up"
                                                    } else {
                                                        "Usage limit reached"
                                                    }),
                                            )
                                            .child(
                                                div()
                                                    .text_color(color("ink-2"))
                                                    .child(format!("  ·  {window} limit")),
                                            )
                                            .child(div().text_color(color("ink-2")).child(reset))
                                            .when(!at.is_empty(), |s| {
                                                s.child(
                                                    div()
                                                        .font_family(theme::MONO)
                                                        .text_size(px(12.))
                                                        .text_color(color("ink-2"))
                                                        .child(format!("  ·  {at}")),
                                                )
                                            }),
                                    )
                                    .when(wrap_up, |s| {
                                        s.child(
                                            div()
                                                .text_size(px(13.))
                                                .text_color(color("ink-2"))
                                                .child("Finishing this step before stopping."),
                                        )
                                    })
                                    .into_any_element()
                            }
                            Message::TaskNotification { tasks, at } => {
                                let native = tasks.iter().all(|task| task.native);
                                let settled = tasks.iter().all(|task| {
                                    matches!(
                                        task.status.as_str(),
                                        "completed" | "failed" | "interrupted"
                                    )
                                });
                                let header = if tasks.len() == 1 {
                                    None
                                } else if settled {
                                    Some(if native {
                                        format!("{} subagents settled", tasks.len())
                                    } else {
                                        format!("{} delegated tasks settled", tasks.len())
                                    })
                                } else {
                                    Some(format!("{} delegated task updates", tasks.len()))
                                };
                                div()
                                    .flex()
                                    .flex_col()
                                    .border_l_2()
                                    .border_color(color("rule"))
                                    .pl(px(14.))
                                    .py(px(4.))
                                    .gap(px(8.))
                                    .children(header.map(|header| {
                                        div()
                                            .flex()
                                            .items_baseline()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .text_size(px(13.5))
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .child(header),
                                            )
                                            .child(
                                                div()
                                                    .font_family(theme::MONO)
                                                    .text_size(px(12.))
                                                    .text_color(color("ink-2"))
                                                    .child(at.clone()),
                                            )
                                    }))
                                    .children(tasks.iter().map(|task| {
                                        let (glyph, token) = match task.status.as_str() {
                                            "completed" => ("✓", "added"),
                                            "failed" => ("✗", "broken"),
                                            "cancelled" | "interrupted" => ("■", "held"),
                                            _ => ("●", "held"),
                                        };
                                        let verb = match task.status.as_str() {
                                            "completed" => "finished",
                                            "failed" => "failed",
                                            "cancelled" => "cancelled",
                                            "interrupted" => "stopped",
                                            _ => "running",
                                        };
                                        let outcome = match task.duration_ms {
                                            None => verb.to_string(),
                                            Some(ms) if task.status == "running" => {
                                                format!("running for {}", crate::transcript::duration(ms.max(1000)))
                                            }
                                            Some(ms) => {
                                                format!("{verb} in {}", crate::transcript::duration(ms.max(1000)))
                                            }
                                        };
                                        let kind = (task.native && task.model.is_none())
                                            .then_some("subagent");
                                        let mut facts = vec![outcome];
                                        facts.extend(task.model.clone());
                                        facts.extend(kind.map(str::to_string));
                                        if tasks.len() == 1 {
                                            facts.push(at.clone());
                                        }
                                        let one_line = task.title.len() + facts.join("  ·  ").len() <= 80;
                                        let title = div()
                                            .flex()
                                            .items_baseline()
                                            .gap(px(8.))
                                            .child(div().text_color(color(token)).child(glyph))
                                            .child(
                                                div()
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .text_size(px(13.5))
                                                    .child(task.title.clone()),
                                            );
                                        let facts_row = |lead: &'static str| {
                                            div()
                                                .flex()
                                                .items_baseline()
                                                .gap(px(8.))
                                                .child(div().text_color(color("ink-2")).child(lead))
                                                .child(
                                                    div()
                                                        .font_family(theme::MONO)
                                                        .text_size(px(12.))
                                                        .text_color(color("ink-2"))
                                                        .child(facts.join("  ·  ")),
                                                )
                                        };
                                        let resume = (task.status == "running").then(|| {
                                            task.resumes_at.as_deref().map_or_else(
                                                || "Resumes when the provider allows".to_string(),
                                                |at| {
                                                    format!(
                                                        "Resumes {}",
                                                        crate::live::parse_iso_ms(at).map_or_else(
                                                            || at.to_string(),
                                                            crate::transcript::clock
                                                        )
                                                    )
                                                },
                                            )
                                        });
                                        let files = task.files.and_then(|(changed, added, removed)| {
                                            (changed != 0).then(|| {
                                                format!(
                                                    "+{added} −{removed} · {}",
                                                    if changed == 1 {
                                                        "1 file".to_string()
                                                    } else {
                                                        format!("{changed} files")
                                                    }
                                                )
                                            })
                                        });
                                        let footer: Vec<String> = resume
                                            .into_iter()
                                            .chain(files)
                                            .chain(task.branch.clone().map(|branch| format!("branch {branch}")))
                                            .collect();
                                        div()
                                            .flex()
                                            .flex_col()
                                            .gap(px(2.))
                                            .child(if one_line {
                                                title.child(
                                                    div()
                                                        .font_family(theme::MONO)
                                                        .text_size(px(12.))
                                                        .text_color(color("ink-2"))
                                                        .child(format!("  ·  {}", facts.join("  ·  "))),
                                                )
                                            } else {
                                                title
                                            })
                                            .when(!one_line, |s| s.child(facts_row("  ")))
                                            .children(task.headline.clone().map(|headline| {
                                                div()
                                                    .text_size(px(theme::BODY))
                                                    .line_height(px(theme::LINE))
                                                    .text_color(color("ink"))
                                                    .child(headline)
                                            }))
                                            .children((task.review
                                                && task.verdict.as_deref() != Some("MERGE"))
                                            .then(|| {
                                                div()
                                                    .text_size(px(13.))
                                                    .text_color(color(if task.verdict.is_none() {
                                                        "held"
                                                    } else {
                                                        "broken"
                                                    }))
                                                    .child(
                                                        task.verdict.clone().map_or_else(
                                                            || {
                                                                "No verdict — this is not a finished review"
                                                                    .to_string()
                                                            },
                                                            |verdict| format!("Verdict: {verdict}"),
                                                        ),
                                                    )
                                            }))
                                            .children((task.review
                                                && task.verdict.as_deref() == Some("MERGE"))
                                            .then(|| {
                                                div()
                                                    .text_size(px(13.))
                                                    .text_color(color("added"))
                                                    .child(format!(
                                                        "Verdict: {}",
                                                        task.verdict.clone().unwrap_or_default()
                                                    ))
                                            }))
                                            .when(!footer.is_empty(), |s| {
                                                s.child(
                                                    div()
                                                        .font_family(theme::MONO)
                                                        .text_size(px(12.))
                                                        .text_color(color("ink-2"))
                                                        .child(format!("  {}", footer.join("  ·  "))),
                                                )
                                            })
                                    }))
                                    .into_any_element()
                            }
                            Message::UsageProtection { at } => div()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .border_l_2()
                                .border_color(color("rule"))
                                .pl(px(14.))
                                .py(px(4.))
                                .child(
                                    div()
                                        .flex()
                                        .items_baseline()
                                        .gap(px(8.))
                                        .child(div().text_color(color("held")).child("◔"))
                                        .child(
                                            div()
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .text_size(px(13.5))
                                                .text_color(color("held"))
                                                .child("Usage protection"),
                                        )
                                        .child(
                                            div()
                                                .font_family(theme::MONO)
                                                .text_size(px(12.))
                                                .text_color(color("ink-2"))
                                                .child(at.clone()),
                                        ),
                                )
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .text_color(color("ink-2"))
                                        .child(
                                            "Shared usage is nearly exhausted. Wrapping up safely before waiting for recovery.",
                                        ),
                                )
                                .into_any_element(),
                            Message::Continued { kind, at } => {
                                let text = match kind {
                                    crate::model::ContinuedKind::Handoff => "Preparing a handoff",
                                    crate::model::ContinuedKind::Background => "Background task finished",
                                    crate::model::ContinuedKind::UsageReset => {
                                        "Continued after the usage limit reset"
                                    }
                                };
                                div()
                                    .flex()
                                    .items_baseline()
                                    .gap(px(8.))
                                    .text_size(px(13.))
                                    .child(div().text_color(color("held")).child("↻"))
                                    .child(div().text_color(color("ink-2")).child(text))
                                    .child(
                                        div()
                                            .font_family(theme::MONO)
                                            .text_size(px(12.))
                                            .text_color(color("ink-2"))
                                            .child(format!("  ·  {at}")),
                                    )
                                    .into_any_element()
                            }
                            Message::Tool {
                                name,
                                summary: target,
                                output,
                                meta,
                                failed,
                                running: step_running,
                            } => div()
                                .when(is_first, |s| {
                                    let fold = entity.clone();
                                    s.pt(px(10.))
                                        .child(
                                            div()
                                                .id("run-summary")
                                                .quiet()
                                                .flex()
                                                .items_center()
                                                .gap(px(6.))
                                                .py(px(4.))
                                                .mx(px(-4.))
                                                .px(px(4.))
                                                .rounded(px(4.))
                                                .text_size(px(12.5))
                                                .text_color(color("ink-2"))
                                                .child(ui::icon(
                                                    if folded {
                                                        "chevron-right"
                                                    } else {
                                                        "chevron-down"
                                                    },
                                                    "ink-2",
                                                ))
                                                .child(summary.clone())
                                                .on_click(move |_, _, cx| {
                                                    fold.update(cx, |this, cx| {
                                                        if !this.fold_toggled.remove(&(id, start)) {
                                                            this.fold_toggled.insert((id, start));
                                                        }
                                                        if this.run_folded(
                                                            id,
                                                            start,
                                                            len,
                                                            this.source.messages(id).len(),
                                                        ) {
                                                            this.unfolded_at.remove(&(id, start));
                                                        } else {
                                                            this.unfolded_at.insert(
                                                                (id, start),
                                                                std::time::Instant::now(),
                                                            );
                                                        }
                                                        this.lists[id]
                                                            .splice(start..start + len, len);
                                                        cx.notify();
                                                    })
                                                }),
                                        )
                                        .when(!folded, |s| s.child(div().h(px(6.))))
                                })
                                .when(!folded, |s| {
                                    s.child(crate::steps::render(
                                        crate::steps::Step {
                                            name,
                                            summary: target,
                                            output,
                                            meta,
                                            failed,
                                            running: step_running,
                                            id,
                                            index,
                                            shown: if is_first { 1. } else { shown },
                                            open,
                                        },
                                        entity.clone(),
                                    ))
                                })
                                .into_any_element(),
                        };
                        let tool = matches!(current, Message::Tool { .. });
                        div()
                            .w_full()
                            .px(px(28.))
                            .pt(px(if index == 0 {
                                28.
                            } else if tool {
                                0.
                            } else {
                                TURN_GAP
                            }))
                            .when(index + 1 == messages.len(), |s| s.pb(px(24.)))
                            .flex()
                            .justify_center()
                            .child(div().w_full().max_w(px(theme::READING)).child(body))
                            .into_any_element()
                    })
                    .size_full()
                    .into_any_element()
                }),
        )
        .child(composer(w, &thread, draft_empty, window, cx))
}

fn composer(
    w: &Workspace,
    thread: &crate::model::Thread,
    draft_empty: bool,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let id = w.selected;
    let creating = w.creating;
    let running = thread.status == Status::Running && !creating;
    let waiting = if creating {
        vec![]
    } else {
        w.source.queued(id)
    };
    div()
        .flex_shrink_0()
        .px(px(28.))
        .pb(px(18.))
        .pt(px(6.))
        .flex()
        .justify_center()
        .child(
            div()
                .w_full()
                .max_w(px(theme::READING))
                .flex()
                .flex_col()
                .gap(px(6.))
                .when_some(w.problem.clone(), |s, message| {
                    s.child(problem(message, cx))
                })
                .when(!waiting.is_empty(), |s| {
                    s.child(queue_strip(&waiting, running, cx))
                })
                .children(protection_banner(w, cx))
                .child(match crate::ask::panel(w, id, creating, cx) {
                    Some(panel) => panel,
                    None => card(w, thread, draft_empty, window, cx).into_any_element(),
                })
                .children(status_line(w, cx)),
        )
}

/// The composer: model, access and mode chips, the draft and its buttons.
fn card(
    w: &Workspace,
    thread: &crate::model::Thread,
    draft_empty: bool,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Div {
    let creating = w.creating;
    let running = thread.status == Status::Running && !creating;
    div()
        .relative()
        .border(px(theme::px_token("stroke", "stroke-rule")))
        .border_color(color(if running { "live" } else { "edge" }))
        .rounded(px(theme::px_token("radius", "radius-lg")))
        .bg(color("ground"))
        .pt(px(10.))
        .pb(px(10.))
        .pl(px(14.))
        .pr(px(12.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .ml(px(-6.))
                .flex()
                .gap(px(4.))
                .items_center()
                .when(creating, |s| s.child(project_chip(w, cx)))
                .child(model_pill(w, cx))
                .child(menu_chip(
                    w,
                    Dropdown::Access,
                    "access",
                    "Access",
                    match access_of(w, thread).as_str() {
                        "" => "Default access".to_string(),
                        mode => mode_label(&RUNTIME_MODES, mode),
                    },
                    running,
                    cx,
                ))
                .child(menu_chip(
                    w,
                    Dropdown::Mode,
                    "mode",
                    "Mode",
                    mode_label(&INTERACTION_MODES, &mode_of(w, thread)),
                    running,
                    cx,
                )),
        )
        .child(w.active_composer().clone())
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .id("attach")
                        .inert("Attachments are unavailable in this preview")
                        .ml(px(-6.))
                        .size(px(28.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .child(ui::icon("paperclip", "ink-2")),
                )
                .child(div().flex_1())
                .when(running, |s| {
                    s.child(
                        div()
                            .relative()
                            .children(ui::focus_tip(
                                &w.tips.stop,
                                window,
                                "Stop",
                                "esc",
                                ui::Tip::AboveRight,
                            ))
                            .child(
                                div()
                                    .id("stop")
                                    .track_focus(&w.tips.stop)
                                    .shortcut("Stop", "esc")
                                    .size(px(30.))
                                    .border(px(theme::px_token("stroke", "stroke-rule")))
                                    .border_color(color("edge"))
                                    .rounded(px(theme::px_token("radius", "radius-md")))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    // A filled stop square, not an outlined one.
                                    .child(div().size(px(9.)).rounded(px(2.)).bg(color("ink")))
                                    .on_click(cx.listener(|this, _, _, cx| this.stop(cx))),
                            ),
                    )
                })
                .when(running, |s| {
                    s.child(
                        div()
                            .id("queue")
                            .shortcut("Queue for after this turn", "⌘↵")
                            .h(px(30.))
                            .px(px(10.))
                            .border(px(theme::px_token("stroke", "stroke-rule")))
                            .border_color(color("edge"))
                            .rounded(px(theme::px_token("radius", "radius-md")))
                            .flex()
                            .items_center()
                            .text_size(px(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .child("Queue")
                            .on_click(cx.listener(|this, _, window, cx| {
                                window.focus(&this.active_composer().read(cx).focus.clone(), cx);
                                window.dispatch_action(Box::new(crate::composer::QueueSend), cx);
                            })),
                    )
                })
                .child(
                    div()
                        .relative()
                        .children(ui::focus_tip(
                            &w.tips.send,
                            window,
                            if running {
                                "Steer the running turn"
                            } else {
                                "Send"
                            },
                            "↵",
                            ui::Tip::AboveRight,
                        ))
                        .child(
                            div()
                                .id("send")
                                .track_focus(&w.tips.send)
                                .when(!draft_empty, |s| {
                                    s.shortcut(
                                        if running {
                                            "Steer the running turn"
                                        } else {
                                            "Send"
                                        },
                                        "↵",
                                    )
                                })
                                .when(draft_empty, |s| {
                                    s.cursor(CursorStyle::Arrow).opacity(0.35).tooltip(|_, cx| {
                                        cx.new(|_| {
                                            ui::Tooltip("Write a message to send".into(), Some("↵"))
                                        })
                                        .into()
                                    })
                                })
                                .size(px(30.))
                                .rounded(px(theme::px_token("radius", "radius-md")))
                                .bg(color("ink"))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(ui::icon("arrow-up", "on-ink"))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    window
                                        .focus(&this.active_composer().read(cx).focus.clone(), cx);
                                    window.dispatch_action(Box::new(crate::composer::Send), cx);
                                })),
                        ),
                ),
        )
        .when(w.picker_open, |s| {
            s.child(crate::model_picker::render(w, window, cx))
        })
}

/// How the thread (or the one being drafted) may act on its own.
fn access_of(w: &Workspace, thread: &Thread) -> String {
    if w.creating {
        w.new_runtime
            .map_or_else(String::new, |at| RUNTIME_MODES[at].0.into())
    } else {
        thread.runtime_mode.clone()
    }
}
fn mode_of(w: &Workspace, thread: &Thread) -> String {
    if w.creating {
        INTERACTION_MODES[w.new_interaction].0.into()
    } else {
        thread.interaction_mode.clone()
    }
}

fn model_pill(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let selection = w.effective_selection();
    let (name, tone) = w.model_label(selection.as_ref());
    // The reasoning level beside the name, once the catalog says what it is.
    let effort = selection
        .as_ref()
        .zip(w.catalog())
        .and_then(|(selection, catalog)| catalog.effort_label(selection));
    div()
        .id("model-pill")
        .shortcut("Model and effort", "⌘M")
        .track_focus(&w.model_focus)
        .h(px(28.))
        .px(px(10.))
        .flex()
        .gap(px(8.))
        .items_center()
        .rounded(px(14.))
        .when(w.picker_open, |s| s.bg(color("sunk")))
        .child(div().size(px(8.)).rounded(px(2.)).bg(color(tone)))
        .child(
            div()
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(color(tone))
                .child(name),
        )
        .when_some(effort, |s, effort| {
            s.child(
                div()
                    .text_size(px(12.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(color("effort"))
                    .child(effort),
            )
        })
        .child(ui::icon("chevron-down", "ink-2"))
        .on_click(cx.listener(|this, _, window, cx| this.toggle_picker(window, cx)))
        .into_any_element()
}

/// A chip that opens a short menu above itself.
struct Menu {
    kind: Dropdown,
    id: &'static str,
    tooltip: &'static str,
    label: String,
    locked: bool,
    items: Vec<(String, bool)>,
}

fn chip_menu(
    w: &Workspace,
    menu: Menu,
    pick: impl Fn(&mut Workspace, usize, &mut Context<Workspace>) + Clone + 'static,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let Menu {
        kind,
        id,
        tooltip,
        label,
        locked,
        items,
    } = menu;
    let open = w.dropdown == Some(kind);
    let button = div()
        .id(id)
        .h(px(28.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(14.))
        .text_size(px(12.5))
        .font_weight(FontWeight::MEDIUM)
        .text_color(color("ink-2"))
        .when(open, |s| s.bg(color("sunk")))
        .child(label)
        .child(ui::icon("chevron-down", "ink-2"));
    let button = if locked {
        button
            .disabled("Change this once the turn has finished")
            .into_any_element()
    } else {
        button
            .control(tooltip)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.dropdown = if this.dropdown == Some(kind) {
                    None
                } else {
                    Some(kind)
                };
                cx.notify();
            }))
            .into_any_element()
    };
    div().relative().child(button).when(open && !locked, |s| {
        s.child(
            div()
                .id(SharedString::from(format!("{id}-menu")))
                .occlude()
                .absolute()
                .bottom(relative(1.))
                .mb(px(6.))
                .left(px(0.))
                .min_w(px(180.))
                .max_w(px(320.))
                .p(px(6.))
                .rounded(px(12.))
                .bg(color("raised"))
                .shadow(theme::float_shadow())
                .text_size(px(13.5))
                .children(items.into_iter().enumerate().map(|(i, (name, selected))| {
                    let pick = pick.clone();
                    div()
                        .id((id, i))
                        .control(name.clone())
                        .h(px(30.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .rounded(px(6.))
                        .when(selected, |s| s.bg(color("sunk")))
                        .child(div().flex_1().truncate().child(name))
                        .when(selected, |s| s.child(ui::icon("check", "ink-2")))
                        .on_click(cx.listener(move |this, _, _, cx| pick(this, i, cx)))
                })),
        )
    })
}

fn menu_chip(
    w: &Workspace,
    kind: Dropdown,
    id: &'static str,
    tooltip: &'static str,
    label: String,
    locked: bool,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let table: &[(&str, &str)] = if kind == Dropdown::Access {
        &RUNTIME_MODES
    } else {
        &INTERACTION_MODES
    };
    let current = if w.creating {
        if kind == Dropdown::Access {
            w.new_runtime.unwrap_or(usize::MAX)
        } else {
            w.new_interaction
        }
    } else {
        let thread = &w.source.list_threads()[w.selected];
        let value = if kind == Dropdown::Access {
            &thread.runtime_mode
        } else {
            &thread.interaction_mode
        };
        table.iter().position(|(v, _)| v == value).unwrap_or(0)
    };
    let items = table
        .iter()
        .enumerate()
        .map(|(i, (_, name))| (name.to_string(), i == current))
        .collect();
    let menu = Menu {
        kind,
        id,
        tooltip,
        label,
        locked,
        items,
    };
    chip_menu(
        w,
        menu,
        move |this, i, cx| {
            if kind == Dropdown::Access {
                this.set_access(i, cx)
            } else {
                this.set_mode(i, cx)
            }
        },
        cx,
    )
}

/// Where a new thread starts, with the folder picker at the end of the list.
fn project_chip(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let projects = w.source.projects();
    let current = w.new_project_id();
    let label = w.new_project_title().unwrap_or_else(|| "Project".into());
    let mut items: Vec<(String, bool)> = projects
        .iter()
        .map(|p| (p.title.clone(), Some(&p.id) == current.as_ref()))
        .collect();
    items.push(("Add project…".into(), false));
    let menu = Menu {
        kind: Dropdown::Project,
        id: "project",
        tooltip: "Project for the new thread",
        label,
        locked: false,
        items,
    };
    chip_menu(
        w,
        menu,
        move |this, i, cx| {
            let projects = this.source.projects();
            this.dropdown = None;
            match projects.get(i) {
                Some(project) => this.new_project = Some(project.id.clone()),
                None => this.add_project(cx),
            }
            cx.notify();
        },
        cx,
    )
}

fn new_thread(w: &Workspace) -> impl IntoElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .child(
            div()
                .text_size(px(20.))
                .font_weight(FontWeight::SEMIBOLD)
                .child("New thread"),
        )
        .child(
            div()
                .max_w(px(420.))
                .text_center()
                .text_color(color("ink-2"))
                .child(match w.new_project_title() {
                    Some(project) => format!(
                        "It starts in {project}. Choose how it runs below, then write the first message."
                    ),
                    None => "Add a project to start a thread in.".into(),
                }),
        )
}

fn problem(message: String, cx: &mut Context<Workspace>) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(12.))
        .py(px(6.))
        .rounded(px(theme::px_token("radius", "radius-md")))
        .bg(color("sunk"))
        .text_size(px(13.))
        .child(ui::state(Status::Error))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_color(color("broken"))
                .child(message),
        )
        .child(
            div()
                .id("dismiss-problem")
                .control("Dismiss")
                .size(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .child(ui::icon("x", "ink-2"))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.problem = None;
                    cx.notify();
                })),
        )
}

/// Usage protection holds: the thread's own hold, the forecasts that say to
/// wrap up, and the recovery queue, with the TUI's actions on each.
fn protection_banner(w: &Workspace, cx: &mut Context<Workspace>) -> Option<AnyElement> {
    let id = w.selected;
    let hold = w.source.hold(id);
    let protection = w.source.protection();
    let forecasts: Vec<crate::usage::Forecast> = protection
        .as_deref()
        .map(|protection| {
            protection
                .forecasts
                .iter()
                .filter(|forecast| forecast.should_wrap)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let queue = protection
        .as_deref()
        .map(|protection| protection.queue.clone())
        .unwrap_or_default();
    let error = protection
        .as_deref()
        .and_then(|protection| protection.error.clone());
    if hold.is_none() && forecasts.is_empty() && queue.is_empty() && error.is_none() {
        return None;
    }
    let action = |slot: (&'static str, usize), tooltip: &'static str, label: &'static str| {
        div()
            .id(slot)
            .control(tooltip)
            .h(px(22.))
            .px(px(8.))
            .flex()
            .flex_shrink_0()
            .items_center()
            .rounded(px(6.))
            .text_size(px(12.5))
            .font_weight(FontWeight::MEDIUM)
            .text_color(color("ink-2"))
            .child(label)
    };
    let name_of = |provider: &str| {
        w.catalog()
            .as_ref()
            .and_then(|catalog| {
                catalog
                    .providers
                    .iter()
                    .find(|candidate| {
                        candidate.instance.eq_ignore_ascii_case(provider)
                            || crate::usage::driver_kind(&candidate.instance) == Some(provider)
                    })
                    .map(|candidate| candidate.name.clone())
            })
            .unwrap_or_else(|| provider.to_string())
    };
    let mut rows = div().flex().flex_col().gap(px(4.));
    if let Some(hold) = hold {
        let title = hold.title().to_string();
        let detail = hold.detail().to_string();
        let wake = (hold.waiting > 0).then(|| {
            if hold.waiting == 1 {
                "1 wake-up waiting".to_string()
            } else {
                format!("{} wake-ups waiting", hold.waiting)
            }
        });
        rows = rows.child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .px(px(12.))
                .py(px(6.))
                .rounded(px(theme::px_token("radius", "radius-md")))
                .bg(color("sunk"))
                .text_size(px(13.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(div().text_color(color("held")).child("◔"))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
                        .children(wake.map(|wake| {
                            div()
                                .font_family(theme::MONO)
                                .text_size(px(11.5))
                                .text_color(color("ink-2"))
                                .child(format!("· {wake}"))
                        })),
                )
                .child(div().text_color(color("ink-2")).child(detail)),
        );
    }
    if let Some(error) = error {
        rows = rows.child(
            div()
                .px(px(12.))
                .text_size(px(13.))
                .text_color(color("broken"))
                .child(format!("Couldn't read usage protection: {error}")),
        );
    }
    let now = crate::live::now_ms();
    for (at, forecast) in forecasts.iter().enumerate() {
        let provider = name_of(&forecast.provider);
        let work = forecast
            .remaining_ms
            .map_or_else(|| "unknown".to_string(), crate::usage::duration_words);
        let reset = forecast
            .resets_at
            .as_deref()
            .and_then(|resets| {
                crate::live::parse_iso_ms(resets)
                    .map(|target| crate::usage::duration_words((target - now).max(0)))
            })
            .unwrap_or_else(|| "unknown".to_string());
        let provider_command = forecast.provider.clone();
        rows = rows.child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(12.))
                .py(px(6.))
                .rounded(px(theme::px_token("radius", "radius-md")))
                .bg(color("sunk"))
                .text_size(px(13.))
                .child(div().text_color(color("held")).child("◔"))
                .child(div().flex_1().min_w_0().truncate().child(format!(
                    "{provider} · {} {}% · ~{work} of work left · resets in {reset} · estimate",
                    forecast.label,
                    forecast.used_percent.round() as i64,
                )))
                .child(
                    action(
                        ("protection-wrap", at),
                        "Wrap up all work on this account",
                        "Wrap up all",
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.source.wrap_provider(provider_command.clone());
                        cx.notify();
                    })),
                ),
        );
    }
    for (at, entry) in queue.iter().enumerate() {
        let thread = entry.thread_id.clone();
        let detail = entry.detail(now);
        rows = rows.child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .px(px(12.))
                .py(px(6.))
                .rounded(px(theme::px_token("radius", "radius-md")))
                .bg(color("sunk"))
                .text_size(px(13.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(div().text_color(color("held")).child("◔"))
                        .child(div().flex_1().min_w_0().truncate().child(format!(
                            "{}. {} · {}",
                            at + 1,
                            entry.title,
                            entry.phase.label()
                        ))),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_color(color("ink-2"))
                                .child(detail),
                        )
                        .children(entry.actions().into_iter().enumerate().map(
                            |(move_at, direction)| {
                                let command = thread.clone();
                                action(
                                    ("protection-queue", at * 4 + move_at),
                                    direction.label(),
                                    direction.label(),
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.source.queue_protection(command.clone(), direction);
                                        cx.notify();
                                    },
                                ))
                            },
                        )),
                ),
        );
    }
    Some(rows.into_any_element())
}

/// Messages waiting for the running turn: the next few, each of which can be
/// held, moved, taken back to edit, removed, or sent at once.
fn queue_strip(waiting: &[Queued], running: bool, cx: &mut Context<Workspace>) -> impl IntoElement {
    const SHOWN: usize = 3;
    let chip = |id: &'static str, at: usize, tooltip: &'static str, label: &'static str| {
        div()
            .id((id, at))
            .control(tooltip)
            .h(px(22.))
            .px(px(8.))
            .flex()
            .flex_shrink_0()
            .items_center()
            .rounded(px(6.))
            .text_size(px(12.5))
            .font_weight(FontWeight::MEDIUM)
            .text_color(color("ink-2"))
            .child(label)
    };
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .children(waiting.iter().take(SHOWN).enumerate().map(|(at, item)| {
            let key = |item: &Queued| item.key.clone();
            let (up, down, hold, edit, remove, now) = (
                key(item),
                key(item),
                key(item),
                key(item),
                key(item),
                key(item),
            );
            let label = if item.held {
                "held".to_string()
            } else if item.scheduled.is_some() {
                "scheduled".to_string()
            } else {
                "queued".to_string()
            };
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(12.))
                .py(px(6.))
                .rounded(px(theme::px_token("radius", "radius-md")))
                .bg(color("sunk"))
                .text_size(px(13.))
                .child(ui::state(if item.held {
                    Status::Held
                } else {
                    Status::Queued
                }))
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .text_color(color("ink-2"))
                        .child(label),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(item.text.lines().next().unwrap_or_default().to_string()),
                )
                .when(item.earlier > 0, |s| {
                    s.child(
                        chip("queue-up", at, "Move earlier", "↑").on_click(cx.listener(
                            move |this, _, _, cx| this.edit_queued(&up, QueueEdit::Earlier, cx),
                        )),
                    )
                })
                .when(item.later > 0, |s| {
                    s.child(
                        chip("queue-down", at, "Move later", "↓").on_click(cx.listener(
                            move |this, _, _, cx| this.edit_queued(&down, QueueEdit::Later, cx),
                        )),
                    )
                })
                .child(if item.held {
                    chip(
                        "queue-hold",
                        at,
                        "Let it run when its turn comes",
                        "Release",
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.edit_queued(&hold, QueueEdit::Release, cx)
                    }))
                } else {
                    chip("queue-hold", at, "Keep it back until released", "Hold").on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.edit_queued(&hold, QueueEdit::Hold, cx)
                        }),
                    )
                })
                .child(
                    chip("queue-edit", at, "Take it back to edit", "Edit").on_click(cx.listener(
                        move |this, _, window, cx| this.edit_queued_text(&edit, window, cx),
                    )),
                )
                .child(
                    chip("queue-remove", at, "Remove without sending", "Remove").on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.edit_queued(&remove, QueueEdit::Remove, cx)
                        }),
                    ),
                )
                .when(running && at == 0 && !item.held, |s| {
                    s.child(
                        chip(
                            "queue-now",
                            at,
                            "Stop this turn and send this message",
                            "Send now",
                        )
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.send_queued_now(&now, cx)),
                        ),
                    )
                })
        }))
        .when(waiting.len() > SHOWN, |s| {
            s.child(
                div()
                    .px(px(12.))
                    .font_family(theme::MONO)
                    .text_size(px(11.5))
                    .text_color(color("ink-2"))
                    .child(format!("+{} more waiting", waiting.len() - SHOWN)),
            )
        })
}

/// A status-line chip: 28pt tall with a tooltip.
fn chip(id: &'static str, tooltip: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .control(tooltip)
        .h(px(28.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(6.))
}

/// The checkout is known (the Git tab has read it): its branch is worth a chip.
fn has_branch(w: &Workspace) -> bool {
    w.source
        .git(w.selected)
        .overview
        .as_ref()
        .is_some_and(|o| o.is_repository)
}

fn status_line(w: &Workspace, cx: &mut Context<Workspace>) -> Option<AnyElement> {
    let background = crate::work_view::background_count(w);
    let usage = usage_chip(w, cx);
    if !has_branch(w) && usage.is_none() && background == 0 {
        return None;
    }
    let git = w.source.git(w.selected);
    let overview = git.overview.as_ref().filter(|o| o.is_repository);
    let branch = overview
        .and_then(|o| o.checked_out())
        .unwrap_or("detached")
        .to_string();
    let changed = overview
        .and_then(|o| o.status.as_ref())
        .map(|s| s.line())
        .filter(|line| line != "clean");
    let line = div()
        .mx(px(-6.))
        .flex()
        .items_center()
        .gap(px(4.))
        .min_w_0()
        .overflow_hidden()
        .font_family(theme::MONO)
        .text_size(px(12.))
        .text_color(color("ink-2"))
        .when(has_branch(w), |s| {
            s.child(
                chip("branch", "Open Git")
                    .min_w_0()
                    .child(ui::icon("git-branch", "ink-2"))
                    .child(div().text_color(color("ink")).child(branch))
                    .children(changed.map(|line| {
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(color("effort"))
                            .child(line)
                    }))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.tab = 1;
                        this.set_inspector(true);
                        cx.notify();
                    })),
            )
        })
        .child(div().flex_1())
        .when(background > 0, |s| {
            s.child(
                chip("background", "Open background tasks")
                    .child(format!("{background} background"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.tab = 4;
                        this.set_inspector(true);
                        cx.notify();
                    })),
            )
        })
        .children(usage);
    Some(line.into_any_element())
}

/// The usage chip: the thread's context share and the account's plan gauges,
/// from the server. The context segment shows whenever the thread's totals
/// are known; the gauges whenever the account's limits are — like the TUI's
/// composer footer, which keeps its gauges on an idle thread with no reading.
fn usage_chip(w: &Workspace, cx: &mut Context<Workspace>) -> Option<AnyElement> {
    let id = w.selected;
    let context = w.source.context(id);
    let totals = context
        .as_deref()
        .and_then(|context| context.totals())
        .or_else(|| {
            w.source
                .snapshot_usage(id)
                .map(|usage| (usage.used, usage.max))
        });
    let breakdown = context
        .as_deref()
        .and_then(|context| context.breakdown.as_ref());
    let instance = w.source.selection(id).map(|selection| selection.instance);
    let limits = w.source.limits();
    let catalog = w.catalog();
    let gauges = crate::usage::plan_gauges(instance.as_deref().and_then(|instance| {
        crate::usage::provider_limits(limits.as_deref(), catalog.as_deref(), instance)
    }));
    if totals.is_none() && gauges.is_empty() {
        return None;
    }
    let shares = breakdown
        .map(|breakdown| {
            crate::usage::context_shares(&breakdown.categories, breakdown.max, breakdown.used)
        })
        .unwrap_or_default();
    let label = totals.map(|(used, max)| {
        let percent = max
            .filter(|max| *max > 0)
            .map(|max| crate::usage::window_percent(used, max));
        match (percent, max) {
            // Like the TUI's composer footer: the share, then the used and
            // ceiling without spaces around the slash.
            (Some(percent), Some(max)) => format!(
                "{percent}% · {}/{}",
                crate::usage::format_count(used),
                crate::usage::format_count(max)
            ),
            _ => format!("{} tokens in context", crate::usage::format_count(used)),
        }
    });
    let usage = chip("usage", "Context and plan usage")
        .flex_shrink_0()
        .children((!shares.is_empty()).then(|| crate::usage::meter(&shares, 24., 5.)))
        .children(label.map(|label| {
            div()
                .text_color(color("ink"))
                .child(label)
                .into_any_element()
        }))
        .children(gauges.iter().enumerate().flat_map(|(at, gauge)| {
            let token = if gauge.percent >= 90. {
                "broken"
            } else if gauge.percent >= 70. {
                "held"
            } else {
                "ink-2"
            };
            // The separator divides the gauges from what stands before them.
            let divided = totals.is_some() || !shares.is_empty() || at > 0;
            [
                divided.then(|| {
                    div()
                        .w(px(1.))
                        .h(px(12.))
                        .mx(px(2.))
                        .bg(color("rule"))
                        .into_any_element()
                }),
                Some(div().child(gauge.short.clone()).into_any_element()),
                Some(
                    div()
                        .text_color(color(token))
                        .child(format!("{}%", gauge.percent.round() as i64))
                        .into_any_element(),
                ),
            ]
            .into_iter()
            .flatten()
        }))
        .on_click(cx.listener(|this, _, _, cx| {
            this.tab = 2;
            this.set_inspector(true);
            cx.notify();
        }));
    Some(usage.into_any_element())
}

#[cfg(test)]
mod tests {
    #[test]
    fn run_summary_counts_each_kind() {
        let source = crate::mock::MockSource::preview();
        use crate::model::ThreadSource;
        assert_eq!(
            super::run_summary(&source.messages(0)),
            "Ran 3 commands, read 3 files, edited 1 file"
        );
    }
    #[test]
    fn steps_between_messages_form_one_run() {
        use crate::model::Message::{Assistant, Tool, User};
        let step = || Tool {
            name: "command".into(),
            summary: String::new(),
            output: String::new(),
            meta: String::new(),
            failed: false,
            running: false,
        };
        let messages = vec![
            User {
                text: String::new(),
            },
            step(),
            step(),
            Assistant {
                text: String::new(),
                at: String::new(),
            },
            step(),
        ];
        assert_eq!(super::run_of(&messages, 2), (1, 2));
        assert_eq!(super::run_of(&messages, 4), (4, 1));
        // A message that is not a step is a run of its own.
        assert_eq!(super::run_of(&messages, 3), (3, 1));
    }
}
