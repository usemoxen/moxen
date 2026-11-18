use crate::ui::{self, Control};
use crate::{
    attachments::{Asset, Picture, ReplyBlock, reply_blocks},
    image_view::{self, ImageItem, Source},
    model::{
        INTERACTION_MODES, Message, QueueEdit, Queued, RUNTIME_MODES, Status, Thread, ThreadId,
        mode_label,
    },
    theme::{self, color},
    workspace::{Dropdown, Workspace},
};
use gpui::{prelude::*, *};
use std::sync::Arc;

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

/// "Ran 3 commands, read 3 files, updated 1 file": the folded run's summary
/// in the TUI's words (`summary.*`), the first part capitalized as the TUI
/// does. The desktop's tool buckets map to the TUI's: edits read as updates
/// (the TUI's own fallback for file changes), code searches as `grep`, and
/// thoughts fall into the default `step` bucket, as unknown tools do.
pub fn run_summary(messages: &[Message]) -> String {
    use crate::language::plural;
    let count = |kind: &str| {
        messages
            .iter()
            .filter(|m| matches!(m, Message::Tool { name, .. } if name == kind))
            .count()
    };
    let mut parts = vec![];
    let ran = count("command");
    if ran > 0 {
        parts.push(plural("summary.command.one", "summary.command.other", ran));
    }
    let read = count("read");
    if read > 0 {
        parts.push(plural("summary.read.one", "summary.read.other", read));
    }
    let searched = count("search");
    if searched > 0 {
        parts.push(plural("summary.grep.one", "summary.grep.other", searched));
    }
    let edited = count("edit");
    if edited > 0 {
        parts.push(plural(
            "summary.file_updated.one",
            "summary.file_updated.other",
            edited,
        ));
    }
    let used = count("tool");
    if used > 0 {
        parts.push(plural("summary.tool.one", "summary.tool.other", used));
    }
    if parts.is_empty() {
        parts.push(plural(
            "summary.step.one",
            "summary.step.other",
            count("thought"),
        ));
    }
    let mut text = parts.join(", ");
    if let Some(first) = text.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    text
}

/// One user prompt as the transcript draws it: a right-aligned sunk bubble.
/// The thread view adds the message's file chips and image thumbnails to the
/// bubble; a research role column draws the bare bubble.
pub fn prompt_bubble(text: String) -> Div {
    div()
        .max_w(relative(0.82))
        .px(px(14.))
        .py(px(10.))
        .rounded(px(14.))
        .bg(color("sunk"))
        .text_size(px(theme::BODY))
        .line_height(px(theme::BODY * 1.55))
        .flex()
        .flex_col()
        .gap(px(8.))
        .when(!text.is_empty(), |s| s.child(text))
}

/// The running turn's clock under an assistant reply's header.
pub fn live_clock(seconds: u64) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .font_family(theme::MONO)
        .text_size(px(12.))
        .text_color(color("live"))
        .child(ui::state(Status::Running))
        .child(format!(
            "{} · {}m {:02}s",
            crate::language::tr("working"),
            seconds / 60,
            seconds % 60
        ))
        .into_any_element()
}

/// What an assistant reply carries above its prose: who wrote it, when, and
/// the running turn's clock when it is still being written.
pub struct AssistantHead<'a> {
    pub model: &'a str,
    pub tone: &'static str,
    pub at: &'a str,
    pub live: Option<AnyElement>,
}

/// One assistant reply as the transcript draws it: the model that wrote it
/// and when, over its prose. `live` is the running turn's clock, shown only
/// under the reply still being written.
pub fn assistant_message(
    head: AssistantHead<'_>,
    text: &str,
    id: ThreadId,
    w: &Workspace,
    entity: Entity<Workspace>,
    missing: &mut Vec<Picture>,
) -> AnyElement {
    let AssistantHead {
        model,
        tone,
        at,
        live,
    } = head;
    div()
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
                        .text_color(color(tone))
                        .child(model.to_string()),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child(at.to_string()),
                )
                .when_some(live, |s, live| s.child(div().flex_1()).child(live)),
        )
        .child(reply_body(text, id, w, entity, missing))
        .into_any_element()
}

pub fn render(w: &Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let id = w.selected;
    let creating = w.creating;
    let draft = w.active_composer().read(cx);
    let draft_empty = draft.empty() || draft.loading_assets != 0;
    let threads = w.source.list_threads();
    let thread = threads.get(id);
    let running = !creating && thread.is_some_and(|thread| thread.status == Status::Running);
    let messages = if creating {
        Arc::default()
    } else {
        w.source.messages(id)
    };
    let last_reply = messages
        .iter()
        .rposition(|m| matches!(m, Message::Assistant { .. }));
    let entity = cx.entity();
    let (model, model_tone) = w.model_label(w.source.selection(id).as_ref());
    let started = thread.and_then(|thread| thread.started_at);
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
                } else if let Some((lead, role, agent)) = w.role_full {
                    crate::research_view::role_full(w, lead, role, agent, cx).into_any_element()
                } else if let Some(summary) = w.source.run_summary(id).filter(|_| w.show_run_view())
                {
                    crate::research_view::run_view(w, id, &summary, w.turn_width(window), cx)
                        .into_any_element()
                } else {
                    list(w.lists[id].clone(), move |index, window, cx| {
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
                        let mut missing = vec![];
                        let body = match current.clone() {
                            Message::User { text, images } => {
                                let images: Arc<Vec<ImageItem>> =
                                    Arc::new(images.into_iter().map(ImageItem::from).collect());
                                missing
                                    .extend(images.iter().filter_map(|image| image.missing(this)));
                                let (text, paths) = crate::attachments::file_chips(&text);
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_end()
                                    .child(
                                        prompt_bubble(text)
                                            .when(!paths.is_empty(), |s| {
                                                s.child(
                                                    div().flex().flex_wrap().gap(px(6.)).children(
                                                        paths.into_iter().enumerate().map(
                                                            |(i, (label, path))| {
                                                                div()
                                                                    .id(("sent-path", i))
                                                                    .max_w(px(230.))
                                                                    .px(px(8.))
                                                                    .py(px(3.))
                                                                    .truncate()
                                                                    .text_size(px(12.))
                                                                    .bg(color("ground"))
                                                                    .text_color(color("ink-2"))
                                                                    .rounded(px(theme::px_token(
                                                                        "radius",
                                                                        "radius-md",
                                                                    )))
                                                                    .child(label)
                                                                    .tooltip(move |_, cx| {
                                                                        cx.new(|_| {
                                                                            ui::Tooltip(
                                                                                path.clone().into(),
                                                                                None,
                                                                            )
                                                                        })
                                                                        .into()
                                                                    })
                                                            },
                                                        ),
                                                    ),
                                                )
                                            })
                                            .when(!images.is_empty(), |s| {
                                                s.child(
                                                    div().flex().flex_wrap().gap(px(6.)).children(
                                                        (0..images.len()).map(|at| {
                                                            image_view::thumbnail(
                                                                ("sent-image", at),
                                                                at,
                                                                images.clone(),
                                                                this,
                                                                entity.clone(),
                                                            )
                                                        }),
                                                    ),
                                                )
                                            }),
                                    )
                                    .into_any_element()
                            }
                            Message::Assistant { text, at } => assistant_message(
                                AssistantHead {
                                    model: &model,
                                    tone: model_tone,
                                    at: &at,
                                    live: (running && Some(index) == last_reply).then(|| {
                                        live_clock(
                                            started.map_or(0, |start| start.elapsed().as_secs()),
                                        )
                                    }),
                                },
                                &text,
                                id,
                                this,
                                entity.clone(),
                                &mut missing,
                            ),
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
                                                    crate::language::message(
                                                        "timeline.planImplemented",
                                                    )
                                                } else {
                                                    crate::language::message(
                                                        "timeline.planProposed",
                                                    )
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
                                    let toggle = entity.clone();
                                    s.child(crate::steps::render(
                                        crate::steps::Step {
                                            name,
                                            summary: target,
                                            output,
                                            meta,
                                            failed,
                                            running: step_running,
                                            index,
                                            shown: if is_first { 1. } else { shown },
                                            open,
                                        },
                                        move |cx: &mut App| {
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
                                        },
                                    ))
                                })
                                .into_any_element(),
                        };
                        if !missing.is_empty() {
                            let weak = entity.downgrade();
                            cx.defer(move |cx| {
                                weak.update(cx, |this, _| {
                                    for picture in &missing {
                                        this.source.read_image(picture);
                                    }
                                })
                                .ok();
                            });
                        }
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
                            .child(
                                div()
                                    .id(("transcript-message", index))
                                    .w_full()
                                    .max_w(px(theme::READING))
                                    .child(body)
                                    .when(
                                        matches!(
                                            current,
                                            Message::User { .. } | Message::Assistant { .. }
                                        ),
                                        |s| {
                                            let entity = entity.clone();
                                            s.on_mouse_down(
                                                MouseButton::Right,
                                                move |event, window, cx| {
                                                    entity.update(cx, |this, cx| {
                                                        this.open_thread_menu(
                                                            id,
                                                            event.position,
                                                            Some(index),
                                                            window,
                                                            cx,
                                                        )
                                                    });
                                                },
                                            )
                                        },
                                    ),
                            )
                            .into_any_element()
                    })
                    .size_full()
                    .into_any_element()
                }),
        )
        .child(composer(w, thread, draft_empty, window, cx))
}

fn reply_body(
    text: &str,
    id: usize,
    w: &Workspace,
    entity: Entity<Workspace>,
    missing: &mut Vec<Picture>,
) -> Div {
    let blocks = reply_blocks(text);
    let images: Arc<Vec<ImageItem>> = Arc::new(
        blocks
            .iter()
            .filter_map(|block| match block {
                ReplyBlock::Image { label, path } => Some(ImageItem {
                    name: if label.is_empty() { *path } else { *label }.to_owned(),
                    source: Source::Server(Picture::Reply {
                        thread: id,
                        path: (*path).to_owned(),
                    }),
                }),
                ReplyBlock::Text(_) => None,
            })
            .collect(),
    );
    missing.extend(images.iter().filter_map(|image| image.missing(w)));
    let mut at = 0;
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .text_size(px(theme::BODY))
        .line_height(px(theme::LINE))
        .when(text.is_empty(), |s| {
            s.text_color(color("ink-2"))
                .child(crate::language::tr("Thinking…").into_owned())
        })
        .children(blocks.into_iter().map(|block| match block {
            ReplyBlock::Text(text) => div().child(text).into_any_element(),
            ReplyBlock::Image { .. } => {
                let current = at;
                at += 1;
                image_view::thumbnail(
                    ("reply-image", current),
                    current,
                    images.clone(),
                    w,
                    entity.clone(),
                )
                .into_any_element()
            }
        }))
}

fn back_title_state(w: &Workspace, back: ThreadId) -> (String, String) {
    if let Some((_, role, agent)) = w.role_full
        && let Some(summary) = w.source.run_summary(back)
        && let Some(row) = summary.agents[role as usize].get(agent)
    {
        return (
            crate::research_view::agent_title(&summary, row),
            format!(
                "{} · {}",
                crate::language::message("run.backPart"),
                row.state.label()
            ),
        );
    }
    let state = w
        .source
        .list_threads()
        .get(back)
        .map(|thread| thread.status.label())
        .unwrap_or("Done");
    (
        crate::language::message("run.leadTitle").into(),
        crate::language::tr(state).into_owned(),
    )
}

fn composer(
    w: &Workspace,
    thread: Option<&Thread>,
    draft_empty: bool,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let id = w.selected;
    let creating = w.creating;
    let running = !creating && thread.is_some_and(|thread| thread.status == Status::Running);
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
                // While the project form is open the error shows inline in
                // the form, not as a toast above the composer.
                .when_some(
                    w.project_form
                        .is_none()
                        .then(|| w.problem.clone())
                        .flatten(),
                    |s, message| s.child(problem(message, cx)),
                )
                .when(!waiting.is_empty(), |s| {
                    s.child(queue_strip(&waiting, running, cx))
                })
                .children(protection_banner(w, cx))
                .when_some(w.notice.clone(), |s, text| {
                    s.child(crate::research_view::notice(&text, cx))
                })
                .when_some(
                    crate::research_view::proposal_panel(w, id, cx),
                    |s, panel| s.child(panel),
                )
                .child(if let Some(back) = w.run_back_to() {
                    let (title, state) = back_title_state(w, back);
                    crate::research_view::back_bar(w, &title, &state, cx).into_any_element()
                } else {
                    match crate::ask::panel(w, id, creating, cx) {
                        Some(panel) => panel,
                        None => card(w, thread, draft_empty, window, cx).into_any_element(),
                    }
                })
                // A new-thread draft has no status of its own: the open thread's
                // branch, usage and background chips stay hidden until the
                // thread is listed.
                .children(
                    thread
                        .filter(|_| Workspace::shown_thread(w.creating, w.selected).is_some())
                        .and_then(|_| status_line(w, cx)),
                ),
        )
}

/// The composer: model, access and mode chips, the draft and its buttons.
fn card(
    w: &Workspace,
    thread: Option<&Thread>,
    draft_empty: bool,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Stateful<Div> {
    let creating = w.creating;
    let running = !creating && thread.is_some_and(|thread| thread.status == Status::Running);
    let loading = w.active_composer().read(cx).loading_assets != 0;
    div()
        .id("composer-card")
        .on_drop(cx.listener(|this, dropped: &ExternalPaths, _, cx| {
            this.drop_attachments(dropped.paths().to_vec(), cx)
        }))
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
                        mode => crate::language::tr(&mode_label(&RUNTIME_MODES, mode)).into_owned(),
                    },
                    running,
                    cx,
                ))
                .child(menu_chip(
                    w,
                    Dropdown::Mode,
                    "mode",
                    "Mode",
                    // The TUI's Spanish for the mode (settings "Build").
                    crate::language::tr(&mode_label(&INTERACTION_MODES, &mode_of(w, thread)))
                        .into_owned(),
                    running,
                    cx,
                )),
        )
        .when_some(w.active_composer().read(cx).once.clone(), |s, once| {
            s.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(12.))
                    .text_color(color("ink-2"))
                    .child(format!(
                        "{} · next prompt",
                        mode_label(&INTERACTION_MODES, &once)
                    ))
                    .child(
                        div()
                            .id("clear-once")
                            .control("Clear one-off mode")
                            .p(px(3.))
                            .child(ui::icon("x", "ink-2"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.active_composer().update(cx, |c, cx| {
                                    c.once = None;
                                    c.changed(cx);
                                });
                            })),
                    ),
            )
        })
        .when(!w.active_composer().read(cx).assets.is_empty(), |s| {
            s.child(draft_assets(w, cx))
        })
        .child(w.active_composer().clone())
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(attachment_menu(w, cx))
                .child(improve_control(w, cx))
                .when(loading, |s| {
                    s.child(
                        div()
                            .text_size(px(12.))
                            .text_color(color("ink-2"))
                            .child("Attaching…"),
                    )
                })
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
                            .shortcut(
                                "Queue for after this turn",
                                crate::primary_key("⌘↵", "Ctrl+Enter"),
                            )
                            .h(px(30.))
                            .px(px(10.))
                            .border(px(theme::px_token("stroke", "stroke-rule")))
                            .border_color(color("edge"))
                            .rounded(px(theme::px_token("radius", "radius-md")))
                            .flex()
                            .items_center()
                            .text_size(px(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .child(crate::language::tr("Queue").into_owned())
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
                                    s.cursor(CursorStyle::Arrow).opacity(0.35).tooltip(
                                        move |_, cx| {
                                            cx.new(move |_| {
                                                ui::Tooltip(
                                                    if loading {
                                                        "Wait for attachments to load"
                                                    } else {
                                                        "Write a message to send"
                                                    }
                                                    .into(),
                                                    Some("↵"),
                                                )
                                            })
                                            .into()
                                        },
                                    )
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
                                    // Clicking Send submits the text as written; Enter selects
                                    // a highlighted slash suggestion first.
                                    this.active_composer()
                                        .update(cx, |c, _| c.slash_dismissed = true);
                                    window.dispatch_action(Box::new(crate::composer::Send), cx);
                                })),
                        ),
                ),
        )
        .when(!w.picker_open && w.dropdown.is_none(), |s| {
            s.children(slash_menu(w, cx))
        })
        .when(w.picker_open, |s| {
            s.child(crate::model_picker::render(w, window, cx))
        })
}

fn attachment_menu(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let open = w.dropdown == Some(Dropdown::Attach);
    let button = div().id("attach");
    let button = if open {
        button.plain_control()
    } else {
        button.control("Attach files or images")
    };
    div()
        .relative()
        .ml(px(-6.))
        .child(
            button
                .size(px(28.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(theme::px_token("radius", "radius-md")))
                .when(open, |s| s.bg(color("sunk")))
                .child(ui::icon("paperclip", "ink-2"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.dropdown = (!open).then_some(Dropdown::Attach);
                    cx.notify();
                })),
        )
        .when(open, |s| {
            s.child(
                deferred(
                    menu_surface("attach-menu")
                        .absolute()
                        .bottom(relative(1.))
                        .mb(px(6.))
                        .left(px(0.))
                        .w(px(208.))
                        .children(
                            [
                                (false, "Attach files or images…"),
                                (true, "Attach folders…"),
                            ]
                            .into_iter()
                            .map(|(folders, label)| {
                                menu_item(("attach-path", folders as usize), label.into(), false)
                                    .plain_control()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.dropdown = None;
                                        this.pick_attachments(folders, cx);
                                        cx.notify();
                                    }))
                            }),
                        ),
                )
                .with_priority(1),
            )
        })
}

fn improve_draft_label() -> String {
    if crate::language::spanish() {
        crate::language::capitalized(crate::language::message("composer.improve"))
    } else {
        "Improve draft".to_owned()
    }
}

fn improve_control(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let composer = w.active_composer().read(cx);
    let undo = composer.undo_improvement.is_some();
    let control = div()
        .id("improve-draft")
        .h(px(28.))
        .flex()
        .items_center()
        .gap(px(6.))
        .px(px(8.))
        .rounded(px(theme::px_token("radius", "radius-md")))
        .text_size(px(12.))
        .text_color(color("ink-2"))
        .child(ui::icon("asterisk", "ink-2"))
        .child(if w.improving {
            crate::language::capitalized(crate::language::message("composer.improving"))
        } else if undo {
            crate::language::capitalized(crate::language::message("composer.undoImprove"))
        } else {
            improve_draft_label()
        });
    if w.improving
        || composer.text().trim().is_empty()
        || crate::composer_menu::mode_command(composer.text()).is_some()
    {
        control.disabled(if w.improving {
            "Improving your draft"
        } else {
            "Write a prompt to improve it"
        })
    } else {
        control
            .plain_control()
            .on_click(cx.listener(move |this, _, window, cx| {
                let composer = this.active_composer().clone();
                window.focus(&composer.read(cx).focus.clone(), cx);
                if undo {
                    composer.update(cx, |c, cx| {
                        if let Some(original) = c.undo_improvement.take() {
                            c.set_text(original, cx);
                        }
                    });
                } else {
                    this.improve_draft(cx);
                }
            }))
    }
}

fn draft_assets(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let composer = w.active_composer().clone();
    let assets = composer.read(cx).assets.clone();
    let images: Arc<Vec<ImageItem>> = Arc::new(
        assets
            .iter()
            .filter_map(|asset| match asset {
                Asset::Image { name, image } => Some(ImageItem {
                    name: name.clone(),
                    source: Source::Draft(image.clone()),
                }),
                Asset::Path { .. } => None,
            })
            .collect(),
    );
    let entity = cx.entity();
    let mut image_index = 0;
    div()
        .id("draft-attachments")
        .flex()
        .items_center()
        .gap(px(7.))
        .overflow_x_scroll()
        .children(assets.into_iter().enumerate().map(|(index, asset)| {
            let name = asset.name();
            let composer = composer.clone();
            let remove = div()
                .id(("remove-attachment", index))
                .control(format!(
                    "{} {name}",
                    crate::language::message("le.chip.remove")
                ))
                .size(px(22.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(theme::px_token("radius", "radius-md")))
                .bg(color("ground"))
                .child(ui::icon("x", "ink-2").size(px(12.)))
                .on_click(move |_, window, cx| {
                    composer.update(cx, |c, cx| {
                        if index < c.assets.len() {
                            c.assets.remove(index);
                            c.changed(cx);
                        }
                        window.focus(&c.focus, cx);
                    });
                });
            match asset {
                Asset::Path { path, directory } => div()
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(5.))
                    .h(px(28.))
                    .max_w(px(230.))
                    .pl(px(7.))
                    .pr(px(3.))
                    .bg(color("sunk"))
                    .rounded(px(theme::px_token("radius", "radius-md")))
                    .child(ui::icon("file", if directory { "ink" } else { "ink-2" }))
                    .child(
                        div()
                            .id(("path-label", index))
                            .truncate()
                            .text_size(px(12.))
                            .child(name)
                            .tooltip(move |_, cx| {
                                cx.new(|_| {
                                    ui::Tooltip(path.to_string_lossy().into_owned().into(), None)
                                })
                                .into()
                            }),
                    )
                    .child(remove)
                    .into_any_element(),
                Asset::Image { .. } => {
                    let at = image_index;
                    image_index += 1;
                    let chip = image_view::thumbnail(
                        ("draft-image", index),
                        at,
                        images.clone(),
                        w,
                        entity.clone(),
                    );
                    div()
                        .relative()
                        .flex_shrink_0()
                        .child(chip)
                        .child(div().absolute().top(px(4.)).right(px(4.)).child(remove))
                        .into_any_element()
                }
            }
        }))
}

fn slash_menu(w: &Workspace, cx: &mut Context<Workspace>) -> Option<AnyElement> {
    let composer = w.active_composer().read(cx);
    composer.slash()?;
    let selected = composer.choice;
    let count = composer.choices.len();
    let start = selected.saturating_sub(5);
    let rows = composer
        .choices
        .iter()
        .enumerate()
        .skip(start)
        .take(6)
        .map(|(at, choice)| {
            div()
                .id(("slash-choice", at))
                .plain_control()
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(8.))
                .h(px(theme::ROW))
                .rounded(px(theme::px_token("radius", "radius-md")))
                .when(at == selected, |s| s.bg(color("sunk")))
                .child(
                    div()
                        .flex_shrink_0()
                        .max_w(relative(0.55))
                        .truncate()
                        .font_weight(FontWeight::MEDIUM)
                        .child(choice.label()),
                )
                .child(
                    div()
                        .flex_1()
                        .truncate()
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child(choice.description.clone()),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.active_composer().update(cx, |c, cx| {
                        window.focus(&c.focus, cx);
                        c.choose(at, window, cx);
                    });
                }))
        })
        .collect::<Vec<_>>();
    Some(
        deferred(
            menu_surface("slash-menu")
                .absolute()
                .left(px(0.))
                .bottom(relative(1.))
                .mb(px(6.))
                .w(px(370.))
                .max_w(relative(1.))
                .child(
                    div()
                        .px(px(8.))
                        .py(px(5.))
                        .text_size(px(11.5))
                        .text_color(color("ink-2"))
                        .child(if count == 0 {
                            crate::language::message("app.no_matching_commands_fad4").into()
                        } else if count > 6 {
                            format!(
                                "Commands and skills · {} of {count} · ↑ ↓ to browse",
                                selected + 1
                            )
                        } else {
                            "Commands and skills".into()
                        }),
                )
                .children(rows)
                .on_scroll(cx.listener(|this, event: &ScrollEvent, _, cx| {
                    this.active_composer().update(cx, |c, _| {
                        let dy = event.delta.pixel_delta(px(theme::ROW)).y;
                        if c.choices.len() > 6 {
                            c.choice = c
                                .choice
                                .saturating_add_signed(if dy > px(0.) { -1 } else { 1 })
                                .min(c.choices.len() - 1);
                        }
                    });
                    cx.notify();
                    cx.stop_propagation();
                })),
        )
        .with_priority(1)
        .into_any_element(),
    )
}

/// How the thread (or the one being drafted) may act on its own.
fn access_of(w: &Workspace, thread: Option<&Thread>) -> String {
    if w.creating {
        w.new_runtime
            .map_or_else(String::new, |at| RUNTIME_MODES[at].0.into())
    } else {
        thread.map_or_else(String::new, |thread| thread.runtime_mode.clone())
    }
}
fn mode_of(w: &Workspace, thread: Option<&Thread>) -> String {
    if w.creating {
        INTERACTION_MODES[w.new_interaction].0.into()
    } else {
        thread.map_or_else(String::new, |thread| thread.interaction_mode.clone())
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
        .shortcut("Model and effort", crate::primary_key("⌘M", "Ctrl+M"))
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
}

pub(crate) fn menu_surface(id: impl Into<ElementId>) -> Stateful<Div> {
    div()
        .id(id)
        .occlude()
        .p(px(6.))
        .rounded(px(12.))
        .bg(color("raised"))
        .shadow(theme::float_shadow())
        .text_size(px(13.5))
}

pub(crate) fn menu_row(id: impl Into<ElementId>, name: String, selected: bool) -> Stateful<Div> {
    menu_item(id, name.clone(), selected).control(name)
}

pub(crate) fn menu_item(id: impl Into<ElementId>, name: String, selected: bool) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(theme::ROW))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(6.))
        .when(selected, |s| s.bg(color("sunk")))
        .child(div().flex_1().truncate().child(name))
        .when(selected, |s| s.child(ui::icon("check", "ink-2")))
}

fn chip_menu(
    w: &Workspace,
    menu: Menu,
    rows: impl FnOnce(&mut Context<Workspace>) -> Vec<AnyElement>,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let Menu {
        kind,
        id,
        tooltip,
        label,
        locked,
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
        let button = if kind == Dropdown::Thread && open {
            button.plain_control()
        } else {
            button.control(tooltip)
        };
        button
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
        let menu = menu_surface(SharedString::from(format!("{id}-menu")))
            .absolute()
            .when(kind == Dropdown::Thread, |s| {
                s.top(relative(1.)).mt(px(6.)).right(px(0.))
            })
            .when(kind != Dropdown::Thread, |s| {
                s.bottom(relative(1.)).mb(px(6.)).left(px(0.))
            })
            .min_w(px(180.))
            .max_w(px(320.))
            .children(rows(cx));
        if kind == Dropdown::Thread {
            s.child(deferred(menu).with_priority(1))
        } else {
            s.child(menu)
        }
    })
}

pub fn actions_chip(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let id = w.selected;
    let items = crate::thread_actions::items(w, id);
    chip_menu(
        w,
        Menu {
            kind: Dropdown::Thread,
            id: "thread-actions",
            tooltip: "Thread actions",
            label: crate::language::tr("Actions").into_owned(),
            locked: items.is_empty(),
        },
        move |cx| crate::thread_actions::menu_rows("thread-actions", id, &items, cx),
        cx,
    )
}

fn choice_rows(
    id: &'static str,
    items: Vec<(String, bool)>,
    pick: impl Fn(&mut Workspace, usize, &mut Context<Workspace>) + Clone + 'static,
    cx: &mut Context<Workspace>,
) -> Vec<AnyElement> {
    items
        .into_iter()
        .enumerate()
        .map(|(i, (name, selected))| {
            let pick = pick.clone();
            menu_row((id, i), name, selected)
                .on_click(cx.listener(move |this, _, _, cx| pick(this, i, cx)))
                .into_any_element()
        })
        .collect()
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
        &INTERACTION_MODES[..3]
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
    };
    chip_menu(
        w,
        menu,
        move |cx| {
            choice_rows(
                id,
                items,
                move |this, i, cx| {
                    if kind == Dropdown::Access {
                        this.set_access(i, cx)
                    } else {
                        this.set_mode(i, cx)
                    }
                },
                cx,
            )
        },
        cx,
    )
}

/// Where a new thread starts, with the folder picker at the end of the list.
fn project_chip(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let projects = w.source.projects();
    let current = w.new_project_id();
    let label = w
        .new_project_title()
        .unwrap_or_else(|| crate::language::tr("Project").into_owned());
    let mut items: Vec<(String, bool)> = projects
        .iter()
        .map(|p| (p.title.clone(), Some(&p.id) == current.as_ref()))
        .collect();
    items.insert(
        0,
        (
            crate::language::message("guide.noProjectChoice").into(),
            w.new_scratch,
        ),
    );
    items.push(("Add project…".into(), false));
    let menu = Menu {
        kind: Dropdown::Project,
        id: "project",
        tooltip: "Project for the new thread",
        label,
        locked: false,
    };
    chip_menu(
        w,
        menu,
        |cx| {
            choice_rows(
                "project",
                items,
                move |this, i, cx| {
                    let projects = this.source.projects();
                    this.dropdown = None;
                    if i == 0 {
                        this.new_project = None;
                        this.new_scratch = true;
                        cx.notify();
                        return;
                    }
                    match projects.get(i - 1) {
                        Some(project) => {
                            this.new_project = Some(project.id.clone());
                            this.new_scratch = false;
                        }
                        None => this.add_project(cx),
                    }
                    cx.notify();
                },
                cx,
            )
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
                .child(crate::language::tr("New thread").into_owned()),
        )
        .child(
            div()
                .max_w(px(420.))
                .text_center()
                .text_color(color("ink-2"))
                .child(if w.new_scratch {
                    crate::language::message("guide.scratchProject").into()
                } else { match w.new_project_title() {
                    Some(project) => format!(
                        "It starts in {project}. Choose how it runs below, then write the first message."
                    ),
                    None => "Add a project to start a thread in.".into(),
                }}),
        )
}

fn problem(message: String, cx: &mut Context<Workspace>) -> impl IntoElement {
    div()
        .debug_selector(|| "composer-problem".into())
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
                .control(crate::language::message("action.dismiss"))
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
    let chip = |id: &'static str, at: usize, tooltip: &'static str, label: &str| {
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
            .child(crate::language::capitalized(label))
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
                // The TUI's queued word (`queued.queued_7b2f`), lowercased the
                // way this strip reads it.
                crate::language::message("queued.queued_7b2f").to_lowercase()
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
                        crate::language::message("queue.action.release"),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.edit_queued(&hold, QueueEdit::Release, cx)
                    }))
                } else {
                    chip(
                        "queue-hold",
                        at,
                        "Keep it back until released",
                        crate::language::message("queue.action.hold"),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.edit_queued(&hold, QueueEdit::Hold, cx)
                    }))
                })
                .child(
                    chip(
                        "queue-edit",
                        at,
                        "Take it back to edit",
                        crate::language::message("skills.edit"),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_queued_text(&edit, window, cx)
                    })),
                )
                .child(
                    chip(
                        "queue-remove",
                        at,
                        "Remove without sending",
                        crate::language::message("queue.action.remove"),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.edit_queued(&remove, QueueEdit::Remove, cx)
                    })),
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
        .unwrap_or(crate::language::message("git.detached_1594"))
        .to_string();
    let changed = overview
        .and_then(|o| o.status.as_ref())
        .filter(|s| !s.is_clean())
        .map(|s| s.line());
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
                    .child(background_chip_label(background))
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
        // The render-harness test for the new-thread draft finds the chip by
        // this name, like `composer-problem` below.
        .debug_selector(|| "status-usage".into())
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

fn background_chip_label(count: usize) -> String {
    if crate::language::spanish() {
        crate::language::fill("bg.runningCount", &[("{count}", &count.to_string())])
    } else {
        format!("{count} background")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn composer_and_background_chip_keep_desktop_english_and_use_catalog_spanish() {
        crate::language::apply(Some("en"), None);
        assert_eq!(super::background_chip_label(2), "2 background");
        assert_eq!(super::improve_draft_label(), "Improve draft");
        crate::language::apply(Some("es-ES"), None);
        assert_eq!(super::background_chip_label(2), "2 en marcha");
        assert_eq!(super::improve_draft_label(), "Mejorar");
    }

    #[test]
    fn run_summary_counts_each_kind() {
        let source = crate::mock::MockSource::preview();
        use crate::model::ThreadSource;
        assert_eq!(
            super::run_summary(&source.messages(0)),
            "Ran 3 commands, read 3 files, updated 1 file"
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
                images: vec![],
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
