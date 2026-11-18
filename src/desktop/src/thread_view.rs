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
    let draft = w.active_composer().read(cx);
    let draft_empty = draft.empty() || draft.loading_assets != 0;
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
                } else if let Some((lead, role, agent)) = w.role_full {
                    crate::research_view::role_full(w, lead, role, agent, cx).into_any_element()
                } else if let Some(summary) = w.source.run_summary(id).filter(|_| w.show_run_view())
                {
                    crate::research_view::run_view(w, id, &summary, cx).into_any_element()
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
                                .child(reply_body(&text, id, this, entity.clone(), &mut missing))
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
        .child(composer(w, &thread, draft_empty, window, cx))
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
            s.text_color(color("ink-2")).child("Thinking…")
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
            format!("part of the research run · {}", row.state.label()),
        );
    }
    let state = w
        .source
        .list_threads()
        .get(back)
        .map(|thread| thread.status.label())
        .unwrap_or("Done");
    ("Lead thread".into(), state.into())
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
                .when(w.source.preview() || has_branch(w), |s| {
                    s.child(status_line(w, cx))
                }),
        )
}

/// The composer: model, access and mode chips, the draft and its buttons.
fn card(
    w: &Workspace,
    thread: &crate::model::Thread,
    draft_empty: bool,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Stateful<Div> {
    let creating = w.creating;
    let running = thread.status == Status::Running && !creating;
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
            "Improving…"
        } else if undo {
            "Undo improvement"
        } else {
            "Improve draft"
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
                .control(format!("Remove {name}"))
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
                        .child(choice.invocation.clone()),
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
                            "No matching commands".to_owned()
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
            label: "Actions".into(),
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
                    match projects.get(i) {
                        Some(project) => this.new_project = Some(project.id.clone()),
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

/// The checkout is known (the Git tab has read it): its branch is worth a chip.
fn has_branch(w: &Workspace) -> bool {
    w.source
        .git(w.selected)
        .overview
        .as_ref()
        .is_some_and(|o| o.is_repository)
}

fn status_line(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let background = crate::work_view::background_count(w);
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
    let chip = |id: &'static str, tooltip: &'static str| {
        div()
            .id(id)
            .control(tooltip)
            .h(px(28.))
            .px(px(8.))
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded(px(6.))
    };
    div()
        .mx(px(-6.))
        .flex()
        .items_center()
        .gap(px(4.))
        .font_family(theme::MONO)
        .text_size(px(12.))
        .text_color(color("ink-2"))
        .child(
            chip("branch", "Open Git")
                .child(ui::icon("git-branch", "ink-2"))
                .child(div().text_color(color("ink")).child(branch))
                .children(changed.map(|line| div().text_color(color("effort")).child(line)))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.tab = 1;
                    this.set_inspector(true);
                    cx.notify();
                })),
        )
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
        .when(w.source.preview(), |s| {
            s.child(
                chip("usage", "Context and plan usage")
                    .child(crate::usage::meter(40., 5.))
                    .child(div().text_color(color("ink")).child("66%"))
                    .child("663k / 1m")
                    .child(div().w(px(1.)).h(px(12.)).mx(px(4.)).bg(color("rule")))
                    .child("5h")
                    .child(div().text_color(color("context-tools")).child("36%"))
                    .child("wk")
                    .child(div().text_color(color("context-tools")).child("43%"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.tab = 2;
                        this.set_inspector(true);
                        cx.notify();
                    })),
            )
        })
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
