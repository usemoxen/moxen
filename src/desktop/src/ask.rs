//! What a thread waits on the person for: a tool approval, or the agent's
//! questions. The panel takes the composer's place while one is open, as the
//! TUI's does (`src/tui/features/answerpanel/`, `permissionpanel/`), and a
//! question wins the slot over an approval.
//!
//! `Draft` is the pure part: which answers are picked and how a request is
//! walked through and sent, the same rules as the TUI's `useAnswerFlow`.

use crate::{
    model::{Answer, Ask, Decision, Permission, Question, Status},
    theme::{self, color},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
use std::collections::HashMap;

/// The answers given so far to one request, and where the panel is in it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    pub request: String,
    /// The question shown, for a request with several.
    pub index: usize,
    /// The row under the cursor.
    pub highlight: usize,
    /// Picked choice values, by question id.
    pub selected: HashMap<String, Vec<String>>,
    /// Written answers, by question id.
    pub custom: HashMap<String, String>,
}

/// A line of a question's panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Row {
    Choice(usize),
    Custom,
    /// Multi-select: done picking.
    Continue,
}

/// What `Draft::advance` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Advance {
    /// Moved to another question.
    Moved,
    /// Every question has its answer: send them.
    Send(Vec<(String, Answer)>),
    /// The last question has no answer yet.
    Incomplete,
}

/// The lines a question shows: its choices, then a written answer if allowed,
/// then Continue for a multi-select.
pub fn rows(question: &Question) -> Vec<Row> {
    let mut rows: Vec<Row> = (0..question.choices.len()).map(Row::Choice).collect();
    if question.custom {
        rows.push(Row::Custom);
    }
    if question.multi {
        rows.push(Row::Continue);
    }
    rows
}

impl Draft {
    pub fn new(request: String) -> Self {
        Self {
            request,
            ..Self::default()
        }
    }

    /// A question's answer: the written one if there is one, else the picked
    /// values that are still choices (a multi-select needs at least one).
    pub fn resolve(&self, question: &Question) -> Option<Answer> {
        if question.custom
            && let Some(written) = self
                .custom
                .get(&question.id)
                .map(|text| text.trim())
                .filter(|text| !text.is_empty())
        {
            return Some(Answer::One(written.to_string()));
        }
        let picked: Vec<String> = self
            .selected
            .get(&question.id)
            .into_iter()
            .flatten()
            .filter(|value| {
                question
                    .choices
                    .iter()
                    .any(|choice| &choice.value == *value)
            })
            .cloned()
            .collect();
        if question.multi {
            (!picked.is_empty()).then_some(Answer::Many(picked))
        } else {
            picked.into_iter().next().map(Answer::One)
        }
    }

    /// Picks the one answer to a single-select; it replaces a written one.
    pub fn pick(&mut self, question: &Question, value: &str) {
        self.selected
            .insert(question.id.clone(), vec![value.to_string()]);
        self.custom.remove(&question.id);
    }

    /// Adds or takes away one choice of a multi-select.
    pub fn toggle(&mut self, question: &Question, value: &str) {
        let picked = self.selected.entry(question.id.clone()).or_default();
        match picked.iter().position(|entry| entry == value) {
            Some(at) => {
                picked.remove(at);
            }
            None => picked.push(value.to_string()),
        }
    }

    /// Writes the answer to a question in the person's own words.
    pub fn write(&mut self, question: &Question, text: &str) {
        self.custom.insert(question.id.clone(), text.to_string());
    }

    /// Where the cursor starts on a question: what was answered, if anything.
    pub fn landing(&self, question: &Question) -> usize {
        let picked = self.selected.get(&question.id);
        let at = question
            .choices
            .iter()
            .position(|choice| picked.is_some_and(|picked| picked.contains(&choice.value)));
        match at {
            Some(at) => at,
            None if question.custom && self.custom.contains_key(&question.id) => {
                question.choices.len()
            }
            None => 0,
        }
    }

    /// Goes on from the current question. Questions can be revisited in any
    /// order, so the next is the nearest one still unanswered; when none is,
    /// the request is sent from the last question (changing an earlier answer
    /// walks on toward it first).
    pub fn advance(&mut self, ask: &Ask) -> Advance {
        let total = ask.questions.len();
        let unanswered = |draft: &Self, at: usize| draft.resolve(&ask.questions[at]).is_none();
        for step in 1..total {
            let next = (self.index + step) % total;
            if unanswered(self, next) {
                self.index = next;
                self.highlight = self.landing(&ask.questions[next]);
                return Advance::Moved;
            }
        }
        if unanswered(self, self.index) {
            return Advance::Incomplete;
        }
        if self.index + 1 < total {
            self.index += 1;
            self.highlight = self.landing(&ask.questions[self.index]);
            return Advance::Moved;
        }
        let answers: Option<Vec<_>> = ask
            .questions
            .iter()
            .map(|question| Some((question.id.clone(), self.resolve(question)?)))
            .collect();
        answers.map_or(Advance::Incomplete, Advance::Send)
    }
}

impl Workspace {
    /// The request the panel is for: a question, else an approval.
    fn request_open(&self) -> Option<String> {
        if self.creating {
            return None;
        }
        let id = self.selected;
        self.source
            .ask(id)
            .map(|ask| ask.request)
            .or_else(|| self.source.permission(id).map(|p| p.request))
    }

    /// Starts a fresh draft when the request shown changes, takes focus for
    /// the panel when one opens and gives it back to the composer when it goes.
    pub fn sync_panel(&mut self, window: &Window, cx: &mut Context<Self>) {
        let open = self.request_open();
        if open.as_deref().unwrap_or("") == self.draft.request {
            return;
        }
        let had = !self.draft.request.is_empty();
        self.draft = Draft::new(open.clone().unwrap_or_default());
        self.custom_open = false;
        if open.is_some() {
            cx.defer_in(window, |this, window, cx| window.focus(&this.ask_focus, cx));
        } else if had {
            cx.defer_in(window, |this, window, cx| {
                let composer = this.active_composer().read(cx).focus.clone();
                window.focus(&composer, cx)
            });
        }
    }

    pub fn decide(&mut self, decision: Decision, cx: &mut Context<Self>) {
        if let Some(permission) = self.source.permission(self.selected) {
            self.source
                .decide(self.selected, &permission.request, decision);
            cx.notify();
        }
    }

    /// Acts on one line of the question shown.
    pub fn use_row(&mut self, at: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ask) = self.source.ask(self.selected) else {
            return;
        };
        let Some(question) = ask.questions.get(self.draft.index) else {
            return;
        };
        let Some(row) = rows(question).get(at).copied() else {
            return;
        };
        self.draft.highlight = at;
        match row {
            Row::Choice(choice) => {
                let value = question.choices[choice].value.clone();
                if question.multi {
                    self.draft.toggle(question, &value);
                } else {
                    self.draft.pick(question, &value);
                    self.go_on(&ask, cx);
                }
            }
            Row::Custom => {
                let written = self.draft.custom.get(&question.id).cloned();
                self.custom_open = true;
                self.custom_input.update(cx, |input, cx| {
                    input.set_text(written.unwrap_or_default(), cx)
                });
                window.focus(&self.custom_input.read(cx).focus.clone(), cx);
            }
            Row::Continue => self.go_on(&ask, cx),
        }
        cx.notify();
    }

    /// The written answer to the question shown.
    pub fn submit_custom(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.custom_open = false;
        window.focus(&self.ask_focus, cx);
        let Some(ask) = self.source.ask(self.selected) else {
            return;
        };
        if let Some(question) = ask.questions.get(self.draft.index)
            && !text.trim().is_empty()
        {
            self.draft.write(question, text);
            self.go_on(&ask, cx);
        }
        cx.notify();
    }

    /// Closes the written answer's field without keeping what was typed.
    pub fn close_custom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.custom_open = false;
        window.focus(&self.ask_focus, cx);
        cx.notify();
    }

    fn go_on(&mut self, ask: &Ask, cx: &mut Context<Self>) {
        match self.draft.advance(ask) {
            Advance::Moved => {}
            Advance::Incomplete => {
                self.problem = Some("Answer every question before sending.".into());
            }
            Advance::Send(answers) => self.source.answer(self.selected, &ask.request, answers),
        }
        cx.notify();
    }

    pub fn goto_question(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(ask) = self.source.ask(self.selected) else {
            return;
        };
        if let Some(question) = ask.questions.get(index) {
            self.draft.index = index;
            self.draft.highlight = self.draft.landing(question);
            self.custom_open = false;
            cx.notify();
        }
    }

    /// Closes the questions without answering them.
    pub fn dismiss_ask(&mut self, cx: &mut Context<Self>) {
        if let Some(ask) = self.source.ask(self.selected) {
            self.source.dismiss(self.selected, &ask.request);
            cx.notify();
        }
    }

    /// Escape can dismiss a question, but a permission still needs an
    /// explicit decision. Neither should fall through to interrupting the turn.
    pub fn dismiss_panel(&mut self, cx: &mut Context<Self>) -> bool {
        if self.source.ask(self.selected).is_some() {
            self.dismiss_ask(cx);
            true
        } else {
            self.source.permission(self.selected).is_some()
        }
    }

    /// Keys for the open panel: arrows move, a digit or Enter picks.
    fn panel_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let id = self.selected;
        if let Some(ask) = self.source.ask(id) {
            let Some(question) = ask.questions.get(self.draft.index) else {
                return;
            };
            let count = rows(question).len();
            let total = ask.questions.len();
            match key {
                "up" | "down" if count > 0 => {
                    let at = self.draft.highlight.min(count - 1);
                    self.draft.highlight = if key == "up" {
                        (at + count - 1) % count
                    } else {
                        (at + 1) % count
                    };
                }
                "enter" if count > 0 => {
                    self.use_row(self.draft.highlight.min(count - 1), window, cx)
                }
                "left" | "backspace" if self.draft.index > 0 => {
                    self.goto_question(self.draft.index - 1, cx)
                }
                "right" if self.draft.index + 1 < total => {
                    self.goto_question(self.draft.index + 1, cx)
                }
                digit => {
                    if let Ok(number) = digit.parse::<usize>()
                        && (1..=question.choices.len()).contains(&number)
                    {
                        self.use_row(number - 1, window, cx);
                    }
                }
            }
        } else if self.source.permission(id).is_some() {
            const DECISIONS: [Decision; 3] =
                [Decision::Allow, Decision::AllowSession, Decision::Deny];
            match key {
                "up" => self.draft.highlight = (self.draft.highlight + 2) % 3,
                "down" => self.draft.highlight = (self.draft.highlight + 1) % 3,
                "enter" => self.decide(DECISIONS[self.draft.highlight.min(2)], cx),
                "1" | "2" | "3" => {
                    self.decide(DECISIONS[key.parse::<usize>().unwrap_or(1) - 1], cx)
                }
                _ => {}
            }
        }
        cx.notify();
    }
}

/// The panel in the composer's place, or nothing when the thread waits on no one.
pub fn panel(
    w: &Workspace,
    id: usize,
    creating: bool,
    cx: &mut Context<Workspace>,
) -> Option<AnyElement> {
    if creating {
        return None;
    }
    let body = if let Some(ask) = w.source.ask(id) {
        question_body(w, &ask, cx)
    } else {
        permission_body(w, &w.source.permission(id)?, cx)
    };
    Some(
        div()
            .id("waiting-panel")
            .track_focus(&w.ask_focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                // Written answers go to their own field.
                if !this.custom_open {
                    this.panel_key(&event.keystroke.key, window, cx);
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    if !this.custom_open {
                        window.focus(&this.ask_focus, cx);
                    }
                }),
            )
            .border(px(theme::px_token("stroke", "stroke-rule")))
            .border_color(color("held"))
            .rounded(px(theme::px_token("radius", "radius-lg")))
            .bg(color("ground"))
            .p(px(14.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(body)
            .into_any_element(),
    )
}

fn heading(
    label: String,
    close: Option<(&'static str, &'static str)>,
    cx: &mut Context<Workspace>,
) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(ui::state(Status::Held))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_weight(FontWeight::SEMIBOLD)
                .child(label),
        )
        .when_some(close, |s, (tip, id)| {
            s.child(
                div()
                    .id(id)
                    .control(tip)
                    .size(px(24.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .child(ui::icon("x", "ink-2"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if id == "deny-permission" {
                            this.decide(Decision::Deny, cx)
                        } else {
                            this.dismiss_ask(cx)
                        }
                    })),
            )
        })
}

fn hint(text: &'static str) -> Div {
    div()
        .text_size(px(12.))
        .text_color(color("ink-2"))
        .child(text)
}

/// What a selectable line shows.
struct Line {
    number: Option<usize>,
    label: String,
    detail: Option<String>,
    /// Under the cursor.
    active: bool,
    /// Part of the answer.
    picked: bool,
}

/// One selectable line: a number, a label, and a detail on the right.
fn line(
    id: (&'static str, usize),
    shown: Line,
    cx: &mut Context<Workspace>,
    on: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) -> Stateful<Div> {
    let Line {
        number,
        label,
        detail,
        active,
        picked,
    } = shown;
    div()
        .id(id)
        .h(px(30.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(6.))
        .cursor(CursorStyle::PointingHand)
        .when(active, |s| s.bg(color("sunk")))
        .hover(|s| s.bg(color("sunk")))
        .child(
            div()
                .w(px(16.))
                .flex_shrink_0()
                .font_family(theme::MONO)
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child(number.map(|n| n.to_string()).unwrap_or_default()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(13.5))
                .child(label),
        )
        .when_some(detail, |s, detail| {
            s.child(
                div()
                    .max_w(relative(0.5))
                    .truncate()
                    .text_size(px(12.5))
                    .text_color(color("ink-2"))
                    .child(detail),
            )
        })
        .when(picked, |s| s.child(ui::icon("check", "ink-2")))
        .on_click(cx.listener(move |this, _, window, cx| on(this, window, cx)))
}

fn permission_body(w: &Workspace, request: &Permission, cx: &mut Context<Workspace>) -> Div {
    let headline = match request.classification.as_deref() {
        Some("command-execution") => "Run a shell command".to_string(),
        Some("file-change") => "Edit a file".to_string(),
        Some("file-read") => "Read a file".to_string(),
        _ => format!("Use {}", request.tool),
    };
    let rows = [
        ("Yes".to_string(), None, Decision::Allow),
        (
            format!("Yes, and don’t ask again for {}", request.tool),
            Some("this session".to_string()),
            Decision::AllowSession,
        ),
        ("No".to_string(), None, Decision::Deny),
    ];
    div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(heading(headline, Some(("Deny", "deny-permission")), cx))
        .when_some(request.description.clone(), |s, text| {
            s.child(
                div()
                    .text_size(px(13.))
                    .text_color(color("ink-2"))
                    .child(text),
            )
        })
        .when_some(request.detail.clone(), |s, detail| {
            s.child(
                div()
                    .id("permission-detail")
                    .max_h(px(120.))
                    .overflow_y_scroll()
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(px(6.))
                    .bg(color("sunk"))
                    .font_family(theme::MONO)
                    .text_size(px(13.))
                    .child(detail),
            )
        })
        .child(
            div()
                .font_weight(FontWeight::MEDIUM)
                .child("Do you want to proceed?"),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .children(
                    rows.into_iter()
                        .enumerate()
                        .map(|(at, (label, detail, decision))| {
                            line(
                                ("permission", at),
                                Line {
                                    number: Some(at + 1),
                                    label,
                                    detail,
                                    active: w.draft.highlight.min(2) == at,
                                    picked: false,
                                },
                                cx,
                                move |this, _, cx| this.decide(decision, cx),
                            )
                        }),
                ),
        )
        .child(hint("↑↓ move · 1–3 or ↵ pick"))
}

fn question_body(w: &Workspace, ask: &Ask, cx: &mut Context<Workspace>) -> Div {
    let draft = &w.draft;
    let index = draft.index.min(ask.questions.len().saturating_sub(1));
    let question = &ask.questions[index];
    let lines = rows(question);
    let highlight = draft.highlight.min(lines.len().saturating_sub(1));
    let written = draft
        .custom
        .get(&question.id)
        .filter(|text| !text.trim().is_empty());
    let preview = match lines.get(highlight) {
        Some(Row::Choice(at)) => question.choices[*at].preview.clone(),
        _ => None,
    };
    let tabs = ask.questions.len() > 1;
    div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(if tabs {
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(div().flex_shrink_0().child(ui::state(Status::Held)))
                .children(ask.questions.iter().enumerate().map(|(at, other)| {
                    let current = at == index;
                    let answered = draft.resolve(other).is_some();
                    div()
                        .id(("question-tab", at))
                        .control(other.header.clone())
                        .h(px(26.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .rounded(px(13.))
                        .text_size(px(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(color(if current { "ink" } else { "ink-2" }))
                        .when(current, |s| s.bg(color("sunk")))
                        .child(format!("{}", at + 1))
                        .when(answered, |s| s.child(ui::icon("check", "ink-2")))
                        .when(current, |s| s.child(other.header.clone()))
                        .on_click(cx.listener(move |this, _, _, cx| this.goto_question(at, cx)))
                }))
                .child(div().flex_1())
                .child(
                    div()
                        .id("dismiss-ask")
                        .control("Dismiss the questions")
                        .size(px(24.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .child(ui::icon("x", "ink-2"))
                        .on_click(cx.listener(|this, _, _, cx| this.dismiss_ask(cx))),
                )
        } else {
            heading(
                question.header.clone(),
                Some(("Dismiss the question", "dismiss-ask")),
                cx,
            )
        })
        .child(
            div()
                .font_weight(FontWeight::MEDIUM)
                .child(question.text.clone()),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .children(lines.iter().enumerate().map(|(at, row)| {
                    let (number, label, detail, picked) = match row {
                        Row::Choice(number) => {
                            let choice = &question.choices[*number];
                            let picked = draft
                                .selected
                                .get(&question.id)
                                .is_some_and(|values| values.contains(&choice.value))
                                && written.is_none();
                            (
                                Some(*number + 1),
                                choice.label.clone(),
                                choice.description.clone(),
                                picked,
                            )
                        }
                        Row::Custom => (
                            None,
                            "Write your own answer…".to_string(),
                            written.cloned(),
                            written.is_some(),
                        ),
                        Row::Continue => (
                            None,
                            "Continue".to_string(),
                            Some(format!(
                                "{} picked",
                                draft.selected.get(&question.id).map_or(0, Vec::len)
                            )),
                            false,
                        ),
                    };
                    line(
                        ("answer", at),
                        Line {
                            number,
                            label,
                            detail,
                            active: highlight == at,
                            picked,
                        },
                        cx,
                        move |this, window, cx| this.use_row(at, window, cx),
                    )
                })),
        )
        .when_some(preview, |s, text| {
            s.child(
                div()
                    .id("answer-preview")
                    .max_h(px(160.))
                    .overflow_y_scroll()
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(px(6.))
                    .bg(color("sunk"))
                    .font_family(theme::MONO)
                    .text_size(px(12.5))
                    .child(text),
            )
        })
        .when(w.custom_open, |s| {
            s.child(
                div()
                    .rounded(px(6.))
                    .border(px(theme::px_token("stroke", "stroke-rule")))
                    .border_color(color("edge"))
                    .child(w.custom_input.clone()),
            )
        })
        .child(hint(if w.custom_open {
            "↵ save the answer · esc cancel"
        } else if tabs {
            "↑↓ move · 1–9 or ↵ pick · ←→ questions"
        } else {
            "↑↓ move · 1–9 or ↵ pick"
        }))
}

#[cfg(test)]
mod tests {
    // Not `super::*`: it would bring gpui's own `test` attribute along.
    use super::{Advance, Draft, Row, rows};
    use crate::model::{Answer, Ask, Choice, Question};

    fn question(id: &str, multi: bool, custom: bool) -> Question {
        Question {
            id: id.into(),
            header: id.into(),
            text: "?".into(),
            choices: ["a", "b"]
                .into_iter()
                .map(|value| Choice {
                    label: value.to_uppercase(),
                    description: None,
                    value: value.into(),
                    preview: None,
                })
                .collect(),
            multi,
            custom,
        }
    }

    fn ask(questions: Vec<Question>) -> Ask {
        Ask {
            request: "r".into(),
            questions,
        }
    }

    #[test]
    fn written_text_wins_and_a_fresh_pick_replaces_it() {
        let q = question("q", false, true);
        let mut draft = Draft::new("r".into());
        draft.pick(&q, "a");
        draft.write(&q, "  mine ");
        assert_eq!(draft.resolve(&q), Some(Answer::One("mine".into())));
        draft.pick(&q, "b");
        assert_eq!(draft.resolve(&q), Some(Answer::One("b".into())));
        // A question that takes no written answer ignores one.
        let closed = question("c", false, false);
        draft.write(&closed, "mine");
        assert_eq!(draft.resolve(&closed), None);
    }

    #[test]
    fn a_multi_select_needs_a_pick_and_drops_values_that_are_not_choices() {
        let q = question("q", true, false);
        let mut draft = Draft::new("r".into());
        assert_eq!(draft.resolve(&q), None);
        draft.toggle(&q, "a");
        draft.toggle(&q, "gone");
        draft.toggle(&q, "b");
        draft.toggle(&q, "a");
        assert_eq!(draft.resolve(&q), Some(Answer::Many(vec!["b".into()])));
    }

    #[test]
    fn the_request_is_sent_once_from_the_last_question() {
        let request = ask(vec![
            question("one", false, false),
            question("two", false, false),
        ]);
        let mut draft = Draft::new("r".into());
        // Next is the nearest question still open, wrapping around.
        assert_eq!(draft.advance(&request), Advance::Moved);
        assert_eq!(draft.index, 1);
        assert_eq!(draft.advance(&request), Advance::Moved);
        assert_eq!(draft.index, 0);
        draft.pick(&request.questions[0], "a");
        assert_eq!(draft.advance(&request), Advance::Moved);
        assert_eq!(draft.index, 1);
        // The only question left open has no answer: nothing to send.
        assert_eq!(draft.advance(&request), Advance::Incomplete);
        draft.pick(&request.questions[1], "b");
        assert_eq!(
            draft.advance(&request),
            Advance::Send(vec![
                ("one".into(), Answer::One("a".into())),
                ("two".into(), Answer::One("b".into())),
            ])
        );
        // Changing an earlier answer walks on to the last question before sending.
        draft.index = 0;
        assert_eq!(draft.advance(&request), Advance::Moved);
        assert_eq!(draft.index, 1);
    }

    #[test]
    fn a_single_question_with_a_pick_sends_at_once() {
        let request = ask(vec![question("only", false, true)]);
        let mut draft = Draft::new("r".into());
        assert_eq!(draft.advance(&request), Advance::Incomplete);
        draft.pick(&request.questions[0], "a");
        assert!(matches!(draft.advance(&request), Advance::Send(_)));
    }

    #[test]
    fn rows_end_with_the_written_answer_and_continue() {
        assert_eq!(
            rows(&question("q", true, true)),
            [Row::Choice(0), Row::Choice(1), Row::Custom, Row::Continue]
        );
        assert_eq!(
            rows(&question("q", false, false)),
            [Row::Choice(0), Row::Choice(1)]
        );
        // Revisiting a question lands on what was answered.
        let q = question("q", false, true);
        let mut draft = Draft::new("r".into());
        draft.pick(&q, "b");
        assert_eq!(draft.landing(&q), 1);
        draft.write(&q, "mine");
        assert_eq!(draft.landing(&q), 1);
    }
}
