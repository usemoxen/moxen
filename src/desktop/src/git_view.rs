//! The inspector's Git and Diff tabs. The Git tab is the checkout as the
//! server reads it: the pull request with its CI, the branches and the
//! history, one commit in full. The Diff tab is what each turn changed and
//! what is uncommitted. The data and its rules are in `git.rs`; this is how
//! they are drawn and what the controls do.
//!
//! Writes to the forge (open, comment, merge) are seen by other people the
//! moment they land, so none fires on one click: each is a form that asks
//! first, or a merge that arms before it merges.

use crate::{
    composer::Composer,
    diff,
    git::{
        self, Checks, CommitDetail, Forge, ForgeKind, Git, OpenCommit, Patch, PatchFile, Request,
        RequestStatus, Run, RunState, Tone, TurnDiff,
    },
    live::now_ms,
    model::{Delivery, MergeStrategy, NewRequest, ThreadId},
    theme::{self, color},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
use std::collections::{HashMap, HashSet};

/// Commits drawn before "Show more", so a long history never buries the rest.
const COMMITS_SHOWN: usize = 12;
const BRANCHES_SHOWN: usize = 6;
/// CI runs listed under the request before "+N more".
const RUNS_SHOWN: usize = 6;

/// What the text field is open for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    Create { draft: bool },
    Comment { number: i64 },
}

/// What the Diff tab has open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pick {
    Tree,
    Turn(i64),
}

/// The tabs' own state: what is open, armed or typed.
pub struct GitUi {
    pub form: Option<Form>,
    pub input: Entity<Composer>,
    /// The request whose merge is armed, waiting for its strategy.
    pub merging: Option<i64>,
    pub picking_base: bool,
    /// The branch a new request merges into, while it is still a choice.
    pub base: Option<String>,
    pub more_branches: bool,
    pub more_commits: bool,
    pub more_runs: bool,
    /// Files opened, by `scope:path`.
    pub expanded: HashSet<String>,
    /// The Diff tab's open entry by thread; `Some(None)` is one closed on purpose.
    pub picked: HashMap<ThreadId, Option<Pick>>,
    /// The thread the tabs last read, so each opening reads again once.
    pub seen: Option<ThreadId>,
    /// What an action that is not the server's own did.
    pub note: Option<String>,
}

impl GitUi {
    pub fn new(input: Entity<Composer>) -> Self {
        Self {
            form: None,
            input,
            merging: None,
            picking_base: false,
            base: None,
            more_branches: false,
            more_commits: false,
            more_runs: false,
            expanded: HashSet::new(),
            picked: HashMap::new(),
            seen: None,
            note: None,
        }
    }
}

impl Workspace {
    /// Reads git and the forge when the Git or Diff tab shows a thread, and
    /// asks for the patch the Diff tab is about to draw.
    pub fn sync_inspector(&mut self) {
        let id = self.selected;
        let visible = self.inspector_open && self.tab <= 1;
        if !visible {
            self.git_ui.seen = None;
            return;
        }
        if self.git_ui.seen != Some(id) {
            self.git_ui.seen = Some(id);
            self.git_ui.note = None;
            self.git_ui.merging = None;
            self.git_ui.form = None;
            let branch = self.source.git(id).branch.clone();
            self.source.read_git(id, branch);
        }
        if self.tab == 0 {
            match self.diff_pick(id) {
                Some(Pick::Turn(turn)) if self.source.turn_patch(id, turn).is_none() => {
                    self.source.read_turn_patch(id, turn)
                }
                Some(Pick::Tree) if self.source.tree_patch(id).is_none() => {
                    self.source.read_tree_patch(id)
                }
                _ => {}
            }
        }
    }

    /// The Diff tab's open entry: the one picked, else the newest turn.
    pub fn diff_pick(&self, id: ThreadId) -> Option<Pick> {
        match self.git_ui.picked.get(&id) {
            Some(picked) => *picked,
            None => self
                .source
                .turn_diffs(id)
                .last()
                .map(|turn| Pick::Turn(turn.turn)),
        }
    }

    pub fn open_form(&mut self, form: Form, window: &mut Window, cx: &mut Context<Self>) {
        self.git_ui.form = Some(form);
        self.git_ui.input.update(cx, |input, cx| {
            input.placeholder = match form {
                Form::Create { .. } => "Title",
                Form::Comment { .. } => "Comment",
            };
            input.set_text(String::new(), cx)
        });
        let focus = self.git_ui.input.read(cx).focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    pub fn close_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.git_ui.form = None;
        let focus = self.active_composer().read(cx).focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    /// The form's text, sent: a title opens the request, a comment is posted.
    pub fn submit_form(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = self.git_ui.form else {
            return;
        };
        self.close_form(window, cx);
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let id = self.selected;
        match form {
            Form::Create { draft } => {
                let git = self.source.git(id);
                let base = self.base_of(&git);
                self.source.create_request(
                    id,
                    NewRequest {
                        title: text.to_string(),
                        draft,
                        base,
                    },
                );
            }
            Form::Comment { number } => {
                self.source.comment_on_request(id, number, text.to_string())
            }
        }
        cx.notify();
    }

    /// The branch a new request merges into: the one picked, else the default.
    fn base_of(&self, git: &Git) -> Option<String> {
        let choices = git.overview.as_ref()?.base_choices();
        git::resolve_base(self.git_ui.base.as_deref(), &choices)
    }

    /// Asks the thread's agent to open the request, as the TUI does: a message
    /// sent to wait its turn, which the TUI's transcript reads back as the same ask.
    fn agent_opens(&mut self, draft: bool, cx: &mut Context<Self>) {
        let id = self.selected;
        let git = self.source.git(id);
        let kind = git.forge.as_ref().and_then(|forge| forge.kind);
        let branch = git
            .overview
            .as_ref()
            .and_then(|o| o.status.as_ref()?.branch.clone());
        let base = self.base_of(&git);
        let prompt =
            git::open_request_prompt(kind, draft, branch.as_deref(), base.as_deref(), false);
        self.source.send_message(id, prompt.into(), Delivery::Queue);
        self.git_ui.note = Some(format!(
            "Asked the agent to open a {}{}.",
            if draft { "draft " } else { "" },
            ForgeKind::short(kind)
        ));
        cx.notify();
    }
}

// -- parts --------------------------------------------------------------------

fn tone_token(tone: Tone) -> &'static str {
    match tone {
        Tone::Passed => "added",
        Tone::Failed => "broken",
        Tone::Pending => "held",
    }
}

fn heading(label: &str, meta: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .items_baseline()
        .gap(px(10.))
        .pt(px(16.))
        .px(px(16.))
        .pb(px(6.))
        .child(ui::caps(label).flex_1())
        .child(
            div()
                .min_w_0()
                .truncate()
                .font_family(theme::MONO)
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child(meta.into()),
        )
}

/// A line of prose in a section.
fn note(text: impl Into<SharedString>, token: &str) -> Div {
    div()
        .px(px(16.))
        .py(px(3.))
        .text_size(px(13.))
        .line_height(px(18.))
        .text_color(color(token))
        .child(text.into())
}

/// A text-only action: it brightens on hover.
fn action(id: impl Into<ElementId>, label: &str, tone: &str) -> Stateful<Div> {
    div()
        .id(id)
        .quiet()
        .text_size(px(13.))
        .text_color(color(tone))
        .child(label.to_string())
}

fn dot() -> Div {
    div().text_color(color("rule")).child("·")
}

/// CI in one glance: the outcome's mark and how many runs passed.
fn glance(checks: Option<Checks>) -> Option<Div> {
    let (tone, text) = checks?.glance()?;
    let token = tone_token(tone);
    Some(
        div()
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .font_family(theme::MONO)
            .text_size(px(12.))
            .text_color(color(token))
            .child(ui::icon(
                match tone {
                    Tone::Passed => "check",
                    Tone::Failed => "x",
                    Tone::Pending => "circle",
                },
                token,
            ))
            .child(text),
    )
}

/// A path as a file row of a patch: chevron, path, counts.
fn file_row(
    id: SharedString,
    path: &str,
    added: Option<i64>,
    removed: Option<i64>,
    open: bool,
    cx: &mut Context<Workspace>,
    key: String,
) -> Stateful<Div> {
    div()
        .id(ElementId::Name(id))
        .control(path.to_string())
        .px(px(12.))
        .py(px(7.))
        .flex()
        .gap(px(8.))
        .items_center()
        .when(open, |s| s.bg(color("sunk")))
        .font_family(theme::MONO)
        .text_size(px(12.5))
        .line_height(px(16.))
        .child(ui::icon(
            if open {
                "chevron-down"
            } else {
                "chevron-right"
            },
            "ink-2",
        ))
        .child(div().flex_1().min_w_0().truncate().child(path.to_string()))
        .child(match (added, removed) {
            (None, None) => div()
                .text_color(color("ink-2"))
                .text_size(px(11.))
                .child("binary"),
            (a, r) => crate::inspector::delta(&format!("+{} −{}", a.unwrap_or(0), r.unwrap_or(0))),
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            if !this.git_ui.expanded.remove(&key) {
                this.git_ui.expanded.insert(key.clone());
            }
            cx.notify();
        }))
}

/// One file of a patch: its row, and its hunks while it is open.
fn patch_file(
    scope: &str,
    index: usize,
    file: &PatchFile,
    cx: &mut Context<Workspace>,
    open: &HashSet<String>,
) -> Div {
    let key = format!("{scope}:{}", file.path);
    let is_open = open.contains(&key);
    div()
        .child(file_row(
            format!("{scope}-file-{index}").into(),
            &file.path,
            (!file.binary).then_some(file.additions as i64),
            (!file.binary).then_some(file.deletions as i64),
            is_open,
            cx,
            key,
        ))
        .when(is_open && !file.binary, |s| {
            s.child(diff::render(
                format!("{scope}-diff-{index}").into(),
                &file.lines,
            ))
        })
}

fn run_row(run: &Run) -> Div {
    let (icon, token) = match run.state {
        RunState::Failed => ("x", "broken"),
        RunState::Pending => ("circle", "held"),
        RunState::Skipped => ("circle", "ink-2"),
        RunState::Passed => ("check", "added"),
    };
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .pl(px(24.))
        .pr(px(16.))
        .py(px(2.))
        .text_size(px(12.5))
        .text_color(color(if run.state == RunState::Failed {
            "ink"
        } else {
            "ink-2"
        }))
        .child(ui::icon(icon, token))
        .child(div().flex_1().min_w_0().truncate().child(run.name.clone()))
}

/// CI runs, failures first, with "+N more" past a few.
fn runs_list(runs: &[Run], all: bool, cx: &mut Context<Workspace>) -> Div {
    let sorted = git::failures_first(runs);
    let shown = if all {
        sorted.len()
    } else {
        sorted.len().min(RUNS_SHOWN)
    };
    div()
        .flex()
        .flex_col()
        .children(sorted[..shown].iter().map(run_row))
        .when(sorted.len() > RUNS_SHOWN, |s| {
            s.child(
                div().px(px(16.)).pt(px(2.)).child(
                    action(
                        "runs-more",
                        &if all {
                            "Show fewer".to_string()
                        } else {
                            format!("+{} more", sorted.len() - RUNS_SHOWN)
                        },
                        "ink-2",
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.git_ui.more_runs = !this.git_ui.more_runs;
                        cx.notify();
                    })),
                ),
            )
        })
}

// -- the Git tab --------------------------------------------------------------

/// The pinned line under the Git tab: where the checkout lives, then its
/// branch and what is uncommitted.
pub fn footer(w: &Workspace) -> Option<Div> {
    let git = w.source.git(w.selected);
    let overview = git.overview.as_ref().filter(|o| o.is_repository)?;
    let place = git
        .forge
        .as_ref()
        .and_then(|forge| forge.slug.clone())
        .or_else(|| overview.root.clone())
        .unwrap_or_else(|| "No remote".into());
    let status = overview.status.as_ref().map(|s| s.line());
    Some(
        div()
            .flex_shrink_0()
            .px(px(16.))
            .py(px(8.))
            .border_t_1()
            .border_color(color("rule"))
            .flex()
            .flex_col()
            .gap(px(2.))
            .font_family(theme::MONO)
            .text_size(px(12.))
            .text_color(color("ink-2"))
            .child(div().truncate().child(place))
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(color("ink"))
                            .child(overview.checked_out().unwrap_or("detached").to_string()),
                    )
                    .when_some(status, |s, status| {
                        let clean = status == "clean";
                        s.child(
                            div()
                                .flex_shrink_0()
                                .text_color(color(if clean { "ink-2" } else { "held" }))
                                .child(format!("· {status}")),
                        )
                    }),
            ),
    )
}

fn form_box(w: &Workspace, git: &Git) -> Option<Div> {
    let form = w.git_ui.form?;
    let kind = git.forge.as_ref().and_then(|f| f.kind);
    let (title, hint) = match form {
        Form::Create { draft } => (
            format!(
                "Open a {}{}",
                if draft { "draft " } else { "" },
                ForgeKind::long(kind)
            ),
            "↵ open it on the forge · esc cancel",
        ),
        Form::Comment { number } => (
            format!("Comment on #{number}"),
            "↵ post the comment · esc cancel",
        ),
    };
    Some(
        div()
            .mx(px(16.))
            .my(px(8.))
            .p(px(10.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .rounded(px(6.))
            .border(px(theme::px_token("stroke", "stroke-rule")))
            .border_color(color("edge"))
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title),
            )
            .child(
                div()
                    .rounded(px(6.))
                    .bg(color("sunk"))
                    .child(w.git_ui.input.clone()),
            )
            .child(
                div()
                    .text_size(px(11.5))
                    .text_color(color("ink-2"))
                    .child(hint),
            ),
    )
}

/// The checked-out branch's request: title, where it stands, CI, size, actions.
fn request_card(w: &Workspace, status: &RequestStatus, cx: &mut Context<Workspace>) -> Div {
    let request = &status.request;
    let state_token = match request.state {
        git::RequestState::Open => "added",
        git::RequestState::Draft => "ink-2",
        git::RequestState::Merged => "ink",
        git::RequestState::Closed => "broken",
    };
    let checks = status.checks();
    let armed = w.git_ui.merging == Some(request.number);
    let number = request.number;
    let id = w.selected;
    let busy = w.source.git(id).busy.is_some();
    let url = request.url.clone();
    div()
        .px(px(16.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .flex()
                .gap(px(8.))
                .text_size(px(14.))
                .line_height(px(14. * 1.4))
                .child(
                    div()
                        .flex_shrink_0()
                        .font_family(theme::MONO)
                        .text_color(color("live"))
                        .child(format!("#{number}")),
                )
                .child(
                    div()
                        .min_w_0()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(request.title.clone()),
                ),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(6.))
                .text_size(px(12.5))
                .child(
                    div()
                        .text_color(color(state_token))
                        .child(request.state.label()),
                )
                .when_some(request.review_label(), |s, (label, tone)| {
                    s.child(dot())
                        .child(div().text_color(color(tone_token(tone))).child(label))
                })
                .when(status.conflicting, |s| {
                    s.child(dot())
                        .child(div().text_color(color("broken")).child("conflicts"))
                })
                .when_some(request.target.clone(), |s, target| {
                    s.child(
                        div()
                            .text_color(color("ink-2"))
                            .child(format!("into {target}")),
                    )
                }),
        )
        .when(
            status.additions.is_some() || status.deletions.is_some() || status.files.is_some(),
            |s| {
                s.child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .items_center()
                        .child(crate::inspector::delta(&format!(
                            "+{} −{}",
                            status.additions.unwrap_or(0),
                            status.deletions.unwrap_or(0)
                        )))
                        .when_some(status.files, |s, files| {
                            s.child(
                                div()
                                    .font_family(theme::MONO)
                                    .text_size(px(12.))
                                    .text_color(color("ink-2"))
                                    .child(format!(
                                        "· {files} file{}",
                                        if files == 1 { "" } else { "s" }
                                    )),
                            )
                        }),
                )
            },
        )
        .child(match checks.and_then(|c| c.glance().map(|g| (c, g))) {
            None => div()
                .text_size(px(12.5))
                .text_color(color("ink-2"))
                .child("No CI checks"),
            Some((checks, (tone, _))) => div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .children(glance(Some(checks)))
                        .child(div().text_size(px(12.5)).text_color(color("ink-2")).child(
                            match tone {
                                Tone::Passed => "checks passed",
                                Tone::Failed => "some checks failing",
                                Tone::Pending => "some checks running",
                            },
                        )),
                )
                .when(!status.runs.is_empty(), |s| {
                    s.child(div().ml(px(-16.)).child(runs_list(
                        &status.runs,
                        w.git_ui.more_runs,
                        cx,
                    )))
                }),
        })
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .when_some(url, |s, url| {
                    s.child(
                        action("request-open", "Open", "ink-2")
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    )
                    .child(dot())
                })
                .when(request.state.active(), |s| {
                    s.child(if busy {
                        div()
                            .text_size(px(13.))
                            .opacity(0.45)
                            .child("Comment")
                            .into_any_element()
                    } else {
                        action("request-comment", "Comment", "ink-2")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_form(Form::Comment { number }, window, cx)
                            }))
                            .into_any_element()
                    })
                    .child(dot())
                    .children(if armed {
                        vec![
                            merge_action(number, MergeStrategy::Squash, "Squash", busy, cx),
                            merge_action(number, MergeStrategy::Merge, "Merge commit", busy, cx),
                            action("merge-cancel", "Cancel", "ink-2")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.git_ui.merging = None;
                                    cx.notify();
                                }))
                                .into_any_element(),
                        ]
                    } else if busy || request.state == git::RequestState::Draft {
                        vec![
                            div()
                                .text_size(px(13.))
                                .opacity(0.45)
                                .child("Merge")
                                .into_any_element(),
                        ]
                    } else {
                        vec![
                            action("request-merge", "Merge", "ink-2")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.git_ui.merging = Some(number);
                                    cx.notify();
                                }))
                                .into_any_element(),
                        ]
                    })
                }),
        )
}

/// A merge, armed: each strategy says what it will do.
fn merge_action(
    number: i64,
    strategy: MergeStrategy,
    label: &'static str,
    busy: bool,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    if busy {
        return div()
            .text_size(px(13.))
            .opacity(0.45)
            .child(label)
            .into_any_element();
    }
    action(label, label, "held")
        .on_click(cx.listener(move |this, _, _, cx| {
            this.git_ui.merging = None;
            let id = this.selected;
            this.source.merge_request(id, number, strategy);
            cx.notify();
        }))
        .into_any_element()
}

fn commit_row(
    git: &Git,
    commit: &git::Commit,
    index: usize,
    cx: &mut Context<Workspace>,
) -> Stateful<Div> {
    let sha = commit.sha.clone();
    div()
        .id(("commit", index))
        .control(commit.subject.clone())
        .px(px(16.))
        .py(px(7.))
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            div()
                .flex()
                .gap(px(10.))
                .text_size(px(13.))
                .line_height(px(17.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(commit.subject.clone()),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .font_family(theme::MONO)
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child(commit.short.clone()),
                ),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child(div().min_w_0().truncate().child({
                    let when = git::ago(&commit.date, now_ms());
                    if when.is_empty() {
                        commit.author.clone()
                    } else {
                        format!("{} · {when}", commit.author)
                    }
                }))
                .children(glance(git.commit_checks.get(&commit.sha).copied())),
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            let id = this.selected;
            this.source.open_commit(id, &sha);
            cx.notify();
        }))
}

pub fn git_tab(w: &Workspace, cx: &mut Context<Workspace>) -> Div {
    let id = w.selected;
    let git = w.source.git(id);
    let mut tab = div().flex().flex_col().pb(px(18.));
    if let Some(error) = &git.error {
        tab = tab.child(note(error.clone(), "broken").pt(px(10.)));
    }
    if let Some(busy) = git.busy {
        tab = tab.child(note(busy, "held").pt(px(10.)));
    }
    let notice = git.notice.clone().or_else(|| w.git_ui.note.clone());
    if let Some(notice) = notice {
        tab = tab.child(note(notice, "ink-2").pt(px(10.)));
    }
    let Some(overview) = &git.overview else {
        return tab.child(
            note(
                if git.loading_git {
                    "Reading git…"
                } else {
                    "No git information."
                },
                "ink-2",
            )
            .pt(px(10.)),
        );
    };
    if !overview.is_repository {
        return tab
            .child(note("This thread's folder is not a git repository.", "ink-2").pt(px(10.)));
    }
    let kind = git.forge.as_ref().and_then(|f| f.kind);
    let noun = ForgeKind::short(kind);
    let checked_out = overview.status.as_ref().and_then(|s| s.branch.clone());

    // The request
    tab = tab.child(heading(
        if kind == Some(ForgeKind::GitLab) {
            "Merge request"
        } else {
            "Pull request"
        },
        checked_out.clone().unwrap_or_default(),
    ));
    tab = tab.children(form_box(w, &git));
    match (&git.forge, &git.status) {
        (None, _) | (Some(Forge { kind: None, .. }), _) => {
            let why = match &git.forge {
                _ if git.loading_forge => "Checking…".to_string(),
                Some(forge) => forge
                    .reason
                    .clone()
                    .unwrap_or_else(|| "No forge for this checkout.".into()),
                None => "No forge for this checkout.".into(),
            };
            tab = tab.child(note(why, "ink-2"));
        }
        (_, Some(status)) => tab = tab.child(request_card(w, status, cx)),
        (_, None) if git.loading_forge => tab = tab.child(note("Reading…", "ink-2")),
        (_, None) => tab = tab.child(no_request(w, &git, noun, checked_out.as_deref(), cx)),
    }
    // Others
    let others: Vec<&Request> = git
        .requests
        .iter()
        .filter(|r| Some(r.number) != git.status.as_ref().map(|s| s.request.number))
        .collect();
    if kind.is_some() && !others.is_empty() {
        tab = tab.child(heading(
            &format!("Other open {noun}s"),
            others.len().to_string(),
        ));
        tab = tab.children(others.into_iter().enumerate().map(|(i, request)| {
            let url = request.url.clone();
            let row = div()
                .id(("other-request", i))
                .px(px(16.))
                .py(px(5.))
                .flex()
                .gap(px(8.))
                .items_center()
                .text_size(px(13.))
                .child(
                    div()
                        .flex_shrink_0()
                        .font_family(theme::MONO)
                        .text_color(color(if request.state == git::RequestState::Draft {
                            "ink-2"
                        } else {
                            "live"
                        }))
                        .child(format!("#{}", request.number)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(request.title.clone()),
                )
                .children(glance(request.checks));
            match url {
                Some(url) => row
                    .control(format!("Open #{} on the forge", request.number))
                    .on_click(move |_, _, cx| cx.open_url(&url)),
                None => row,
            }
        }));
    }

    // Branches
    let local: Vec<&git::Branch> = overview.branches.iter().filter(|b| !b.remote).collect();
    let branches: Vec<&git::Branch> = if w.git_ui.more_branches {
        overview.branches.iter().collect()
    } else {
        local.iter().copied().take(BRANCHES_SHOWN).collect()
    };
    let hidden = if w.git_ui.more_branches {
        0
    } else {
        overview.branches.len() - branches.len()
    };
    tab = tab.child(heading("Branches", format!("{} local", local.len())));
    let shown_branch = git.branch.clone().or_else(|| overview.branch.clone());
    tab = tab.children(branches.into_iter().enumerate().map(|(i, branch)| {
        let active = shown_branch.as_deref() == Some(branch.name.as_str());
        let name = branch.name.clone();
        let current = overview.branch.as_deref() == Some(branch.name.as_str());
        div()
            .id(("branch", i))
            .control(format!("Show the history of {}", branch.name))
            .px(px(16.))
            .py(px(4.))
            .flex()
            .gap(px(8.))
            .when(active, |s| s.bg(color("sunk")))
            .font_family(theme::MONO)
            .text_size(px(12.5))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(color(if branch.remote { "ink-2" } else { "ink" }))
                    .child(format!(
                        "{}{}",
                        if branch.current { "* " } else { "  " },
                        branch.name
                    )),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .text_color(color(if branch.track() == "in sync" {
                        "ink-2"
                    } else {
                        "held"
                    }))
                    .child(branch.track()),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                let id = this.selected;
                // The checked-out branch follows it again rather than pinning it.
                this.source.read_git(id, (!current).then(|| name.clone()));
                cx.notify();
            }))
    }));
    if hidden > 0 || w.git_ui.more_branches {
        tab = tab.child(
            div().px(px(16.)).py(px(4.)).child(
                action(
                    "branches-more",
                    &if w.git_ui.more_branches {
                        "Show fewer branches".to_string()
                    } else {
                        format!(
                            "Show {hidden} more branch{}",
                            if hidden == 1 { "" } else { "es" }
                        )
                    },
                    "ink-2",
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.git_ui.more_branches = !this.git_ui.more_branches;
                    cx.notify();
                })),
            ),
        );
    }

    // History
    tab = tab.child(heading(
        "Commits",
        shown_branch.unwrap_or_else(|| "detached".into()),
    ));
    if overview.commits.is_empty() {
        tab = tab.child(note(
            if git.loading_git {
                "Reading…"
            } else {
                "No commits."
            },
            "ink-2",
        ));
    } else {
        let count = if w.git_ui.more_commits {
            overview.commits.len()
        } else {
            overview.commits.len().min(COMMITS_SHOWN)
        };
        tab = tab.children(
            overview.commits[..count]
                .iter()
                .enumerate()
                .map(|(i, commit)| commit_row(&git, commit, i, cx)),
        );
        if overview.commits.len() > COMMITS_SHOWN {
            tab = tab.child(
                div().px(px(16.)).py(px(4.)).child(
                    action(
                        "commits-more",
                        &if w.git_ui.more_commits {
                            "Show fewer commits".to_string()
                        } else {
                            format!("Show {} more commits", overview.commits.len() - count)
                        },
                        "ink-2",
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.git_ui.more_commits = !this.git_ui.more_commits;
                        cx.notify();
                    })),
                ),
            );
        }
    }
    tab.child(div().px(px(16.)).pt(px(10.)).child(
        action("git-refresh", "Refresh", "ink-2").on_click(cx.listener(|this, _, _, cx| {
            let id = this.selected;
            let branch = this.source.git(id).branch.clone();
            this.source.read_git(id, branch);
            cx.notify();
        })),
    ))
}

/// The checked-out branch has no request: where one would merge, and who opens it.
fn no_request(
    w: &Workspace,
    git: &Git,
    noun: &str,
    branch: Option<&str>,
    cx: &mut Context<Workspace>,
) -> Div {
    let choices = git
        .overview
        .as_ref()
        .map(|o| o.base_choices())
        .unwrap_or_default();
    let base = git::resolve_base(w.git_ui.base.as_deref(), &choices);
    let busy = git.busy.is_some();
    let picking = w.git_ui.picking_base && choices.len() > 1;
    let ask =
        |id: &'static str, label: String, tone: &str, draft: bool, cx: &mut Context<Workspace>| {
            let row = div()
                .id(id)
                .px(px(16.))
                .py(px(4.))
                .text_size(px(13.))
                .text_color(color(tone))
                .child(label);
            if busy {
                return row.opacity(0.45);
            }
            row.control(match id {
                "agent-draft" | "agent-ready" => "Sends the agent a message asking it to open it",
                _ => "Asks for a title, then opens it",
            })
            .on_click(cx.listener(move |this, _, window, cx| match id {
                "agent-draft" | "agent-ready" => this.agent_opens(draft, cx),
                _ => this.open_form(Form::Create { draft }, window, cx),
            }))
        };
    div()
        .flex()
        .flex_col()
        .child(note(
            format!("No {noun} for {}.", branch.unwrap_or("this checkout")),
            "ink-2",
        ))
        .child(
            div()
                .id("request-base")
                .px(px(16.))
                .py(px(4.))
                .flex()
                .gap(px(6.))
                .items_center()
                .text_size(px(13.))
                .child(div().text_color(color("ink-2")).child("Into"))
                .child(
                    div()
                        .font_family(theme::MONO)
                        .child(base.clone().unwrap_or_else(|| "the default branch".into())),
                )
                .when(choices.len() > 1, |s| {
                    s.child(ui::icon(
                        if picking {
                            "chevron-down"
                        } else {
                            "chevron-right"
                        },
                        "ink-2",
                    ))
                    .control("Where it merges")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.git_ui.picking_base = !this.git_ui.picking_base;
                        cx.notify();
                    }))
                }),
        )
        .children(picking.then(|| {
            div()
                .flex()
                .flex_col()
                .children(choices.iter().enumerate().map(|(i, choice)| {
                    let picked = base.as_deref() == Some(choice.as_str());
                    let choice = choice.clone();
                    div()
                        .id(("base", i))
                        .control(format!("Merge into {choice}"))
                        .pl(px(32.))
                        .pr(px(16.))
                        .py(px(4.))
                        .font_family(theme::MONO)
                        .text_size(px(12.5))
                        .when(picked, |s| s.bg(color("sunk")))
                        .child(format!("{} {choice}", if picked { "●" } else { " " }))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.git_ui.base = Some(choice.clone());
                            this.git_ui.picking_base = false;
                            cx.notify();
                        }))
                }))
        }))
        .child(ask(
            "agent-draft",
            format!("Have the agent open a draft {noun}"),
            "live",
            true,
            cx,
        ))
        .child(ask(
            "agent-ready",
            "Have the agent open it ready for review".into(),
            "ink",
            false,
            cx,
        ))
        .child(ask(
            "yourself-draft",
            format!("Open a draft {noun} yourself"),
            "ink-2",
            true,
            cx,
        ))
}

// -- one commit ---------------------------------------------------------------

/// The commit view's top row: back to the history, the sha, widen.
pub fn commit_header(commit: &OpenCommit, cx: &mut Context<Workspace>) -> Div {
    let sha = commit.sha.clone();
    let short: String = sha.chars().take(7).collect();
    div()
        .flex_shrink_0()
        .flex()
        .items_center()
        .gap(px(4.))
        .py(px(8.))
        .pl(px(10.))
        .pr(px(12.))
        .border_b_1()
        .border_color(color("rule"))
        .child(
            div()
                .id("commits-back")
                .control("Back to the commits")
                .h(px(28.))
                .px(px(6.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(6.))
                .text_size(px(13.))
                .text_color(color("ink-2"))
                .child(ui::icon("chevron-left", "ink-2"))
                .child("Commits")
                .on_click(cx.listener(|this, _, _, cx| {
                    let id = this.selected;
                    this.source.close_commit(id);
                    cx.notify();
                })),
        )
        .child(div().flex_1())
        .child(
            div()
                .id("copy-sha")
                .control("Copy the full sha")
                .h(px(28.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(6.))
                .font_family(theme::MONO)
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child(short)
                .child(ui::icon("copy", "ink-2"))
                .on_click(move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(sha.clone()))
                }),
        )
}

fn chip(label: String, token: &str) -> Div {
    div()
        .px(px(7.))
        .py(px(4.))
        .rounded(px(5.))
        .bg(color("sunk"))
        .font_family(theme::MONO)
        .text_size(px(11.5))
        .line_height(px(12.))
        .text_color(color(token))
        .child(label)
}

fn person(name: &str, what: &str, when: &str) -> Div {
    let initials: String = name
        .split_whitespace()
        .filter_map(|w| w.chars().next())
        .take(2)
        .collect();
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .text_size(px(13.))
        .child(
            div()
                .size(px(20.))
                .rounded_full()
                .bg(color("sunk"))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(8.5))
                .font_weight(FontWeight::BOLD)
                .text_color(color("ink-2"))
                .child(initials),
        )
        .child(name.to_string())
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child(format!("{what} {when}")),
        )
}

/// One commit, in full: message, people, CI, and its patch file by file.
pub fn commit_tab(w: &Workspace, commit: &OpenCommit, cx: &mut Context<Workspace>) -> Div {
    let Some(detail) = &commit.detail else {
        return div().px(px(16.)).py(px(16.)).child(note(
            if commit.loading {
                "Reading the commit…"
            } else {
                "Git could not read this commit."
            },
            "ink-2",
        ));
    };
    let now = now_ms();
    commit_body(w, commit, detail, now, cx)
}

fn commit_body(
    w: &Workspace,
    commit: &OpenCommit,
    detail: &CommitDetail,
    now: i64,
    cx: &mut Context<Workspace>,
) -> Div {
    let (added, removed) = detail.totals();
    let failing = commit.runs.as_ref().and_then(|runs| {
        runs.iter()
            .find(|run| run.state == RunState::Failed && run.url.is_some())
            .and_then(|run| run.url.clone())
    });
    let mut view = div().flex().flex_col().child(
        div()
            .pt(px(16.))
            .px(px(16.))
            .pb(px(4.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .text_size(px(16.))
                    .line_height(px(16. * 1.35))
                    .font_weight(FontWeight::BOLD)
                    .child(detail.subject.clone()),
            )
            .child(person(
                &detail.author,
                "authored",
                &git::ago(&detail.date, now),
            ))
            .when(detail.committer != detail.author, |s| {
                s.child(person(
                    &detail.committer,
                    "committed",
                    &git::ago(&detail.committer_date, now),
                ))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.))
                    .children(detail.refs.iter().map(|r| chip(r.clone(), "ink")))
                    .children((!detail.parents.is_empty()).then(|| {
                        chip(
                            format!(
                                "{} {}",
                                if detail.parents.len() == 1 {
                                    "parent"
                                } else {
                                    "parents"
                                },
                                detail
                                    .parents
                                    .iter()
                                    .map(|p| p.chars().take(7).collect::<String>())
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            ),
                            "ink-2",
                        )
                    })),
            )
            .when(!detail.body.is_empty(), |s| {
                s.child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(14. * 1.6))
                        .child(detail.body.clone()),
                )
            }),
    );
    if let Some(runs) = commit.runs.as_ref().filter(|runs| !runs.is_empty()) {
        view = view
            .child(heading(
                "Checks",
                Checks::tally(runs)
                    .glance()
                    .map(|(_, text)| text)
                    .unwrap_or_default(),
            ))
            .child(runs_list(runs, w.git_ui.more_runs, cx))
            .children(failing.map(|url| {
                div().px(px(16.)).pt(px(4.)).child(
                    action("failing-run", "Open the failing run", "ink-2")
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                )
            }));
    }
    view = view.child(
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .pt(px(14.))
            .px(px(16.))
            .pb(px(8.))
            .child(ui::caps("Files").flex_1())
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .font_family(theme::MONO)
                    .text_size(px(12.))
                    .text_color(color("ink-2"))
                    .child(format!("{} ·", detail.files.len()))
                    .child(crate::inspector::delta(&format!("+{added} −{removed}"))),
            ),
    );
    if detail.files.is_empty() {
        return view.child(note("No changes to show.", "ink-2"));
    }
    let scope = format!("commit-{}", detail.sha);
    view.children(detail.files.iter().enumerate().map(|(i, file)| {
        match detail.patch.iter().find(|p| p.path == file.path) {
            Some(patch) => patch_file(&scope, i, patch, cx, &w.git_ui.expanded),
            // A file the patch leaves out (binary, or too large for git to show).
            None => div().child(file_row(
                format!("{scope}-file-{i}").into(),
                &file.path,
                file.added,
                file.removed,
                false,
                cx,
                format!("{scope}:{}", file.path),
            )),
        }
    }))
    .child(div().h(px(18.)))
}

// -- the Diff tab -------------------------------------------------------------

fn pick_row(
    id: &'static str,
    index: usize,
    label: String,
    meta: String,
    open: bool,
    pick: Pick,
    cx: &mut Context<Workspace>,
) -> Stateful<Div> {
    div()
        .id((id, index))
        .control(format!("Show what {label} changed"))
        .px(px(16.))
        .py(px(7.))
        .flex()
        .gap(px(8.))
        .items_center()
        .when(open, |s| s.bg(color("sunk")))
        .text_size(px(13.))
        .child(ui::icon(
            if open {
                "chevron-down"
            } else {
                "chevron-right"
            },
            "ink-2",
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_weight(FontWeight::SEMIBOLD)
                .child(label),
        )
        .child(
            div()
                .flex_shrink_0()
                .font_family(theme::MONO)
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child(meta),
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            let id = this.selected;
            // Opening the open one closes it.
            let next = (this.diff_pick(id) != Some(pick)).then_some(pick);
            this.git_ui.picked.insert(id, next);
            this.sync_inspector();
            cx.notify();
        }))
}

fn patch_body(
    scope: &str,
    patch: Option<Patch>,
    empty: &str,
    w: &Workspace,
    cx: &mut Context<Workspace>,
) -> Div {
    match patch {
        None | Some(Patch::Loading) => div().child(note("Reading the diff…", "ink-2")),
        Some(Patch::Missing) => div().child(note(empty.to_string(), "ink-2")),
        Some(Patch::Failed(why)) => div().child(note(why, "broken")),
        Some(Patch::Ready(files)) if files.is_empty() => {
            div().child(note(empty.to_string(), "ink-2"))
        }
        Some(Patch::Ready(files)) => div().children(
            files
                .iter()
                .enumerate()
                .map(|(i, file)| patch_file(scope, i, file, cx, &w.git_ui.expanded)),
        ),
    }
}

pub fn diff_tab(w: &Workspace, cx: &mut Context<Workspace>) -> Div {
    let id = w.selected;
    let git = w.source.git(id);
    let turns: Vec<TurnDiff> = w.source.turn_diffs(id);
    let open = w.diff_pick(id);
    let mut tab = div().flex().flex_col().pb(px(18.));
    tab = tab.child(heading("Uncommitted", ""));
    let uncommitted = git
        .overview
        .as_ref()
        .and_then(|o| o.status.as_ref())
        .map(|s| s.line())
        .unwrap_or_default();
    tab = tab.child(pick_row(
        "pick-tree",
        0,
        "Working tree".into(),
        uncommitted,
        open == Some(Pick::Tree),
        Pick::Tree,
        cx,
    ));
    if open == Some(Pick::Tree) {
        tab = tab
            .child(patch_body(
                "tree",
                w.source.tree_patch(id),
                "Nothing is uncommitted.",
                w,
                cx,
            ))
            .child(
                note(
                    "Untracked files are not shown until they are added.",
                    "ink-2",
                )
                .text_size(px(11.5)),
            );
    }
    tab = tab.child(heading("Turns", turns.len().to_string()));
    if turns.is_empty() {
        return tab.child(note("No turn has changed files yet.", "ink-2"));
    }
    for (i, turn) in turns.iter().rev().enumerate() {
        let (added, removed) = turn.totals();
        let this = Pick::Turn(turn.turn);
        let is_open = open == Some(this);
        tab = tab.child(pick_row(
            "pick-turn",
            i,
            format!("Turn {}", turn.turn),
            format!(
                "{} file{} +{added} −{removed}",
                turn.files.len(),
                if turn.files.len() == 1 { "" } else { "s" }
            ),
            is_open,
            this,
            cx,
        ));
        if is_open {
            tab = tab.child(patch_body(
                &format!("turn-{}", turn.turn),
                w.source.turn_patch(id, turn.turn),
                "No diff is kept for this turn.",
                w,
                cx,
            ));
        }
    }
    tab.child(div().h(px(18.)))
}
