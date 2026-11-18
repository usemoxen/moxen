//! What the Git and Diff tabs show, as the Moxen server answers it: history
//! and branches (`git.overview`, `git.commit.detail`), the forge's pull
//! requests and CI (`forge.*`), and patches (`turnDiff`, `workspace.git`).
//! Everything here is plain data and the rules for reading it, the same ones
//! as the TUI's Git tab (`src/tui/features/gitpanel/`, `src/tui/model/gitpanel.ts`
//! and `patch.ts`); the server runs git and the forge's CLI, never this client.

use crate::live::{parse_iso_ms, text};
use serde_json::Value;
use std::collections::HashMap;

fn owned(value: &Value, key: &str) -> Option<String> {
    text(value, &[key]).map(str::to_string)
}

fn count(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

// -- CI -----------------------------------------------------------------------

/// CI counted by outcome; skipped runs count as passed, as the forges do.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Checks {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Passed,
    Failed,
    Pending,
}

impl Checks {
    fn from_json(value: &Value) -> Option<Self> {
        let at = |key| value.get(key).and_then(Value::as_u64).map(|n| n as u32);
        value.is_object().then(|| Self {
            passed: at("passed").unwrap_or(0),
            failed: at("failed").unwrap_or(0),
            pending: at("pending").unwrap_or(0),
        })
    }

    pub fn tally(runs: &[Run]) -> Self {
        let of = |states: &[RunState]| runs.iter().filter(|r| states.contains(&r.state)).count();
        Self {
            passed: of(&[RunState::Passed, RunState::Skipped]) as u32,
            failed: of(&[RunState::Failed]) as u32,
            pending: of(&[RunState::Pending]) as u32,
        }
    }

    /// CI in one glance: how many of the runs passed, and the tone. `None`
    /// when there are no runs.
    pub fn glance(&self) -> Option<(Tone, String)> {
        let total = self.passed + self.failed + self.pending;
        if total == 0 {
            return None;
        }
        let tone = if self.failed > 0 {
            Tone::Failed
        } else if self.pending > 0 {
            Tone::Pending
        } else {
            Tone::Passed
        };
        Some((tone, format!("{}/{total}", self.passed)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunState {
    Failed,
    Pending,
    Passed,
    Skipped,
}

/// One CI check of a request or a commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub name: String,
    pub state: RunState,
    pub url: Option<String>,
}

pub fn runs_of(value: &Value) -> Vec<Run> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|run| {
            Some(Run {
                name: owned(run, "name")?,
                state: match text(run, &["state"])? {
                    "failed" => RunState::Failed,
                    "pending" => RunState::Pending,
                    "skipped" => RunState::Skipped,
                    _ => RunState::Passed,
                },
                url: owned(run, "url"),
            })
        })
        .collect()
}

/// Runs with the failing ones first, so the reason a request is red is read first.
pub fn failures_first(runs: &[Run]) -> Vec<Run> {
    let mut sorted = runs.to_vec();
    sorted.sort_by_key(|run| match run.state {
        RunState::Failed => 0,
        RunState::Pending => 1,
        RunState::Passed => 2,
        RunState::Skipped => 3,
    });
    sorted
}

// -- the checkout -------------------------------------------------------------

/// What is uncommitted in the checkout.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Worktree {
    pub branch: Option<String>,
    pub staged: i64,
    pub unstaged: i64,
    pub untracked: i64,
    pub conflicted: i64,
}

impl Worktree {
    /// "2 staged · 1 changed", or "clean".
    pub fn line(&self) -> String {
        let parts: Vec<String> = [
            (self.staged, "staged"),
            (self.unstaged, "changed"),
            (self.untracked, "untracked"),
            (self.conflicted, "conflicted"),
        ]
        .into_iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, what)| format!("{n} {what}"))
        .collect();
        if parts.is_empty() {
            "clean".into()
        } else {
            parts.join(" · ")
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub ahead: Option<i64>,
    pub behind: Option<i64>,
}

impl Branch {
    /// How it stands against its upstream: "↑2 ↓1", "in sync", or nothing
    /// when it tracks none.
    pub fn track(&self) -> String {
        if self.ahead.is_none() && self.behind.is_none() {
            return String::new();
        }
        let (ahead, behind) = (self.ahead.unwrap_or(0), self.behind.unwrap_or(0));
        match (ahead, behind) {
            (0, 0) => "in sync".into(),
            (a, 0) => format!("↑{a}"),
            (0, b) => format!("↓{b}"),
            (a, b) => format!("↑{a} ↓{b}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub author: String,
    /// ISO 8601, the author date.
    pub date: String,
    pub subject: String,
    pub refs: Vec<String>,
}

impl Commit {
    fn from_json(value: &Value) -> Option<Self> {
        let sha = owned(value, "sha")?;
        Some(Self {
            short: owned(value, "shortSha").unwrap_or_else(|| sha.chars().take(7).collect()),
            sha,
            author: owned(value, "author").unwrap_or_default(),
            date: owned(value, "date").unwrap_or_default(),
            subject: owned(value, "subject").unwrap_or_default(),
            refs: strings(&value["refs"]),
        })
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::to_string))
        .collect()
}

/// The thread's checkout: status, branches and one branch's commits.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Overview {
    pub is_repository: bool,
    pub root: Option<String>,
    pub status: Option<Worktree>,
    pub branches: Vec<Branch>,
    pub commits: Vec<Commit>,
    /// The branch `commits` was read from.
    pub branch: Option<String>,
    pub default_branch: Option<String>,
}

impl Overview {
    pub fn from_json(value: &Value) -> Self {
        let status = value
            .get("status")
            .filter(|s| s.is_object())
            .map(|s| Worktree {
                branch: owned(s, "branch"),
                staged: count(s, "staged").unwrap_or(0),
                unstaged: count(s, "unstaged").unwrap_or(0),
                untracked: count(s, "untracked").unwrap_or(0),
                conflicted: count(s, "conflicted").unwrap_or(0),
            });
        Self {
            is_repository: value["isRepository"].as_bool().unwrap_or(false),
            root: owned(value, "root"),
            status,
            branches: value["branches"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|b| {
                    Some(Branch {
                        name: owned(b, "name")?,
                        current: b["current"].as_bool().unwrap_or(false),
                        remote: b["remote"].as_bool().unwrap_or(false),
                        ahead: count(b, "ahead"),
                        behind: count(b, "behind"),
                    })
                })
                .collect(),
            commits: value["commits"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Commit::from_json)
                .collect(),
            branch: owned(value, "branch"),
            default_branch: owned(value, "defaultBranch"),
        }
    }

    /// The branch the checkout is on: what the footer names.
    pub fn checked_out(&self) -> Option<&str> {
        self.status
            .as_ref()
            .and_then(|s| s.branch.as_deref())
            .or(self.branch.as_deref())
    }

    /// The branches a request can merge into: local ones other than the
    /// branch being proposed, the repository's default first.
    pub fn base_choices(&self) -> Vec<String> {
        let head = self.status.as_ref().and_then(|s| s.branch.as_deref());
        let mut names: Vec<String> = self
            .branches
            .iter()
            .filter(|b| !b.remote && Some(b.name.as_str()) != head)
            .map(|b| b.name.clone())
            .collect();
        if let Some(first) = &self.default_branch
            && let Some(at) = names.iter().position(|n| n == first)
        {
            let first = names.remove(at);
            names.insert(0, first);
        }
        names
    }
}

/// The base a request targets: the one picked while it is still a choice,
/// else the first choice.
pub fn resolve_base(picked: Option<&str>, choices: &[String]) -> Option<String> {
    picked
        .filter(|p| choices.iter().any(|c| c == p))
        .map(str::to_string)
        .or_else(|| choices.first().cloned())
}

// -- the forge ----------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForgeKind {
    GitHub,
    GitLab,
}

impl ForgeKind {
    /// "PR" on GitHub, "MR" on GitLab, and the long names.
    pub fn short(kind: Option<Self>) -> &'static str {
        if kind == Some(Self::GitLab) {
            "MR"
        } else {
            "PR"
        }
    }
    pub fn long(kind: Option<Self>) -> &'static str {
        if kind == Some(Self::GitLab) {
            "merge request"
        } else {
            "pull request"
        }
    }
}

/// Which forge the checkout belongs to, and whether it can be used.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Forge {
    pub kind: Option<ForgeKind>,
    pub slug: Option<String>,
    /// Why the forge is unusable, in one line.
    pub reason: Option<String>,
}

impl Forge {
    pub fn from_json(value: &Value) -> Self {
        Self {
            kind: match text(value, &["kind"]) {
                Some("github") => Some(ForgeKind::GitHub),
                Some("gitlab") => Some(ForgeKind::GitLab),
                _ => None,
            },
            slug: owned(value, "slug"),
            reason: owned(value, "reason"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestState {
    Open,
    Draft,
    Merged,
    Closed,
}

impl RequestState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Open => "Open",
            Self::Draft => "Draft",
            Self::Merged => "Merged",
            Self::Closed => "Closed",
        }
    }
    /// A request can still be commented on and merged.
    pub fn active(self) -> bool {
        matches!(self, Self::Open | Self::Draft)
    }
}

/// One pull request or merge request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub number: i64,
    pub title: String,
    pub state: RequestState,
    pub url: Option<String>,
    pub target: Option<String>,
    pub review: Option<String>,
    pub checks: Option<Checks>,
}

impl Request {
    fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            number: value.get("number")?.as_i64()?,
            title: owned(value, "title").unwrap_or_default(),
            state: match text(value, &["state"]) {
                Some("draft") => RequestState::Draft,
                Some("merged") => RequestState::Merged,
                Some("closed") => RequestState::Closed,
                _ => RequestState::Open,
            },
            url: owned(value, "url"),
            target: owned(value, "targetBranch"),
            review: owned(value, "reviewDecision"),
            checks: Checks::from_json(&value["checks"]),
        })
    }

    /// The review's outcome as the TUI words it.
    pub fn review_label(&self) -> Option<(&'static str, Tone)> {
        match self.review.as_deref()? {
            "APPROVED" => Some(("Approved", Tone::Passed)),
            "CHANGES_REQUESTED" => Some(("Changes requested", Tone::Failed)),
            "REVIEW_REQUIRED" => Some(("Review required", Tone::Pending)),
            _ => None,
        }
    }
}

pub fn requests_of(value: &Value) -> Vec<Request> {
    value["requests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Request::from_json)
        .collect()
}

/// The request the checked-out branch has, with its CI and mergeability.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestStatus {
    pub request: Request,
    pub runs: Vec<Run>,
    pub conflicting: bool,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub files: Option<i64>,
}

impl RequestStatus {
    pub fn from_json(value: &Value) -> Option<Self> {
        let request = Request::from_json(value.get("request")?)?;
        let body = &value["request"];
        Some(Self {
            runs: runs_of(&body["runs"]),
            conflicting: text(body, &["mergeable"]) == Some("conflicting"),
            additions: count(body, "additions"),
            deletions: count(body, "deletions"),
            files: count(body, "changedFiles"),
            request,
        })
    }

    /// The rollup, else a count of the named runs.
    pub fn checks(&self) -> Option<Checks> {
        self.request
            .checks
            .or_else(|| (!self.runs.is_empty()).then(|| Checks::tally(&self.runs)))
    }
}

/// CI tallies for a branch's commits, by sha.
pub fn commit_checks_of(value: &Value) -> HashMap<String, Checks> {
    value["checks"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(sha, checks)| Some((sha.clone(), Checks::from_json(checks)?)))
        .collect()
}

// -- patches ------------------------------------------------------------------

/// One line of a patch as it is drawn: both line numbers, the sign and the text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub old: String,
    pub new: String,
    /// `+`, `-`, a space, or `@` for a hunk header.
    pub sign: char,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchFile {
    pub path: String,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
    pub lines: Vec<DiffLine>,
}

fn header_path(line: &str) -> Option<String> {
    // `diff --git a/<path> b/<path>`; the b side is the file's new name.
    let rest = line.strip_prefix("diff --git a/")?;
    let at = rest.rfind(" b/")?;
    Some(rest[at + 3..].to_string())
}

/// `@@ -12,3 +14,4 @@ ...`: the first old and new line numbers.
fn hunk_start(line: &str) -> Option<(i64, i64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let first = |range: &str| range.split(',').next()?.parse().ok();
    Some((first(old)?, first(new)?))
}

/// Splits a git patch into its files, with line numbers worked out.
pub fn parse_patch(patch: &str) -> Vec<PatchFile> {
    let mut files: Vec<PatchFile> = vec![];
    let (mut old, mut new) = (0i64, 0i64);
    let mut in_hunk = false;
    for line in patch.lines() {
        if let Some(path) = header_path(line) {
            files.push(PatchFile {
                path,
                additions: 0,
                deletions: 0,
                binary: false,
                lines: vec![],
            });
            in_hunk = false;
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        if line.starts_with("Binary files ") {
            file.binary = true;
        } else if let Some((o, n)) = hunk_start(line) {
            (old, new, in_hunk) = (o, n, true);
            file.lines.push(DiffLine {
                old: String::new(),
                new: String::new(),
                sign: '@',
                text: line.to_string(),
            });
        } else if in_hunk {
            let (sign, text) = match line.chars().next() {
                Some(sign @ ('+' | '-' | ' ')) => (sign, &line[1..]),
                // "\ No newline at end of file" and the like.
                Some('\\') | None => continue,
                Some(_) => (' ', line),
            };
            let number = |n: &mut i64| {
                let shown = n.to_string();
                *n += 1;
                shown
            };
            let (shown_old, shown_new) = match sign {
                '+' => {
                    file.additions += 1;
                    (String::new(), number(&mut new))
                }
                '-' => {
                    file.deletions += 1;
                    (number(&mut old), String::new())
                }
                _ => (number(&mut old), number(&mut new)),
            };
            file.lines.push(DiffLine {
                old: shown_old,
                new: shown_new,
                sign,
                text: text.to_string(),
            });
        }
    }
    files
}

// -- one commit ---------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitFile {
    pub path: String,
    /// `None` for a binary file.
    pub added: Option<i64>,
    pub removed: Option<i64>,
}

/// One commit in full.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitDetail {
    pub sha: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub date: String,
    pub committer: String,
    pub committer_date: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub files: Vec<CommitFile>,
    pub patch: Vec<PatchFile>,
}

impl CommitDetail {
    /// `None` when git could not read the commit.
    pub fn from_json(value: &Value) -> Option<Self> {
        let commit = value.get("commit").filter(|c| c.is_object())?;
        Some(Self {
            sha: owned(commit, "sha")?,
            subject: owned(commit, "subject").unwrap_or_default(),
            body: owned(commit, "body").unwrap_or_default(),
            author: owned(commit, "author").unwrap_or_default(),
            date: owned(commit, "date").unwrap_or_default(),
            committer: owned(commit, "committer").unwrap_or_default(),
            committer_date: owned(commit, "committerDate").unwrap_or_default(),
            parents: strings(&commit["parents"]),
            refs: strings(&commit["refs"]),
            files: commit["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| {
                    Some(CommitFile {
                        path: owned(f, "path")?,
                        added: count(f, "added"),
                        removed: count(f, "removed"),
                    })
                })
                .collect(),
            patch: commit["diff"].as_str().map(parse_patch).unwrap_or_default(),
        })
    }

    /// Lines added and removed over the commit's files.
    pub fn totals(&self) -> (i64, i64) {
        self.files.iter().fold((0, 0), |(a, r), f| {
            (a + f.added.unwrap_or(0), r + f.removed.unwrap_or(0))
        })
    }
}

/// The commit open in the Git tab: its record, then its CI once the forge answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenCommit {
    pub sha: String,
    /// `None` while reading, or when git could not read it.
    pub detail: Option<CommitDetail>,
    pub loading: bool,
    pub runs: Option<Vec<Run>>,
}

// -- the tab's whole state ----------------------------------------------------

/// Everything the Git tab shows for one thread.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Git {
    pub overview: Option<Overview>,
    pub forge: Option<Forge>,
    /// Open requests.
    pub requests: Vec<Request>,
    /// The checked-out branch's own request.
    pub status: Option<RequestStatus>,
    pub commit_checks: HashMap<String, Checks>,
    pub commit: Option<OpenCommit>,
    pub loading_git: bool,
    pub loading_forge: bool,
    pub error: Option<String>,
    /// A write in flight, named for the line that says so.
    pub busy: Option<&'static str>,
    /// What the last write did, until the next.
    pub notice: Option<String>,
    /// The branch history is read for; `None` follows the checked-out one.
    pub branch: Option<String>,
}

/// One turn's changes, from the thread's checkpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnDiff {
    /// 1-based, as `turnDiff` reads it.
    pub turn: i64,
    pub files: Vec<(String, i64, i64)>,
}

impl TurnDiff {
    pub fn totals(&self) -> (i64, i64) {
        self.files
            .iter()
            .fold((0, 0), |(a, d), (_, add, del)| (a + add, d + del))
    }
}

/// The turns of a thread's snapshot that changed files, oldest first.
pub fn turn_diffs_of(thread: &Value) -> Vec<TurnDiff> {
    let mut turns: Vec<TurnDiff> = thread["checkpoints"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|checkpoint| {
            let files: Vec<(String, i64, i64)> = checkpoint["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| {
                    Some((
                        owned(f, "path")?,
                        count(f, "additions").unwrap_or(0),
                        count(f, "deletions").unwrap_or(0),
                    ))
                })
                .collect();
            (!files.is_empty()).then(|| TurnDiff {
                turn: checkpoint["checkpointTurnCount"].as_i64().unwrap_or(0),
                files,
            })
        })
        .filter(|turn| turn.turn > 0)
        .collect();
    turns.sort_by_key(|turn| turn.turn);
    turns
}

/// A patch the server is asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Patch {
    Loading,
    /// Nothing to show: no checkpoint, or nothing changed.
    Missing,
    /// The server could not produce it; the text says why.
    Failed(String),
    Ready(Vec<PatchFile>),
}

// -- words --------------------------------------------------------------------

/// "3 minutes ago", "yesterday", "2 months ago": how GitHub words an age.
pub fn ago(iso: &str, now_ms: i64) -> String {
    let Some(at) = parse_iso_ms(iso) else {
        return String::new();
    };
    let seconds = ((now_ms - at) / 1000).max(0);
    let unit = |n: i64, name: &str| format!("{n} {name}{} ago", if n == 1 { "" } else { "s" });
    if seconds < 60 {
        return "just now".into();
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return unit(minutes, "minute");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return unit(hours, "hour");
    }
    let days = hours / 24;
    if days == 1 {
        return "yesterday".into();
    }
    if days < 30 {
        return unit(days, "day");
    }
    let months = days / 30;
    if months < 12 {
        return unit(months, "month");
    }
    unit(days / 365, "year")
}

/// The instructions an agent gets to open the request, word for word what the
/// TUI sends (`openRequestPrompt`), so either client's transcript reads it as
/// the same ask. The thread's own agent knows the work; `cold` is for one that
/// starts without it.
pub fn open_request_prompt(
    kind: Option<ForgeKind>,
    draft: bool,
    branch: Option<&str>,
    base: Option<&str>,
    cold: bool,
) -> String {
    let long = ForgeKind::long(kind);
    let short = ForgeKind::short(kind);
    let gitlab = kind == Some(ForgeKind::GitLab);
    let base_flag = match base {
        None => String::new(),
        Some(base) if gitlab => format!(" --target-branch {base}"),
        Some(base) => format!(" --base {base}"),
    };
    let cli = format!(
        "{}{base_flag}",
        if gitlab {
            "glab mr create"
        } else {
            "gh pr create"
        }
    );
    let draft_flag = if draft { " --draft" } else { "" };
    let branch = branch.map_or("the current branch".to_string(), |b| format!("`{b}`"));
    let into = base.map_or(String::new(), |b| format!(" into `{b}`"));
    let lines = [
        format!(
            "Open a {}{long} for {branch}{into}.",
            if draft { "draft " } else { "" }
        ),
        String::new(),
        if cold {
            "You are picking this up without the conversation that did the work. First read what the branch holds: `git status`, `git log` and `git diff` against the base branch it will merge into.".into()
        } else {
            "Use what you know from this thread about what was done and why.".into()
        },
        "1. If there are uncommitted changes that belong to this work, commit them with a clear message. Leave anything unrelated alone.".into(),
        "2. Push the branch (set its upstream if it has none).".into(),
        format!("3. Open it with `{cli}{draft_flag}`: a short, specific title, and a description covering what changed, why, and how it was verified."),
        format!("4. Reply with the {short}'s URL."),
        String::new(),
        format!("If a {short} for this branch already exists, do not open another; say so and give its URL."),
    ];
    lines.join("\n")
}

/// What an `open_request_prompt` asked for, in a line, when `text` is exactly
/// one (the same exact-match rule as the TUI's `readOpenRequestPrompt`: a
/// message of the person's own that merely starts the same way stays theirs).
pub fn open_request_summary(text: &str) -> Option<String> {
    let head = text.strip_prefix("Open a ")?.lines().next()?;
    let (draft, rest) = match head.strip_prefix("draft ") {
        Some(rest) => (true, rest),
        None => (false, head),
    };
    let (kind, rest) = if let Some(rest) = rest.strip_prefix("pull request for ") {
        (ForgeKind::GitHub, rest)
    } else {
        (ForgeKind::GitLab, rest.strip_prefix("merge request for ")?)
    };
    let rest = rest.strip_suffix('.')?;
    let (branch, base) = match rest.split_once(" into ") {
        Some((branch, base)) => (branch, Some(base)),
        None => (rest, None),
    };
    let unquote = |name: &str| {
        name.strip_prefix('`')?
            .strip_suffix('`')
            .map(str::to_string)
    };
    let branch = if branch == "the current branch" {
        None
    } else {
        Some(unquote(branch)?)
    };
    let base = match base {
        Some(base) => Some(unquote(base)?),
        None => None,
    };
    [false, true]
        .into_iter()
        .any(|cold| {
            open_request_prompt(Some(kind), draft, branch.as_deref(), base.as_deref(), cold) == text
        })
        .then(|| {
            format!(
                "Asked the agent to open a {}{}{}{}.",
                if draft { "draft " } else { "" },
                ForgeKind::long(Some(kind)),
                branch.map_or(String::new(), |b| format!(" for {b}")),
                base.map_or(String::new(), |b| format!(" into {b}")),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ci_reads_as_one_glance() {
        let glance = |passed, failed, pending| {
            Checks {
                passed,
                failed,
                pending,
            }
            .glance()
        };
        assert_eq!(glance(0, 0, 0), None);
        assert_eq!(glance(18, 0, 0), Some((Tone::Passed, "18/18".into())));
        assert_eq!(glance(16, 2, 0), Some((Tone::Failed, "16/18".into())));
        assert_eq!(glance(15, 0, 3), Some((Tone::Pending, "15/18".into())));
        // Failing wins over pending, and skipped runs count as passed.
        assert_eq!(glance(1, 1, 1).unwrap().0, Tone::Failed);
        let runs = runs_of(&json!([
            {"name": "a", "state": "skipped", "url": null},
            {"name": "b", "state": "failed", "url": "u"},
            {"name": "c", "state": "pending", "url": null},
        ]));
        assert_eq!(
            Checks::tally(&runs),
            Checks {
                passed: 1,
                failed: 1,
                pending: 1
            }
        );
        assert_eq!(failures_first(&runs)[0].name, "b");
    }

    fn overview() -> Overview {
        Overview::from_json(&json!({
            "isRepository": true,
            "root": "/work/moxen",
            "status": {"branch": "feature", "staged": 1, "unstaged": 2, "untracked": 0, "conflicted": 0},
            "branches": [
                {"name": "feature", "current": true, "remote": false, "ahead": 2, "behind": 0},
                {"name": "dev", "current": false, "remote": false, "ahead": null, "behind": null},
                {"name": "main", "current": false, "remote": false, "ahead": 0, "behind": 0},
                {"name": "origin/main", "current": false, "remote": true, "ahead": null, "behind": null}
            ],
            "commits": [{"sha": "abcdef0123", "shortSha": "abcdef0", "author": "A", "date": "2026-11-16T10:00:00Z",
                         "subject": "Fix", "refs": ["HEAD -> feature"]}],
            "branch": "feature",
            "defaultBranch": "main"
        }))
    }

    #[test]
    fn the_overview_reads_status_branches_and_base_choices() {
        let overview = overview();
        assert_eq!(overview.checked_out(), Some("feature"));
        assert_eq!(
            overview.status.as_ref().unwrap().line(),
            "1 staged · 2 changed"
        );
        assert_eq!(overview.branches[0].track(), "↑2");
        assert_eq!(overview.branches[1].track(), "");
        assert_eq!(overview.branches[2].track(), "in sync");
        // The default first, the branch being proposed and remotes left out.
        assert_eq!(overview.base_choices(), vec!["main", "dev"]);
        let choices = overview.base_choices();
        assert_eq!(resolve_base(Some("dev"), &choices).as_deref(), Some("dev"));
        assert_eq!(
            resolve_base(Some("gone"), &choices).as_deref(),
            Some("main")
        );
        assert_eq!(resolve_base(None, &[]), None);
        assert_eq!(
            Worktree::default().line(),
            "clean",
            "nothing uncommitted reads as clean"
        );
    }

    #[test]
    fn a_request_status_carries_its_ci_and_mergeability() {
        let status = RequestStatus::from_json(&json!({"request": {
            "number": 7, "title": "Add it", "state": "draft", "url": "https://x/7",
            "targetBranch": "main", "reviewDecision": "CHANGES_REQUESTED", "checks": null,
            "runs": [{"name": "build", "state": "failed", "url": "https://x/run"},
                     {"name": "lint", "state": "passed", "url": null}],
            "mergeable": "conflicting", "additions": 10, "deletions": 2, "changedFiles": 3
        }}))
        .expect("status");
        assert_eq!(status.request.state, RequestState::Draft);
        assert!(status.conflicting);
        assert_eq!(
            status.request.review_label().unwrap().0,
            "Changes requested"
        );
        // No rollup: the named runs are counted.
        assert_eq!(status.checks().unwrap().glance().unwrap().1, "1/2");
        assert_eq!(RequestStatus::from_json(&json!({"request": null})), None);
        let listed = requests_of(&json!({"requests": [
            {"number": 1, "title": "t", "state": "open", "checks": {"passed": 2, "failed": 0, "pending": 0}},
            {"title": "no number"}
        ]}));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].checks.unwrap().passed, 2);
    }

    const PATCH: &str = "diff --git a/src/a.rs b/src/a.rs\nindex 1..2 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -3,3 +3,4 @@ fn x\n keep\n-old\n+new\n+added\n tail\n\\ No newline at end of file\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";

    #[test]
    fn a_patch_splits_by_file_and_numbers_its_lines() {
        let files = parse_patch(PATCH);
        assert_eq!(files.len(), 2);
        let a = &files[0];
        assert_eq!(
            (a.path.as_str(), a.additions, a.deletions),
            ("src/a.rs", 2, 1)
        );
        let shown: Vec<(&str, &str, char)> = a
            .lines
            .iter()
            .map(|l| (l.old.as_str(), l.new.as_str(), l.sign))
            .collect();
        assert_eq!(
            shown,
            vec![
                ("", "", '@'),
                ("3", "3", ' '),
                ("4", "", '-'),
                ("", "4", '+'),
                ("", "5", '+'),
                ("5", "6", ' '),
            ]
        );
        assert!(files[1].binary && files[1].lines.is_empty());
        assert!(parse_patch("").is_empty());
    }

    #[test]
    fn a_commit_reads_with_its_files_and_patch() {
        let detail = CommitDetail::from_json(&json!({"commit": {
            "sha": "abc", "subject": "S", "body": "B", "author": "A", "date": "d",
            "committer": "C", "committerDate": "e", "parents": ["p1"], "refs": [],
            "files": [{"path": "src/a.rs", "added": 2, "removed": 1}, {"path": "img.png", "added": null, "removed": null}],
            "diff": PATCH
        }}))
        .expect("detail");
        assert_eq!(detail.totals(), (2, 1));
        assert_eq!(detail.patch.len(), 2);
        assert_eq!(CommitDetail::from_json(&json!({"commit": null})), None);
    }

    #[test]
    fn turns_that_changed_files_are_listed_oldest_first() {
        let turns = turn_diffs_of(&json!({"checkpoints": [
            {"turnId": "b", "checkpointTurnCount": 2, "files": [{"path": "x", "additions": 3, "deletions": 1}]},
            {"turnId": "a", "checkpointTurnCount": 1, "files": []},
            {"turnId": "c", "checkpointTurnCount": 3, "files": [{"path": "y", "additions": 1, "deletions": 0},
                                                              {"path": "z", "additions": 2, "deletions": 2}]},
        ]}));
        assert_eq!(turns.iter().map(|t| t.turn).collect::<Vec<_>>(), vec![2, 3]);
        assert_eq!(turns[1].totals(), (3, 2));
    }

    #[test]
    fn ages_read_like_github() {
        let now = parse_iso_ms("2026-11-17T12:00:00Z").unwrap();
        let at = |iso: &str| ago(iso, now);
        assert_eq!(at("2026-11-17T11:59:30Z"), "just now");
        assert_eq!(at("2026-11-17T11:59:00Z"), "1 minute ago");
        assert_eq!(at("2026-11-17T09:00:00Z"), "3 hours ago");
        assert_eq!(at("2026-11-16T09:00:00Z"), "yesterday");
        assert_eq!(at("2026-11-07T12:00:00Z"), "10 days ago");
        assert_eq!(at("2026-08-17T12:00:00Z"), "3 months ago");
        assert_eq!(at("not a date"), "");
    }

    #[test]
    fn the_agent_is_asked_to_open_the_request_as_the_tui_asks() {
        let prompt = open_request_prompt(
            Some(ForgeKind::GitHub),
            true,
            Some("feature"),
            Some("main"),
            false,
        );
        assert!(prompt.starts_with(
            "Open a draft pull request for `feature` into `main`.\n\nUse what you know"
        ));
        assert!(prompt.contains("`gh pr create --base main --draft`"));
        assert!(prompt.ends_with("do not open another; say so and give its URL."));
        let lab = open_request_prompt(Some(ForgeKind::GitLab), false, None, Some("dev"), true);
        assert!(lab.starts_with("Open a merge request for the current branch into `dev`.\n"));
        assert!(lab.contains("`glab mr create --target-branch dev`"));
        assert!(lab.contains("You are picking this up without the conversation"));
        assert!(lab.contains("Reply with the MR's URL."));
    }

    #[test]
    fn only_the_exact_ask_reads_back_as_a_summary() {
        let ask = open_request_prompt(
            Some(ForgeKind::GitHub),
            true,
            Some("feature"),
            Some("main"),
            false,
        );
        assert_eq!(
            open_request_summary(&ask).as_deref(),
            Some("Asked the agent to open a draft pull request for feature into main.")
        );
        let cold = open_request_prompt(Some(ForgeKind::GitLab), false, None, None, true);
        assert_eq!(
            open_request_summary(&cold).as_deref(),
            Some("Asked the agent to open a merge request.")
        );
        // A message of the person's own that starts the same way stays theirs.
        assert_eq!(
            open_request_summary(
                "Open a pull request for `feature` into `main`.\nand also fix the tests"
            ),
            None
        );
        assert_eq!(open_request_summary("hello"), None);
    }
}
