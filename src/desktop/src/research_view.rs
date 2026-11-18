//! Research mode in the composer's place and the reading column: the run-size
//! question (`research.proposals`, answered with `research.proposal.answer`),
//! the run view and its role transcripts (`research.run` read live), and the
//! parked-question notice (`researchSizePending`). Sizes, roster and column
//! rules are the TUI's (`src/tui/model/researchpicker.ts`,
//! `src/tui/model/researchrun.ts`); the words are the TUI's
//! (`src/tui/i18n/en.ts`).

use crate::{
    model::{
        AgentRef, AgentState, Message, PickerRow, PickerState, ROLES, ResearchProposal,
        ResearchRole, RunAgent, RunPhase, RunSummary, Selection, ThreadId, column_widths,
        default_agent_index, focus_role_of, initial_picker, move_row, run_elapsed_ms, set_critics,
        set_researchers, step_agent, step_picker, step_role, thread_count,
    },
    research::MAX_RESEARCHERS,
    theme::{self, color},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

/// "45s", "3m 12s", "3m", "1h 5m": the TUI's `formatDuration` in seconds.
fn format_elapsed(ms: i64) -> String {
    let seconds = (ms.max(0) as f64 / 1000.0).round() as i64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let rest = seconds % 60;
    if minutes < 60 {
        return if rest == 0 {
            format!("{minutes}m")
        } else {
            format!("{minutes}m {rest}s")
        };
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

/// How long the run has been going, or took, as the header says it.
fn elapsed(summary: &RunSummary) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis() as i64)
        .unwrap_or(0);
    format_elapsed(run_elapsed_ms(summary, now))
}

fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

impl Workspace {
    /// The picker's state for the thread's question: the proposal's size
    /// clamped to what the server accepts, kept while it is open.
    fn proposal_state(&mut self, id: ThreadId, proposal: &ResearchProposal) -> PickerState {
        if let Some((known, state)) = self.picker.get(&id)
            && known == &proposal.id
        {
            return *state;
        }
        let state = initial_picker(proposal.size);
        self.picker.insert(id, (proposal.id.clone(), state));
        state
    }

    fn proposal_id(&self, id: ThreadId) -> Option<ResearchProposal> {
        self.source.proposal(id)
    }

    /// Starts the run with the picked size (`choice: "start"`).
    pub fn answer_size(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        let Some(proposal) = self.proposal_id(id) else {
            return;
        };
        let size = self.proposal_state(id, &proposal).size;
        self.picker.remove(&id);
        self.source.answer_proposal(id, &proposal.id, Some(size));
        cx.notify();
    }

    /// Runs one researcher instead (`choice: "single"`), as Esc does.
    pub fn answer_single(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        let Some(proposal) = self.proposal_id(id) else {
            return;
        };
        self.picker.remove(&id);
        self.source.answer_proposal(id, &proposal.id, None);
        cx.notify();
    }

    /// A role's model and effort as one short label, as the TUI names it.
    fn proposal_model(&self, proposal: &ResearchProposal, role: ResearchRole) -> String {
        let Some(request) = proposal.role_model(role) else {
            return String::new();
        };
        let selection = Selection {
            instance: request.provider.clone(),
            model: request.model.clone(),
            options: vec![],
        };
        let name = self.model_label(Some(&selection)).0;
        match &request.effort {
            Some(effort) => format!("{name} · {}", capitalized(effort)),
            None => name,
        }
    }

    /// The provider each role draws on, deduplicated.
    fn proposal_providers(&self, proposal: &ResearchProposal) -> String {
        let mut ids = vec![proposal.lead_provider.clone()];
        for role in ROLES {
            if let Some(model) = proposal.role_model(role)
                && !ids.contains(&model.provider)
            {
                ids.push(model.provider.clone());
            }
        }
        let catalog = self.catalog();
        ids.into_iter()
            .map(|id| {
                catalog
                    .as_ref()
                    .and_then(|catalog| {
                        catalog
                            .providers
                            .iter()
                            .find(|provider| provider.instance == id)
                    })
                    .map(|provider| provider.name.clone())
                    .unwrap_or(id)
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The column keys act on now (null follows the phase).
    pub fn run_focus(&self, lead: ThreadId) -> ResearchRole {
        self.run_role.get(&lead).copied().unwrap_or_else(|| {
            self.source
                .run_summary(lead)
                .map(|summary| focus_role_of(&summary))
                .unwrap_or(ResearchRole::Researcher)
        })
    }

    /// The agent a column shows now: the pick, else the one at work.
    fn run_shown(&self, lead: ThreadId, role: ResearchRole) -> usize {
        if let Some(picked) = self.run_picks.get(&(lead, role)) {
            return *picked;
        }
        self.source
            .run_summary(lead)
            .map(|summary| default_agent_index(&summary, role))
            .unwrap_or(0)
    }
}

/// One dot of the researchers control, or one of the critics' two choices.
fn step_dot(on: bool, focused: bool, label: SharedString) -> impl IntoElement {
    div()
        .text_color(if on {
            color("live")
        } else if focused {
            color("ink")
        } else {
            color("ink-2")
        })
        .when(focused && on, |s| s.text_color(color("live")).underline())
        .child(label)
}

/// The run-size question in the composer's place, or nothing when the server
/// asked nothing. Keys: arrows move, a digit picks researchers, Enter starts,
// Esc runs one researcher instead.
pub fn proposal_panel(
    w: &Workspace,
    id: ThreadId,
    cx: &mut Context<Workspace>,
) -> Option<AnyElement> {
    let proposal = w.source.proposal(id)?;
    let state = w
        .picker
        .get(&id)
        .and_then(|(known, state)| (known == &proposal.id).then_some(*state))
        .unwrap_or_else(|| initial_picker(proposal.size));
    let size = state.size;
    let dot = |at: usize| {
        step_dot(
            at < size.researchers,
            state.row == PickerRow::Researchers,
            if at < size.researchers { "●" } else { "○" }.into(),
        )
    };
    let critics = [1, 3].map(|count| {
        step_dot(
            size.critics == count,
            state.row == PickerRow::Critics,
            format!(" {count} ").into(),
        )
    });
    let entity = cx.entity();
    let rows = [
        (
            PickerRow::Researchers,
            "Researchers",
            (0..MAX_RESEARCHERS).map(dot).collect::<Vec<_>>(),
            size.researchers.to_string(),
            w.proposal_model(&proposal, ResearchRole::Researcher),
            Some(format!(
                "{count} in total for the run, not at once.",
                count = size.researchers
            )),
        ),
        (
            PickerRow::Critics,
            "Critics",
            critics.into_iter().collect::<Vec<_>>(),
            size.critics.to_string(),
            w.proposal_model(&proposal, ResearchRole::Critic),
            Some(if size.critics == 1 {
                "One critic does Evidence, Risks and Alternatives.".into()
            } else {
                "One each: Evidence, Risks and Alternatives.".into()
            }),
        ),
        (
            PickerRow::Researchers,
            "Finalizer",
            vec![step_dot(true, false, "●".into())],
            "1".into(),
            w.proposal_model(&proposal, ResearchRole::Finalizer),
            None,
        ),
    ];
    let focus_panel = entity.clone();
    let panel = div()
        .id("research-proposal")
        .track_focus(&w.ask_focus)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |_, _, window, cx| {
                let focus = focus_panel.read(cx).ask_focus.clone();
                window.focus(&focus, cx);
            }),
        )
        .border(px(theme::px_token("stroke", "stroke-rule")))
        .border_color(color("edge"))
        .rounded(px(theme::px_token("radius", "radius-lg")))
        .bg(color("ground"))
        .p(px(14.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(px(15.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Full research run"),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child("esc"),
                ),
        )
        .child(
            div()
                .text_size(px(13.))
                .text_color(color("ink-2"))
                .child(proposal.task.clone()),
        )
        .children(
            rows.into_iter()
                .map(|(row, label, control, count, model, note)| {
                    let focused = state.row == row;
                    div()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .w(px(12.))
                                        .text_color(if focused {
                                            color("live")
                                        } else {
                                            color("ink-2")
                                        })
                                        .child(if focused { "▌" } else { " " }),
                                )
                                .child(
                                    div()
                                        .w(px(120.))
                                        .text_size(px(13.))
                                        .when(focused, |s| s.font_weight(FontWeight::SEMIBOLD))
                                        .child(label),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .gap(px(4.))
                                        .children(control.into_iter().enumerate().map(
                                            |(at, dot)| {
                                                div()
                                                    .id(("research-size", at))
                                                    .cursor_pointer()
                                                    .child(dot)
                                                    .on_click(cx.listener(move |this, _, _, cx| {
                                                        let Some(proposal) =
                                                            this.source.proposal(id)
                                                        else {
                                                            return;
                                                        };
                                                        let current =
                                                            this.proposal_state(id, &proposal);
                                                        let next = if row == PickerRow::Researchers
                                                        {
                                                            set_researchers(current, at + 1)
                                                        } else {
                                                            set_critics(
                                                                current,
                                                                if at == 0 { 1 } else { 3 },
                                                            )
                                                        };
                                                        this.picker.insert(
                                                            id,
                                                            (proposal.id.clone(), next),
                                                        );
                                                        cx.notify();
                                                    }))
                                            },
                                        ))
                                        .into_any_element(),
                                )
                                .child(
                                    div()
                                        .w(px(28.))
                                        .text_size(px(13.))
                                        .text_color(color("ink"))
                                        .child(count),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(px(13.))
                                        .text_color(color("ink-2"))
                                        .child(model),
                                ),
                        )
                        .when_some(note, |s, note| {
                            s.child(
                                div()
                                    .pl(px(140.))
                                    .text_size(px(12.))
                                    .text_color(color("ink-2"))
                                    .child(note),
                            )
                        })
                        .into_any_element()
                }),
        )
        .child(
            div()
                .text_size(px(13.))
                .text_color(color("ink"))
                .child(format!(
                    "{} threads, the lead included · {}",
                    thread_count(size),
                    w.proposal_providers(&proposal)
                )),
        )
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(
                    div()
                        .id("research-start")
                        .control("Start the research run")
                        .px(px(12.))
                        .py(px(6.))
                        .rounded(px(6.))
                        .bg(color("live"))
                        .text_color(color("on-live"))
                        .text_size(px(13.))
                        .child("Start")
                        .on_click(cx.listener(move |this, _, _, cx| this.answer_size(id, cx))),
                )
                .child(
                    div()
                        .id("research-single")
                        .control("Run one researcher instead")
                        .px(px(12.))
                        .py(px(6.))
                        .text_size(px(13.))
                        .text_color(color("ink-2"))
                        .child("One researcher instead")
                        .on_click(cx.listener(move |this, _, _, cx| this.answer_single(id, cx))),
                ),
        )
        .child(
            div()
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child("←→ change · ↑↓ row · enter start · esc one researcher"),
        )
        .on_click(cx.listener(|_, _, _, cx| cx.notify()))
        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
            let Some(proposal) = this.source.proposal(id) else {
                return;
            };
            let current = this.proposal_state(id, &proposal);
            let key = event.keystroke.key.as_str();
            let next = match key {
                "left" | "h" => Some(step_picker(current, -1)),
                "right" | "l" => Some(step_picker(current, 1)),
                "up" | "k" => Some(move_row(current, -1)),
                "down" | "j" | "tab" => Some(move_row(current, 1)),
                "enter" => {
                    this.answer_size(id, cx);
                    None
                }
                "escape" | "o" => {
                    this.answer_single(id, cx);
                    None
                }
                digit if current.row == PickerRow::Researchers => digit
                    .parse::<usize>()
                    .ok()
                    .filter(|n| (1..=MAX_RESEARCHERS).contains(n))
                    .map(|n| set_researchers(current, n)),
                _ => None,
            };
            if let Some(next) = next {
                this.picker.insert(id, (proposal.id.clone(), next));
                cx.notify();
            }
        }));
    Some(panel.into_any_element())
}

/// The parked-question notice above the composer, until it is dismissed.
pub fn notice(text: &str, cx: &mut Context<Workspace>) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(12.))
        .py(px(6.))
        .rounded(px(theme::px_token("radius", "radius-md")))
        .bg(color("sunk"))
        .text_size(px(13.))
        .child(ui::icon("circle-dot", "live"))
        .child(div().flex_1().min_w_0().child(text.to_string()))
        .child(
            div()
                .id("dismiss-notice")
                .control("Dismiss")
                .p(px(3.))
                .child(ui::icon("x", "ink-2"))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.notice = None;
                    this.notice_at = None;
                    cx.notify();
                })),
        )
}

/// "Researcher 1", "Critic 2 · Risks", "Finalizer": what a column and the
/// roster call an agent.
pub(crate) fn agent_title(summary: &RunSummary, agent: &RunAgent) -> String {
    match agent.role {
        ResearchRole::Finalizer => "Finalizer".into(),
        ResearchRole::Researcher => format!("Researcher {}", agent.index),
        ResearchRole::Critic => {
            let lens = agent.lens.as_deref().unwrap_or("");
            let lens = if lens == "all three reviews" {
                "all three reviews".to_string()
            } else {
                lens.to_string()
            };
            let lens = if lens.is_empty() {
                String::new()
            } else {
                format!(" · {lens}")
            };
            if summary.agents[ResearchRole::Critic as usize].len() == 1 {
                format!("Critic{lens}")
            } else {
                format!("Critic {}{lens}", agent.index)
            }
        }
    }
}

fn state_color(state: AgentState) -> &'static str {
    match state {
        AgentState::Working => "live",
        AgentState::Done => "added",
        AgentState::Failed => "broken",
        AgentState::Stopped => "ink-2",
        AgentState::Waiting => "ink-2",
    }
}

/// Where the composer sits while a role of a research run (or its lead) is
/// open in full: what is on screen, and the way back to the run.
pub fn back_bar(
    w: &Workspace,
    title: &str,
    state: &str,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    div()
        .id("run-back")
        .track_focus(&w.ask_focus)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _, window, cx| {
                window.focus(&this.ask_focus, cx);
            }),
        )
        .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
            if event.keystroke.key.as_str() == "escape" {
                this.back_to_run(cx);
            }
        }))
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(12.))
        .py(px(8.))
        .border(px(theme::px_token("stroke", "stroke-rule")))
        .border_color(color("edge"))
        .rounded(px(theme::px_token("radius", "radius-lg")))
        .bg(color("ground"))
        .child(div().text_color(color("live")).child("◈"))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(13.))
                .text_color(color("ink"))
                .child(format!("{title}  ·  {state}")),
        )
        .child(
            div()
                .id("back-to-run")
                .control("Back to the research run")
                .text_size(px(13.))
                .text_color(color("live"))
                .child("← back to the run")
                .on_click(cx.listener(|this, _, _, cx| this.back_to_run(cx))),
        )
}

/// One role thread opened in full: its transcript under its agent title,
/// with the way back in the composer's place.
pub fn role_full(
    w: &Workspace,
    lead: ThreadId,
    role: ResearchRole,
    agent: usize,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let Some(summary) = w.source.run_summary(lead) else {
        return div().into_any_element();
    };
    let Some(row) = summary.agents[role as usize].get(agent) else {
        return div().into_any_element();
    };
    let title = column_title(&summary, row);
    let state = row.state.label().to_string();
    let body: AnyElement = match &row.thread_id {
        None => div()
            .p(px(10.))
            .text_size(px(13.))
            .text_color(color("ink-2"))
            .child("Not started yet.")
            .into_any_element(),
        Some(thread) => match w.source.role_messages(thread) {
            None => div()
                .p(px(10.))
                .text_size(px(13.))
                .text_color(color("ink-2"))
                .child("Reading…")
                .into_any_element(),
            Some(messages) => role_rows(w, lead, role, agent, &messages, cx),
        },
    };
    div()
        .id("role-full-scroll")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px(px(28.))
        .py(px(12.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .flex()
                .items_baseline()
                .justify_between()
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_size(px(15.))
                        .child(title),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child(state),
                ),
        )
        .child(body)
        .into_any_element()
}

/// One role thread's transcript, as the run view's column draws it.
fn role_rows(
    w: &Workspace,
    lead: ThreadId,
    role: ResearchRole,
    agent: usize,
    messages: &[Message],
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let key = (lead, role, agent);
    let expanded = w.run_expanded.contains(&key);
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .children(messages.iter().enumerate().map(|(at, message)| {
            match message.clone() {
                Message::User { text, .. } => div()
                    .flex()
                    .flex_col()
                    .items_end()
                    .child(
                        div()
                            .max_w(relative(0.9))
                            .px(px(10.))
                            .py(px(8.))
                            .rounded(px(12.))
                            .bg(color("sunk"))
                            .text_size(px(theme::BODY))
                            .line_height(px(theme::LINE))
                            .child(text),
                    )
                    .into_any_element(),
                Message::Assistant { text, .. } => div()
                    .text_size(px(theme::BODY))
                    .line_height(px(theme::LINE))
                    .child(if text.is_empty() {
                        "Thinking…".into()
                    } else {
                        text
                    })
                    .into_any_element(),
                Message::Plan {
                    text, implemented, ..
                } => div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(color(if implemented { "ink-2" } else { "ink" }))
                            .child(if implemented {
                                "Plan implemented"
                            } else {
                                "Plan proposed"
                            }),
                    )
                    .child(
                        div()
                            .text_size(px(theme::BODY))
                            .line_height(px(theme::LINE))
                            .child(text),
                    )
                    .into_any_element(),
                Message::Tool {
                    name,
                    summary,
                    output,
                    meta,
                    failed,
                    ..
                } => {
                    let toggle = (lead, role, agent);
                    div()
                        .id(("role-step", at))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .text_size(px(13.))
                                .child(ui::icon("wrench", if failed { "broken" } else { "ink-2" }))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .child(summary)
                                        .when(name == "thought", |s| s.text_color(color("ink-2"))),
                                )
                                .child(
                                    div()
                                        .font_family(theme::MONO)
                                        .text_size(px(11.5))
                                        .text_color(color("ink-2"))
                                        .child(meta),
                                ),
                        )
                        .when(expanded, |s| {
                            s.child(
                                div()
                                    .pl(px(14.))
                                    .border_l_2()
                                    .border_color(color("rule"))
                                    .font_family(theme::MONO)
                                    .text_size(px(12.))
                                    .text_color(color("ink-2"))
                                    .child(output),
                            )
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if this.run_expanded.remove(&toggle) {
                            } else {
                                this.run_expanded.insert(toggle);
                            }
                            cx.notify();
                        }))
                        .into_any_element()
                }
            }
        }))
        .into_any_element()
}

fn column_title(summary: &RunSummary, agent: &RunAgent) -> String {
    format!("{} {}", agent_title(summary, agent), agent.state.glyph())
}

/// The research run in place of the lead's chat: a header, a roster with one
/// glyph per agent, and the researcher, critic and finalizer columns. Narrow
/// panes draw the focused column under a switcher.
pub fn run_view(
    w: &Workspace,
    lead: ThreadId,
    summary: &RunSummary,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let focus = w.run_focus(lead);
    let widths = column_widths(summary, theme::READING - 56.0);
    let phase_color = match summary.phase() {
        RunPhase::Failed => "broken",
        RunPhase::Finished => "added",
        RunPhase::Stopped => "ink-2",
        _ => "live",
    };
    let mut roster = div().flex().gap(px(16.));
    for role in ROLES {
        let agents = &summary.agents[role as usize];
        let shown = w.run_shown(lead, role).min(agents.len().saturating_sub(1));
        let focus_role = role;
        roster = roster.child(
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(
                    div()
                        .id(("run-role", role as usize))
                        .control(format!("Show the {} column", role.label()))
                        .text_size(px(13.))
                        .text_color(if focus == role {
                            color("ink")
                        } else {
                            color("ink-2")
                        })
                        .child(role.label())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.run_role.insert(lead, focus_role);
                            cx.notify();
                        })),
                )
                .children(agents.iter().enumerate().map(|(at, agent)| {
                    div()
                        .id(("run-agent", role as usize * 16 + at))
                        .control(format!("Show {}", agent_title(summary, agent)))
                        .px(px(3.))
                        .text_size(px(13.))
                        .text_color(if shown == at {
                            color("ink")
                        } else {
                            color(state_color(agent.state))
                        })
                        .child(agent.state.glyph())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.run_role.insert(lead, focus_role);
                            this.run_picks.insert((lead, focus_role), at);
                            cx.notify();
                        }))
                })),
        );
    }
    let roles: Vec<ResearchRole> = match widths {
        None => vec![focus],
        Some(_) => vec![
            ResearchRole::Researcher,
            ResearchRole::Critic,
            ResearchRole::Finalizer,
        ],
    };
    div()
        .id("research-run")
        .track_focus(&w.ask_focus)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _, window, cx| {
                window.focus(&this.ask_focus, cx);
            }),
        )
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .flex()
                .items_baseline()
                .justify_between()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_size(px(15.))
                        .child(if summary.title.is_empty() {
                            "Research run".into()
                        } else {
                            format!("Research run · {}", summary.title)
                        }),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(color(phase_color))
                        .child(format!(
                            "{} · {}",
                            summary.phase().label(),
                            elapsed(summary)
                        )),
                ),
        )
        .child(roster)
        .when(widths.is_none(), |s| {
            s.child(
                div()
                    .flex()
                    .gap(px(6.))
                    .children(ROLES.into_iter().map(|role| {
                        let active = role == focus;
                        div()
                            .id(("run-chip", role as usize))
                            .control(format!("Show the {} column", role.label()))
                            .px(px(8.))
                            .py(px(2.))
                            .rounded(px(6.))
                            .text_size(px(13.))
                            .text_color(if active { color("ink") } else { color("ink-2") })
                            .when(active, |s| s.bg(color("sunk")))
                            .child(role.label())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.run_role.insert(lead, role);
                                cx.notify();
                            }))
                    })),
            )
        })
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .gap(px(8.))
                .children(roles.into_iter().map(|role| {
                    let summary = summary.clone();
                    let shown = w
                        .run_shown(lead, role)
                        .min(summary.agents[role as usize].len().saturating_sub(1));
                    let agent = summary.agents[role as usize][shown].clone();
                    let width = widths
                        .map(|widths| widths[role as usize])
                        .unwrap_or(theme::READING - 56.0);
                    let focused = role == focus;
                    let state = agent.state.label().to_string();
                    let body: AnyElement = match &agent.thread_id {
                        None => div()
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .p(px(10.))
                            .text_size(px(13.))
                            .text_color(color("ink-2"))
                            .child(if summary.ended {
                                match role {
                                    ResearchRole::Researcher => "No researcher was started.",
                                    ResearchRole::Critic => "No critic was started.",
                                    ResearchRole::Finalizer => "No final report was written.",
                                }
                            } else {
                                match role {
                                    ResearchRole::Researcher => "Not started yet.",
                                    ResearchRole::Critic => "Waiting for the reports.",
                                    ResearchRole::Finalizer => "Waiting for a critic verdict.",
                                }
                            })
                            .into_any_element(),
                        Some(thread) => match w.source.role_messages(thread) {
                            None => div()
                                .p(px(10.))
                                .text_size(px(13.))
                                .text_color(color("ink-2"))
                                .child("Reading…")
                                .into_any_element(),
                            Some(messages) => role_rows(w, lead, role, shown, &messages, cx),
                        },
                    };
                    div()
                        .id(("run-column", role as usize))
                        .flex()
                        .flex_col()
                        .w(px(width))
                        .min_h_0()
                        .rounded(px(8.))
                        .border_1()
                        .border_color(color(if focused { "live" } else { "rule" }))
                        .bg(color("ground"))
                        .child(
                            div()
                                .flex()
                                .items_baseline()
                                .justify_between()
                                .px(px(10.))
                                .pt(px(8.))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(column_title(&summary, &agent)),
                                )
                                .child(
                                    div()
                                        .font_family(theme::MONO)
                                        .text_size(px(11.5))
                                        .text_color(color("ink-2"))
                                        .child(state),
                                ),
                        )
                        .child(
                            div()
                                .id(("run-column-scroll", role as usize))
                                .flex_1()
                                .min_h_0()
                                .overflow_y_scroll()
                                .px(px(10.))
                                .py(px(8.))
                                .child(body),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.run_role.insert(lead, role);
                            cx.notify();
                        }))
                        .into_any_element()
                })),
        )
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child("←→ agent · tab column · ↑↓ scroll · enter opens it"),
                )
                .child(
                    div()
                        .id("open-lead")
                        .control("Open the lead thread")
                        .text_size(px(13.))
                        .text_color(color("live"))
                        .child("lead thread →")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.lead_full = Some(lead);
                            cx.notify();
                        })),
                ),
        )
        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
            let Some(summary) = this.source.run_summary(lead) else {
                return;
            };
            let focus = this.run_focus(lead);
            let shown = this
                .run_shown(lead, focus)
                .min(summary.agents[focus as usize].len().saturating_sub(1));
            match event.keystroke.key.as_str() {
                "left" => {
                    let next = step_agent(
                        &summary,
                        AgentRef {
                            role: focus,
                            index: shown,
                        },
                        -1,
                    );
                    this.run_role.insert(lead, next.role);
                    this.run_picks.insert((lead, next.role), next.index);
                }
                "right" => {
                    let next = step_agent(
                        &summary,
                        AgentRef {
                            role: focus,
                            index: shown,
                        },
                        1,
                    );
                    this.run_role.insert(lead, next.role);
                    this.run_picks.insert((lead, next.role), next.index);
                }
                "tab" => {
                    let direction = if event.keystroke.modifiers.shift {
                        -1
                    } else {
                        1
                    };
                    this.run_role.insert(lead, step_role(focus, direction));
                }
                "enter" => {
                    if let Some(agent) = summary.agents[focus as usize].get(shown)
                        && agent.thread_id.is_some()
                    {
                        this.role_full = Some((lead, focus, shown));
                    }
                }
                "escape" => {
                    // Back to the run, as the Dismiss action does elsewhere:
                    // a focused run view answers its own keys.
                    this.back_to_run(cx);
                }
                _ => return,
            }
            cx.notify();
        }))
        .into_any_element()
}
