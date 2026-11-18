//! The inspector's Agents, Info and Background views.

use crate::{
    live::now_ms,
    model::{Message, Status, ThreadId, ThreadSource},
    theme::{self, color},
    transcript::duration,
    ui::{self, Control},
    work::{Agent, Background, BackgroundTask, Delegated, Read, View},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

enum Detail {
    Subagent(Agent),
    Output(BackgroundTask),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Escape {
    CloseDetail,
    DismissQuestion,
    KeepApproval,
    StopTurn,
}

#[derive(Default)]
pub struct WorkUi {
    seen: Option<(ThreadId, usize)>,
    detail: Option<Detail>,
    subagent_running: bool,
    delegated_status: Option<Status>,
    confirming_cancel: bool,
}

impl WorkUi {
    pub fn escape(&mut self, source: &dyn ThreadSource, id: ThreadId) -> Escape {
        if self.dismiss() {
            Escape::CloseDetail
        } else if source.ask(id).is_some() {
            Escape::DismissQuestion
        } else if source.permission(id).is_some() {
            // A permission still needs an explicit decision.
            Escape::KeepApproval
        } else {
            Escape::StopTurn
        }
    }

    pub fn dismiss(&mut self) -> bool {
        std::mem::take(&mut self.confirming_cancel) || self.detail.take().is_some()
    }
}

impl Workspace {
    pub fn sync_work(&mut self) {
        let visible = (self.inspector_open && !self.creating && self.tab >= 3)
            .then_some((self.selected, self.tab));
        if self.work_ui.seen != visible {
            self.work_ui = WorkUi {
                seen: visible,
                ..WorkUi::default()
            };
            self.refresh_work();
        }
    }

    pub fn refresh_work(&mut self) {
        let id = self.selected;
        if self.work_ui.seen != Some((id, self.tab)) || !self.inspector_open || self.creating {
            return;
        }
        if self.tab == 4 {
            self.source.read_work(id, Read::Background);
        } else if self.source.delegated(id).is_some() {
            let status = Some(self.source.list_threads()[id].status);
            if status != self.work_ui.delegated_status
                || self.source.work(id, &Read::Delegation).is_none()
            {
                self.work_ui.delegated_status = status;
                self.source.read_work(id, Read::Delegation);
            }
        }
        match &self.work_ui.detail {
            Some(Detail::Subagent(agent)) => {
                let running = self
                    .source
                    .inspector(id)
                    .agents
                    .iter()
                    .any(|row| row.id == agent.id && row.status == Status::Running);
                let read = Read::Subagent(agent.id.clone());
                let was_running = std::mem::replace(&mut self.work_ui.subagent_running, running);
                if was_running || running || self.source.work(id, &read).is_none() {
                    self.source.read_work(id, read);
                }
            }
            Some(Detail::Output(task)) => {
                let read = Read::Output(task.id.clone());
                self.source.read_work(id, read);
            }
            None => {}
        }
    }

    fn open_work_detail(&mut self, detail: Detail, window: &mut Window, cx: &mut Context<Self>) {
        let read = match &detail {
            Detail::Subagent(agent) => {
                self.work_ui.subagent_running = agent.status == Status::Running;
                Read::Subagent(agent.id.clone())
            }
            Detail::Output(task) => Read::Output(task.id.clone()),
        };
        self.source.read_work(self.selected, read);
        self.work_ui.detail = Some(detail);
        window.focus(&self.work_focus, cx);
        cx.notify();
    }
}

pub fn agent_count(w: &Workspace) -> usize {
    let agents = w.source.inspector(w.selected);
    let children = w.source.children(w.selected);
    let threads = w.source.list_threads();
    let running = agents
        .agents
        .iter()
        .filter(|row| row.status == Status::Running)
        .count()
        + children
            .iter()
            .filter(|&&id| threads[id].status == Status::Running)
            .count();
    if running > 0 {
        running
    } else {
        agents.agents.len() + children.len()
    }
}

pub fn background_count(w: &Workspace) -> usize {
    if w.tab == 4
        && w.inspector_open
        && let Some(read) = w.source.work(w.selected, &Read::Background)
        && let Ok(View::Background(list)) = read.as_ref()
    {
        return list.tasks.len();
    }
    w.source.inspector(w.selected).background_count
}

pub fn notice(text: impl Into<SharedString>) -> Div {
    div()
        .px(px(16.))
        .py(px(10.))
        .text_size(px(13.))
        .text_color(color("ink-2"))
        .child(text.into())
}

fn heading(text: impl Into<SharedString>) -> Div {
    div()
        .px(px(8.))
        .pt(px(8.))
        .pb(px(3.))
        .font_weight(FontWeight::SEMIBOLD)
        .child(text.into())
}

fn body() -> Div {
    div()
        .px(px(8.))
        .py(px(6.))
        .flex()
        .flex_col()
        .gap(px(2.))
        .text_size(px(13.))
        .line_height(px(18.))
        .text_color(color("ink"))
}

fn action(id: impl Into<ElementId>, label: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .control(label)
        .rounded(px(6.))
        .px(px(8.))
        .py(px(5.))
        .child(label)
}

fn row(id: impl Into<ElementId>, title: String, meta: String, status: Status) -> Stateful<Div> {
    div()
        .id(id)
        .control("Open")
        .flex_1()
        .min_w_0()
        .flex()
        .items_start()
        .gap(px(8.))
        .px(px(8.))
        .py(px(6.))
        .rounded(px(6.))
        .child(div().pt(px(2.)).child(ui::state(status)))
        .child(
            div().min_w_0().child(title).child(
                div()
                    .text_color(color("ink-2"))
                    .text_size(px(12.))
                    .child(meta),
            ),
        )
}

fn detail_line(label: &'static str, value: impl Into<SharedString>) -> Div {
    div()
        .px(px(8.))
        .py(px(4.))
        .child(
            div()
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child(label),
        )
        .child(value.into())
}

fn elapsed(started: Option<i64>) -> String {
    started.map_or_else(String::new, |at| format!(" · {}", duration(now_ms() - at)))
}

fn open_thread(w: &mut Workspace, id: ThreadId, window: &mut Window, cx: &mut Context<Workspace>) {
    w.select(id, cx);
    window.focus(&w.composers[id].read(cx).focus.clone(), cx);
}

fn agent_list(w: &Workspace, cx: &mut Context<Workspace>) -> Div {
    let children = w.source.children(w.selected);
    let inspector = w.source.inspector(w.selected);
    let threads = w.source.list_threads();
    if children.is_empty() && inspector.agents.is_empty() {
        return notice("No delegated threads or provider subagents.");
    }
    body()
        .when(!children.is_empty(), |s| {
            s.child(heading("Delegated threads"))
        })
        .children(children.into_iter().map(|id| {
            let thread = &threads[id];
            let (model, _) = w.model_label(w.source.selection(id).as_ref());
            let timer = thread.started_at.map_or_else(String::new, |at| {
                format!(" · {}", duration(at.elapsed().as_millis() as i64))
            });
            row(
                ("delegated-thread", id),
                thread.title.clone(),
                format!("{model} · {}{timer}", thread.status.label()),
                thread.status,
            )
            .on_click(cx.listener(move |this, _, window, cx| open_thread(this, id, window, cx)))
        }))
        .when(!inspector.agents.is_empty(), |s| {
            s.child(heading("Provider subagents"))
        })
        .children(inspector.agents.iter().map(|agent| {
            let key = SharedString::from(agent.id.clone());
            let open = agent.clone();
            let timer = if agent.status == Status::Running {
                elapsed(agent.started)
            } else {
                String::new()
            };
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(
                    row(
                        format!("subagent-{key}"),
                        agent.title.clone(),
                        format!("{} · {}{timer}", agent.kind, agent.status.label()),
                        agent.status,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_work_detail(Detail::Subagent(open.clone()), window, cx)
                    })),
                )
                .when(agent.stoppable, |s| s.child(stop_button(key, cx)))
        }))
}

fn info(w: &Workspace, delegated: Delegated, cx: &mut Context<Workspace>) -> Div {
    let id = w.selected;
    let threads = w.source.list_threads();
    let thread = &threads[id];
    let prompt = w
        .source
        .messages(id)
        .iter()
        .find_map(|message| match message {
            Message::User { text, .. } => Some(text.trim().to_string()),
            _ => None,
        });
    let (model, _) = w.model_label(w.source.selection(id).as_ref());
    let read = w.source.work(id, &Read::Delegation);
    let mut details = body()
        .child(heading("Delegated task"))
        .children(delegated.parent.map(|id| {
            row(
                ("parent-thread", id),
                threads[id].title.clone(),
                "Parent thread".into(),
                threads[id].status,
            )
            .on_click(cx.listener(move |this, _, window, cx| open_thread(this, id, window, cx)))
        }))
        .children(
            prompt
                .filter(|s| !s.is_empty())
                .map(|s| detail_line("Task", s)),
        )
        .child(detail_line("Model", model))
        .children(delegated.branch.map(|s| detail_line("Branch", s)))
        .children(delegated.worktree.map(|s| detail_line("Worktree", s)));
    match read.as_deref() {
        Some(Ok(View::Delegation(link))) => {
            let timer = thread.started_at.map_or_else(String::new, |at| {
                format!(" · {}", duration(at.elapsed().as_millis() as i64))
            });
            let status = if thread.status == Status::Running || thread.status == Status::Queued {
                thread.status.label()
            } else {
                match link.status.as_deref() {
                    Some("failed") => "Failed",
                    Some("interrupted") => "Interrupted",
                    Some("cancelled") => "Cancelled",
                    _ => thread.status.label(),
                }
            };
            details = details.child(detail_line("Status", format!("{status}{timer}")));
            if let Some(summary) = &link.summary {
                details = details.child(detail_line("Summary", summary.clone()));
            }
            if link.active
                && (matches!(
                    thread.status,
                    Status::Running | Status::Queued | Status::Held
                ) || link.status.as_deref() == Some("running"))
            {
                details = details.child(div().flex().flex_wrap().gap(px(4.)).children(
                    if w.work_ui.confirming_cancel {
                        let cancel = |label, notify| {
                            action(label, label).on_click(cx.listener(move |this, _, _, cx| {
                                this.work_ui.confirming_cancel = false;
                                this.source.cancel_task(this.selected, notify);
                                cx.notify();
                            }))
                        };
                        let mut choices = vec![cancel(
                            if link.notify {
                                "Cancel and notify parent"
                            } else {
                                "Confirm cancellation"
                            },
                            link.notify,
                        )];
                        if link.notify {
                            choices.push(cancel("Cancel without notifying", false));
                        }
                        choices.push(action("keep-task", "Keep task").on_click(cx.listener(
                            |this, _, _, cx| {
                                this.work_ui.confirming_cancel = false;
                                cx.notify();
                            },
                        )));
                        choices
                    } else {
                        vec![action("cancel-task", "Cancel task").on_click(cx.listener(
                            |this, _, window, cx| {
                                this.work_ui.confirming_cancel = true;
                                window.focus(&this.work_focus, cx);
                                cx.notify();
                            },
                        ))]
                    },
                ));
            }
            details
        }
        Some(Err(error)) => details.child(notice(error.clone())),
        _ => details.child(notice("Reading task status…")),
    }
}

fn stop_button(key: SharedString, cx: &mut Context<Workspace>) -> Stateful<Div> {
    action(format!("stop-task-{key}"), "Stop")
        .text_color(color("broken"))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.source.stop_background(this.selected, key.as_ref());
            cx.notify();
        }))
}

fn background(w: &Workspace, cx: &mut Context<Workspace>) -> Div {
    let read = w.source.work(w.selected, &Read::Background);
    let list = match read.as_deref() {
        Some(Ok(View::Background(list))) => list,
        Some(Err(error)) => return notice(error.clone()),
        _ => return notice("Reading background tasks…"),
    };
    let mut pane = body();
    let mut group = None;
    for task in &list.tasks {
        if group != Some(task.kind) {
            group = Some(task.kind);
            pane = pane.child(heading(match task.kind {
                "Shell" => "Shells",
                "Monitor" => "Monitors",
                "Agent" => "Agents",
                _ => "Tasks",
            }));
        }
        let key = SharedString::from(task.id.clone());
        let open = task.clone();
        let meta = task
            .command
            .as_deref()
            .filter(|cmd| *cmd != task.title)
            .unwrap_or(task.kind);
        pane = pane.child(
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(
                    row(
                        format!("background-task-{key}"),
                        task.title.clone(),
                        format!("{meta}{}", elapsed(task.started)),
                        Status::Running,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_work_detail(Detail::Output(open.clone()), window, cx)
                    })),
                )
                .when(task.stoppable, |s| s.child(stop_button(key, cx))),
        );
    }
    pane.when(list.tasks.is_empty() && list.live && !list.partial, |s| {
        s.child(notice("Nothing is running in the background."))
    })
    .when(!list.live, |s| {
        s.child(notice(
            "There is no live session to read background tasks from.",
        ))
    })
    .when(list.partial, |s| {
        s.child(notice(
            "Only background work reported by the provider is shown.",
        ))
    })
}

fn back(cx: &mut Context<Workspace>) -> Stateful<Div> {
    action("back-to-work-list", "Back").on_click(cx.listener(|this, _, _, cx| {
        this.work_ui.dismiss();
        cx.notify();
    }))
}

fn subagent(w: &Workspace, selected: &Agent, cx: &mut Context<Workspace>) -> Div {
    let snapshot = w.source.inspector(w.selected);
    let agent = snapshot
        .agents
        .iter()
        .find(|a| a.id == selected.id)
        .unwrap_or(selected);
    let key = SharedString::from(agent.id.clone());
    let read = w.source.work(w.selected, &Read::Subagent(agent.id.clone()));
    let header = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(back(cx))
        .child(div().flex_1().min_w_0().child(agent.title.clone()))
        .when(agent.stoppable, |s| s.child(stop_button(key, cx)));
    let mut pane = body().child(header).child(detail_line(
        "Subagent",
        format!("{} · {}", agent.kind, agent.status.label()),
    ));
    match read.as_deref() {
        Some(Ok(View::Subagent(Some(rows)))) if !rows.is_empty() => {
            pane = pane.children(rows.iter().map(|row| match &row.message {
                Message::User { text, .. } => detail_line("Prompt", text.clone()),
                Message::Assistant { text, .. } => detail_line("Reply", text.clone()),
                Message::Plan { text, .. } => detail_line("Plan", text.clone()),
                Message::Tool {
                    name,
                    summary,
                    output,
                    ..
                } => {
                    let label = match name.as_str() {
                        "command" => "Command",
                        "thought" => "Thought",
                        "read" => "Read",
                        "edit" => "Edit",
                        "search" => "Search",
                        _ => "Tool",
                    };
                    detail_line(label, summary.clone()).when(
                        !output.is_empty() && output != summary,
                        |s| {
                            s.child(
                                div()
                                    .mt(px(4.))
                                    .font_family(theme::MONO)
                                    .text_size(px(12.))
                                    .child(output.clone()),
                            )
                        },
                    )
                }
            }));
        }
        Some(Ok(View::Subagent(Some(_)))) => {
            pane = pane.child(notice("No transcript entries yet."))
        }
        Some(Ok(View::Subagent(None))) => {
            pane = pane.child(notice(
                "The provider has no transcript available for this subagent.",
            ))
        }
        Some(Err(error)) => pane = pane.child(notice(error.clone())),
        _ => pane = pane.child(notice("Reading subagent transcript…")),
    }
    pane.children(agent.last_message.clone().filter(|_| !matches!(read.as_deref(), Some(Ok(View::Subagent(Some(rows)))) if !rows.is_empty()))
        .map(|text| detail_line("Last message", text)))
}

fn output(w: &Workspace, task: &BackgroundTask, cx: &mut Context<Workspace>) -> Div {
    let list = w.source.work(w.selected, &Read::Background);
    let available = match list.as_deref() {
        Some(Ok(View::Background(Background {
            live: true, tasks, ..
        }))) => Some(tasks.iter().find(|t| t.id == task.id)),
        _ => None,
    };
    let status = match available {
        Some(Some(_)) => format!("Running{}", elapsed(task.started)),
        Some(None) => "Finished".into(),
        None => "Status unavailable".into(),
    };
    let key = SharedString::from(task.id.clone());
    let header = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(back(cx))
        .child(div().flex_1().min_w_0().child(task.title.clone()))
        .when(available.flatten().is_some_and(|t| t.stoppable), |s| {
            s.child(stop_button(key, cx))
        });
    let pane = body()
        .child(header)
        .child(detail_line(task.kind, status))
        .when(available.flatten().is_some_and(|t| !t.stoppable), |s| {
            s.child(notice("The provider cannot stop this task independently."))
        })
        .children(task.command.clone().map(|command| {
            detail_line(
                match task.kind {
                    "Agent" => "Prompt",
                    "Monitor" => "Script",
                    _ => "Command",
                },
                command,
            )
        }));
    let read = w.source.work(w.selected, &Read::Output(task.id.clone()));
    match read.as_deref() {
        Some(Ok(View::Output(Some(text)))) if !text.is_empty() => {
            pane.child(heading("Output")).child(
                div()
                    .p(px(8.))
                    .bg(color("sunk"))
                    .rounded(px(6.))
                    .font_family(theme::MONO)
                    .text_size(px(12.))
                    .child(text.clone()),
            )
        }
        Some(Ok(View::Output(Some(_)))) => pane.child(notice("No output yet.")),
        Some(Ok(View::Output(None))) => {
            pane.child(notice("Output is not available for this task."))
        }
        Some(Err(error)) => pane.child(notice(error.clone())),
        _ => pane.child(notice("Reading output…")),
    }
}

pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> Div {
    if w.creating {
        return notice("Select a thread to see its work.");
    }
    match &w.work_ui.detail {
        Some(Detail::Subagent(agent)) => subagent(w, agent, cx),
        Some(Detail::Output(task)) => output(w, task, cx),
        None if w.tab == 4 => background(w, cx),
        None => match w.source.delegated(w.selected) {
            Some(delegated) => info(w, delegated, cx),
            None => agent_list(w, cx),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{Detail, Escape, WorkUi};
    use crate::{
        mock::MockSource,
        model::{Status, ThreadSource},
        work::{Read, View},
    };

    #[test]
    fn escape_closes_details_before_leaving_a_running_approval_alone() {
        let source = MockSource::preview();
        let approval = 2;
        assert_eq!(source.list_threads()[approval].status, Status::Running);
        assert!(source.permission(approval).is_some());
        let background = source.work(0, &Read::Background).expect("mock jobs");
        let Ok(View::Background(background)) = background.as_ref() else {
            panic!("expected background jobs");
        };
        let mut inspector = WorkUi {
            detail: Some(Detail::Output(background.tasks[0].clone())),
            ..WorkUi::default()
        };

        assert_eq!(inspector.escape(&source, approval), Escape::CloseDetail);
        assert!(inspector.detail.is_none());
        assert_eq!(inspector.escape(&source, approval), Escape::KeepApproval);
        assert_eq!(inspector.escape(&source, 3), Escape::DismissQuestion);
        assert_eq!(inspector.escape(&source, 0), Escape::StopTurn);
    }
}
