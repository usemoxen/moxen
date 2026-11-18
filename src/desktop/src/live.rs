//! The live `ThreadSource`: the user's real projects and threads, from the
//! Moxen server's shell subscription. It holds the latest snapshot behind a
//! mutex and wakes the window by bumping a revision, so the connection thread
//! never touches the UI.
//!
//! Which threads are listed, how they nest and how their status reads follow
//! the TUI's sidebar (`src/tui/model/sidebar.ts`, `shell.ts`). A thread keeps
//! the same `ThreadId` for as long as this source lives, even after the server
//! stops listing it, because the window keys per-thread state by it.

use crate::{
    attachments::{self, Asset, Picture, Prompt},
    catalog::{Catalog, OptionValue, is_effort},
    composer_menu::{Destination, Improvement, Inventory},
    experience::{self, Fix, Memory, Record, Update},
    git::{self, CommitDetail, Forge, Git, OpenCommit, Overview, Patch, RequestStatus, TurnDiff},
    model::{
        Answer, Ask, CatalogState, Connection, Decision, Delivery, Embeddings, HarnessRun,
        ManagedSkill, MemoryDraft, MemoryEntry, MemoryList, MemorySearch, MergeStrategy, Message,
        NewRequest, NewThread, Permission, Problem, Project, QueueEdit, Queued, RemoteState, Reply,
        Selection, SettingsNotice, SideAnswer, Snapshot, Status, Thread, ThreadAction, ThreadId,
        ThreadSource, UpdateState,
    },
    pending,
    settings::{self, Discovery},
    transcript::{self, Row},
    wire::{Wire, WireError},
    work::{self, Background, Delegated, Delegation, InspectorData, Read, View},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// How long a refused answer waits before it checks the request is still open.
const REFUSAL_GRACE: Duration = Duration::from_millis(800);

/// One live thread as the sidebar orders it.
#[derive(Clone, Debug)]
pub struct Entry {
    pub id: ThreadId,
    pub uuid: String,
    pub parent: Option<String>,
    pub project: String,
    /// Newest user turn or finished turn: what the sidebar sorts by.
    pub sort_ms: i64,
    pub created_ms: i64,
    pub settled: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Arranged {
    pub flat: Vec<ThreadId>,
    pub grouped: Vec<ThreadId>,
    /// 1 for a delegated task shown under its parent.
    pub depth: HashMap<ThreadId, usize>,
    sections: HashMap<ThreadId, bool>,
}

/// The top-level ancestor a task nests under: a parent listed in the same
/// project, so a project's threads stay together however the list is grouped.
fn root_of<'a>(entry: &Entry, by_uuid: &HashMap<&'a str, &'a Entry>) -> Option<&'a str> {
    let listed = |p: &&str| by_uuid.get(p).is_some_and(|e| e.project == entry.project);
    let mut seen: HashSet<&str> = HashSet::from([entry.uuid.as_str()]);
    let mut top = None;
    let mut up = entry.parent.as_deref().filter(listed);
    while let Some(parent) = up {
        let parent: &'a str = by_uuid.get_key_value(parent)?.0;
        if !seen.insert(parent) {
            break;
        }
        top = Some(parent);
        up = by_uuid[parent].parent.as_deref().filter(listed);
    }
    top
}

/// Newest first, each delegated task right under its parent (oldest task
/// first), one level deep. A task whose parent is not in `entries` stays at
/// the top level.
fn nest(entries: &[&Entry]) -> Vec<(ThreadId, usize)> {
    let mut sorted: Vec<&Entry> = entries.to_vec();
    sorted.sort_by_key(|e| std::cmp::Reverse(e.sort_ms));
    let by_uuid: HashMap<&str, &Entry> = sorted.iter().map(|e| (e.uuid.as_str(), *e)).collect();
    let mut children: HashMap<&str, Vec<&Entry>> = HashMap::new();
    let mut tops: Vec<&Entry> = vec![];
    for entry in &sorted {
        match root_of(entry, &by_uuid) {
            Some(root) => children.entry(root).or_default().push(entry),
            None => tops.push(entry),
        }
    }
    let mut out = vec![];
    for top in tops {
        out.push((top.id, 0));
        let mut kids = children.remove(top.uuid.as_str()).unwrap_or_default();
        kids.sort_by_key(|e| e.created_ms);
        out.extend(kids.into_iter().map(|kid| (kid.id, 1)));
    }
    out
}

/// The sidebar order: active threads, then settled ones (flat); or per
/// project, projects with live work first, newest first.
pub fn arrange(entries: &[Entry]) -> Arranged {
    let mut arranged = Arranged::default();
    let by_uuid: HashMap<_, _> = entries.iter().map(|e| (e.uuid.as_str(), e)).collect();
    let mut anchors = HashSet::new();
    for entry in entries.iter().filter(|entry| !entry.settled) {
        let mut parent = entry.parent.as_deref();
        let mut seen = HashSet::from([entry.uuid.as_str()]);
        while let Some(up) = parent.and_then(|id| by_uuid.get(id)) {
            if !seen.insert(up.uuid.as_str()) {
                break;
            }
            if up.settled {
                anchors.insert(up.id);
            }
            parent = up.parent.as_deref();
        }
    }
    for entry in entries {
        let settled = entry.settled && !anchors.contains(&entry.id);
        let parent_live = entry
            .parent
            .as_deref()
            .and_then(|id| by_uuid.get(id))
            .is_some_and(|parent| !parent.settled || anchors.contains(&parent.id));
        // Put away a settled task until its parent settles. A settled parent
        // with live tasks remains as the header of their active family.
        if !settled || !parent_live {
            arranged.sections.insert(entry.id, settled);
        }
    }
    let in_section = |entry: &Entry, settled| arranged.sections.get(&entry.id) == Some(&settled);
    let flat_of = |settled: bool| -> Vec<(ThreadId, usize)> {
        nest(
            &entries
                .iter()
                .filter(|e| in_section(e, settled))
                .collect::<Vec<_>>(),
        )
    };
    for (id, depth) in flat_of(false).into_iter().chain(flat_of(true)) {
        arranged.flat.push(id);
        arranged.depth.insert(id, depth);
    }
    let mut projects: Vec<&str> = vec![];
    for entry in entries {
        if !projects.contains(&entry.project.as_str()) {
            projects.push(&entry.project);
        }
    }
    let newest = |project: &str, settled: bool| {
        entries
            .iter()
            .filter(|e| e.project == project && in_section(e, settled))
            .map(|e| e.sort_ms)
            .max()
    };
    projects.sort_by_key(|project| {
        // Live work first, then the newest turn; the sort is stable, so ties
        // keep the order the server listed them in.
        let live = newest(project, false);
        (
            live.is_none(),
            std::cmp::Reverse(live.or(newest(project, true))),
        )
    });
    for project in projects {
        for settled in [false, true] {
            let of_project: Vec<&Entry> = entries
                .iter()
                .filter(|e| e.project == project && in_section(e, settled))
                .collect();
            arranged
                .grouped
                .extend(nest(&of_project).into_iter().map(|(id, _)| id));
        }
    }
    for entry in entries
        .iter()
        .filter(|entry| !arranged.sections.contains_key(&entry.id))
    {
        // Still selectable in the jump palette and from its parent's inspector.
        arranged.flat.push(entry.id);
        arranged.grouped.push(entry.id);
    }
    arranged
}

// -- time ---------------------------------------------------------------------

/// Milliseconds since the Unix epoch of an ISO-8601 instant such as
/// `2026-11-16T14:22:09.406Z` (what the server writes); an offset is honoured.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let (date, time) = text.split_once('T')?;
    let mut d = date.split('-');
    let (year, month, day): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let (clock, offset) = match time.find(['Z', '+', '-']) {
        Some(at) => (&time[..at], &time[at..]),
        None => (time, "Z"),
    };
    let mut c = clock.split(':');
    let hour: i64 = c.next()?.parse().ok()?;
    let minute: i64 = c.next()?.parse().ok()?;
    let seconds = c.next().unwrap_or("0");
    let (whole, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    let whole: i64 = whole.parse().ok()?;
    let millis: i64 = format!("{fraction:0<3}")[..3].parse().ok()?;
    let offset_minutes = match offset.chars().next()? {
        'Z' => 0,
        sign @ ('+' | '-') => {
            let (h, m) = offset[1..].split_once(':')?;
            let total = h.parse::<i64>().ok()? * 60 + m.parse::<i64>().ok()?;
            if sign == '+' { total } else { -total }
        }
        _ => return None,
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hour) * 60 + minute - offset_minutes) * 60_000 + whole * 1000 + millis)
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// `45s`, `12m`, `3h`, `4d`: the sidebar's age column (`relativeAge`).
pub fn relative_age(now: i64, then: i64) -> String {
    let seconds = ((now - then).max(0) + 500) / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = (seconds + 30) / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = (minutes + 30) / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    format!("{}d", (hours + 12) / 24)
}

/// A project chip's two letters (`projectBadge`): the first character plus the
/// first later digit, or else the last character.
pub fn project_badge(title: &str) -> String {
    let compact: Vec<char> = title.chars().filter(char::is_ascii_alphanumeric).collect();
    let Some(&first) = compact.first() else {
        return "??".into();
    };
    let second = compact[1..]
        .iter()
        .copied()
        .find(char::is_ascii_digit)
        .or(compact.last().copied())
        .unwrap_or(first);
    format!("{first}{second}").to_uppercase()
}

// -- reading a snapshot -------------------------------------------------------

pub(crate) fn text<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut at = value;
    for key in path {
        at = at.get(key)?;
    }
    at.as_str()
}

pub(crate) fn ms(value: &Value, path: &[&str]) -> Option<i64> {
    text(value, path).and_then(parse_iso_ms)
}

/// Mirrors `isSettledThread`: sticky settlement, reopened by a later
/// `unsettledAt` or an `active` override.
fn is_settled(thread: &Value) -> bool {
    match text(thread, &["settledOverride"]) {
        Some("settled") => return true,
        Some("active") => return false,
        _ => {}
    }
    let Some(settled) = text(thread, &["settledAt"]) else {
        return false;
    };
    match text(thread, &["unsettledAt"]) {
        None => true,
        Some(unsettled) => parse_iso_ms(settled) >= parse_iso_ms(unsettled),
    }
}

fn status_of(thread: &Value) -> Status {
    let session = text(thread, &["session", "status"]);
    if matches!(session, Some("running" | "starting")) {
        return Status::Running;
    }
    let flag = |key| thread.get(key).and_then(Value::as_bool) == Some(true);
    if flag("hasPendingApprovals") || flag("hasPendingUserInput") {
        return Status::Held;
    }
    if is_settled(thread) {
        return Status::Idle;
    }
    let usage_limit = text(thread, &["session", "lastError"])
        .is_some_and(|error| error.to_lowercase().contains("usage limit"));
    if usage_limit
        || session == Some("error")
        || text(thread, &["latestTurn", "state"]) == Some("error")
    {
        return Status::Error;
    }
    if ms(thread, &["snoozedUntil"]).is_some_and(|until| until > now_ms()) {
        return Status::Snoozed;
    }
    if thread
        .get("queuedTurns")
        .and_then(Value::as_array)
        .is_some_and(|queued| !queued.is_empty())
    {
        return Status::Queued;
    }
    Status::Idle
}

/// What the age column counts from: a running turn's start, else the thread's
/// latest activity.
fn stamp_of(thread: &Value, status: Status) -> Option<i64> {
    if status == Status::Running
        && let Some(start) = ms(thread, &["latestTurn", "startedAt"])
            .or_else(|| ms(thread, &["latestTurn", "requestedAt"]))
    {
        return Some(start);
    }
    ["updatedAt", "latestUserMessageAt", "createdAt"]
        .iter()
        .filter_map(|key| ms(thread, &[key]))
        .max()
}

/// `threadSortTime`: newest user turn or finished turn, never `updatedAt`, so
/// a running thread holds its slot instead of leapfrogging on every tool call.
fn sort_ms_of(thread: &Value) -> i64 {
    let mut times = vec![
        ms(thread, &["latestUserMessageAt"]),
        ms(thread, &["latestTurn", "requestedAt"]),
        ms(thread, &["createdAt"]),
    ];
    if text(thread, &["latestTurn", "state"]) != Some("running") {
        times.push(ms(thread, &["latestTurn", "completedAt"]));
    }
    times.into_iter().flatten().max().unwrap_or(0)
}

fn is_listed(thread: &Value) -> bool {
    let set = |key| thread.get(key).is_some_and(|v| !v.is_null());
    thread.get("hidden").and_then(Value::as_bool) != Some(true)
        && !set("archivedAt")
        && !set("deletedAt")
}

fn iso_ms(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|instant| instant.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn model_request(fields: &mut Value, model: &Selection) {
    fields["provider"] = json!(model.instance);
    fields["model"] = json!(model.model);
    for (id, value) in &model.options {
        match (id.as_str(), value) {
            ("serviceTier", OptionValue::Text(tier)) => {
                fields["speedMode"] = json!(if tier == "fast" { "fast" } else { "standard" });
            }
            ("fastMode", OptionValue::Flag(fast)) => {
                fields["speedMode"] = json!(if *fast { "fast" } else { "standard" });
            }
            (id, OptionValue::Text(effort)) if is_effort(id) => {
                fields["thinkingEffort"] = json!(effort);
            }
            _ => {}
        }
    }
}

fn usage_reset_of(thread: &Value) -> Option<i64> {
    let latest = text(thread, &["latestTurn", "turnId"])?;
    let limit = thread["activities"].as_array()?.iter().rev().find(|row| {
        text(row, &["turnId"]) == Some(latest)
            && matches!(text(row, &["kind"]), Some("usage.limit" | "usage.wrap-up"))
    })?;
    ms(limit, &["payload", "resetsAt"])
}

fn revert_targets(thread: &Value) -> HashMap<String, usize> {
    let turns: HashMap<_, _> = thread["checkpoints"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some((
                text(row, &["turnId"])?,
                usize::try_from(row["checkpointTurnCount"].as_u64()?.checked_sub(1)?).ok()?,
            ))
        })
        .collect();
    thread["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some((
                text(row, &["id"])?.to_string(),
                *turns.get(text(row, &["turnId"])?)?,
            ))
        })
        .collect()
}

struct Slot {
    uuid: String,
    thread: Thread,
    stamp_ms: Option<i64>,
    present: bool,
    project_id: String,
    /// The model the thread runs, as the server sent it: a new thread in the
    /// same project starts on it.
    selection: Option<Value>,
    sort_ms: i64,
    parent: Option<String>,
    created_ms: i64,
    branch: Option<String>,
    worktree: Option<String>,
    cwd: Option<String>,
    snoozed_until: Option<i64>,
    has_work: bool,
    protected: bool,
    scheduled_continue: Option<String>,
    notifies_parent: bool,
}

/// What is known of one thread's conversation.
#[derive(Default)]
struct Transcript {
    rows: Vec<Row>,
    /// `rows` as the window reads them, rebuilt when they change.
    messages: Option<Arc<Vec<Message>>>,
    revert: HashMap<String, usize>,
    usage_reset: Option<i64>,
}

/// The approvals and questions open on one thread.
#[derive(Default)]
struct Waiting {
    permissions: Vec<Permission>,
    asks: Vec<Ask>,
}

#[derive(Default)]
struct SkillRead {
    requested: Option<Instant>,
    result: Option<Arc<Result<Inventory, String>>>,
}

#[derive(Default)]
struct State {
    /// The open connection, while there is one.
    wire: Option<Arc<Wire>>,
    /// The thread whose conversation is followed, and which watcher follows it.
    focused: Option<ThreadId>,
    watch: u64,
    /// The thread and connection the running watcher belongs to.
    watching: Option<(ThreadId, u64)>,
    /// Counts connections, so a watcher of a closed one is replaced.
    wire_epoch: u64,
    transcripts: HashMap<ThreadId, Transcript>,
    connection: Option<Connection>,
    paired_name: Option<String>,
    client_locale: Option<String>,
    restart_required: bool,
    experience: Option<Arc<Result<Value, String>>>,
    records: Vec<Record>,
    diagnosis: Option<Arc<Result<Value, String>>>,
    app_update: Option<Update>,
    slots: Vec<Slot>,
    ids: HashMap<String, ThreadId>,
    arranged: Arranged,
    projects: Vec<Project>,
    project_roots: HashMap<String, String>,
    skills: HashMap<(String, String), SkillRead>,
    images: HashMap<Picture, Option<Result<Arc<gpui::Image>, String>>>,
    improvements: VecDeque<(Improvement, Option<String>)>,
    /// Messages waiting for their turn, by thread, in the order they run.
    queues: HashMap<ThreadId, Vec<Queued>>,
    /// The whole server queue (thread, turn), in its order: moving one place
    /// takes as many steps as there are other threads' entries to pass.
    global_queue: Vec<(String, String)>,
    problems: VecDeque<Problem>,
    /// What each followed thread waits on the person for, as its last snapshot said.
    waiting: HashMap<ThreadId, Waiting>,
    /// Requests answered here that the server has not yet confirmed: hidden
    /// at once, and shown again if the answer is refused.
    answered: HashSet<String>,
    /// A thread being started, until the shell lists it.
    opening: Option<String>,
    opened: Option<ThreadId>,
    added: Option<String>,
    /// The providers and models, once read: `None` until the first answer.
    catalog: Option<Result<Arc<Catalog>, String>>,
    /// What the Git tab shows, by thread, and which read of it is the latest.
    git: HashMap<ThreadId, Arc<Git>>,
    git_reads: HashMap<ThreadId, u64>,
    /// The turns that changed files, from each followed thread's snapshot.
    turns: HashMap<ThreadId, Vec<TurnDiff>>,
    /// Patches asked for: a turn's, and what is uncommitted.
    patches: HashMap<(ThreadId, i64), Patch>,
    trees: HashMap<ThreadId, Patch>,
    work: HashMap<(ThreadId, Read), Arc<Result<View, String>>>,
    work_reads: HashSet<(ThreadId, Read)>,
    inspector: HashMap<ThreadId, Arc<InspectorData>>,
    archived: Vec<(String, String)>,
    restoring: HashSet<String>,
    actions: HashSet<ThreadId>,
    settled: Option<ThreadId>,
    side_answers: HashMap<ThreadId, SideAnswer>,
    asking_side_question: bool,
    reverted: Option<(ThreadId, Option<String>)>,
    /// The server's settings table, once read.
    settings: Option<Arc<Result<Snapshot, String>>>,
    /// The key a `settings.set` is writing, for the row's pending mark.
    settings_pending: Option<String>,
    settings_write: Option<Result<(), String>>,
    settings_reads: HashMap<(&'static str, Option<ThreadId>), u64>,
    settings_read_id: u64,
    /// The last settings export or import, in a line.
    settings_notice: Option<SettingsNotice>,
    /// The last harness or MCP test or probe, while it runs and after.
    harness_run: Option<HarnessRun>,
    /// The last model discovery answer.
    discovered: Option<Discovery>,
    /// The last profile export: the profile and its document.
    profile_document: Option<(String, String)>,
    /// Every memory the selected thread sees, once read.
    memories: Option<Arc<Result<MemoryList, String>>>,
    /// One memory in full, by name and scope.
    memory_details: HashMap<(String, String), Arc<Result<MemoryEntry, String>>>,
    /// The last keyword search.
    memory_search: Option<Arc<Result<MemorySearch, String>>>,
    /// The skills the manager lists, once read.
    managed_skills: Option<Arc<Result<Vec<ManagedSkill>, String>>>,
    /// One skill's text, by source and folder.
    skill_texts: HashMap<(String, String), Arc<Result<String, String>>>,
    /// The embeddings engine behind semantic search, once read.
    embeddings: Option<Arc<Result<Embeddings, String>>>,
    /// Remote access and the paired devices, once read.
    remote: Option<Arc<Result<RemoteState, String>>>,
    /// The providers' newest versions and Moxen's own update check, once read.
    updates: Option<Arc<Result<UpdateState, String>>>,
}
impl State {
    fn composer_directory(&self, target: &Destination) -> Option<&str> {
        match target {
            Destination::Thread(id) => self.slots.get(*id)?.cwd.as_deref(),
            Destination::Project(id) => self.project_roots.get(id).map(String::as_str),
        }
    }

    fn skill_key(
        &self,
        target: &Destination,
        selection: Option<&Selection>,
    ) -> Option<(String, String)> {
        Some((
            selection?.instance.clone(),
            self.composer_directory(target)?.into(),
        ))
    }

    fn reserve_action(&mut self, id: ThreadId, is_side_question: bool) -> bool {
        if is_side_question && self.asking_side_question {
            self.problems.push_back(Problem {
                message: crate::model::side_question_pending().into(),
                unsent: None,
            });
            return false;
        }
        if !self.actions.insert(id) {
            return false;
        }
        if is_side_question {
            self.asking_side_question = true;
        }
        true
    }

    /// The thread's Git tab data, to change.
    fn git_of(&mut self, id: ThreadId) -> &mut Git {
        Arc::make_mut(self.git.entry(id).or_default())
    }

    /// Replaces the listed threads with a shell snapshot's.
    fn apply(&mut self, snapshot: &Value) {
        self.project_roots = snapshot["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                Some((
                    text(p, &["id"])?.into(),
                    text(p, &["workspaceRoot"])?.into(),
                ))
            })
            .collect();
        let projects: HashMap<&str, &str> = snapshot["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| Some((text(p, &["id"])?, text(p, &["title"])?)))
            .collect();
        for slot in &mut self.slots {
            slot.present = false;
        }
        let mut entries = vec![];
        for thread in snapshot["threads"].as_array().into_iter().flatten() {
            let (Some(uuid), true) = (text(thread, &["id"]), is_listed(thread)) else {
                continue;
            };
            let id = *self.ids.entry(uuid.to_string()).or_insert(self.slots.len());
            let status = status_of(thread);
            let settled = is_settled(thread) && status != Status::Running;
            let snoozed_until = ms(thread, &["snoozedUntil"]);
            let project_id = text(thread, &["projectId"]).unwrap_or_default();
            let project = projects
                .get(project_id)
                .copied()
                .unwrap_or("Unknown project");
            let value = Thread {
                id,
                title: text(thread, &["title"]).unwrap_or(uuid).to_string(),
                model: text(thread, &["modelSelection", "model"])
                    .unwrap_or_default()
                    .to_string(),
                status,
                activity: String::new(),
                project: project.to_string(),
                depth: 0,
                settled,
                started_at: None,
                runtime_mode: text(thread, &["runtimeMode"])
                    .unwrap_or("full-access")
                    .to_string(),
                interaction_mode: text(thread, &["interactionMode"])
                    .unwrap_or("default")
                    .to_string(),
            };
            let slot = Slot {
                uuid: uuid.to_string(),
                thread: value,
                stamp_ms: stamp_of(thread, status),
                present: true,
                project_id: project_id.to_string(),
                selection: thread
                    .get("modelSelection")
                    .filter(|selection| selection.is_object())
                    .cloned(),
                sort_ms: sort_ms_of(thread),
                parent: text(thread, &["parentThreadId"]).map(str::to_string),
                created_ms: ms(thread, &["createdAt"]).unwrap_or(0),
                branch: text(thread, &["branch"]).map(str::to_string),
                worktree: text(thread, &["worktreePath"]).map(str::to_string),
                cwd: text(thread, &["worktreePath"])
                    .or_else(|| {
                        snapshot["projects"]
                            .as_array()?
                            .iter()
                            .find(|p| text(p, &["id"]) == Some(project_id))
                            .and_then(|p| text(p, &["workspaceRoot"]))
                    })
                    .map(str::to_string),
                snoozed_until,
                has_work: matches!(status, Status::Running | Status::Held)
                    || thread["queuedTurns"]
                        .as_array()
                        .is_some_and(|rows| !rows.is_empty()),
                protected: thread["protection"]["protected"] == true,
                notifies_parent: thread["delegationNotifies"] == true,
                scheduled_continue: thread["queuedTurns"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|turn| text(turn, &["scheduleReason"]) == Some("usage-reset"))
                    .and_then(|turn| text(turn, &["turnId"]))
                    .map(str::to_string),
            };
            if id == self.slots.len() {
                self.slots.push(slot);
            } else {
                self.slots[id] = slot;
            }
            entries.push(Entry {
                id,
                uuid: uuid.to_string(),
                parent: text(thread, &["parentThreadId"]).map(str::to_string),
                project: project_id.to_string(),
                sort_ms: sort_ms_of(thread),
                created_ms: ms(thread, &["createdAt"]).unwrap_or(0),
                settled,
            });
        }
        self.archived = snapshot["archivedThreads"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let uuid = text(row, &["id"])?;
                Some((
                    uuid.to_string(),
                    text(row, &["title"]).unwrap_or(uuid).to_string(),
                ))
            })
            .collect();
        self.restoring
            .retain(|uuid| self.archived.iter().any(|(id, _)| uuid == id));
        self.arranged = arrange(&entries);
        self.projects = projects_of(snapshot, &entries);
        if let Some(uuid) = &self.opening
            && let Some(&id) = self.ids.get(uuid)
            && self.arranged.flat.contains(&id)
        {
            self.opened = Some(id);
            self.opening = None;
        }
        for slot in &mut self.slots {
            slot.thread.depth = self
                .arranged
                .depth
                .get(&slot.thread.id)
                .copied()
                .unwrap_or(0);
        }
    }

    fn has_family_work(&self, id: ThreadId) -> bool {
        self.slots.iter().any(|slot| {
            if !slot.present || !slot.has_work {
                return false;
            }
            let mut member = slot;
            for _ in 0..self.slots.len() {
                if member.thread.id == id {
                    return true;
                }
                let Some(parent) = member.parent.as_ref().and_then(|uuid| self.ids.get(uuid))
                else {
                    break;
                };
                member = &self.slots[*parent];
            }
            false
        })
    }
}

/// The projects a thread can start in, the one with the newest turn first;
/// scratch folders and deleted projects are not offered.
fn projects_of(snapshot: &Value, entries: &[Entry]) -> Vec<Project> {
    let newest = |project: &str| {
        entries
            .iter()
            .filter(|e| e.project == project)
            .map(|e| e.sort_ms)
            .max()
    };
    let mut projects: Vec<Project> = snapshot["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            p.get("scratch").and_then(Value::as_bool) != Some(true)
                && p.get("deletedAt").is_none_or(Value::is_null)
        })
        .filter_map(|p| {
            Some(Project {
                id: text(p, &["id"])?.to_string(),
                title: text(p, &["title"])?.to_string(),
            })
        })
        .collect();
    projects.sort_by_key(|p| (std::cmp::Reverse(newest(&p.id)), p.title.to_lowercase()));
    projects
}

/// The messages waiting in a thread (`queuedMessages` in
/// `src/tui/model/thread.ts`), in the order the server will run them. `read`
/// is the answer to `queue.read`, which knows which are held and how the
/// whole queue is ordered; without it they keep the thread's own order.
pub fn queue_of(thread: &Value, read: Option<&Value>) -> Vec<Queued> {
    let messages: HashMap<&str, &Value> = thread["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Some((text(m, &["id"])?, m)))
        .collect();
    let entries = read
        .and_then(|r| r["entries"].as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut waiting: Vec<(usize, Queued)> = vec![];
    for turn in thread["queuedTurns"].as_array().into_iter().flatten() {
        let (Some(turn_id), Some(message)) = (
            text(turn, &["turnId"]),
            text(turn, &["messageId"]).and_then(|id| messages.get(id)),
        ) else {
            continue;
        };
        // The usage-limit continue belongs to the limit banner, not the queue.
        if text(turn, &["scheduleReason"]) == Some("usage-reset") {
            continue;
        }
        let listed = entries
            .iter()
            .position(|e| text(e, &["turnId"]) == Some(turn_id));
        let (body, images) =
            attachments::user_images(message, text(message, &["text"]).unwrap_or_default());
        waiting.push((
            listed.unwrap_or(usize::MAX),
            Queued {
                key: turn_id.to_string(),
                text: body,
                images,
                held: listed.is_some_and(|at| entries[at]["policy"]["held"] == true),
                scheduled: text(turn, &["scheduledFor"]).map(str::to_string),
                earlier: 0,
                later: 0,
            },
        ));
    }
    // Unlisted entries keep the snapshot's order, after the listed ones.
    waiting.sort_by_key(|(at, _)| *at);
    let count = waiting.len();
    waiting
        .into_iter()
        .enumerate()
        .map(|(at, (_, mut queued))| {
            queued.earlier = at;
            queued.later = count - 1 - at;
            queued
        })
        .collect()
}

/// The server queue as `queue.read` lists it, without removed entries.
pub fn global_queue(read: &Value) -> Vec<(String, String)> {
    read["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["policy"]["removed"] != true)
        .filter_map(|e| Some((text(e, &["threadId"])?.into(), text(e, &["turnId"])?.into())))
        .collect()
}

/// How many `up` (or `down`) edits move a turn past its neighbour in the same
/// thread, when other threads' entries lie between them (`queueMoveSteps`).
pub fn move_steps(queue: &[(String, String)], thread: &str, turn: &str, up: bool) -> usize {
    let Some(at) = queue.iter().position(|(t, u)| t == thread && u == turn) else {
        return 0;
    };
    let mut others = queue
        .iter()
        .enumerate()
        .filter(|(_, (t, _))| t == thread)
        .map(|(i, _)| i);
    let neighbour = if up {
        others.rfind(|&i| i < at)
    } else {
        others.find(|&i| i > at)
    };
    neighbour.map_or(0, |other| at.abs_diff(other))
}

struct Shared {
    state: Mutex<State>,
    revision: AtomicU64,
}
impl Shared {
    fn update<T>(&self, change: impl FnOnce(&mut State) -> T) -> T {
        let changed = change(&mut self.state.lock().expect("live state"));
        self.revision.fetch_add(1, Ordering::SeqCst);
        changed
    }
    /// Changes a thread's Git tab data, unless a newer read has begun since
    /// the one that is reporting.
    fn update_git(&self, id: ThreadId, read: u64, change: impl FnOnce(&mut Git)) {
        self.update(|state| {
            if state.git_reads.get(&id) == Some(&read) {
                change(state.git_of(id));
            }
        });
    }
}

pub struct ServerSource {
    shared: Arc<Shared>,
    target: ClientTarget,
}

#[derive(Clone)]
enum ClientTarget {
    Desktop(Result<Option<String>, WireError>),
    #[cfg(all(test, unix))]
    Socket(String),
}
impl ServerSource {
    fn dispatch_thread_action(&self, id: ThreadId, action: ThreadAction) {
        let (uuid, cwd, current, reset, scheduled_continue) = {
            let state = self.shared.state.lock().expect("live state");
            let Some(slot) = state.slots.get(id).filter(|slot| slot.present) else {
                return;
            };
            (
                slot.uuid.clone(),
                slot.cwd.clone(),
                slot.selection.as_ref().and_then(Selection::from_json),
                state
                    .transcripts
                    .get(&id)
                    .and_then(|transcript| transcript.usage_reset),
                slot.scheduled_continue.clone(),
            )
        };
        let mut fields = json!({"threadId": uuid});
        let (name, opened, draft) = match action {
            ThreadAction::Rename(title) => {
                fields["title"] = json!(title);
                ("thread.meta.update", None, None)
            }
            ThreadAction::RegenerateTitle => {
                fields["regenerateTitle"] = json!(true);
                ("thread.meta.update", None, None)
            }
            ThreadAction::Settle { stop } => {
                if stop {
                    fields["stop"] = json!(true);
                }
                ("thread.settle", None, None)
            }
            ThreadAction::Unsettle => {
                fields["reason"] = json!("user");
                ("thread.unsettle", None, None)
            }
            ThreadAction::Snooze(until) => {
                fields["snoozedUntil"] = json!(until);
                ("thread.snooze", None, None)
            }
            ThreadAction::Unsnooze => ("thread.unsnooze", None, None),
            ThreadAction::Archive => ("thread.archive", None, None),
            ThreadAction::Delete => ("thread.delete", None, None),
            ThreadAction::Protect => ("thread.protect", None, None),
            ThreadAction::Handover { prompt, selection } => {
                let Some(cwd) = cwd else {
                    return;
                };
                fields = json!({
                    "cwd": cwd, "prompt": prompt, "wait": false,
                });
                model_request(&mut fields, &selection);
                ("thread.handover", Some(&["threadId"][..]), None)
            }
            ThreadAction::Continue { selection } => {
                let same_provider = selection.as_ref().is_none_or(|choice| {
                    current
                        .as_ref()
                        .is_some_and(|current| current.instance == choice.instance)
                });
                if let Some(choice) = selection.filter(|choice| {
                    !current
                        .as_ref()
                        .is_some_and(|current| choice.same_as(current))
                }) {
                    fields["modelSelection"] = choice.to_json();
                }
                if same_provider && let Some(reset) = reset.filter(|reset| *reset > now_ms()) {
                    // The TUI allows a minute for the provider's limit to clear before starting.
                    fields["scheduledFor"] = json!(iso_ms(reset + 60_000));
                }
                ("thread.continue", Some(&["threadId"][..]), None)
            }
            ThreadAction::ContinueAtReset => {
                let Some(reset) = reset
                    .filter(|reset| *reset > now_ms())
                    .and_then(|reset| iso_ms(reset + 60_000))
                else {
                    return;
                };
                if scheduled_continue.is_some() {
                    return;
                }
                fields["scheduledFor"] = json!(reset);
                fields["scheduleReason"] = json!("usage-reset");
                fields["message"] = json!({"text": "The usage limit that stopped the last turn has reset. Continue the task where you left off."});
                ("thread.turn.start", None, None)
            }
            ThreadAction::CancelContinue { notify_parent } => {
                let Some(turn) = scheduled_continue else {
                    return;
                };
                fields["turnId"] = json!(turn);
                if !notify_parent {
                    fields["notifyParent"] = json!(false);
                }
                ("thread.turn.interrupt", None, None)
            }
            ThreadAction::Delegate { task, selection } => {
                fields = json!({
                    "parentThreadId": uuid, "task": task,
                    "wait": false, "isolation": "shared",
                });
                model_request(&mut fields, &selection);
                ("thread.delegate", Some(&["child", "id"][..]), None)
            }
            ThreadAction::SideQuestion(question) => {
                fields["question"] = json!(question);
                ("thread.side-question", None, None)
            }
            ThreadAction::Revert {
                turn_count,
                restore_files,
                draft,
            } => {
                fields["turnCount"] = json!(turn_count);
                if restore_files {
                    fields["restoreFiles"] = json!(true);
                }
                ("thread.conversation.revert", None, draft)
            }
        };
        let is_side_question = name == "thread.side-question";
        let epoch = self.shared.update(|state| {
            state
                .reserve_action(id, is_side_question)
                .then_some(state.wire_epoch)
        });
        let Some(epoch) = epoch else {
            return;
        };
        background_result(&self.shared, move |wire, shared| {
            let result = wire.and_then(|wire| wire.dispatch(name, fields));
            shared.update(|state| {
                release_action(state, epoch, id, is_side_question);
                let Ok(result) = &result else {
                    return;
                };
                if let Some(uuid) = opened.and_then(|path| text(result, path)) {
                    if let Some(&id) = state.ids.get(uuid).filter(|&&id| state.slots[id].present) {
                        state.opened = Some(id);
                    } else {
                        state.opening = Some(uuid.to_string());
                    }
                }
                if name == "thread.settle" {
                    state.settled = Some(id);
                }
                if is_side_question && let Some(answer) = text(result, &["text"]) {
                    state
                        .side_answers
                        .insert(id, SideAnswer::new(answer.to_string()));
                }
                if name == "thread.conversation.revert" {
                    state.reverted = Some((id, draft));
                    state.patches.retain(|(thread, _), _| *thread != id);
                }
            });
            result.map(|_| ()).map_err(|error| problem(&error, None))
        });
    }
    pub fn desktop(target: Result<Option<String>, WireError>) -> Self {
        Self::with_target(ClientTarget::Desktop(target))
    }

    #[cfg(all(test, unix))]
    fn connect(endpoint: String) -> Self {
        Self::with_target(ClientTarget::Socket(endpoint))
    }

    fn with_target(target: ClientTarget) -> Self {
        let source = Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                revision: AtomicU64::new(0),
            }),
            target,
        };
        source.start();
        source
    }

    /// Runs one connection to the server on its own thread: handshake,
    /// shell subscription, then each snapshot until the server hangs up.
    fn start(&self) {
        self.shared
            .update(|state| state.connection = Some(Connection::Connecting));
        let shared = self.shared.clone();
        let target = self.target.clone();
        let spawned = std::thread::Builder::new()
            .name("moxen-live".into())
            .spawn(move || {
                let failed = match session(target, &shared) {
                    Ok(()) => "The connection to the Moxen server closed.".to_string(),
                    Err(error) => error.message,
                };
                shared.update(|state| state.connection = Some(Connection::Failed(failed)));
            });
        if let Err(cause) = spawned {
            self.shared.update(|state| {
                state.connection = Some(Connection::Failed(cause.to_string()));
            });
        }
    }
}

fn session(target: ClientTarget, shared: &Arc<Shared>) -> Result<(), WireError> {
    let (wire, hello) = match target {
        ClientTarget::Desktop(server) => Wire::desktop(server?.as_deref(), || {
            shared.update(|state| state.connection = Some(Connection::Starting));
        })?,
        #[cfg(all(test, unix))]
        ClientTarget::Socket(endpoint) => Wire::connect(&endpoint)?,
    };
    let wire = Arc::new(wire);
    load_catalog(shared, &wire);
    let subscription = wire.subscribe_shell()?;
    shared.update(|state| {
        state.wire_epoch += 1;
        state.wire = Some(wire.clone());
        state.paired_name = hello.paired_name;
        state.client_locale = hello.client_locale;
        state.restart_required = hello.restart_required;
        state.work.clear();
        state.work_reads.clear();
        state.settings_reads.clear();
    });
    read_settings_snapshot(shared);
    read_experience(shared);
    read_records(shared);
    // A thread opened before the connection existed starts being followed now.
    follow(shared);
    let ended = (|| {
        for frame in subscription.frames.iter() {
            let frame = frame?;
            if frame["kind"] == "snapshot" {
                shared.update(|state| {
                    state.apply(&frame["snapshot"]);
                    state.connection = Some(Connection::Live);
                });
                follow(shared);
            } else if frame["kind"] == "event" {
                shared.update(|state| apply_app_event(state, &frame["event"]));
            }
        }
        Ok(())
    })();
    shared.update(end_session);
    ended
}

fn end_session(state: &mut State) {
    state.wire = None;
    state.wire_epoch += 1;
    // Ends the open thread's watcher.
    state.watch += 1;
    state.settings_reads.clear();
    if matches!(state.app_update, Some(Update::Running { .. })) {
        state.app_update = Some(Update::Lost);
    }
    if state.settings_pending.take().is_some() {
        state.settings_write = Some(Err(not_connected().message));
    }
    state.harness_run = None;
    // In-flight answers, actions and side questions belong to the dropped
    // connection: the next snapshot decides what is still open, so a request
    // answered before the drop is answerable again after the reconnect.
    state.answered.clear();
    state.actions.clear();
    state.asking_side_question = false;
}

/// A failed answer's grace re-check: a request that is still open comes back
/// so it can be answered again. A disconnect in between already released the
/// answer (see `end_session`), so a stale refusal touches neither a
/// post-reconnect answer nor the problems.
fn reopen_refused(state: &mut State, epoch: u64, id: ThreadId, request: &str) -> bool {
    if state.wire_epoch != epoch {
        return false;
    }
    let open = state.waiting.get(&id).is_some_and(|waiting| {
        waiting.permissions.iter().any(|p| p.request == request)
            || waiting.asks.iter().any(|a| a.request == request)
    });
    if open {
        state.answered.remove(request);
    }
    open
}

/// Releases a thread action's reservation. A disconnect in between already
/// released it (see `end_session`), so a stale completion must not clear a
/// post-reconnect reservation.
fn release_action(state: &mut State, epoch: u64, id: ThreadId, side_question: bool) {
    if state.wire_epoch != epoch {
        return;
    }
    state.actions.remove(&id);
    if side_question {
        state.asking_side_question = false;
    }
}

/// Reads the providers, models and efforts (`getConfig`) on its own thread.
/// A failed read is kept, to be shown and tried again when the picker opens.
fn load_catalog(shared: &Arc<Shared>, wire: &Arc<Wire>) {
    let (shared, wire) = (shared.clone(), wire.clone());
    let spawned = std::thread::Builder::new()
        .name("moxen-catalog".into())
        .spawn(move || {
            let read = wire
                .request("getConfig", None)
                .map_err(|error| error.message)
                .and_then(|config| {
                    Catalog::from_config(&config)
                        .map(Arc::new)
                        .ok_or_else(|| "The server's provider list was not understood.".to_string())
                });
            shared.update(|state| match read {
                Ok(catalog) => state.catalog = Some(Ok(catalog)),
                // Keeps a catalog already read: a hiccup should not empty the picker.
                Err(message) if !matches!(state.catalog, Some(Ok(_))) => {
                    state.catalog = Some(Err(message))
                }
                Err(_) => {}
            });
        });
    drop(spawned);
}

/// Starts following the focused thread's conversation, ending any watcher
/// for another thread (or an earlier connection). Does nothing while the
/// thread is already followed or there is no connection.
fn follow(shared: &Arc<Shared>) {
    let (wire, id, uuid, token) = {
        let mut state = shared.state.lock().expect("live state");
        let (Some(wire), Some(id)) = (state.wire.clone(), state.focused) else {
            return;
        };
        let Some(uuid) = state.slots.get(id).map(|slot| slot.uuid.clone()) else {
            return;
        };
        if state.watching == Some((id, state.wire_epoch)) {
            return;
        }
        state.watching = Some((id, state.wire_epoch));
        state.watch += 1;
        (wire, id, uuid, state.watch)
    };
    let shared = shared.clone();
    let _ = std::thread::Builder::new()
        .name("moxen-thread".into())
        .spawn(move || watch(&shared, &wire, id, &uuid, token));
}

/// One thread's subscription: a snapshot replaces its rows, and live text
/// deltas extend them until the next snapshot. Ends when another watcher
/// takes over or the connection does, which drops the subscription.
fn watch(shared: &Arc<Shared>, wire: &Wire, id: ThreadId, uuid: &str, token: u64) {
    let Ok(subscription) = wire.subscribe_thread(uuid) else {
        return;
    };
    loop {
        if shared.state.lock().expect("live state").watch != token {
            return;
        }
        let frame = match subscription.frames.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(frame)) => frame,
            Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
        };
        // `synchronized` and other frames carry nothing to draw.
        let known = match frame["kind"].as_str() {
            Some("snapshot") => true,
            Some("event") => matches!(
                frame["event"]["type"].as_str(),
                Some("thread.message-sent" | "thread.reasoning-delta")
            ),
            _ => false,
        };
        if !known {
            continue;
        }
        // Which waiting messages are held, and how the whole queue is ordered,
        // are only in the work queue; ask for it when this thread has any.
        let read = (frame["kind"] == "snapshot"
            && frame["snapshot"]["thread"]["queuedTurns"]
                .as_array()
                .is_some_and(|waiting| !waiting.is_empty()))
        .then(|| wire.query("queue.read", json!({})).ok())
        .flatten();
        shared.update(|state| {
            if state.watch != token {
                return;
            }
            if frame["kind"] == "snapshot" {
                let thread = &frame["snapshot"]["thread"];
                state.inspector.insert(
                    id,
                    Arc::new(InspectorData {
                        tasks: work::checklist(thread),
                        agents: work::agents(thread),
                        background_count: work::background_count(thread),
                    }),
                );
                state.queues.insert(id, queue_of(thread, read.as_ref()));
                state.turns.insert(id, git::turn_diffs_of(thread));
                state.waiting.insert(
                    id,
                    Waiting {
                        permissions: pending::permissions(thread),
                        asks: pending::asks(thread),
                    },
                );
                if let Some(read) = &read {
                    state.global_queue = global_queue(read);
                }
            }
            let entry = state.transcripts.entry(id).or_default();
            if frame["kind"] == "snapshot" {
                let thread = &frame["snapshot"]["thread"];
                entry.rows = transcript::project(thread);
                entry.revert = revert_targets(thread);
                entry.usage_reset = usage_reset_of(thread);
            } else {
                let payload = &frame["event"]["payload"];
                if frame["event"]["type"] == "thread.message-sent" {
                    let message = &payload["message"];
                    if text(message, &["role"]) == Some("assistant") {
                        transcript::append(
                            &mut entry.rows,
                            text(message, &["id"]).unwrap_or_default(),
                            text(message, &["text"]).unwrap_or_default(),
                            transcript::created_ms(message),
                        );
                    }
                } else {
                    transcript::append_thought(
                        &mut entry.rows,
                        text(payload, &["toolCallId"]).unwrap_or_default(),
                        text(payload, &["text"]).unwrap_or_default(),
                    );
                }
            }
            entry.messages = None;
        });
    }
}

impl ThreadSource for ServerSource {
    fn thread_action(&mut self, id: ThreadId, action: ThreadAction) {
        self.dispatch_thread_action(id, action);
    }
    fn action_pending(&self, id: ThreadId) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .actions
            .contains(&id)
    }
    fn has_family_work(&self, id: ThreadId) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .has_family_work(id)
    }
    fn archived(&self) -> Vec<(String, String)> {
        let state = self.shared.state.lock().expect("live state");
        state
            .archived
            .iter()
            .filter(|(id, _)| !state.restoring.contains(id))
            .cloned()
            .collect()
    }
    fn restore_thread(&mut self, uuid: &str) {
        let uuid = uuid.to_string();
        if !self
            .shared
            .update(|state| state.restoring.insert(uuid.clone()))
        {
            return;
        }
        background_result(&self.shared, move |wire, shared| {
            match wire.and_then(|wire| wire.dispatch("thread.restore", json!({"threadId": uuid}))) {
                Ok(_) => Ok(()),
                Err(error) => {
                    shared.update(|state| {
                        state.restoring.remove(&uuid);
                    });
                    Err(problem(&error, None))
                }
            }
        });
    }
    fn take_settled(&mut self) -> Option<ThreadId> {
        self.shared.state.lock().expect("live state").settled.take()
    }
    fn side_question_pending(&self) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .asking_side_question
    }
    fn has_side_answer(&self, id: ThreadId) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .side_answers
            .contains_key(&id)
    }
    fn read_side_answer(&mut self, id: ThreadId, only_unread: bool) -> Option<String> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .side_answers
            .get_mut(&id)?
            .read(only_unread)
    }
    fn revert_before(&self, id: ThreadId, row: usize) -> Option<usize> {
        let state = self.shared.state.lock().expect("live state");
        let transcript = state.transcripts.get(&id)?;
        transcript
            .revert
            .get(&transcript.rows.get(row)?.key)
            .copied()
    }
    fn take_reverted(&mut self) -> Option<(ThreadId, Option<String>)> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .reverted
            .take()
    }
    fn usage_reset(&self, id: ThreadId) -> Option<String> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .transcripts
            .get(&id)?
            .usage_reset
            .filter(|reset| *reset > now_ms())
            .and_then(iso_ms)
    }
    fn scheduled_continue(&self, id: ThreadId) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .slots
            .get(id)
            .is_some_and(|slot| slot.scheduled_continue.is_some())
    }
    fn notifies_parent(&self, id: ThreadId) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .slots
            .get(id)
            .is_some_and(|slot| slot.notifies_parent)
    }
    fn is_protected(&self, id: ThreadId) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .slots
            .get(id)
            .is_some_and(|slot| slot.protected)
    }
    fn is_snoozed(&self, id: ThreadId) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .slots
            .get(id)
            .and_then(|slot| slot.snoozed_until)
            .is_some_and(|until| until > now_ms())
    }
    fn can_handover(&self, id: ThreadId) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .slots
            .get(id)
            .is_some_and(|slot| slot.cwd.is_some())
    }
    fn order(&self, by_project: bool) -> Vec<ThreadId> {
        let state = self.shared.state.lock().expect("live state");
        if by_project {
            state.arranged.grouped.clone()
        } else {
            state.arranged.flat.clone()
        }
    }
    fn sidebar_section(&self, id: ThreadId) -> Option<bool> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .arranged
            .sections
            .get(&id)
            .copied()
    }
    fn preview(&self) -> bool {
        false
    }
    fn connection(&self) -> Connection {
        let state = self.shared.state.lock().expect("live state");
        state.connection.clone().unwrap_or(Connection::Connecting)
    }
    fn paired_name(&self) -> Option<String> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .paired_name
            .clone()
    }
    fn restart_required(&self) -> bool {
        self.shared
            .state
            .lock()
            .expect("live state")
            .restart_required
    }
    fn client_locale(&self) -> Option<String> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .client_locale
            .clone()
    }
    fn experience(&self) -> Option<Arc<Result<Value, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .experience
            .clone()
    }
    fn update_experience(&mut self, change: Value) {
        settings_read(
            &self.shared,
            Some(("experience.update", None)),
            move |wire| {
                wire.dispatch("experience.update", change)
                    .map_err(|error| error.message)
            },
            |state, result| match result {
                Ok(snapshot) => state.experience = Some(Arc::new(Ok(snapshot))),
                Err(message) => state.problems.push_back(Problem {
                    message,
                    unsent: None,
                }),
            },
        );
    }
    fn experience_saving(&self) -> bool {
        let state = self.shared.state.lock().expect("live state");
        state.settings_pending.is_some()
            || state
                .settings_reads
                .contains_key(&("experience.update", None))
            || state.settings_reads.contains_key(&("guide.memory", None))
    }
    fn set_guide_memory(&mut self, choice: Memory) {
        let settings = choice.writes();
        settings_read(
            &self.shared,
            Some(("guide.memory", None)),
            move |wire| {
                let write = |(key, value)| {
                    wire.dispatch("settings.set", json!({"key":key,"value":value}))
                        .map_err(|error| error.message)
                };
                let first = write(settings[0])?;
                Ok::<_, String>(match write(settings[1]) {
                    Ok(second) => (second, None),
                    Err(error) => (first, Some(error)),
                })
            },
            |state, result| {
                let error = match result {
                    Ok((snapshot, error)) => {
                        if let Some(snapshot) = Snapshot::from_json(&snapshot) {
                            state.settings = Some(Arc::new(Ok(snapshot)));
                        }
                        error
                    }
                    Err(error) => Some(error),
                };
                if let Some(message) = error {
                    state.problems.push_back(Problem {
                        message,
                        unsent: None,
                    });
                }
            },
        );
    }
    fn add_guide_project(&mut self, path: String) {
        settings_read(
            &self.shared,
            Some(("project.ensure", None)),
            move |wire| {
                wire.dispatch(
                    "project.ensure",
                    json!({"cwd":path,"projectPolicy":"create"}),
                )
                .map_err(|error| error.message)
            },
            |state, result| match result {
                Ok(project) => state.added = project["projectId"].as_str().map(str::to_owned),
                Err(message) => state.problems.push_back(Problem {
                    message,
                    unsent: None,
                }),
            },
        );
    }
    fn records(&self) -> Vec<Record> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .records
            .clone()
    }
    fn read_records(&mut self) {
        read_records(&self.shared);
    }
    fn fix_record(&mut self, fix: Fix) {
        self.shared.update(|state| {
            state.settings_reads.remove(&("store.problems", None));
        });
        settings_read(
            &self.shared,
            Some(("record.fix", None)),
            move |wire| {
                let (command, fields) = fix.payload();
                let result = wire
                    .dispatch(command, fields)
                    .map_err(|error| error.message)?;
                let settings = (command == "settings.set")
                    .then(|| Snapshot::from_json(&result))
                    .flatten();
                Ok((settings, read_problem_rows(wire)))
            },
            |state, result| match result {
                Ok((settings, rows)) => {
                    if let Some(settings) = settings {
                        state.settings = Some(Arc::new(Ok(settings)));
                    }
                    if let Some(rows) = rows {
                        state.records = rows;
                    }
                }
                Err(message) => state.problems.push_back(Problem {
                    message,
                    unsent: None,
                }),
            },
        );
    }
    fn diagnosis(&self) -> Option<Arc<Result<Value, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .diagnosis
            .clone()
    }
    fn read_diagnosis(&mut self) {
        settings_read(
            &self.shared,
            Some(("doctor", None)),
            |wire| {
                wire.query("doctor", json!({}))
                    .map_err(|error| error.message)
            },
            |state, result| state.diagnosis = Some(Arc::new(result)),
        );
    }
    fn app_update(&self) -> Option<Update> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .app_update
            .clone()
    }
    fn revision(&self) -> u64 {
        self.shared.revision.load(Ordering::SeqCst)
    }
    fn retry(&mut self) {
        let failed = matches!(self.connection(), Connection::Failed(_));
        if failed {
            self.start();
        }
    }
    fn list_threads(&self) -> Vec<Thread> {
        let state = self.shared.state.lock().expect("live state");
        let now = now_ms();
        state
            .slots
            .iter()
            .map(|slot| {
                let mut thread = slot.thread.clone();
                if thread.status == Status::Snoozed
                    && slot.snoozed_until.is_some_and(|until| until <= now)
                {
                    thread.status = Status::Idle;
                }
                if let Some(stamp) = slot.stamp_ms {
                    thread.activity = relative_age(now, stamp);
                    if thread.status == Status::Running {
                        thread.started_at = Instant::now().checked_sub(
                            std::time::Duration::from_millis((now - stamp).max(0) as u64),
                        );
                    }
                }
                thread
            })
            .collect()
    }
    // Sending and the inspector arrive with their own issues; a real thread
    // shows none of them yet.
    fn messages(&self, id: ThreadId) -> Arc<Vec<Message>> {
        let mut state = self.shared.state.lock().expect("live state");
        let Some(transcript) = state.transcripts.get_mut(&id) else {
            return Arc::new(vec![]);
        };
        transcript
            .messages
            .get_or_insert_with(|| {
                Arc::new(
                    transcript
                        .rows
                        .iter()
                        .map(|row| row.message.clone())
                        .collect(),
                )
            })
            .clone()
    }
    fn focus(&mut self, id: ThreadId) {
        self.shared.update(|state| state.focused = Some(id));
        follow(&self.shared);
    }
    fn queued(&self, id: ThreadId) -> Vec<Queued> {
        let state = self.shared.state.lock().expect("live state");
        state.queues.get(&id).cloned().unwrap_or_default()
    }
    fn take_queued(&mut self, id: ThreadId, key: &str) -> Option<Prompt> {
        let queued = {
            let state = self.shared.state.lock().expect("live state");
            state
                .queues
                .get(&id)?
                .iter()
                .find(|queued| queued.key == key)?
                .clone()
        };
        let mut assets = vec![];
        for item in &queued.images {
            match self.image(&item.source) {
                Some(Ok(image)) => assets.push(Asset::Image {
                    name: item.name.clone(),
                    image,
                }),
                _ => return None,
            }
        }
        self.edit_queued(id, key, QueueEdit::Remove);
        Some(Prompt {
            text: queued.text,
            assets,
            once: None,
        })
    }
    fn edit_queued(&mut self, id: ThreadId, key: &str, edit: QueueEdit) {
        let Some((uuid, steps)) = ({
            let state = self.shared.state.lock().expect("live state");
            state.slots.get(id).map(|slot| {
                let steps = |up| move_steps(&state.global_queue, &slot.uuid, key, up).max(1);
                let steps = match edit {
                    QueueEdit::Earlier => steps(true),
                    QueueEdit::Later => steps(false),
                    _ => 1,
                };
                (slot.uuid.clone(), steps)
            })
        }) else {
            return;
        };
        let turn = key.to_string();
        if edit == QueueEdit::Remove {
            // It leaves the strip at once; a refusal puts it back with the
            // next snapshot.
            self.shared.update(|state| {
                if let Some(queue) = state.queues.get_mut(&id) {
                    queue.retain(|queued| queued.key != turn);
                }
            });
        }
        background(&self.shared, move |wire| {
            let action = match edit {
                QueueEdit::Earlier => "up",
                QueueEdit::Later => "down",
                QueueEdit::Hold => "hold",
                QueueEdit::Release => "release",
                // Taking a waiting message back is a turn interrupt, as the
                // TUI's queued panel does it.
                QueueEdit::Remove => {
                    return wire
                        .dispatch(
                            "thread.turn.interrupt",
                            json!({ "threadId": uuid, "turnId": turn }),
                        )
                        .map(|_| ())
                        .map_err(|error| problem(&error, None));
                }
            };
            for _ in 0..steps {
                wire.dispatch(
                    "queue.edit",
                    json!({ "threadId": uuid, "turnId": turn, "action": action }),
                )
                .map_err(|error| problem(&error, None))?;
            }
            Ok(())
        });
    }
    fn send_queued_now(&mut self, id: ThreadId, key: &str) -> Option<Reply> {
        let uuid = self.uuid_of(id)?;
        let turn = key.to_string();
        // The waiting message goes first, then the running turn ends and it
        // starts; the server promotes the next waiting turn when one ends.
        let first = self.queued(id).first().is_some_and(|q| q.key != key);
        background(&self.shared, move |wire| {
            if first {
                wire.dispatch(
                    "queue.edit",
                    json!({ "threadId": uuid, "turnId": turn, "action": "first" }),
                )
                .map_err(|error| problem(&error, None))?;
            }
            wire.dispatch("thread.turn.interrupt", json!({ "threadId": uuid }))
                .map(|_| ())
                .map_err(|error| problem(&error, None))
        });
        None
    }
    fn inspector(&self, id: ThreadId) -> Arc<InspectorData> {
        let state = self.shared.state.lock().expect("live state");
        state.inspector.get(&id).cloned().unwrap_or_default()
    }
    fn children(&self, id: ThreadId) -> Vec<ThreadId> {
        let state = self.shared.state.lock().expect("live state");
        let Some(parent) = state.slots.get(id) else {
            return vec![];
        };
        let mut children: Vec<_> = state
            .slots
            .iter()
            .filter(|s| s.present && s.parent.as_deref() == Some(&parent.uuid))
            .collect();
        children.sort_by_key(|s| std::cmp::Reverse(s.created_ms));
        children.into_iter().map(|s| s.thread.id).collect()
    }
    fn delegated(&self, id: ThreadId) -> Option<Delegated> {
        let state = self.shared.state.lock().expect("live state");
        let slot = state.slots.get(id)?;
        let parent = slot.parent.as_ref()?;
        Some(Delegated {
            parent: state
                .ids
                .get(parent)
                .copied()
                .filter(|&id| state.slots[id].present),
            branch: slot.branch.clone(),
            worktree: slot.worktree.clone(),
        })
    }
    fn read_work(&mut self, id: ThreadId, read: Read) {
        read_work(&self.shared, id, read);
    }
    fn work(&self, id: ThreadId, read: &Read) -> Option<Arc<Result<View, String>>> {
        let state = self.shared.state.lock().expect("live state");
        state.work.get(&(id, read.clone())).cloned()
    }
    fn stop_background(&mut self, id: ThreadId, task: &str) {
        let Some(uuid) = self.uuid_of(id) else {
            return;
        };
        let task = task.to_string();
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            wire.dispatch(
                "thread.background.stop",
                json!({ "threadId": uuid, "taskId": task }),
            )
            .map_err(|error| problem(&error, None))?;
            read_work(&shared, id, Read::Background);
            Ok(())
        });
    }
    fn cancel_task(&mut self, id: ThreadId, notify_parent: bool) {
        let (child, parent) = {
            let state = self.shared.state.lock().expect("live state");
            let Some(slot) = state.slots.get(id) else {
                return;
            };
            let Some(parent) = &slot.parent else {
                return;
            };
            (slot.uuid.clone(), parent.clone())
        };
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            wire.dispatch(
                "thread.task.cancel",
                json!({
                    "parentThreadId": parent, "taskId": child, "notifyParent": notify_parent,
                }),
            )
            .map_err(|error| problem(&error, None))?;
            read_work(&shared, id, Read::Delegation);
            Ok(())
        });
    }
    fn git(&self, id: ThreadId) -> Arc<Git> {
        let state = self.shared.state.lock().expect("live state");
        state.git.get(&id).cloned().unwrap_or_default()
    }
    fn read_git(&mut self, id: ThreadId, branch: Option<String>) {
        if let Some(uuid) = self.uuid_of(id) {
            begin_read(&self.shared, id, &uuid, branch);
        }
    }
    fn open_commit(&mut self, id: ThreadId, sha: &str) {
        let Some(uuid) = self.uuid_of(id) else {
            return;
        };
        let sha = sha.to_string();
        // Only the commit changes: the history behind it keeps loading.
        self.shared.update(|state| {
            state.git_of(id).commit = Some(OpenCommit {
                sha: sha.clone(),
                detail: None,
                loading: true,
                runs: None,
            });
        });
        let (detail, runs) = (self.shared.clone(), self.shared.clone());
        let (detail_sha, runs_sha) = (sha.clone(), sha);
        let (detail_uuid, runs_uuid) = (uuid.clone(), uuid);
        with_wire(&self.shared, move |wire| {
            let fields = json!({ "threadId": detail_uuid, "sha": detail_sha });
            let result = wire.query("git.commit.detail", fields);
            detail.update(|state| {
                let git = state.git_of(id);
                let Some(open) = git.commit.as_mut().filter(|open| open.sha == detail_sha) else {
                    return;
                };
                open.loading = false;
                match result {
                    Ok(value) => open.detail = CommitDetail::from_json(&value),
                    Err(error) => git.error = Some(error.message),
                }
            });
        });
        with_wire(&self.shared, move |wire| {
            let fields = json!({ "threadId": runs_uuid, "sha": runs_sha });
            // CI is the forge's and may be slow or absent: the commit stands without it.
            let Ok(value) = wire.query("forge.commit.runs", fields) else {
                return;
            };
            let list = git::runs_of(&value["runs"]);
            runs.update(|state| {
                if let Some(open) = state
                    .git_of(id)
                    .commit
                    .as_mut()
                    .filter(|open| open.sha == runs_sha)
                {
                    open.runs = Some(list);
                }
            });
        });
    }
    fn close_commit(&mut self, id: ThreadId) {
        self.shared.update(|state| state.git_of(id).commit = None);
    }
    fn create_request(&mut self, id: ThreadId, request: NewRequest) {
        let mut fields = json!({ "title": request.title, "draft": request.draft });
        if let Some(base) = request.base {
            fields["targetBranch"] = base.into();
        }
        self.forge_write(id, "Opening…", "forge.request.create", fields, |result| {
            let url = result["url"].as_str();
            url.map_or("Opened.".to_string(), |url| format!("Opened {url}"))
        });
    }
    fn comment_on_request(&mut self, id: ThreadId, number: i64, body: String) {
        self.forge_write(
            id,
            "Commenting…",
            "forge.request.comment",
            json!({ "number": number, "body": body }),
            move |_| format!("Commented on #{number}."),
        );
    }
    fn merge_request(&mut self, id: ThreadId, number: i64, strategy: MergeStrategy) {
        self.forge_write(
            id,
            "Merging…",
            "forge.request.merge",
            json!({ "number": number, "strategy": strategy.wire(), "deleteBranch": false }),
            move |_| format!("Merged #{number}."),
        );
    }
    fn turn_diffs(&self, id: ThreadId) -> Vec<TurnDiff> {
        let state = self.shared.state.lock().expect("live state");
        state.turns.get(&id).cloned().unwrap_or_default()
    }
    fn turn_patch(&self, id: ThreadId, turn: i64) -> Option<Patch> {
        let state = self.shared.state.lock().expect("live state");
        state.patches.get(&(id, turn)).cloned()
    }
    fn read_turn_patch(&mut self, id: ThreadId, turn: i64) {
        let Some(uuid) = self.uuid_of(id) else {
            return;
        };
        self.shared.update(|state| {
            state.patches.insert((id, turn), Patch::Loading);
        });
        let shared = self.shared.clone();
        with_wire(&shared.clone(), move |wire| {
            let result = wire.request(
                "turnDiff",
                Some(json!({ "threadId": uuid, "toTurnCount": turn })),
            );
            let patch = match result {
                Ok(Value::String(diff)) => Patch::Ready(git::parse_patch(&diff)),
                Ok(_) => Patch::Missing,
                Err(error) => Patch::Failed(error.message),
            };
            shared.update(|state| {
                state.patches.insert((id, turn), patch);
            });
        });
    }
    fn tree_patch(&self, id: ThreadId) -> Option<Patch> {
        let state = self.shared.state.lock().expect("live state");
        state.trees.get(&id).cloned()
    }
    fn read_tree_patch(&mut self, id: ThreadId) {
        let Some(uuid) = self.uuid_of(id) else {
            return;
        };
        let root = self.shared.update(|state| {
            state.trees.insert(id, Patch::Loading);
            state
                .git
                .get(&id)
                .and_then(|g| g.overview.as_ref()?.root.clone())
        });
        let shared = self.shared.clone();
        with_wire(&shared.clone(), move |wire| {
            let patch = read_tree(&wire, &uuid, root).unwrap_or_else(Patch::Failed);
            shared.update(|state| {
                state.trees.insert(id, patch);
            });
        });
    }
    fn send_message(&mut self, id: ThreadId, prompt: Prompt, delivery: Delivery) -> Option<Reply> {
        let (uuid, busy) = {
            let state = self.shared.state.lock().expect("live state");
            let slot = state.slots.get(id)?;
            (
                slot.uuid.clone(),
                matches!(slot.thread.status, Status::Running | Status::Held),
            )
        };
        let mut command = json!({
            "threadId": uuid,
            "message": prompt.wire(),
            // A settled thread wakes on the send, as the TUI's does.
            "wakeSettled": true,
        });
        if busy {
            command["delivery"] = match delivery {
                Delivery::Steer => "steer",
                Delivery::Queue => "queue",
            }
            .into();
        } else if let Some(mode) = &prompt.once {
            command["interactionMode"] = mode.clone().into();
        }
        background_result(&self.shared, move |wire, _| {
            let wire = wire.map_err(|error| problem(&error, Some((Some(id), prompt.clone()))))?;
            wire.dispatch("thread.turn.start", command)
                .map(|_| ())
                .map_err(|error| problem(&error, Some((Some(id), prompt))))
        });
        None
    }
    fn composer_directory(&self, target: &Destination) -> Option<String> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .composer_directory(target)
            .map(str::to_owned)
    }
    fn read_skills(&mut self, target: &Destination, selection: Option<&Selection>) {
        let key = {
            let mut state = self.shared.state.lock().expect("live state");
            if state.wire.is_none() {
                return;
            }
            let Some(key) = state.skill_key(target, selection) else {
                return;
            };
            let read = state.skills.entry(key.clone()).or_default();
            if read
                .requested
                .is_some_and(|at| at.elapsed() < Duration::from_secs(15))
            {
                return;
            }
            read.requested = Some(Instant::now());
            key
        };
        let shared = self.shared.clone();
        with_wire(&self.shared, move |wire| {
            let result = wire
                .query("skills.list", json!({ "instanceId": key.0, "cwd": key.1 }))
                .map_err(|e| e.message)
                .and_then(|value| Inventory::decode(&value));
            shared.update(|state| {
                let read = state.skills.entry(key).or_default();
                read.result = Some(Arc::new(result));
            });
        });
    }
    fn skills(
        &self,
        target: &Destination,
        selection: Option<&Selection>,
    ) -> Option<Arc<Result<Inventory, String>>> {
        let state = self.shared.state.lock().expect("live state");
        state
            .skills
            .get(&state.skill_key(target, selection)?)?
            .result
            .clone()
    }
    fn read_image(&mut self, picture: &Picture) {
        let request = {
            let mut state = self.shared.state.lock().expect("live state");
            if state.wire.is_none() || state.images.contains_key(picture) {
                return;
            }
            let request = match picture {
                Picture::Stored(id) => ("attachment.read", json!({ "attachmentId": id })),
                Picture::Reply { thread, path } => {
                    let Some(slot) = state.slots.get(*thread) else {
                        return;
                    };
                    ("image.read", json!({ "threadId": slot.uuid, "path": path }))
                }
            };
            state.images.insert(picture.clone(), None);
            request
        };
        let picture = picture.clone();
        let shared = self.shared.clone();
        with_wire(&self.shared, move |wire| {
            let result = wire
                .query(request.0, request.1)
                .map_err(|e| e.message)
                .and_then(|value| attachments::decode(&value));
            shared.update(|state| {
                state.images.insert(picture, Some(result));
            });
        });
    }
    fn image(&self, picture: &Picture) -> Option<Result<Arc<gpui::Image>, String>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .images
            .get(picture)?
            .clone()
    }
    fn improve(&mut self, request: Improvement) {
        let shared = self.shared.clone();
        background_result(&self.shared, move |wire, _| {
            let mut fields = json!({
                "directory": request.directory, "prompt": request.original, "protectedText": [],
            });
            if let Some(selection) = &request.selection {
                fields["modelSelection"] = selection.to_json();
            }
            let result = wire
                .and_then(|wire| wire.dispatch("prompt.improve", fields))
                .and_then(|value| {
                    text(&value, &["text"])
                        .map(str::to_owned)
                        .filter(|text| !text.trim().is_empty())
                        .ok_or_else(|| WireError {
                            code: "INVALID_REPLY".into(),
                            message: "The improver returned an empty draft.".into(),
                        })
                });
            shared.update(|state| {
                state
                    .improvements
                    .push_back((request, result.as_ref().ok().cloned()))
            });
            result.map(|_| ()).map_err(|e| problem(&e, None))
        });
    }
    fn take_improvement(&mut self) -> Option<(Improvement, Option<String>)> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .improvements
            .pop_front()
    }
    fn stop(&mut self, id: ThreadId) {
        let Some(uuid) = self.uuid_of(id) else {
            return;
        };
        background(&self.shared, move |wire| {
            wire.dispatch("thread.turn.interrupt", json!({ "threadId": uuid }))
                .map(|_| ())
                .map_err(|error| problem(&error, None))
        });
    }
    fn projects(&self) -> Vec<Project> {
        let state = self.shared.state.lock().expect("live state");
        state.projects.clone()
    }
    fn catalog(&self) -> CatalogState {
        match &self.shared.state.lock().expect("live state").catalog {
            None => CatalogState::Loading,
            Some(Ok(catalog)) => CatalogState::Ready(catalog.clone()),
            Some(Err(message)) => CatalogState::Failed(message.clone()),
        }
    }
    fn refresh_catalog(&mut self) {
        let wire = self.shared.state.lock().expect("live state").wire.clone();
        if let Some(wire) = wire {
            load_catalog(&self.shared, &wire);
        }
    }
    fn selection(&self, id: ThreadId) -> Option<Selection> {
        let state = self.shared.state.lock().expect("live state");
        state
            .slots
            .get(id)?
            .selection
            .as_ref()
            .and_then(Selection::from_json)
    }
    fn project_selection(&self, project: &str) -> Option<Selection> {
        let state = self.shared.state.lock().expect("live state");
        project_selection(&state, project).and_then(|value| Selection::from_json(&value))
    }
    fn set_model(&mut self, id: ThreadId, selection: Selection) {
        let value = selection.to_json();
        // Shown at once; the shell's next snapshot confirms it, and a refusal
        // puts the old one back.
        let (uuid, before) = {
            let mut state = self.shared.state.lock().expect("live state");
            let Some(slot) = state.slots.get_mut(id) else {
                return;
            };
            let before = (slot.selection.clone(), slot.thread.model.clone());
            slot.selection = Some(value.clone());
            slot.thread.model = selection.model.clone();
            (slot.uuid.clone(), before)
        };
        self.shared.update(|_| {});
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            wire.dispatch(
                "thread.model-selection.set",
                json!({ "threadId": uuid, "modelSelection": value }),
            )
            .map(|_| ())
            .map_err(|error| {
                shared.update(|state| {
                    if let Some(slot) = state.slots.get_mut(id)
                        && slot.selection.as_ref() == Some(&value)
                    {
                        slot.selection = before.0;
                        slot.thread.model = before.1;
                    }
                });
                problem(&error, None)
            })
        });
    }
    fn create_thread(&mut self, draft: NewThread) {
        // The thread starts on the model chosen for it; else the one the
        // project's newest thread runs on; with none, the server's default.
        let selection = draft.model.as_ref().map(Selection::to_json).or_else(|| {
            let state = self.shared.state.lock().expect("live state");
            draft
                .project
                .as_deref()
                .and_then(|project| project_selection(&state, project))
        });
        let shared = self.shared.clone();
        background_result(&self.shared, move |wire, _| {
            let unsent = || Some((None, draft.prompt.clone()));
            let wire = wire.map_err(|error| problem(&error, unsent()))?;
            let message = draft.prompt.wire();
            let title: String = text(&message, &["text"])
                .unwrap_or_default()
                .lines()
                .next()
                .unwrap_or_default()
                .chars()
                .take(60)
                .collect();
            let mut create = json!({
                "title": title,
                "interactionMode": draft.interaction_mode,
            });
            if let Some(project) = draft.project {
                create["projectId"] = project.into();
            } else {
                create["scratch"] = true.into();
            }
            if let Some(selection) = &selection {
                create["modelSelection"] = selection.clone();
            }
            if let Some(mode) = &draft.runtime_mode {
                create["runtimeMode"] = mode.clone().into();
            }
            let created = wire
                .dispatch("thread.create", create)
                .map_err(|error| problem(&error, unsent()))?;
            let uuid = text(&created, &["threadId"])
                .unwrap_or_default()
                .to_string();
            let mut start = json!({ "threadId": uuid, "message": message });
            if let Some(mode) = &draft.prompt.once {
                start["interactionMode"] = mode.clone().into();
            }
            if let Some(selection) = selection {
                start["modelSelection"] = selection;
            }
            wire.dispatch("thread.turn.start", start)
                .map_err(|error| problem(&error, unsent()))?;
            shared.update(|state| {
                if let Some(id) = state.ids.get(&uuid) {
                    state.opened = Some(*id);
                } else {
                    state.opening = Some(uuid);
                }
            });
            Ok(())
        });
    }
    fn add_project(&mut self, path: String) {
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            let added = wire
                .dispatch("project.create", json!({ "workspaceRoot": path }))
                .map_err(|error| problem(&error, None))?;
            let id = text(&added, &["projectId"]).unwrap_or_default().to_string();
            shared.update(|state| state.added = Some(id));
            Ok(())
        });
    }
    fn set_modes(&mut self, id: ThreadId, runtime: &str, interaction: &str) {
        let (uuid, runtime_changed, interaction_changed) = {
            let state = self.shared.state.lock().expect("live state");
            let Some(slot) = state.slots.get(id) else {
                return;
            };
            (
                slot.uuid.clone(),
                slot.thread.runtime_mode != runtime,
                slot.thread.interaction_mode != interaction,
            )
        };
        let (runtime, interaction) = (runtime.to_string(), interaction.to_string());
        background(&self.shared, move |wire| {
            if runtime_changed {
                wire.dispatch(
                    "thread.runtime-mode.set",
                    json!({ "threadId": uuid, "runtimeMode": runtime }),
                )
                .map_err(|error| problem(&error, None))?;
            }
            if interaction_changed {
                wire.dispatch(
                    "thread.interaction-mode.set",
                    json!({ "threadId": uuid, "interactionMode": interaction }),
                )
                .map_err(|error| problem(&error, None))?;
            }
            Ok(())
        });
    }
    fn permission(&self, id: ThreadId) -> Option<Permission> {
        let state = self.shared.state.lock().expect("live state");
        let waiting = state.waiting.get(&id)?;
        let open = |request: &str| !state.answered.contains(request);
        waiting
            .permissions
            .iter()
            .find(|permission| open(&permission.request))
            .cloned()
    }
    fn ask(&self, id: ThreadId) -> Option<Ask> {
        let state = self.shared.state.lock().expect("live state");
        let waiting = state.waiting.get(&id)?;
        waiting
            .asks
            .iter()
            .find(|ask| !state.answered.contains(&ask.request))
            .cloned()
    }
    fn decide(&mut self, id: ThreadId, request: &str, decision: Decision) {
        self.reply(id, request, "thread.permission.respond", |command| {
            command["decision"] = decision.wire().into();
        });
    }
    fn answer(&mut self, id: ThreadId, request: &str, answers: Vec<(String, Answer)>) {
        self.reply(id, request, "thread.user-input.respond", |command| {
            command["answers"] = answers
                .into_iter()
                .map(|(question, answer)| {
                    let value = match answer {
                        Answer::One(one) => json!(one),
                        Answer::Many(many) => json!(many),
                    };
                    (question, value)
                })
                .collect::<serde_json::Map<_, _>>()
                .into();
        });
    }
    fn dismiss(&mut self, id: ThreadId, request: &str) {
        self.reply(id, request, "thread.user-input.dismiss", |_| {});
    }
    fn take_opened(&mut self) -> Option<ThreadId> {
        self.shared.state.lock().expect("live state").opened.take()
    }
    fn take_added(&mut self) -> Option<String> {
        self.shared.state.lock().expect("live state").added.take()
    }
    fn take_problem(&mut self) -> Option<Problem> {
        let mut state = self.shared.state.lock().expect("live state");
        state.problems.pop_front()
    }
    fn stream_word(&mut self, _: ThreadId, _: usize, _: &str, _: bool) {}
    fn read_settings(&mut self) {
        read_settings_snapshot(&self.shared);
    }
    fn settings(&self) -> Option<Arc<Result<Snapshot, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .settings
            .clone()
    }
    fn settings_saving(&self) -> Option<String> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .settings_pending
            .clone()
    }

    fn take_settings_write(&mut self) -> Option<Result<(), String>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .settings_write
            .take()
    }

    fn clear_settings_transients(&mut self) {
        self.shared.update(|state| {
            state.discovered = None;
            state.profile_document = None;
            state
                .settings_reads
                .remove(&("harness.models.discover", None));
            state
                .settings_reads
                .remove(&("harness.profile.export", None));
        });
    }
    fn set_setting(&mut self, key: &str, value: &str) {
        send_setting(&self.shared, key, value);
    }
    fn duplicate_setting(&mut self, key: &str, id: &str, new_id: &str) {
        send_duplicate(&self.shared, key, id, new_id);
    }
    fn test_harness(&mut self, profile: &str, model: Option<String>) {
        run_harness_test(&self.shared, profile, model);
    }
    fn probe_harness(&mut self, profile: &str, model: Option<String>) {
        run_harness_probe(&self.shared, profile, model);
    }
    fn test_mcp(&mut self, name: &str) {
        run_mcp_test(&self.shared, name);
    }
    fn harness_run(&self) -> Option<HarnessRun> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .harness_run
            .clone()
    }
    fn discover_models(&mut self, base_url: &str, api_format: &str, api_key_env: Option<String>) {
        run_discover(&self.shared, base_url, api_format, api_key_env);
    }
    fn take_discovered(&mut self) -> Option<Discovery> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .discovered
            .take()
    }
    fn export_profile(&mut self, profile: &str) {
        run_export(&self.shared, profile);
    }
    fn take_profile_document(&mut self) -> Option<(String, String)> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .profile_document
            .take()
    }
    fn import_profile(&mut self, text: &str) {
        run_import(&self.shared, text);
    }
    fn take_settings_notice(&mut self) -> Option<SettingsNotice> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .settings_notice
            .take()
    }
    fn read_memories(&mut self, thread: Option<ThreadId>) {
        read_memory_list(&self.shared, thread);
    }
    fn memories(&self) -> Option<Arc<Result<MemoryList, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .memories
            .clone()
    }
    fn read_memory(&mut self, thread: Option<ThreadId>, name: &str, scope: &str) {
        read_memory_detail(&self.shared, thread, name, scope);
    }
    fn memory_detail(&self, name: &str, scope: &str) -> Option<Arc<Result<MemoryEntry, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .memory_details
            .get(&(name.to_string(), scope.to_string()))
            .cloned()
    }
    fn search_memories(&mut self, thread: Option<ThreadId>, query: &str) {
        run_memory_search(&self.shared, thread, query);
    }
    fn memory_search(&self) -> Option<Arc<Result<MemorySearch, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .memory_search
            .clone()
    }
    fn save_memory(&mut self, thread: Option<ThreadId>, draft: MemoryDraft) {
        send_memory_save(&self.shared, thread, draft);
    }
    fn delete_memory(&mut self, thread: Option<ThreadId>, name: &str, scope: &str) {
        send_memory_delete(&self.shared, thread, name, scope);
    }
    fn edit_memory(
        &mut self,
        thread: Option<ThreadId>,
        name: &str,
        scope: &str,
        old: &str,
        new: &str,
        description: Option<String>,
    ) {
        send_memory_edit(&self.shared, thread, name, scope, old, new, description);
    }
    fn append_memory(&mut self, thread: Option<ThreadId>, name: &str, scope: &str, text: &str) {
        send_memory_append(&self.shared, thread, name, scope, text);
    }
    fn import_claude_memory(&mut self, thread: Option<ThreadId>) {
        send_memory_import_claude(&self.shared, thread);
    }
    fn read_embeddings(&mut self) {
        read_embeddings_status(&self.shared);
    }
    fn embeddings(&self) -> Option<Arc<Result<Embeddings, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .embeddings
            .clone()
    }
    fn setup_embeddings(&mut self, all: bool) {
        send_embeddings(&self.shared, "memory.embeddings.setup", all);
    }
    fn rebuild_embeddings(&mut self, all: bool) {
        send_embeddings(&self.shared, "memory.embeddings.rebuild", all);
    }
    fn unload_embeddings(&mut self) {
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            wire.dispatch("memory.embeddings.unload", json!({}))
                .map_err(|error| problem(&error, None))?;
            read_embeddings_status(&shared);
            Ok(())
        });
    }
    fn read_managed_skills(&mut self, thread: Option<ThreadId>) {
        read_skill_list(&self.shared, thread);
    }
    fn managed_skills(&self) -> Option<Arc<Result<Vec<ManagedSkill>, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .managed_skills
            .clone()
    }
    fn read_skill_text(&mut self, thread: Option<ThreadId>, source: &str, folder: &str) {
        read_skill_detail(&self.shared, thread, source, folder);
    }
    fn skill_text(&self, source: &str, folder: &str) -> Option<Arc<Result<String, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .skill_texts
            .get(&(source.to_string(), folder.to_string()))
            .cloned()
    }
    fn save_skill(
        &mut self,
        thread: Option<ThreadId>,
        source: &str,
        folder: &str,
        text: &str,
        previous: &str,
    ) {
        send_skill_save(&self.shared, thread, source, folder, text, previous);
    }
    fn set_skill_enabled(
        &mut self,
        thread: Option<ThreadId>,
        source: &str,
        folder: &str,
        enabled: bool,
    ) {
        send_skill_field(
            &self.shared,
            thread,
            "skills.enabled.set",
            source,
            folder,
            "enabled",
            json!(enabled),
        );
    }
    fn set_skill_providers(
        &mut self,
        thread: Option<ThreadId>,
        source: &str,
        folder: &str,
        providers: Vec<String>,
    ) {
        send_skill_field(
            &self.shared,
            thread,
            "skills.providers.set",
            source,
            folder,
            "providers",
            json!(providers),
        );
    }
    fn remove_skill(&mut self, thread: Option<ThreadId>, source: &str, folder: &str) {
        let address = skill_fields(&self.shared, thread, source, folder);
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            wire.dispatch("skills.remove", address)
                .map_err(|error| problem(&error, None))?;
            read_skill_list(&shared, thread);
            Ok(())
        });
    }
    fn import_skill(&mut self, thread: Option<ThreadId>, source: &str, from: &str) {
        let mut fields = skill_fields(&self.shared, thread, source, "");
        fields["from"] = json!(from);
        fields
            .as_object_mut()
            .expect("skill fields")
            .remove("folder");
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            wire.dispatch("skills.import", fields)
                .map_err(|error| problem(&error, None))?;
            read_skill_list(&shared, thread);
            Ok(())
        });
    }
    fn read_remote(&mut self) {
        read_remote_state(&self.shared);
    }
    fn remote(&self) -> Option<Arc<Result<RemoteState, String>>> {
        self.shared.state.lock().expect("live state").remote.clone()
    }
    fn pair_remote(&mut self) {
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            let pairing = wire
                .dispatch("remote.pairing.start", json!({}))
                .map_err(|error| problem(&error, None))?;
            match settings::Pairing::from_json(&pairing) {
                Some(pairing) => {
                    set_pairing(&shared, Some(pairing));
                    Ok(())
                }
                None => Err(Problem {
                    message: "The server's pairing answer was unreadable.".into(),
                    unsent: None,
                }),
            }
        });
    }
    fn cancel_pairing(&mut self) {
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            wire.dispatch("remote.pairing.cancel", json!({}))
                .map_err(|error| problem(&error, None))?;
            set_pairing(&shared, None);
            Ok(())
        });
    }
    fn revoke_device(&mut self, device_id: &str) {
        let fields = json!({"deviceId": device_id});
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            wire.dispatch("remote.device.revoke", fields)
                .map_err(|error| problem(&error, None))?;
            read_remote_state(&shared);
            Ok(())
        });
    }
    fn read_updates(&mut self) {
        read_update_state(&self.shared);
    }
    fn check_app_update(&mut self) {
        let allowed = self.shared.update(|state| {
            if matches!(state.app_update, Some(Update::Running { .. })) {
                return false;
            }
            state.app_update = None;
            state.updates = None;
            true
        });
        if allowed {
            read_update_state(&self.shared);
        }
    }
    fn updates(&self) -> Option<Arc<Result<UpdateState, String>>> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .updates
            .clone()
    }
    fn update_provider(&mut self, provider: &str) {
        let fields = json!({"provider": provider});
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            let result = wire
                .dispatch("provider.update", fields)
                .map_err(|error| problem(&error, None))?;
            let line = settings::provider_update_line(&result);
            shared.update(|state| {
                state.settings_notice = Some(SettingsNotice {
                    text: line,
                    error: false,
                });
            });
            read_update_state(&shared);
            Ok(())
        });
    }
    fn apply_update(&mut self) {
        send_app_update(&self.shared, "app.update.apply");
    }
    fn rollback_update(&mut self) {
        send_app_update(&self.shared, "app.update.rollback");
    }
}

/// The model the project's newest thread runs on, as the server sent it.
fn project_selection(state: &State, project: &str) -> Option<Value> {
    state
        .slots
        .iter()
        .filter(|slot| slot.present && slot.project_id == project)
        .max_by_key(|slot| slot.sort_ms)
        .and_then(|slot| slot.selection.clone())
}

impl ServerSource {
    /// Answers a request the thread waits on. It disappears at once; if the
    /// server refuses and the request is still open a moment later it comes
    /// back with the reason. A refusal after another client answered first
    /// is a race the person already won, so it is not reported.
    fn reply(
        &self,
        id: ThreadId,
        request: &str,
        command: &'static str,
        fill: impl FnOnce(&mut Value),
    ) {
        let Some(uuid) = self.uuid_of(id) else {
            return;
        };
        let mut body = json!({ "threadId": uuid, "requestId": request });
        fill(&mut body);
        let shared = self.shared.clone();
        let request = request.to_string();
        let epoch = shared.update(|state| {
            state.answered.insert(request.clone());
            state.wire_epoch
        });
        background(&self.shared, move |wire| {
            let Err(error) = wire.dispatch(command, body) else {
                return Ok(());
            };
            std::thread::sleep(REFUSAL_GRACE);
            let mut state = shared.state.lock().expect("live state");
            if !reopen_refused(&mut state, epoch, id, &request) {
                return Ok(());
            }
            Err(problem(&error, None))
        });
    }
    fn uuid_of(&self, id: ThreadId) -> Option<String> {
        let state = self.shared.state.lock().expect("live state");
        state.slots.get(id).map(|slot| slot.uuid.clone())
    }

    /// A write to the forge. It names what it is doing while it runs, says
    /// what came of it afterwards, and then reads the forge again: the forge
    /// decides what happened, so the list is never patched by hand.
    fn forge_write(
        &self,
        id: ThreadId,
        busy: &'static str,
        command: &'static str,
        mut fields: Value,
        done: impl FnOnce(&Value) -> String + Send + 'static,
    ) {
        let Some(uuid) = self.uuid_of(id) else {
            return;
        };
        fields["threadId"] = uuid.clone().into();
        self.shared.update(|state| {
            let git = state.git_of(id);
            git.busy = Some(busy);
            git.error = None;
            git.notice = None;
        });
        let shared = self.shared.clone();
        with_wire(&shared.clone(), move |wire| {
            let result = wire.dispatch(command, fields);
            let branch = shared.update(|state| {
                let git = state.git_of(id);
                git.busy = None;
                match &result {
                    Ok(value) => git.notice = Some(done(value)),
                    Err(error) => git.error = Some(error.message.clone()),
                }
                git.branch.clone()
            });
            // The request and the list changed: ask again, as the forge decides what happened.
            if result.is_ok() && command != "forge.request.comment" {
                begin_read(&shared, id, &uuid, branch);
            }
        });
    }
}

/// Starts reading a thread's git and forge: history on one side, the forge on
/// the other, so a slow forge never holds up the branches and commits.
fn begin_read(shared: &Arc<Shared>, id: ThreadId, uuid: &str, branch: Option<String>) {
    let read = shared.update(|state| {
        let read = state.git_reads.entry(id).or_default();
        *read += 1;
        let read = *read;
        let git = state.git_of(id);
        git.branch = branch.clone();
        git.loading_git = true;
        git.loading_forge = true;
        git.error = None;
        read
    });
    let (history, forge) = (shared.clone(), shared.clone());
    let (history_uuid, forge_uuid) = (uuid.to_string(), uuid.to_string());
    let shared = shared.clone();
    with_wire(&shared.clone(), move |wire| {
        read_history(&history, &wire, id, read, &history_uuid, branch.as_deref())
    });
    with_wire(&shared.clone(), move |wire| {
        read_forge(&forge, &wire, id, read, &forge_uuid)
    });
}

/// Polls each visible view without overlapping reads of it. Thread and work
/// IDs key the result, and a previous connection cannot replace it.
fn read_work(shared: &Arc<Shared>, id: ThreadId, read: Read) {
    let key = (id, read);
    let (uuid, parent, epoch) = {
        let mut state = shared.state.lock().expect("live state");
        let Some(slot) = state.slots.get(id) else {
            return;
        };
        let names = (slot.uuid.clone(), slot.parent.clone(), state.wire_epoch);
        if state.wire.is_none() || !state.work_reads.insert(key.clone()) {
            return;
        }
        names
    };
    let target = shared.clone();
    let shared = shared.clone();
    with_wire(&shared.clone(), move |wire| {
        let answer = match &key.1 {
            Read::Delegation => (|| {
                let link = wire.query("thread.delegation", json!({ "threadId": uuid }))?;
                let status = match &parent {
                    Some(parent) => wire.query(
                        "thread.task.status",
                        json!({
                            "parentThreadId": parent, "taskId": uuid,
                        }),
                    )?,
                    None => Value::Null,
                };
                Ok(View::Delegation(Delegation::read(&link, &status)))
            })(),
            Read::Background => wire
                .query("thread.background.list", json!({ "threadId": uuid }))
                .map(|value| View::Background(Background::read(&value))),
            Read::Subagent(agent) => wire
                .query(
                    "thread.subagent",
                    json!({
                        "threadId": uuid, "agentId": agent,
                    }),
                )
                .map(|value| View::subagent(&value)),
            Read::Output(task) => wire
                .query(
                    "thread.background.output",
                    json!({
                        "threadId": uuid, "taskId": task,
                    }),
                )
                .map(|value| View::output(&value)),
        };
        target.update(|state| {
            if state.wire_epoch == epoch {
                state.work_reads.remove(&key);
                // Some providers release the output buffer when the task exits.
                let keep_output = matches!(&answer, Ok(View::Output(None)))
                    && matches!(state.work.get(&key).map(Arc::as_ref),
                        Some(Ok(View::Output(Some(output)))) if !output.is_empty());
                if state.wire.is_some() && !keep_output {
                    state.work.insert(
                        key,
                        Arc::new(answer.map_err(|error: WireError| error.message)),
                    );
                }
            }
        });
    });
}

/// Runs a read on its own thread with the open connection; nothing if there is none.
fn with_wire(shared: &Arc<Shared>, job: impl FnOnce(Arc<Wire>) + Send + 'static) {
    let wire = shared.state.lock().expect("live state").wire.clone();
    let Some(wire) = wire else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("moxen-read".into())
        .spawn(move || job(wire));
}

/// The checkout's history: status, branches and commits, then each commit's CI.
fn read_history(
    shared: &Arc<Shared>,
    wire: &Wire,
    id: ThreadId,
    read: u64,
    uuid: &str,
    branch: Option<&str>,
) {
    let mut fields = json!({ "threadId": uuid });
    if let Some(branch) = branch {
        fields["branch"] = branch.into();
    }
    let overview = match wire.query("git.overview", fields) {
        Ok(value) => Overview::from_json(&value),
        Err(error) => {
            shared.update_git(id, read, |git| {
                git.loading_git = false;
                git.error = Some(error.message);
            });
            return;
        }
    };
    let shown = overview.branch.clone().filter(|_| overview.is_repository);
    let total = overview.commits.len();
    shared.update_git(id, read, |git| {
        git.overview = Some(overview);
        git.loading_git = false;
    });
    // CI per commit rides on the forge and the network: after history has
    // painted, never before it.
    if let Some(branch) = shown
        && let Ok(value) = wire.query(
            "forge.commits.checks",
            json!({ "threadId": uuid, "branch": branch, "limit": total }),
        )
    {
        let checks = git::commit_checks_of(&value);
        shared.update_git(id, read, |git| git.commit_checks = checks);
    }
}

/// The forge: which one, the open requests and the checked-out branch's own.
fn read_forge(shared: &Arc<Shared>, wire: &Wire, id: ThreadId, read: u64, uuid: &str) {
    let forge = match wire.query("forge.detect", json!({ "threadId": uuid })) {
        Ok(value) => Forge::from_json(&value),
        // A forge failure is not a tab failure: history still stands.
        Err(error) => Forge {
            reason: Some(error.message),
            ..Forge::default()
        },
    };
    if forge.kind.is_none() {
        shared.update_git(id, read, |git| {
            git.forge = Some(forge);
            git.requests = vec![];
            git.status = None;
            git.loading_forge = false;
        });
        return;
    }
    let requests = wire
        .query(
            "forge.requests.list",
            json!({ "threadId": uuid, "state": "open" }),
        )
        .map(|value| git::requests_of(&value));
    let status = wire
        .query("forge.request.status", json!({ "threadId": uuid }))
        .ok()
        .and_then(|value| RequestStatus::from_json(&value));
    shared.update_git(id, read, |git| {
        git.forge = Some(forge);
        match requests {
            Ok(requests) => git.requests = requests,
            Err(error) => git.error = Some(error.message),
        }
        git.status = status;
        git.loading_forge = false;
    });
}

/// What is uncommitted in the checkout, as one patch: the changed files the
/// server names, then their diff against HEAD. Untracked files are not in it.
fn read_tree(wire: &Wire, uuid: &str, root: Option<String>) -> Result<Patch, String> {
    let ask = |root: &str, call: &str, paths: &[&str]| {
        let mut fields = json!({ "threadId": uuid, "root": root, "call": call });
        if !paths.is_empty() {
            fields["paths"] = paths.into();
        }
        wire.query("workspace.git", fields)
            .map(|value| text(&value, &["stdout"]).unwrap_or_default().to_string())
            .map_err(|error| error.message)
    };
    let root = match root {
        Some(root) => root,
        None => {
            let overview = wire
                .query("git.overview", json!({ "threadId": uuid, "limit": 1 }))
                .map_err(|error| error.message)?;
            Overview::from_json(&overview)
                .root
                .ok_or_else(|| "This thread's folder is not a git repository.".to_string())?
        }
    };
    let changed = ask(&root, "changed", &[])?;
    let paths: Vec<&str> = changed
        .split('\0')
        .filter(|path| !path.is_empty())
        .collect();
    if paths.is_empty() {
        return Ok(Patch::Missing);
    }
    Ok(Patch::Ready(git::parse_patch(&ask(&root, "diff", &paths)?)))
}

/// What a refused or failed command tells the user.
fn problem(error: &WireError, unsent: Option<(Option<ThreadId>, Prompt)>) -> Problem {
    Problem {
        message: error.message.chars().take(160).collect(),
        unsent,
    }
}

/// Runs a command on its own thread so the window never waits for the server;
/// whatever goes wrong comes back through `take_problem`.
fn background(
    shared: &Arc<Shared>,
    job: impl FnOnce(&Wire) -> Result<(), Problem> + Send + 'static,
) {
    background_result(shared, move |wire, _| {
        let wire = wire.map_err(|error| problem(&error, None))?;
        job(&wire)
    });
}

fn background_result(
    shared: &Arc<Shared>,
    job: impl FnOnce(Result<Arc<Wire>, WireError>, &Arc<Shared>) -> Result<(), Problem> + Send + 'static,
) {
    let wire = shared.state.lock().expect("live state").wire.clone();
    let shared = shared.clone();
    let spawned = std::thread::Builder::new()
        .name("moxen-command".into())
        .spawn(move || {
            let outcome = job(wire.ok_or_else(not_connected), &shared);
            if let Err(failed) = outcome {
                shared.update(|state| state.problems.push_back(failed));
            }
        });
    drop(spawned);
}

fn not_connected() -> WireError {
    WireError {
        code: "NOT_CONNECTED".into(),
        message: "Not connected to the Moxen server.".into(),
    }
}

/// A thread's address for memory reads and writes: its own id, so the server
/// resolves the project; without one, only the global scope answers.
fn memory_address(state: &State, thread: Option<ThreadId>) -> Value {
    match thread.and_then(|id| state.slots.get(id)) {
        Some(slot) => json!({"threadId": slot.uuid}),
        None => json!({}),
    }
}

/// A thread's project for the skills manager; without one, the user's own skills.
fn skills_address(state: &State, thread: Option<ThreadId>) -> Value {
    match thread.and_then(|id| state.slots.get(id)) {
        Some(slot) => json!({"projectId": slot.project_id}),
        None => json!({}),
    }
}

fn skill_fields(
    shared: &Arc<Shared>,
    thread: Option<ThreadId>,
    source: &str,
    folder: &str,
) -> Value {
    let state = shared.state.lock().expect("live state");
    let mut fields = skills_address(&state, thread);
    fields["source"] = json!(source);
    fields["folder"] = json!(folder);
    fields
}

/// Reads settings on the current wire. A keyed read coalesces duplicate
/// requests while it is pending, and can be superseded after a write.
fn settings_read<T: Send + 'static>(
    shared: &Arc<Shared>,
    key: Option<(&'static str, Option<ThreadId>)>,
    read: impl FnOnce(&Wire) -> T + Send + 'static,
    apply: impl FnOnce(&mut State, T) + Send + 'static,
) {
    let (wire, epoch, id) = {
        let mut state = shared.state.lock().expect("live state");
        let Some(wire) = state.wire.clone() else {
            return;
        };
        if key.is_some_and(|key| state.settings_reads.contains_key(&key)) {
            return;
        }
        state.settings_read_id += 1;
        let id = state.settings_read_id;
        if let Some(key) = key {
            state.settings_reads.insert(key, id);
        }
        (wire, state.wire_epoch, id)
    };
    let worker = shared.clone();
    let spawned = std::thread::Builder::new()
        .name("moxen-settings-read".into())
        .spawn(move || {
            let answer = read(&wire);
            worker.update(|state| {
                if state.wire_epoch != epoch || state.wire.is_none() {
                    return;
                }
                if let Some(key) = key {
                    if state.settings_reads.get(&key) != Some(&id) {
                        return;
                    }
                    state.settings_reads.remove(&key);
                }
                apply(state, answer);
            });
        });
    if spawned.is_err()
        && let Some(key) = key
    {
        shared.update(|state| {
            if state.settings_reads.get(&key) == Some(&id) {
                state.settings_reads.remove(&key);
            }
        });
    }
}

/// Reads `settings.read` on its own thread; the window redraws from the answer.
fn read_settings_snapshot(shared: &Arc<Shared>) {
    settings_read(
        shared,
        Some(("settings.read", None)),
        |wire| {
            wire.query("settings.read", json!({}))
                .map_err(|error| error.message)
                .and_then(|value| {
                    Snapshot::from_json(&value)
                        .ok_or_else(|| "The server's settings answer was unreadable.".to_string())
                })
        },
        |state, snapshot| state.settings = Some(Arc::new(snapshot)),
    );
}

fn read_experience(shared: &Arc<Shared>) {
    settings_read(
        shared,
        Some(("experience.read", None)),
        |wire| {
            wire.query("experience.read", json!({}))
                .map_err(|error| error.message)
        },
        |state, result| state.experience = Some(Arc::new(result)),
    );
}

fn read_problem_rows(wire: &Wire) -> Option<Vec<Record>> {
    let store = wire.query("store.problems", json!({})).ok()?;
    let config = wire.query("config.read", json!({})).unwrap_or(Value::Null);
    Some(experience::problems(&store, &config))
}

fn read_records(shared: &Arc<Shared>) {
    if shared
        .state
        .lock()
        .expect("live state")
        .settings_reads
        .contains_key(&("record.fix", None))
    {
        return;
    }
    settings_read(
        shared,
        Some(("store.problems", None)),
        read_problem_rows,
        |state, rows| {
            if let Some(rows) = rows {
                state.records = rows;
            }
        },
    );
}

fn apply_app_event(state: &mut State, event: &Value) {
    let payload = &event["payload"];
    match event["type"].as_str() {
        Some("app.server-restart-required") if payload["version"].is_string() => {
            state.restart_required = true
        }
        Some("app.update-progress") => {
            if let Some(Update::Running {
                command_id,
                progress,
                ..
            }) = state.app_update.as_mut()
                && payload["commandId"].as_str() == Some(command_id)
                && payload["progress"]["stage"].is_string()
            {
                *progress = payload["progress"].clone();
            }
        }
        _ => {}
    }
}

/// A settings write replaces the snapshot with what the server accepted.
fn write_settings(shared: &Arc<Shared>, key: &str, command: &'static str, fields: Value) {
    let (epoch, wire) = shared.update(|state| {
        if state.settings_pending.is_some() {
            return (state.wire_epoch, None);
        }
        let Some(wire) = state.wire.clone() else {
            state.settings_write = Some(Err(not_connected().message));
            return (state.wire_epoch, None);
        };
        state.settings_pending = Some(key.to_string());
        state.settings_write = None;
        (state.wire_epoch, Some(wire))
    });
    let Some(wire) = wire else { return };
    let refresh_remote = key.starts_with("remote.");
    let worker = shared.clone();
    let spawned = std::thread::Builder::new()
        .name("moxen-settings-write".into())
        .spawn(move || {
            let answer = wire
                .dispatch(command, fields)
                .map_err(|error| error.message);
            let accepted = worker.update(|state| {
                if state.wire_epoch != epoch || state.wire.is_none() {
                    return false;
                }
                state.settings_pending = None;
                let result = answer.and_then(|updated| {
                    let snapshot = Snapshot::from_json(&updated).ok_or_else(|| {
                        "The server's settings answer was unreadable.".to_string()
                    })?;
                    state.settings_reads.remove(&("settings.read", None));
                    state.settings = Some(Arc::new(Ok(snapshot)));
                    if command == "harness.profile.import" {
                        let id = text(&updated, &["id"]).unwrap_or_default();
                        let file = text(&updated, &["fileId"]).unwrap_or_default();
                        state.settings_notice = Some(SettingsNotice {
                            text: if id == file {
                                format!("Imported profile {id}.")
                            } else {
                                format!("Imported profile {id} (the file named {file}).")
                            },
                            error: false,
                        });
                    }
                    if refresh_remote {
                        state.settings_reads.remove(&("remote.status", None));
                    }
                    Ok(())
                });
                let accepted = result.is_ok();
                state.settings_write = Some(result);
                accepted
            });
            if accepted && refresh_remote {
                read_remote_state(&worker);
            }
        });
    if let Err(error) = spawned {
        shared.update(|state| {
            if state.wire_epoch == epoch && state.wire.is_some() {
                state.settings_pending = None;
                state.settings_write = Some(Err(error.to_string()));
            }
        });
    }
}

/// Writes one key through the server; the snapshot refreshes from its answer,
/// and a refusal reaches the person as a problem.
fn send_setting(shared: &Arc<Shared>, key: &str, value: &str) {
    let fields = json!({"key": key, "value": value});
    write_settings(shared, key, "settings.set", fields);
}

/// Copies one list entry under a new id; the snapshot refreshes from the answer.
fn send_duplicate(shared: &Arc<Shared>, key: &str, id: &str, new_id: &str) {
    let fields = json!({"key": key, "id": id, "newId": new_id});
    write_settings(shared, key, "settings.duplicate", fields);
}

/// One tiny request to a Harness profile's endpoint. The answer stays on the
/// run for the settings window to draw; there is no toast for it.
fn run_harness_test(shared: &Arc<Shared>, profile: &str, model: Option<String>) {
    run_settings_check(shared, "harness", "test", profile, model);
}

/// The probe battery against one profile's model; it writes the findings to
/// the config, so the snapshot reloads after.
fn run_harness_probe(shared: &Arc<Shared>, profile: &str, model: Option<String>) {
    run_settings_check(shared, "harness", "probe", profile, model);
}

/// Starts one MCP server, lists its tools and stops it again.
fn run_mcp_test(shared: &Arc<Shared>, name: &str) {
    run_settings_check(shared, "mcp", "test", name, None);
}

fn run_settings_check(
    shared: &Arc<Shared>,
    scope: &'static str,
    kind: &'static str,
    name: &str,
    model: Option<String>,
) {
    let connection = shared.update(|state| {
        if matches!(state.harness_run, Some(HarnessRun::Running { .. })) {
            return None;
        }
        let Some(wire) = state.wire.clone() else {
            state.harness_run = Some(HarnessRun::failed(
                scope,
                kind,
                name,
                not_connected().message,
            ));
            return None;
        };
        state.harness_run = Some(HarnessRun::running(scope, kind, name));
        Some((wire, state.wire_epoch))
    });
    let Some((wire, epoch)) = connection else {
        return;
    };
    let (command, mut fields) = match (scope, kind) {
        ("harness", "test") => ("harness.profile.test", json!({"profileId": name})),
        ("harness", "probe") => ("harness.profile.probe", json!({"profileId": name})),
        _ => ("mcp.server.test", json!({"name": name})),
    };
    if let Some(model) = model {
        fields["model"] = json!(model);
    }
    let worker = shared.clone();
    let target = name.to_string();
    let spawned = std::thread::Builder::new()
        .name("moxen-settings-check".into())
        .spawn(move || {
            let result = wire.dispatch(command, fields);
            let refresh = result.is_ok() && kind == "probe";
            let current = worker.update(|state| {
                if state.wire_epoch != epoch || state.wire.is_none() {
                    return false;
                }
                state.harness_run = Some(match result {
                    Ok(result) if kind == "probe" => HarnessRun::probe_done(&target, &result),
                    Ok(result) => HarnessRun::test_done(scope, kind, &target, &result),
                    Err(error) => HarnessRun::failed(scope, kind, &target, error.message),
                });
                if refresh {
                    state.settings_reads.remove(&("settings.read", None));
                }
                true
            });
            if current && refresh {
                read_settings_snapshot(&worker);
            }
        });
    if let Err(error) = spawned {
        shared.update(|state| {
            if state.wire_epoch == epoch && state.wire.is_some() {
                state.harness_run = Some(HarnessRun::failed(scope, kind, name, error.to_string()));
            }
        });
    }
}

/// Which models a server lists, before a profile for it exists.
fn run_discover(
    shared: &Arc<Shared>,
    base_url: &str,
    api_format: &str,
    api_key_env: Option<String>,
) {
    let mut fields = json!({"baseUrl": base_url, "apiFormat": api_format});
    if let Some(env) = api_key_env {
        fields["apiKeyEnv"] = json!(env);
    }
    settings_read(
        shared,
        Some(("harness.models.discover", None)),
        move |wire| match wire.dispatch("harness.models.discover", fields) {
            Ok(result) => Discovery::from_json(&result),
            Err(error) => Discovery {
                host: None,
                models: vec![],
                error: Some(error.message),
            },
        },
        |state, answer| state.discovered = Some(answer),
    );
}

/// Shares one profile as a JSON document (no saved key, no probe results).
fn run_export(shared: &Arc<Shared>, profile: &str) {
    let fields = json!({"profileId": profile});
    let profile = profile.to_string();
    settings_read(
        shared,
        Some(("harness.profile.export", None)),
        move |wire| {
            wire.query("harness.profile.export", fields)
                .map_err(|error| error.message)
                .and_then(|exported| {
                    text(&exported, &["text"])
                        .map(str::to_string)
                        .ok_or_else(|| "The server's export answer was unreadable.".to_string())
                })
        },
        move |state, result| match result {
            Ok(document) => state.profile_document = Some((profile, document)),
            Err(message) => {
                state.settings_notice = Some(SettingsNotice {
                    text: message,
                    error: true,
                })
            }
        },
    );
}

/// Adds a profile from an exported document; the server renames on a taken id.
fn run_import(shared: &Arc<Shared>, document: &str) {
    write_settings(
        shared,
        "providers.harness.profiles",
        "harness.profile.import",
        json!({"text": document, "onConflict": "rename"}),
    );
}

/// Reads every memory the thread sees, global first.
fn read_memory_list(shared: &Arc<Shared>, thread: Option<ThreadId>) {
    let address = memory_address(&shared.state.lock().expect("live state"), thread);
    settings_read(
        shared,
        Some(("memory.list", thread)),
        move |wire| {
            wire.query("memory.list", address)
                .map_err(|error| error.message)
                .and_then(|value| {
                    MemoryList::from_json(&value)
                        .ok_or_else(|| "The server's memories answer was unreadable.".to_string())
                })
        },
        move |state, memories| state.memories = Some(Arc::new(memories)),
    );
}

/// Reads one memory in full.
fn read_memory_detail(shared: &Arc<Shared>, thread: Option<ThreadId>, name: &str, scope: &str) {
    let mut address = memory_address(&shared.state.lock().expect("live state"), thread);
    address["name"] = json!(name);
    address["scope"] = json!(scope);
    let key = (name.to_string(), scope.to_string());
    settings_read(
        shared,
        None,
        move |wire| {
            wire.query("memory.read", address)
                .map_err(|error| error.message)
                .and_then(|value| {
                    crate::settings::MemoryEntry::from_json(&value)
                        .ok_or_else(|| "The server's memory answer was unreadable.".to_string())
                })
        },
        move |state, memory| {
            state.memory_details.insert(key, Arc::new(memory));
        },
    );
}

/// Keyword matches with excerpts.
fn run_memory_search(shared: &Arc<Shared>, thread: Option<ThreadId>, query: &str) {
    let mut address = memory_address(&shared.state.lock().expect("live state"), thread);
    address["query"] = json!(query);
    address["limit"] = json!(30);
    settings_read(
        shared,
        None,
        move |wire| {
            wire.query("memory.search", address)
                .map_err(|error| error.message)
                .and_then(|value| {
                    MemorySearch::from_json(&value)
                        .ok_or_else(|| "The server's search answer was unreadable.".to_string())
                })
        },
        move |state, search| state.memory_search = Some(Arc::new(search)),
    );
}

/// Saves a memory, then reads the list again.
fn send_memory_save(shared: &Arc<Shared>, thread: Option<ThreadId>, draft: MemoryDraft) {
    let mut fields = memory_address(&shared.state.lock().expect("live state"), thread);
    fields["name"] = json!(draft.name);
    fields["description"] = json!(draft.description);
    fields["memoryType"] = json!(draft.memory_type);
    fields["body"] = json!(draft.body);
    fields["scope"] = json!(draft.scope);
    let shared = shared.clone();
    background(&shared.clone(), move |wire| {
        wire.dispatch("memory.save", fields)
            .map_err(|error| problem(&error, None))?;
        read_memory_list(&shared, thread);
        Ok(())
    });
}

/// Deletes a memory, then reads the list again.
fn send_memory_delete(shared: &Arc<Shared>, thread: Option<ThreadId>, name: &str, scope: &str) {
    let mut fields = memory_address(&shared.state.lock().expect("live state"), thread);
    fields["name"] = json!(name);
    fields["scope"] = json!(scope);
    let key = (name.to_string(), scope.to_string());
    let shared = shared.clone();
    background(&shared.clone(), move |wire| {
        wire.dispatch("memory.delete", fields)
            .map_err(|error| problem(&error, None))?;
        shared.update(|state| {
            state.memory_details.remove(&key);
        });
        read_memory_list(&shared, thread);
        Ok(())
    });
}

/// Replaces one piece of a memory's body, then reads the list again.
fn send_memory_edit(
    shared: &Arc<Shared>,
    thread: Option<ThreadId>,
    name: &str,
    scope: &str,
    old: &str,
    new: &str,
    description: Option<String>,
) {
    let mut fields = memory_address(&shared.state.lock().expect("live state"), thread);
    fields["name"] = json!(name);
    fields["scope"] = json!(scope);
    fields["oldText"] = json!(old);
    fields["newText"] = json!(new);
    if let Some(description) = description {
        fields["description"] = json!(description);
    }
    let key = (name.to_string(), scope.to_string());
    let shared = shared.clone();
    background(&shared.clone(), move |wire| {
        wire.dispatch("memory.edit", fields)
            .map_err(|error| problem(&error, None))?;
        read_memory_list(&shared, thread);
        shared.update(|state| {
            state.memory_details.remove(&key);
        });
        Ok(())
    });
}

/// Adds text to the end of a memory, then reads the list again.
fn send_memory_append(
    shared: &Arc<Shared>,
    thread: Option<ThreadId>,
    name: &str,
    scope: &str,
    text: &str,
) {
    let mut fields = memory_address(&shared.state.lock().expect("live state"), thread);
    fields["name"] = json!(name);
    fields["scope"] = json!(scope);
    fields["text"] = json!(text);
    let shared = shared.clone();
    background(&shared.clone(), move |wire| {
        wire.dispatch("memory.append", fields)
            .map_err(|error| problem(&error, None))?;
        read_memory_list(&shared, thread);
        Ok(())
    });
}

/// Copies Claude Code's auto memory for the project into Moxen's.
fn send_memory_import_claude(shared: &Arc<Shared>, thread: Option<ThreadId>) {
    let address = memory_address(&shared.state.lock().expect("live state"), thread);
    let shared = shared.clone();
    background(&shared.clone(), move |wire| {
        let imported = wire
            .dispatch("memory.import-claude", address)
            .map_err(|error| problem(&error, None))?;
        let names: Vec<String> = imported
            .get("imported")
            .and_then(Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let skipped: usize = imported
            .get("skipped")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        shared.update(|state| {
            state.settings_notice = Some(SettingsNotice {
                text: if names.is_empty() {
                    "Nothing new to import.".into()
                } else if skipped == 0 {
                    format!("Imported {}.", names.join(", "))
                } else {
                    format!(
                        "Imported {}; {skipped} already here kept as they were.",
                        names.join(", ")
                    )
                },
                error: false,
            });
        });
        read_memory_list(&shared, thread);
        Ok(())
    });
}

/// Reads the embeddings engine behind semantic search.
fn read_embeddings_status(shared: &Arc<Shared>) {
    settings_read(
        shared,
        Some(("memory.embeddings.status", None)),
        move |wire| {
            wire.query("memory.embeddings.status", json!({}))
                .map_err(|error| error.message)
                .and_then(|value| {
                    Embeddings::from_json(&value)
                        .ok_or_else(|| "The server's embeddings answer was unreadable.".to_string())
                })
        },
        move |state, embeddings| state.embeddings = Some(Arc::new(embeddings)),
    );
}

/// Sets up or rebuilds the embeddings index, then reads it again.
fn send_embeddings(shared: &Arc<Shared>, command: &str, all: bool) {
    let mut fields = json!({});
    if all {
        fields["all"] = json!(true);
    }
    let command = command.to_string();
    let shared = shared.clone();
    background(&shared.clone(), move |wire| {
        let indexed = wire
            .dispatch(&command, fields)
            .map_err(|error| problem(&error, None))?;
        let count = indexed.get("indexed").and_then(Value::as_u64).unwrap_or(0);
        shared.update(|state| {
            state.settings_notice = Some(SettingsNotice {
                text: format!("Indexed {count} memories."),
                error: false,
            });
        });
        read_embeddings_status(&shared);
        Ok(())
    });
}

/// Reads the skills under the thread's project, or the user's own.
fn read_skill_list(shared: &Arc<Shared>, thread: Option<ThreadId>) {
    let address = skills_address(&shared.state.lock().expect("live state"), thread);
    settings_read(
        shared,
        Some(("skills.manage.list", thread)),
        move |wire| {
            wire.query("skills.manage.list", address)
                .map_err(|error| error.message)
                .and_then(|value| {
                    value
                        .get("skills")
                        .and_then(Value::as_array)
                        .map(|skills| skills.iter().filter_map(ManagedSkill::from_json).collect())
                        .ok_or_else(|| "The server's skills answer was unreadable.".to_string())
                })
        },
        move |state, skills| state.managed_skills = Some(Arc::new(skills)),
    );
}

/// Reads one skill's text.
fn read_skill_detail(shared: &Arc<Shared>, thread: Option<ThreadId>, source: &str, folder: &str) {
    let fields = skill_fields(shared, thread, source, folder);
    let key = (source.to_string(), folder.to_string());
    settings_read(
        shared,
        None,
        move |wire| {
            wire.query("skills.manage.read", fields)
                .map_err(|error| error.message)
                .and_then(|value| {
                    text(&value, &["text"])
                        .map(str::to_string)
                        .ok_or_else(|| "The server's skill answer was unreadable.".to_string())
                })
        },
        move |state, detail| {
            state.skill_texts.insert(key, Arc::new(detail));
        },
    );
}

/// Saves a skill's text, then reads the list again.
fn send_skill_save(
    shared: &Arc<Shared>,
    thread: Option<ThreadId>,
    source: &str,
    folder: &str,
    text: &str,
    previous: &str,
) {
    let mut fields = skill_fields(shared, thread, source, folder);
    fields["text"] = json!(text);
    fields["previous"] = json!(previous);
    let shared = shared.clone();
    background(&shared.clone(), move |wire| {
        wire.dispatch("skills.save", fields)
            .map_err(|error| problem(&error, None))?;
        read_skill_list(&shared, thread);
        Ok(())
    });
}

/// Flips a skill's switch or its provider list, then reads the list again.
fn send_skill_field(
    shared: &Arc<Shared>,
    thread: Option<ThreadId>,
    command: &str,
    source: &str,
    folder: &str,
    field: &str,
    value: Value,
) {
    let mut fields = skill_fields(shared, thread, source, folder);
    fields[field] = value;
    let command = command.to_string();
    let shared = shared.clone();
    background(&shared.clone(), move |wire| {
        wire.dispatch(&command, fields)
            .map_err(|error| problem(&error, None))?;
        read_skill_list(&shared, thread);
        Ok(())
    });
}

/// Reads remote access and the paired devices together.
fn read_remote_state(shared: &Arc<Shared>) {
    settings_read(
        shared,
        Some(("remote.status", None)),
        move |wire| {
            wire.query("remote.status", json!({}))
                .map_err(|error| error.message)
                .and_then(|status| {
                    RemoteState::status_from_json(&status)
                        .ok_or_else(|| "The server's remote answer was unreadable.".to_string())
                })
                .and_then(|state| {
                    wire.query("remote.devices", json!({}))
                        .map(|devices| state.with_devices(&devices))
                        .map_err(|error| error.message)
                })
        },
        move |state, remote| state.remote = Some(Arc::new(remote)),
    );
}

/// Keeps the pairing on the last remote answer, if there is one.
fn set_pairing(shared: &Arc<Shared>, pairing: Option<settings::Pairing>) {
    shared.update(|state| {
        let Some(remote) = state.remote.clone() else {
            return;
        };
        let Ok(current) = remote.as_ref() else {
            return;
        };
        let mut next = current.clone();
        next.pairing = pairing;
        state.remote = Some(Arc::new(Ok(next)));
    });
}

/// Reads the providers' newest versions and Moxen's own update check together.
fn read_update_state(shared: &Arc<Shared>) {
    settings_read(
        shared,
        Some(("app.update.check", None)),
        move |wire| {
            let providers = wire
                .query("provider.latest", json!({}))
                .map(|value| UpdateState::providers_from_json(&value))
                .unwrap_or_default();
            wire.query("app.update.check", json!({}))
                .map_err(|error| error.message)
                .and_then(|value| {
                    UpdateState::check_from_json(&value)
                        .ok_or_else(|| "The server's update answer was unreadable.".to_string())
                })
                .map(|mut state| {
                    state.providers = providers;
                    state
                })
        },
        move |state, updates| state.updates = Some(Arc::new(updates)),
    );
}

/// Downloads, tests and switches to a release (or rolls back), then checks again.
fn send_app_update(shared: &Arc<Shared>, command: &str) {
    let command_id = uuid::Uuid::new_v4().to_string();
    let rollback = command == "app.update.rollback";
    let command = command.to_owned();
    let start = shared.update(|state| {
        if matches!(state.app_update, Some(Update::Running { .. })) || state.paired_name.is_some() {
            return None;
        }
        let wire = state.wire.clone()?;
        state.app_update = Some(Update::Running {
            command_id: command_id.clone(),
            rollback,
            progress: json!({"stage":"checking"}),
        });
        Some((wire, state.wire_epoch))
    });
    let Some((wire, epoch)) = start else { return };
    let worker = shared.clone();
    let spawned = std::thread::Builder::new()
        .name("moxen-app-update".into())
        .spawn(move || {
            let result = wire.dispatch(&command, json!({"commandId":command_id}));
            worker.update(|state| {
                if state.wire_epoch != epoch || state.wire.is_none() {
                    return;
                }
                state.app_update = Some(match result {
                    Ok(result) => {
                        let action = experience::string(&result, "action");
                        let version = experience::string(&result, "version");
                        state.settings_notice = Some(SettingsNotice {
                            text: if action == "already-current" {
                                "Already current.".into()
                            } else {
                                format!("Updated to {version}.")
                            },
                            error: false,
                        });
                        Update::Finished { rollback, result }
                    }
                    Err(error)
                        if matches!(
                            error.code.as_str(),
                            "CONNECTION_CLOSED" | "SERVER_DISCONNECTED" | "TIMEOUT"
                        ) =>
                    {
                        Update::Lost
                    }
                    Err(error) => Update::Failed {
                        code: error.code,
                        message: error.message,
                        rollback,
                    },
                });
            });
        });
    if let Err(error) = spawned {
        shared.update(|state| {
            if state.wire_epoch == epoch {
                state.app_update = Some(Update::Failed {
                    code: String::new(),
                    message: error.to_string(),
                    rollback,
                });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(
        id: ThreadId,
        uuid: &str,
        parent: Option<&str>,
        project: &str,
        sort: i64,
        settled: bool,
    ) -> Entry {
        Entry {
            id,
            uuid: uuid.into(),
            parent: parent.map(str::to_string),
            project: project.into(),
            sort_ms: sort,
            created_ms: sort,
            settled,
        }
    }

    #[test]
    fn reads_the_servers_timestamps() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2026-11-16T14:22:09.406Z"),
            Some(1_794_838_929_406)
        );
        // An offset moves the instant; a short fraction is milliseconds.
        assert_eq!(
            parse_iso_ms("2026-11-16T16:22:09.4+02:00"),
            parse_iso_ms("2026-11-16T14:22:09.400Z")
        );
        assert_eq!(parse_iso_ms("not a time"), None);
    }

    #[test]
    fn ages_and_badges_read_like_the_tui() {
        let now = 10_000_000;
        assert_eq!(relative_age(now, now - 59_000), "59s");
        assert_eq!(relative_age(now, now - 12 * 60_000), "12m");
        assert_eq!(relative_age(now, now - 3 * 3_600_000), "3h");
        assert_eq!(relative_age(now, now - 4 * 86_400_000), "4d");
        assert_eq!(project_badge("moxen"), "MN");
        assert_eq!(project_badge("agent-2"), "A2");
        assert_eq!(project_badge("--"), "??");
    }

    #[test]
    fn nests_tasks_under_their_parent_and_keeps_projects_together() {
        let entries = vec![
            entry(0, "a", None, "p1", 100, false),
            entry(1, "b", None, "p2", 300, false),
            entry(2, "task", Some("a"), "p1", 400, false),
            entry(3, "old", None, "p1", 50, true),
            entry(4, "c", None, "p1", 200, false),
        ];
        let arranged = arrange(&entries);
        // Newest first; the task follows its parent, not its own age.
        assert_eq!(arranged.flat, vec![1, 4, 0, 2, 3]);
        assert_eq!(arranged.depth[&2], 1);
        // p1 holds the newest turn (the task's); its settled thread follows its
        // live ones, and p2 comes after.
        assert_eq!(arranged.grouped, vec![4, 0, 2, 3, 1]);
        // A task whose parent was archived stays at the top level.
        let orphan = arrange(&[entry(0, "x", Some("gone"), "p", 1, false)]);
        assert_eq!(orphan.depth[&0], 0);
    }

    #[test]
    fn groups_by_project_when_projects_interleave() {
        let entries = vec![
            entry(0, "a", None, "p1", 400, false),
            entry(1, "b", None, "p2", 300, false),
            entry(2, "c", None, "p1", 200, false),
        ];
        assert_eq!(arrange(&entries).flat, vec![0, 1, 2]);
        assert_eq!(arrange(&entries).grouped, vec![0, 2, 1]);
    }

    #[test]
    fn settled_tasks_leave_the_sidebar_until_the_parent_settles() {
        let mut family = [
            entry(0, "parent", None, "p", 20, false),
            entry(1, "child", Some("parent"), "p", 30, true),
        ];
        assert_eq!(arrange(&family).sections, HashMap::from([(0, false)]));
        family[0].settled = true;
        let settled = arrange(&family);
        assert_eq!(settled.sections, HashMap::from([(0, true), (1, true)]));
        assert_eq!(settled.depth[&1], 1);
        family[1].settled = false;
        let anchored = arrange(&family);
        assert_eq!(anchored.sections, HashMap::from([(0, false), (1, false)]));
        assert_eq!(anchored.depth[&1], 1);
    }

    #[test]
    fn shell_keeps_snoozed_threads_and_reports_work_only_in_the_target_family() {
        let mut state = State::default();
        state.apply(&json!({
            "threads": [
                {"id": "root", "snoozedUntil": "2099-01-01T00:00:00Z"},
                {"id": "child", "parentThreadId": "root"},
                {"id": "grandchild", "parentThreadId": "child", "queuedTurns": [{"turnId": "q"}]},
                {"id": "past", "snoozedUntil": "2000-01-01T00:00:00Z"},
                {"id": "deleted", "deletedAt": "2026-01-01T00:00:00Z"}
            ],
            "archivedThreads": [{"id":"archived","title":"Archive"}]
        }));
        assert_eq!(state.slots[0].thread.status, Status::Snoozed);
        assert_eq!(state.slots[3].thread.status, Status::Idle);
        assert!(!state.arranged.sections[&0]);
        assert!(state.has_family_work(0));
        assert!(state.has_family_work(1));
        assert!(!state.has_family_work(3));
        assert!(!state.ids.contains_key("deleted"));
        assert_eq!(state.archived, [("archived".into(), "Archive".into())]);
    }

    #[test]
    fn only_the_latest_turns_usage_hit_and_checkpointed_messages_are_actionable() {
        let mut thread = json!({
            "latestTurn": {"turnId": "latest"},
            "activities": [
                {"kind":"usage.limit","turnId":"older","payload":{"resetsAt":"2098-01-01T00:00:00Z"}},
                {"kind":"usage.limit","turnId":"latest","payload":{"resetsAt":"2099-01-01T00:00:00Z"}}
            ],
            "messages": [{"id":"a","turnId":"older"},{"id":"b","turnId":"latest"}],
            "checkpoints": [{"turnId":"older","checkpointTurnCount":1}]
        });
        assert_eq!(
            usage_reset_of(&thread),
            parse_iso_ms("2099-01-01T00:00:00Z")
        );
        thread["latestTurn"]["turnId"] = json!("new turn");
        assert_eq!(usage_reset_of(&thread), None);
        assert_eq!(revert_targets(&thread), HashMap::from([("a".into(), 0)]));
    }

    #[test]
    fn a_side_question_in_flight_refuses_another_even_on_a_different_thread() {
        for (locale, refusal) in [
            ("en", "A side question is still being answered"),
            ("es-ES", "Todavía se está respondiendo otra pregunta aparte"),
        ] {
            crate::language::apply(Some(locale), None);
            let mut state = State::default();
            assert!(state.reserve_action(0, true));
            assert!(!state.reserve_action(1, true));
            assert_eq!(state.problems.pop_front().unwrap().message, refusal);
            assert!(state.reserve_action(1, false));
        }
    }

    #[test]
    fn the_latest_side_answer_is_preserved_per_thread_after_reading() {
        let mut state = State::default();
        state
            .side_answers
            .insert(0, SideAnswer::new("First answer".into()));
        state
            .side_answers
            .insert(1, SideAnswer::new("Other thread's answer".into()));
        let other = state.side_answers.get_mut(&1).unwrap();
        assert_eq!(other.read(true).as_deref(), Some("Other thread's answer"));
        assert!(other.read(true).is_none());
        let first = state.side_answers.get_mut(&0).unwrap();
        assert_eq!(first.read(true).as_deref(), Some("First answer"));
        assert_eq!(first.read(false).as_deref(), Some("First answer"));
    }

    #[test]
    fn a_snapshot_lists_visible_threads_and_keeps_ids_stable() {
        let mut state = State::default();
        state.apply(&json!({
            "projects": [{"id": "p", "title": "moxen"}],
            "threads": [
                {"id": "t1", "projectId": "p", "title": "Fix it", "createdAt": "2026-11-16T10:00:00.000Z",
                 "modelSelection": {"instanceId": "claude", "model": "opus"},
                 "session": {"status": "running"}, "archivedAt": null},
                {"id": "t2", "projectId": "p", "title": "Old", "createdAt": "2026-11-15T10:00:00.000Z",
                 "settledAt": "2026-11-15T11:00:00.000Z", "archivedAt": null},
                {"id": "t3", "projectId": "p", "title": "Gone", "archivedAt": "2026-11-15T11:00:00.000Z"},
                {"id": "t4", "projectId": "p", "title": "Internal", "hidden": true, "archivedAt": null},
            ],
        }));
        assert_eq!(state.arranged.flat, vec![0, 1]);
        assert_eq!(state.slots[0].thread.status, Status::Running);
        assert_eq!(state.slots[0].thread.project, "moxen");
        assert!(state.slots[1].thread.settled);
        // The server drops t1 and adds t5: t2 keeps its id, t5 gets a new one.
        state.apply(&json!({
            "projects": [{"id": "p", "title": "moxen"}],
            "threads": [
                {"id": "t5", "projectId": "p", "title": "New", "archivedAt": null},
                {"id": "t2", "projectId": "p", "title": "Old", "settledAt": "2026-11-15T11:00:00.000Z",
                 "unsettledAt": "2026-11-16T09:00:00.000Z", "archivedAt": null},
            ],
        }));
        assert_eq!(state.ids["t2"], 1);
        assert_eq!(state.ids["t5"], 2);
        assert!(!state.arranged.flat.contains(&0));
        // A later `unsettledAt` reopens the thread.
        assert!(!state.slots[1].thread.settled);
    }

    #[test]
    fn status_follows_the_sidebar_rules() {
        let status = |thread: Value| status_of(&thread);
        assert_eq!(
            status(json!({"session": {"status": "starting"}})),
            Status::Running
        );
        // A running turn outranks a pending question and a settled mark.
        assert_eq!(
            status(json!({"session": {"status": "running"}, "settledAt": "2026-01-01T00:00:00Z"})),
            Status::Running
        );
        assert_eq!(status(json!({"hasPendingApprovals": true})), Status::Held);
        assert_eq!(
            status(json!({"session": {"status": "ready", "lastError": "You hit the Usage Limit"}})),
            Status::Error
        );
        assert_eq!(
            status(json!({"latestTurn": {"state": "error"}})),
            Status::Error
        );
        assert_eq!(
            status(json!({"queuedTurns": [{"turnId": "x"}]})),
            Status::Queued
        );
        assert_eq!(
            status(json!({"settledAt": "2026-01-01T00:00:00Z", "latestTurn": {"state": "error"}})),
            Status::Idle
        );
    }

    fn waiting_thread() -> Value {
        json!({
            "messages": [
                {"id": "m1", "text": "first"},
                {"id": "m2", "text": "second"},
                {"id": "m3", "text": "continue"},
            ],
            "queuedTurns": [
                {"turnId": "t1", "messageId": "m1", "scheduledFor": null, "scheduleReason": null},
                {"turnId": "t2", "messageId": "m2", "scheduledFor": null, "scheduleReason": null},
                {"turnId": "t3", "messageId": "m3", "scheduledFor": "2026-11-16T20:00:00.000Z", "scheduleReason": "usage-reset"},
            ],
            "activities": [
                {"kind": "permission.requested", "payload": {"requestId": "perm1", "toolName": "Bash",
                    "classification": "command-execution", "detail": "cargo test"}},
                {"kind": "user-input.requested", "payload": {"requestId": "ask1", "questions": [
                    {"id": "q", "header": "Scope", "question": "Which?", "multiSelect": true,
                     "options": [{"label": "A"}, {"label": "B", "value": "b"}]}]}},
                {"kind": "turn.plan.updated", "payload": {"plan": [{"step": "Old plan", "status": "completed"}]}},
                {"kind": "turn.plan.updated", "payload": {"plan": [
                     {"step": "Pending first", "status": "pending"},
                     {"step": "In flight", "status": "in_progress"},
                     {"step": "Done out of order", "status": "completed"}]}},
                {"kind": "background.tasks", "payload": {"tasks": [{"taskId": "shell-1"}]}},
            ],
            "subagentRows": [{"agentId": "agent-1", "agentType": "Explore", "running": true, "stoppable": true}],
            "checkpoints": [
                {"turnId": "t1", "status": "available", "checkpointTurnCount": 1, "files": []},
                {"turnId": "t2", "status": "available", "checkpointTurnCount": 2,
                 "files": [{"path": "src/a.rs", "additions": 2, "deletions": 1}]},
            ],
        })
    }

    #[test]
    fn the_queue_follows_the_servers_order_and_marks_held_entries() {
        // Without the work queue they keep the thread's order; a usage-limit
        // continue belongs to the banner.
        let plain = queue_of(&waiting_thread(), None);
        assert_eq!(
            plain.iter().map(|q| q.text.as_str()).collect::<Vec<_>>(),
            ["first", "second"]
        );
        let read = json!({"entries": [
            {"threadId": "a", "turnId": "t2", "policy": {"held": true}},
            {"threadId": "a", "turnId": "t1", "policy": {"held": false}},
        ]});
        let queue = queue_of(&waiting_thread(), Some(&read));
        assert_eq!(queue[0].text, "second");
        assert!(queue[0].held && !queue[1].held);
        assert_eq!((queue[0].earlier, queue[0].later), (0, 1));
        assert_eq!((queue[1].earlier, queue[1].later), (1, 0));
    }

    #[test]
    fn moving_past_another_threads_entries_takes_one_step_each() {
        let queue: Vec<(String, String)> = [("a", "1"), ("b", "2"), ("b", "3"), ("a", "4")]
            .into_iter()
            .map(|(t, u)| (t.to_string(), u.to_string()))
            .collect();
        assert_eq!(move_steps(&queue, "a", "4", true), 3);
        assert_eq!(move_steps(&queue, "a", "1", false), 3);
        // Already first or last in its thread, or not listed: nothing to do.
        assert_eq!(move_steps(&queue, "a", "1", true), 0);
        assert_eq!(move_steps(&queue, "a", "9", false), 0);
    }

    #[test]
    fn a_new_thread_opens_once_the_shell_lists_it() {
        let mut state = State {
            opening: Some("t9".into()),
            ..State::default()
        };
        let snapshot = |threads: Value| json!({"projects": [{"id": "p", "title": "moxen"}], "threads": threads});
        state.apply(&snapshot(
            json!([{"id": "t1", "projectId": "p", "title": "Old"}]),
        ));
        assert_eq!(state.opened, None);
        state.apply(&snapshot(json!([
            {"id": "t1", "projectId": "p", "title": "Old"},
            {"id": "t9", "projectId": "p", "title": "New"},
        ])));
        assert_eq!(state.opened, Some(state.ids["t9"]));
        assert!(state.opening.is_none());
    }

    #[test]
    fn projects_are_offered_newest_first_without_scratch_folders() {
        let mut state = State::default();
        state.apply(&json!({
            "projects": [
                {"id": "idle", "title": "Idle"},
                {"id": "scratch", "title": "Scratch", "scratch": true},
                {"id": "busy", "title": "Busy"},
                {"id": "gone", "title": "Gone", "deletedAt": "2026-11-01T00:00:00.000Z"},
            ],
            "threads": [{"id": "t", "projectId": "busy", "title": "x", "createdAt": "2026-11-16T10:00:00.000Z"}],
        }));
        let titles: Vec<_> = state.projects.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, ["Busy", "Idle"]);
    }

    /// A server that serves one running thread with a message waiting in its
    /// queue, and records every command it is sent.
    #[cfg(unix)]
    fn settings_answer() -> Value {
        json!({
            "path": "/fake/config.json", "exists": true,
            "settings": [
                {"descriptor": {"key": "ui.theme", "label": "Theme", "description": "The look.",
                    "section": "interface", "group": "Looks",
                    "kind": {"type": "enum", "choices": [
                        {"value": "auto", "label": "Auto"},
                        {"value": "dark", "label": "Dark"}]}},
                 "value": "dark", "explicit": true,
                 "effective": {"value": "dark", "label": "Dark"}},
                {"descriptor": {"key": "ui.usageRefreshSeconds", "label": "Usage refresh", "description": "How often.",
                    "section": "interface", "group": "Looks",
                    "kind": {"type": "integer", "min": 5, "max": 600, "unit": "s"}},
                 "value": 30, "explicit": false},
                {"descriptor": {"key": "providers.harness.profiles", "label": "Profiles", "description": "Endpoints.",
                    "section": "provider:harness", "group": "Model servers",
                    "kind": {"type": "list", "noun": "profile", "actions": ["duplicate", "test", "probe", "transfer"], "fields": [
                        {"path": "baseUrl", "label": "Base URL", "description": "Address.", "group": "Endpoint", "kind": {"type": "string"}},
                        {"path": "apiKey", "label": "API key", "description": "Keychain.", "group": "Endpoint", "kind": {"type": "secret"}}]}},
                 "value": "", "explicit": true,
                 "items": [{"id": "office", "title": "office", "summary": "chat · http://localhost:8080",
                    "status": null,
                    "fields": [
                        {"path": "baseUrl", "value": "http://localhost:8080", "explicit": true},
                        {"path": "apiKey", "value": "keychain:x", "explicit": true}],
                    "resolved": []}]},
                {"descriptor": {"key": "mcp.servers", "label": "Servers", "description": "Programs.",
                    "section": "mcp",
                    "kind": {"type": "list", "noun": "server", "actions": ["test", "duplicate"], "fields": [
                        {"path": "url", "label": "URL", "description": "Address.", "group": "Connection", "kind": {"type": "string"}},
                        {"path": "env", "label": "Environment", "description": "Secrets.", "group": "Connection", "kind": {"type": "pairs", "secret": true}}]}},
                 "value": "", "explicit": true,
                 "items": [{"id": "search", "title": "search", "summary": "program · bunx",
                    "status": null,
                    "fields": [
                        {"path": "url", "value": "", "explicit": false},
                        {"path": "env", "value": "TOKEN=<hidden>", "explicit": true}],
                    "resolved": []}]},
            ],
        })
    }

    #[cfg(unix)]
    fn fake_server(path: std::path::PathBuf) -> Arc<Mutex<Vec<Value>>> {
        use std::io::{BufRead, Write};
        use std::os::unix::net::UnixListener;
        let listener = UnixListener::bind(&path).expect("bind");
        let commands = Arc::new(Mutex::new(Vec::<Value>::new()));
        let seen = commands.clone();
        let remote_enabled = Arc::new(std::sync::atomic::AtomicBool::new(true));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let stream = stream.expect("accept");
                let seen = seen.clone();
                let remote_enabled = remote_enabled.clone();
                std::thread::spawn(move || {
                    let mut writer = stream.try_clone().expect("clone");
                    let mut shell = None;
                    let mut completed = false;
                    let mut seen_release = false;
                    let mut repaired = HashSet::new();
                    let fake_experience = |completed, seen_release| {
                        json!({"version":"0.2.0","onboardingCompleted":completed,
                        "seenReleases":if seen_release { json!(["0.2.0"]) } else { json!([]) }, "releases":[{"version":"0.2.0","title":{"en":"Changes","es":"Cambios"}}]})
                    };
                    for line in std::io::BufReader::new(stream).lines() {
                        let Ok(line) = line else { break };
                        let message: Value = serde_json::from_str(&line).expect("json");
                        let id = message["id"].as_u64().expect("id");
                        let params = &message["params"];
                        let result = match message["method"].as_str().expect("method") {
                            "hello" => json!({"protocol": 1, "server": "moxen", "pid": 1,
                                "build": "b", "buildDisplay": "B", "restartRequired": false}),
                            "subscribeShell" | "subscribeThread" => {
                                let item = if message["method"] == "subscribeShell" {
                                    assert_eq!(params, &json!({}));
                                    shell = Some(id);
                                    json!({"kind": "snapshot", "snapshot": {
                                        "projects": [{"id": "p", "title": "moxen", "workspaceRoot": "/fake/project"}],
                                        "archivedThreads": [{"id": "archived", "title": "Archived work"}],
                                        "threads": [{"id": "t1", "projectId": "p", "title": "Fix",
                                            "session": {"status": "running"},
                                            "modelSelection": {"instanceId": "claude", "model": "opus"}},
                                            {"id": "child", "projectId": "p", "title": "Check focus",
                                             "parentThreadId": "t1", "branch": "task/focus",
                                             "delegationNotifies": true,
                                             "modelSelection": {"instanceId": "claude", "model": "opus"}},
                                            {"id": "archived", "projectId": "p", "parentThreadId": "t1",
                                             "archivedAt": "2026-11-16T10:00:00Z"}]}})
                                } else {
                                    assert_eq!(params, &json!({"threadId": "t1"}));
                                    json!({"kind": "snapshot", "snapshot": {"thread": waiting_thread()}})
                                };
                                writeln!(
                                    writer,
                                    "{}",
                                    json!({"id": id, "result": {"subscription": id}})
                                )
                                .unwrap();
                                writeln!(writer, "{}", json!({"subscription": id, "item": item}))
                                    .unwrap();
                                continue;
                            }
                            "getConfig" => json!({"providers": [{
                                "instanceId": "claude", "driver": "claudeAgent", "displayName": "Claude Code",
                                "enabled": true, "installed": true, "auth": {"status": "authenticated"},
                                "models": [
                                    {"slug": "opus", "name": "Opus", "isCustom": false,
                                     "capabilities": {"optionDescriptors": [
                                        {"id": "effort", "label": "Effort", "type": "select",
                                         "options": [{"id": "low", "label": "Low"}, {"id": "max", "label": "Max"}]}]}},
                                    {"slug": "haiku", "name": "Haiku", "isCustom": false}
                                ]}], "settings": {}}),
                            "turnDiff" => json!(
                                "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n"
                            ),
                            "query" => match params["type"].as_str() {
                                Some("experience.read") => {
                                    assert_eq!(params, &json!({"type":"experience.read"}));
                                    fake_experience(completed, seen_release)
                                }
                                Some("store.problems") => {
                                    assert_eq!(params, &json!({"type":"store.problems"}));
                                    let rows = [
                                        json!({"id":"bad","kind":"ledger","file":"store.json","line":7,"message":"Bad record"}),
                                        json!({"id":"stuck","kind":"turn-ownerless","threadId":"t1","turnId":"stuck-turn","message":"Stuck turn"}),
                                    ];
                                    json!({"problems":rows.iter().filter(|row| !repaired.contains(row["id"].as_str().unwrap())).collect::<Vec<_>>()})
                                }
                                Some("config.read") => {
                                    assert_eq!(params, &json!({"type":"config.read"}));
                                    json!({"path":"config.json","problems":if repaired.contains("theme") { json!([]) } else {
                                        json!([{"path":"ui.theme","message":"Bad theme"}]) }})
                                }
                                Some("doctor") => {
                                    assert_eq!(params, &json!({"type":"doctor"}));
                                    json!({"node":{"ok":true,"version":"1.3.13"},"git":{"ok":true},"providers":{"codex":{"ok":true}}})
                                }
                                Some("skills.list") => {
                                    seen.lock().unwrap().push(params.clone());
                                    json!({"trigger": "/", "skills": [{"name": "design-review", "enabled": true, "userInvocable": true}],"commands":[]})
                                }
                                Some("attachment.read" | "image.read") => {
                                    seen.lock().unwrap().push(params.clone());
                                    json!({"mimeType":"image/png","dataUrl":attachments::SAMPLE})
                                }
                                Some("thread.delegation") => {
                                    assert_eq!(
                                        params,
                                        &json!({"type": "thread.delegation", "threadId": "child"})
                                    );
                                    json!({"parentThreadId": "t1", "notify": true})
                                }
                                Some("thread.task.status") => {
                                    assert_eq!(
                                        params,
                                        &json!({"type": "thread.task.status", "parentThreadId": "t1", "taskId": "child"})
                                    );
                                    json!({"task": {"status": "running", "summary": "Checking focus"}})
                                }
                                Some("thread.subagent") => {
                                    assert_eq!(
                                        params,
                                        &json!({"type": "thread.subagent", "threadId": "t1", "agentId": "agent-1"})
                                    );
                                    json!({"available": true, "messages": [
                                        {"id": "m1", "role": "user", "text": "Trace the key path"},
                                        {"id": "m2", "role": "assistant", "text": "Found the listener"},
                                    ]})
                                }
                                Some("thread.background.list") => {
                                    assert_eq!(
                                        params,
                                        &json!({"type": "thread.background.list", "threadId": "t1"})
                                    );
                                    let stopped = seen.lock().unwrap().iter().any(|m| {
                                        m["type"] == "thread.background.stop"
                                            && m["taskId"] == "shell-1"
                                    });
                                    if stopped {
                                        json!({"live": true, "partial": true, "tasks": []})
                                    } else {
                                        json!({"live": true, "partial": true, "tasks": [{
                                            "taskId": "shell-1", "toolName": "Bash", "description": "Checks", "command": "cargo test"
                                        }, {
                                            "taskId": "watch", "toolName": "Monitor", "description": "Logs", "stoppable": false
                                        }]})
                                    }
                                }
                                Some("thread.background.output") => {
                                    assert_eq!(
                                        params,
                                        &json!({"type": "thread.background.output", "threadId": "t1", "taskId": "shell-1"})
                                    );
                                    if seen.lock().unwrap().iter().any(|m| {
                                        m["type"] == "thread.background.stop"
                                            && m["taskId"] == "shell-1"
                                    }) {
                                        json!({"available": false, "lines": []})
                                    } else {
                                        json!({"available": true, "lines": ["running", "done"]})
                                    }
                                }
                                Some("git.overview") => {
                                    json!({"isRepository": true, "root": "/work",
                                    "status": {"branch": "feature", "staged": 0, "unstaged": 2, "untracked": 0, "conflicted": 0},
                                    "branches": [{"name": "feature", "current": true, "remote": false, "ahead": 1, "behind": 0},
                                                 {"name": "main", "current": false, "remote": false, "ahead": null, "behind": null}],
                                    "commits": [{"sha": "abc1234567", "shortSha": "abc1234", "author": "A",
                                                 "date": "2026-11-16T10:00:00Z", "subject": "Fix", "refs": []}],
                                    "branch": "feature", "defaultBranch": "main"})
                                }
                                Some("forge.commits.checks") => {
                                    json!({"checks": {"abc1234567": {"passed": 3, "failed": 1, "pending": 0}}})
                                }
                                Some("forge.detect") => {
                                    json!({"kind": "github", "slug": "o/r", "installed": true, "authenticated": true})
                                }
                                Some("forge.requests.list") => json!({"requests": [
                                    {"number": 5, "title": "Other", "state": "open"},
                                    {"number": 7, "title": "Mine", "state": "open"}]}),
                                Some("forge.request.status") => {
                                    json!({"request": {"number": 7, "title": "Mine", "state": "open",
                                    "url": "https://x/7", "targetBranch": "main", "runs": [], "mergeable": "mergeable"}})
                                }
                                Some("git.commit.detail") => {
                                    json!({"commit": {"sha": "abc1234567", "subject": "Fix", "body": "",
                                    "author": "A", "date": "2026-11-16T10:00:00Z", "committer": "A", "committerDate": "2026-11-16T10:00:00Z",
                                    "parents": [], "refs": [], "files": [], "diff": null}})
                                }
                                Some("forge.commit.runs") => {
                                    json!({"runs": [{"name": "ci", "state": "failed", "url": "https://x/run"}]})
                                }
                                Some("workspace.git") if params["call"] == "changed" => {
                                    json!({"stdout": "src/a.rs\0"})
                                }
                                Some("workspace.git") => {
                                    json!({"stdout": "diff --git a/src/a.rs b/src/a.rs\n@@ -1 +1 @@\n-a\n+b\n"})
                                }
                                Some("queue.read") => json!({"entries": [
                                    {"threadId": "t1", "turnId": "t1", "policy": {"held": false}},
                                    {"threadId": "other", "turnId": "x", "policy": {"held": false}},
                                    {"threadId": "t1", "turnId": "t2", "policy": {"held": true}},
                                ]}),
                                Some("settings.read") => {
                                    assert_eq!(params, &json!({"type":"settings.read"}));
                                    settings_answer()
                                }
                                Some("harness.profile.export") => {
                                    seen.lock().unwrap().push(params.clone());
                                    json!({"id": params["profileId"], "text": "{\"id\": \"office\"}"})
                                }
                                Some("memory.list") => {
                                    assert_eq!(params["threadId"], "t1");
                                    json!({"projectId": "p", "index": null, "memories": [
                                        {"name": "tastes", "description": "Likes.", "type": "user",
                                         "scope": "global", "body": "Tea."},
                                    ]})
                                }
                                Some("memory.read") => {
                                    assert_eq!(params["threadId"], "t1");
                                    json!({"name": params["name"], "description": "Likes.", "type": "user",
                                         "scope": params["scope"], "body": "Tea."})
                                }
                                Some("memory.search") => {
                                    assert_eq!(params["threadId"], "t1");
                                    json!({"total": 1, "memories": [
                                        {"name": "tastes", "description": "Likes.", "scope": "global",
                                         "excerpt": "…Tea…"},
                                    ]})
                                }
                                Some("memory.embeddings.status") => {
                                    json!({"state": "ready", "device": null, "message": null,
                                        "file": null, "percent": null, "phase": "idle",
                                        "validation": null, "busy": false, "indexed": 2})
                                }
                                Some("skills.manage.list") => {
                                    assert_eq!(params["projectId"], "p");
                                    json!({"skills": [{
                                        "source": "agents", "folder": "review", "name": "review",
                                        "description": "Reviews a change.", "path": "/skills/review",
                                        "enabled": true, "editable": true, "providers": [],
                                    }], "roots": {"agents": "/a", "claude": "/c"}})
                                }
                                Some("skills.manage.read") => {
                                    assert_eq!(params["projectId"], "p");
                                    json!({"text": "# Review"})
                                }
                                Some("remote.status") => {
                                    let enabled = remote_enabled.load(Ordering::SeqCst);
                                    json!({"available": true, "enabled": enabled, "interfaces": {},
                                        "port": 47317, "listening": if enabled {
                                            json!([{"host": "192.168.1.2", "port": 47317}])
                                        } else { json!([]) }})
                                }
                                Some("remote.devices") => {
                                    json!({"devices": [{"id": "d1", "name": "Laptop",
                                        "pairedAt": "2026-11-16T10:00:00Z", "connections": 1}]})
                                }
                                Some("provider.latest") => {
                                    assert_eq!(params, &json!({"type":"provider.latest"}));
                                    json!({"enabled": true,
                                        "claude": {"latest": "2.0.0"},
                                        "opencode": {"latest": null}})
                                }
                                Some("app.update.check") => {
                                    assert_eq!(params, &json!({"type":"app.update.check"}));
                                    json!({"install": {"version": "0.2.0"}, "status": "available",
                                        "reason": null, "latest": {"version": "0.3.0"},
                                        "updatable": true})
                                }
                                other => panic!("unexpected fake-server query: {other:?}"),
                            },
                            "dispatch" => {
                                seen.lock().unwrap().push(params.clone());
                                match params["type"].as_str() {
                                    Some("experience.update") => {
                                        if params["completeOnboarding"] == true {
                                            assert_eq!(
                                                params,
                                                &json!({"type":"experience.update","completeOnboarding":true})
                                            );
                                            completed = true;
                                        } else {
                                            assert_eq!(
                                                params,
                                                &json!({"type":"experience.update","seenRelease":"0.2.0"})
                                            );
                                            seen_release = true;
                                        }
                                        fake_experience(completed, seen_release)
                                    }
                                    Some("store.quarantine") => {
                                        assert_eq!(
                                            params,
                                            &json!({"type":"store.quarantine","id":"bad"})
                                        );
                                        repaired.insert("bad");
                                        json!({"accepted":true})
                                    }
                                    Some("project.ensure") => {
                                        assert_eq!(
                                            params,
                                            &json!({"type":"project.ensure","cwd":"/guide/fixture","projectPolicy":"create"})
                                        );
                                        json!({"projectId":"p"})
                                    }
                                    Some("thread.background.stop") => {
                                        json!({"stopped": true, "taskId": params["taskId"]})
                                    }
                                    Some("thread.task.cancel") => {
                                        json!({"task": {"taskId": params["taskId"], "status": "cancel_requested"},
                                            "interruptRequested": true, "stateAfter": "running"})
                                    }
                                    Some(
                                        "thread.meta.update"
                                        | "thread.settle"
                                        | "thread.unsettle"
                                        | "thread.snooze"
                                        | "thread.unsnooze"
                                        | "thread.archive"
                                        | "thread.restore"
                                        | "thread.delete"
                                        | "thread.protect"
                                        | "thread.conversation.revert",
                                    ) => json!({"accepted": true}),
                                    Some("thread.handover" | "thread.continue") => {
                                        json!({"threadId": "new-thread"})
                                    }
                                    Some("thread.delegate") => json!({"child": {"id": "child"}}),
                                    Some("thread.side-question") => {
                                        json!({"text": "Separate answer"})
                                    }
                                    Some("prompt.improve") => {
                                        json!({"text": "Clarify the expected result.", "provider": "claude", "model": "opus"})
                                    }
                                    Some("thread.turn.start")
                                        if params["message"]["text"] == "reject draft" =>
                                    {
                                        writeln!(writer, "{}", json!({"id": id, "error": {
                                            "code": "ATTACHMENT_REJECTED", "message": "Attachment rejected by the server."
                                        }})).unwrap();
                                        continue;
                                    }
                                    Some("thread.turn.start" | "thread.turn.interrupt") => {
                                        if params["turnId"] == "stuck-turn" {
                                            assert_eq!(
                                                params,
                                                &json!({"type":"thread.turn.interrupt","threadId":"t1","turnId":"stuck-turn"})
                                            );
                                            repaired.insert("stuck");
                                        }
                                        json!({"accepted": true, "threadId": "new-thread"})
                                    }
                                    Some("settings.set" | "settings.duplicate")
                                        if params["value"] == "reject"
                                            || params["newId"] == "reject" =>
                                    {
                                        writeln!(writer, "{}", json!({"id": id, "error": {
                                            "code": "INVALID_CONFIG", "message": "Refused by the settings server."
                                        }})).unwrap();
                                        continue;
                                    }
                                    Some("settings.set" | "settings.duplicate") => {
                                        if params["key"] == "ui.theme" && params["value"] == "" {
                                            assert_eq!(
                                                params,
                                                &json!({"type":"settings.set","key":"ui.theme","value":""})
                                            );
                                            repaired.insert("theme");
                                        }
                                        if params["key"] == "remote.enabled" {
                                            remote_enabled
                                                .store(params["value"] == "true", Ordering::SeqCst);
                                        }
                                        settings_answer()
                                    }
                                    Some("harness.profile.test") => {
                                        json!({"ok": true, "profileId": params["profileId"],
                                            "model": "large", "latencyMs": 1200,
                                            "message": "Answered in 1.2s."})
                                    }
                                    Some("harness.profile.probe") => {
                                        json!({"profileId": params["profileId"], "model": "large",
                                            "at": "2026-11-16T10:00:00Z", "checks": [], "quirks": {},
                                            "server": {}, "notes": ["Single slot."],
                                            "stopped": null, "saved": true})
                                    }
                                    Some("mcp.server.test") => {
                                        json!({"ok": true, "name": params["name"],
                                            "message": "Listed 3 tools.",
                                            "tools": ["lookup", "fetch", "search"]})
                                    }
                                    Some("harness.models.discover") => {
                                        json!({"ok": true, "host": "localhost:8080",
                                            "models": [{"id": "large"}]})
                                    }
                                    Some("harness.profile.import") => {
                                        let mut answer = settings_answer();
                                        answer["id"] = params["text"].clone();
                                        answer["fileId"] = json!("office");
                                        answer
                                    }
                                    Some("memory.save") => {
                                        json!({"name": params["name"], "scope": params["scope"],
                                            "replaced": false, "total": 2})
                                    }
                                    Some("memory.delete") => {
                                        json!({"name": params["name"], "scope": params["scope"],
                                            "total": 1,
                                            "before": {"name": params["name"], "scope": params["scope"]}})
                                    }
                                    Some("memory.edit" | "memory.append") => {
                                        json!({"name": params["name"], "scope": params["scope"], "total": 2})
                                    }
                                    Some("memory.import-claude") => {
                                        json!({"from": "CLAUDE.md", "imported": ["CLAUDE.md"], "skipped": []})
                                    }
                                    Some(
                                        "memory.embeddings.setup" | "memory.embeddings.rebuild",
                                    ) => {
                                        json!({"indexed": 2})
                                    }
                                    Some("memory.embeddings.unload") => json!({"accepted": true}),
                                    Some(
                                        "skills.save"
                                        | "skills.enabled.set"
                                        | "skills.providers.set",
                                    ) => json!({"accepted": true}),
                                    Some("skills.remove") => json!({"movedTo": "review.md"}),
                                    Some("skills.import") => {
                                        json!({"source": params["source"], "folder": "review"})
                                    }
                                    Some("remote.pairing.start") => {
                                        json!({"code": "ABCD-EFGH", "expiresAt": "2026-11-16T11:00:00Z",
                                            "addresses": ["192.168.1.2:47317"], "fingerprint": "fp"})
                                    }
                                    Some("provider.update") => {
                                        json!({"provider": params["provider"], "before": "1.0.0",
                                            "after": "2.0.0", "updated": true, "output": ""})
                                    }
                                    Some("app.update.apply" | "app.update.rollback") => {
                                        let command = params["type"].as_str().unwrap();
                                        let command_id = params["commandId"].as_str().unwrap();
                                        assert!(uuid::Uuid::parse_str(command_id).is_ok());
                                        assert_eq!(
                                            params,
                                            &json!({"type":command,"commandId":command_id})
                                        );
                                        writeln!(writer, "{}", json!({"subscription":shell.unwrap(),"item":{"kind":"event","event":{
                                            "type":"app.update-progress","payload":{"commandId":command_id,"progress":{"stage":"downloading","bytes":10,"total":100}}}}})).unwrap();
                                        writeln!(writer, "{}", json!({"subscription":shell.unwrap(),"item":{"kind":"event","event":{
                                            "type":"app.server-restart-required","payload":{"version":"0.2.0","from":"0.1.0"}}}})).unwrap();
                                        json!({"action": "already-current", "version": "0.2.0"})
                                    }
                                    Some("remote.pairing.cancel" | "remote.device.revoke") => {
                                        json!({"accepted": true})
                                    }
                                    _ => json!({"accepted": true, "threadId": "new-thread"}),
                                }
                            }
                            _ => Value::Null,
                        };
                        writeln!(writer, "{}", json!({"id": id, "result": result})).unwrap();
                    }
                });
            }
        });
        commands
    }

    #[cfg(unix)]
    fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        while !ready() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn settings_source() -> ServerSource {
        ServerSource {
            target: ClientTarget::Desktop(Ok(None)),
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                revision: AtomicU64::new(0),
            }),
        }
    }

    #[cfg(unix)]
    #[test]
    fn application_experience_and_diagnostics_use_server_reads_and_exact_repairs() {
        let dir = std::env::temp_dir().join(format!("mx-exp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("s.sock");
        let commands = fake_server(socket.clone());
        let mut source = ServerSource::connect(socket.to_string_lossy().into_owned());
        let snapshot = |source: &ServerSource| {
            source
                .experience()
                .and_then(|answer| answer.as_ref().as_ref().ok().cloned())
        };
        wait_for("experience and problem reads", || {
            snapshot(&source).is_some() && source.records().len() == 3
        });
        assert!(!experience::completed(&snapshot(&source).unwrap()));
        assert!(experience::unread(&snapshot(&source).unwrap()));
        source.update_experience(json!({"completeOnboarding":true}));
        wait_for("onboarding acknowledgement", || {
            snapshot(&source).is_some_and(|current| experience::completed(&current))
        });
        source.update_experience(json!({"seenRelease":"0.2.0"}));
        wait_for("release acknowledgement", || {
            snapshot(&source).is_some_and(|current| !experience::unread(&current))
        });
        source.set_guide_memory(Memory::Embeddings);
        wait_for("the ordered settings writes", || {
            !source.experience_saving()
        });
        assert!(commands.lock().unwrap().ends_with(&[
            json!({"type":"settings.set","key":"memory","value":"true"}),
            json!({"type":"settings.set","key":"memoryEmbeddings","value":"true"})
        ]));
        source.add_guide_project("/guide/fixture".into());
        wait_for("the project result", || {
            source.take_added().as_deref() == Some("p")
        });
        source.create_thread(NewThread {
            project: None,
            prompt: "first draft".into(),
            runtime_mode: None,
            interaction_mode: "default".into(),
            model: None,
        });
        wait_for("the first thread in a separate workspace", || {
            commands.lock().unwrap().ends_with(&[
                json!({"type":"thread.create","scratch":true,"title":"first draft","interactionMode":"default"}),
                json!({"type":"thread.turn.start","threadId":"new-thread","message":{"text":"first draft"}}),
            ])
        });
        for (index, fix) in [
            Fix::MoveAside("bad".into()),
            Fix::Stop("t1".into(), "stuck-turn".into()),
            Fix::Reset("ui.theme".into()),
        ]
        .into_iter()
        .enumerate()
        {
            source.fix_record(fix);
            wait_for("the problems to refresh", || {
                source.records().len() == 2 - index
            });
        }
        source.read_diagnosis();
        wait_for("the doctor's answer", || {
            source.diagnosis().as_deref().is_some_and(|answer| {
                answer
                    .as_ref()
                    .is_ok_and(|value| value["node"]["version"] == "1.3.13")
            })
        });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_our_update_progress_is_applied_and_a_disconnect_releases_the_action() {
        let mut state = State {
            app_update: Some(Update::Running {
                command_id: "own".into(),
                rollback: false,
                progress: json!({"stage":"checking"}),
            }),
            ..Default::default()
        };
        let frame = |id| json!({"type":"app.update-progress","payload":{"commandId":id,"progress":{"stage":"testing"}}});
        apply_app_event(&mut state, &frame("another-client"));
        assert!(
            matches!(&state.app_update, Some(Update::Running { progress, .. }) if progress["stage"] == "checking")
        );
        apply_app_event(&mut state, &frame("own"));
        assert!(
            matches!(&state.app_update, Some(Update::Running { progress, .. }) if progress["stage"] == "testing")
        );
        end_session(&mut state);
        assert!(matches!(&state.app_update, Some(Update::Lost)));
        assert_eq!(state.wire_epoch, 1);
    }

    #[test]
    fn disconnected_settings_actions_do_not_stay_running() {
        let mut source = settings_source();
        source.set_setting("remote.enabled", "true");
        assert!(source.settings_saving().is_none());
        assert_eq!(
            source.take_settings_write(),
            Some(Err(not_connected().message))
        );
        for (scope, kind, action) in [
            (
                "harness",
                "test",
                ServerSource::test_harness as fn(&mut ServerSource, &str, Option<String>),
            ),
            ("harness", "probe", ServerSource::probe_harness),
            (
                "mcp",
                "test",
                |source: &mut ServerSource, name: &str, _: Option<String>| source.test_mcp(name),
            ),
        ] {
            action(&mut source, "office", None);
            assert_eq!(
                source.harness_run(),
                Some(HarnessRun::failed(
                    scope,
                    kind,
                    "office",
                    not_connected().message
                ))
            );
        }
        source.shared.update(|state| {
            state.settings_pending = Some("remote.enabled".into());
            state.harness_run = Some(HarnessRun::running("mcp", "test", "office"));
            end_session(state);
        });
        assert!(source.settings_saving().is_none());
        assert!(source.harness_run().is_none());
        assert_eq!(
            source.take_settings_write(),
            Some(Err(not_connected().message))
        );
    }

    #[test]
    fn a_disconnect_releases_in_flight_answers_actions_and_side_questions() {
        let mut state = State::default();
        state.answered.insert("ask1".into());
        state.actions.insert(0);
        state.asking_side_question = true;
        end_session(&mut state);
        assert!(state.answered.is_empty());
        assert!(state.actions.is_empty());
        assert!(!state.asking_side_question);
    }

    #[test]
    fn a_stale_refusal_or_completion_does_not_touch_a_reconnect() {
        let mut state = State {
            waiting: HashMap::from([(
                0,
                Waiting {
                    permissions: vec![Permission {
                        request: "perm1".into(),
                        tool: "Bash".into(),
                        classification: None,
                        detail: None,
                        description: None,
                    }],
                    asks: vec![],
                },
            )]),
            ..Default::default()
        };
        // The answer and the action go out on this connection.
        let epoch = state.wire_epoch;
        state.answered.insert("perm1".into());
        assert!(state.reserve_action(0, true));
        // The connection drops with the request still open and returns; the
        // person answers (and re-dispatches) again on the new connection.
        end_session(&mut state);
        assert!(state.answered.is_empty());
        state.wire_epoch += 1;
        state.answered.insert("perm1".into());
        assert!(state.reserve_action(0, true));
        // The dropped connection's late refusal and completion must touch
        // neither the new answer nor the new reservation.
        assert!(!reopen_refused(&mut state, epoch, 0, "perm1"));
        release_action(&mut state, epoch, 0, true);
        assert!(state.answered.contains("perm1"));
        assert!(state.actions.contains(&0));
        assert!(state.asking_side_question);
        // The new connection's own completion still releases.
        let epoch = state.wire_epoch;
        assert!(reopen_refused(&mut state, epoch, 0, "perm1"));
        release_action(&mut state, epoch, 0, true);
        assert!(!state.answered.contains("perm1"));
        assert!(!state.actions.contains(&0));
        assert!(!state.asking_side_question);
    }

    #[cfg(unix)]
    #[test]
    fn an_answer_before_a_disconnect_is_answerable_after_the_reconnect() {
        let (mut source, dir) = connect_settings_test("reply-reconnect");
        source.shared.update(|state| {
            state.apply(&json!({
                "projects": [{"id": "p", "title": "moxen", "workspaceRoot": "/fake/project"}],
                "threads": [{"id": "t1", "projectId": "p", "title": "Fix",
                    "session": {"status": "running"},
                    "modelSelection": {"instanceId": "claude", "model": "opus"}}],
            }));
            state.waiting.insert(
                0,
                Waiting {
                    permissions: vec![Permission {
                        request: "perm1".into(),
                        tool: "Bash".into(),
                        classification: Some("command-execution".into()),
                        detail: Some("cargo test".into()),
                        description: None,
                    }],
                    asks: vec![],
                },
            );
        });
        source.decide(0, "perm1", Decision::Allow);
        assert!(source.permission(0).is_none());
        // The connection drops with the request still open and returns.
        source.shared.update(end_session);
        let (wire, _) =
            Wire::connect(dir.join("s.sock").to_str().expect("socket path")).expect("reconnect");
        source.shared.update(|state| {
            state.wire_epoch += 1;
            state.wire = Some(Arc::new(wire));
        });
        // Still open, and answerable again.
        assert_eq!(
            source.permission(0).map(|ask| ask.request),
            Some("perm1".into())
        );
        source.decide(0, "perm1", Decision::Allow);
        assert!(source.permission(0).is_none());
        // The re-answer reaches the server and no stale refusal surfaces.
        std::thread::sleep(REFUSAL_GRACE + Duration::from_millis(200));
        assert!(source.take_problem().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn closing_settings_discards_discovery_and_export_answers() {
        let mut source = settings_source();
        source.shared.update(|state| {
            state.discovered = Some(Discovery::from_json(&json!({"ok": true, "models": []})));
            state.profile_document = Some(("office".into(), "{}".into()));
            state
                .settings_reads
                .insert(("harness.models.discover", None), 1);
            state
                .settings_reads
                .insert(("harness.profile.export", None), 2);
        });
        source.clear_settings_transients();
        assert!(source.take_profile_document().is_none());
        assert!(source.take_discovered().is_none());
        assert!(
            source
                .shared
                .state
                .lock()
                .unwrap()
                .settings_reads
                .is_empty()
        );
    }

    #[cfg(unix)]
    fn connect_settings_test(name: &str) -> (ServerSource, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("moxen-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temporary settings test directory");
        let path = dir.join("s.sock");
        fake_server(path.clone());
        let (wire, _) = Wire::connect(path.to_str().expect("socket path")).expect("test wire");
        let source = settings_source();
        source
            .shared
            .update(|state| state.wire = Some(Arc::new(wire)));
        (source, dir)
    }

    #[cfg(unix)]
    #[test]
    fn refused_settings_writes_release_pending_and_report_the_inline_error() {
        let (mut source, dir) = connect_settings_test("settings-refused");
        source.set_setting("ui.theme", "reject");
        wait_for("the refused setting", || source.settings_saving().is_none());
        assert_eq!(
            source.take_settings_write(),
            Some(Err("Refused by the settings server.".into()))
        );
        source.duplicate_setting("providers.harness.profiles", "office", "reject");
        wait_for("the refused duplicate", || {
            source.settings_saving().is_none()
        });
        assert_eq!(
            source.take_settings_write(),
            Some(Err("Refused by the settings server.".into()))
        );
        source.set_setting("ui.theme", "dark");
        wait_for("the accepted retry", || source.settings_saving().is_none());
        assert_eq!(source.take_settings_write(), Some(Ok(())));
        std::fs::remove_dir_all(dir).expect("remove test socket");
    }

    #[cfg(unix)]
    #[test]
    fn settings_reads_coalesce_and_drop_answers_from_before_reconnect() {
        use std::sync::mpsc::channel;
        struct Answer(std::sync::mpsc::Sender<()>);
        impl Drop for Answer {
            fn drop(&mut self) {
                self.0.send(()).expect("test receiver");
            }
        }

        let (source, dir) = connect_settings_test("settings-epoch");
        let key = Some(("settings.read", None));
        let (started, started_rx) = channel();
        let (release, release_rx) = channel();
        let (dropped, dropped_rx) = channel();
        settings_read(
            &source.shared,
            key,
            move |_| {
                started.send(()).unwrap();
                release_rx.recv().unwrap();
                Answer(dropped)
            },
            |state, _| state.settings = Some(Arc::new(Err("stale".into()))),
        );
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (duplicate, duplicate_rx) = channel();
        settings_read(
            &source.shared,
            key,
            move |_| Answer(duplicate),
            |state, _| state.settings = Some(Arc::new(Err("duplicate".into()))),
        );
        assert!(matches!(
            duplicate_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        ));
        source.shared.update(|state| {
            state.wire_epoch += 1;
            state.settings = Some(Arc::new(Err("new connection".into())));
        });
        release.send(()).unwrap();
        dropped_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            source.settings().as_deref().unwrap().as_ref().unwrap_err(),
            "new connection"
        );
        std::fs::remove_dir_all(dir).expect("remove test socket");
    }

    #[cfg(unix)]
    #[test]
    fn sends_steers_queues_and_edits_through_the_servers_commands() {
        let dir = std::env::temp_dir().join(format!("moxen-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("s.sock");
        let _ = std::fs::remove_file(&path);
        let commands = fake_server(path.clone());
        let mut source = ServerSource::connect(path.to_string_lossy().into_owned());
        wait_for("the thread list", || !source.list_threads().is_empty());
        source.focus(0);
        wait_for("the queue", || source.queued(0).len() == 2);
        // The server's order, and which entry is held.
        let queue = source.queued(0);
        assert_eq!(queue[0].key, "t1");
        assert!(queue[1].held);
        let sent = |expected: usize| {
            wait_for("the command", || commands.lock().unwrap().len() >= expected);
            commands.lock().unwrap()[expected - 1].clone()
        };

        // The thread is running: a plain send steers, Queue queues.
        source.send_message(0, "now".into(), Delivery::Steer);
        let steer = sent(1);
        assert_eq!(steer["type"], "thread.turn.start");
        assert_eq!(steer["threadId"], "t1");
        assert_eq!(steer["delivery"], "steer");
        assert_eq!(steer["message"]["text"], "now");
        assert_eq!(steer["wakeSettled"], true);
        source.send_message(0, "later".into(), Delivery::Queue);
        assert_eq!(sent(2)["delivery"], "queue");

        source.stop(0);
        let stop = sent(3);
        assert_eq!(stop["type"], "thread.turn.interrupt");
        assert!(stop.get("turnId").is_none());

        // Moving the second entry up passes the other thread's entry: the
        // global queue has t1, other, t2, so two steps reach the first.
        source.edit_queued(0, "t2", QueueEdit::Earlier);
        wait_for("two moves", || commands.lock().unwrap().len() >= 5);
        let moves = commands.lock().unwrap()[3..5].to_vec();
        assert!(
            moves
                .iter()
                .all(|m| m["type"] == "queue.edit" && m["action"] == "up" && m["turnId"] == "t2")
        );
        // Taking one back to edit returns its text and cancels that turn.
        assert_eq!(
            source
                .take_queued(0, "t1")
                .map(|prompt| prompt.text)
                .as_deref(),
            Some("first")
        );
        let cancel = sent(6);
        assert_eq!(cancel["type"], "thread.turn.interrupt");
        assert_eq!(cancel["turnId"], "t1");
        assert!(source.queued(0).iter().all(|q| q.key != "t1"));

        // A new thread is created in the project on the project's model, then
        // started with its message.
        source.create_thread(NewThread {
            project: Some("p".into()),
            prompt: "build it\nplease".into(),
            runtime_mode: Some("auto".into()),
            interaction_mode: "research".into(),
            model: None,
        });
        let create = sent(7);
        assert_eq!(create["type"], "thread.create");
        assert_eq!(create["projectId"], "p");
        assert_eq!(create["title"], "build it");
        assert_eq!(create["runtimeMode"], "auto");
        assert_eq!(create["interactionMode"], "research");
        assert_eq!(create["modelSelection"]["model"], "opus");
        let start = sent(8);
        assert_eq!(start["type"], "thread.turn.start");
        assert_eq!(start["threadId"], "new-thread");
        assert_eq!(start["message"]["text"], "build it\nplease");

        // The catalog the server reports, and a thread's model changing
        // through `thread.model-selection.set`, shown at once.
        wait_for("the catalog", || {
            matches!(source.catalog(), CatalogState::Ready(_))
        });
        let CatalogState::Ready(catalog) = source.catalog() else {
            unreachable!()
        };
        let haiku = catalog.rebase(source.selection(0).as_ref(), "claude", "haiku");
        source.set_model(0, haiku.clone());
        let set = sent(9);
        assert_eq!(set["type"], "thread.model-selection.set");
        assert_eq!(set["threadId"], "t1");
        assert_eq!(set["modelSelection"], haiku.to_json());
        assert_eq!(source.selection(0), Some(haiku));

        // A thread started with a model of its own does not take the project's.
        let max = catalog
            .rebase(None, "claude", "opus")
            .with_option("effort", "max");
        source.create_thread(NewThread {
            project: Some("p".into()),
            prompt: "again".into(),
            runtime_mode: None,
            interaction_mode: "default".into(),
            model: Some(max.clone()),
        });
        let create = sent(10);
        assert_eq!(create["modelSelection"], max.to_json());
        assert_eq!(sent(11)["modelSelection"], max.to_json());

        // The approval and the question the thread waits on, answered through
        // the server's commands; each is hidden as soon as it is answered.
        wait_for("the approval", || source.permission(0).is_some());
        let approval = source.permission(0).expect("approval");
        assert_eq!(
            (approval.request.as_str(), approval.tool.as_str()),
            ("perm1", "Bash")
        );
        source.decide(0, "perm1", Decision::AllowSession);
        let respond = sent(12);
        assert_eq!(respond["type"], "thread.permission.respond");
        assert_eq!(respond["threadId"], "t1");
        assert_eq!(respond["requestId"], "perm1");
        assert_eq!(respond["decision"], "accept-session");
        assert!(source.permission(0).is_none());

        let ask = source.ask(0).expect("question");
        assert_eq!(ask.request, "ask1");
        source.answer(
            0,
            "ask1",
            vec![("q".into(), Answer::Many(vec!["A".into(), "b".into()]))],
        );
        let answered = sent(13);
        assert_eq!(answered["type"], "thread.user-input.respond");
        assert_eq!(answered["requestId"], "ask1");
        assert_eq!(answered["answers"], json!({"q": ["A", "b"]}));
        assert!(source.ask(0).is_none());
        source.dismiss(0, "ask1");
        let dismissed = sent(14);
        assert_eq!(dismissed["type"], "thread.user-input.dismiss");
        assert_eq!(dismissed["requestId"], "ask1");

        // The Git tab: history, the forge and the branch's own request, each
        // from the server's own reads.
        source.read_git(0, None);
        wait_for("the pull request", || {
            let git = source.git(0);
            !git.loading_git && !git.loading_forge && git.status.is_some()
        });
        let git = source.git(0);
        let overview = git.overview.as_ref().expect("overview");
        assert_eq!(overview.checked_out(), Some("feature"));
        assert_eq!(overview.commits[0].subject, "Fix");
        assert_eq!(
            git.forge.as_ref().and_then(|f| f.slug.as_deref()),
            Some("o/r")
        );
        assert_eq!(git.requests.len(), 2);
        assert_eq!(git.status.as_ref().map(|s| s.request.number), Some(7));
        wait_for("the commit CI", || !source.git(0).commit_checks.is_empty());
        assert_eq!(
            source.git(0).commit_checks["abc1234567"]
                .glance()
                .unwrap()
                .1,
            "3/4"
        );

        // A commit opens in full, its CI after it.
        source.open_commit(0, "abc1234567");
        wait_for("the commit", || {
            source
                .git(0)
                .commit
                .as_ref()
                .is_some_and(|c| c.detail.is_some() && c.runs.is_some())
        });
        source.close_commit(0);
        assert!(source.git(0).commit.is_none());

        // The turns that changed files, one turn's patch and the uncommitted changes.
        assert_eq!(source.turn_diffs(0).len(), 1);
        assert_eq!(source.turn_diffs(0)[0].turn, 2);
        assert_eq!(source.turn_patch(0, 2), None);
        source.read_turn_patch(0, 2);
        wait_for("the turn's patch", || {
            matches!(source.turn_patch(0, 2), Some(Patch::Ready(_)))
        });
        let Some(Patch::Ready(files)) = source.turn_patch(0, 2) else {
            unreachable!()
        };
        assert_eq!(
            (files[0].path.as_str(), files[0].additions),
            ("src/a.rs", 2)
        );
        source.read_tree_patch(0);
        wait_for("the working tree", || {
            matches!(source.tree_patch(0), Some(Patch::Ready(_)))
        });

        // Forge writes go through the server's commands, name themselves while
        // they run and say what came of it.
        source.comment_on_request(0, 7, "looks good".into());
        let comment = sent(15);
        assert_eq!(comment["type"], "forge.request.comment");
        assert_eq!(comment["threadId"], "t1");
        assert_eq!(
            (comment["number"].as_i64(), comment["body"].as_str()),
            (Some(7), Some("looks good"))
        );
        wait_for("the comment notice", || {
            source.git(0).notice.as_deref() == Some("Commented on #7.")
        });
        source.merge_request(0, 7, MergeStrategy::Squash);
        let merge = sent(16);
        assert_eq!(merge["type"], "forge.request.merge");
        assert_eq!(merge["strategy"], "squash");
        assert_eq!(merge["deleteBranch"], false);
        source.create_request(
            0,
            NewRequest {
                title: "Add it".into(),
                draft: true,
                base: Some("main".into()),
            },
        );
        let create = sent(17);
        assert_eq!(create["type"], "forge.request.create");
        assert_eq!(create["title"], "Add it");
        assert_eq!(create["draft"], true);
        assert_eq!(create["targetBranch"], "main");

        source.stop_background(0, "shell-1");
        assert_eq!(
            sent(18),
            json!({
                "type": "thread.background.stop", "threadId": "t1", "taskId": "shell-1",
            })
        );
        source.stop_background(0, "agent-1");
        assert_eq!(
            sent(19),
            json!({
                "type": "thread.background.stop", "threadId": "t1", "taskId": "agent-1",
            })
        );
        source.cancel_task(1, false);
        assert_eq!(
            sent(20),
            json!({
                "type": "thread.task.cancel", "parentThreadId": "t1", "taskId": "child",
                "notifyParent": false,
            })
        );
        let choice = Selection::from_json(&json!({
            "instanceId": "codex", "model": "gpt", "options": [{"id": "reasoningEffort", "value": "high"}],
        })).unwrap();
        let mut old = source.selection(0).unwrap().with_option("effort", "medium");
        old.options
            .push(("fastMode".into(), OptionValue::Flag(false)));
        source.shared.update(|state| {
            state.slots[0].selection = Some(old.to_json());
            state.transcripts.get_mut(&0).unwrap().usage_reset =
                parse_iso_ms("2099-01-01T00:00:00Z");
        });
        old.options.reverse();
        let cases = [
            (
                ThreadAction::Rename("New title".into()),
                json!({"type":"thread.meta.update","threadId":"t1","title":"New title"}),
            ),
            (
                ThreadAction::RegenerateTitle,
                json!({"type":"thread.meta.update","threadId":"t1","regenerateTitle":true}),
            ),
            (
                ThreadAction::Settle { stop: false },
                json!({"type":"thread.settle","threadId":"t1"}),
            ),
            (
                ThreadAction::Settle { stop: true },
                json!({"type":"thread.settle","threadId":"t1","stop":true}),
            ),
            (
                ThreadAction::Unsettle,
                json!({"type":"thread.unsettle","threadId":"t1","reason":"user"}),
            ),
            (
                ThreadAction::Snooze("2099-01-01T00:00:00.000Z".into()),
                json!({"type":"thread.snooze","threadId":"t1","snoozedUntil":"2099-01-01T00:00:00.000Z"}),
            ),
            (
                ThreadAction::Unsnooze,
                json!({"type":"thread.unsnooze","threadId":"t1"}),
            ),
            (
                ThreadAction::Archive,
                json!({"type":"thread.archive","threadId":"t1"}),
            ),
            (
                ThreadAction::Delete,
                json!({"type":"thread.delete","threadId":"t1"}),
            ),
            (
                ThreadAction::Protect,
                json!({"type":"thread.protect","threadId":"t1"}),
            ),
            (
                ThreadAction::Handover {
                    prompt: "Handoff".into(),
                    selection: choice.with_option("serviceTier", "fast"),
                },
                json!({"type":"thread.handover","cwd":"/fake/project","prompt":"Handoff","provider":"codex","model":"gpt","thinkingEffort":"high","speedMode":"fast","wait":false}),
            ),
            (
                ThreadAction::Continue { selection: None },
                json!({"type":"thread.continue","threadId":"t1","scheduledFor":"2099-01-01T00:01:00.000Z"}),
            ),
            (
                ThreadAction::Continue {
                    selection: Some(old),
                },
                json!({"type":"thread.continue","threadId":"t1","scheduledFor":"2099-01-01T00:01:00.000Z"}),
            ),
            (
                ThreadAction::Continue {
                    selection: Some(choice.clone()),
                },
                json!({"type":"thread.continue","threadId":"t1","modelSelection":choice.to_json()}),
            ),
            (
                ThreadAction::Delegate {
                    task: "Check it".into(),
                    selection: Selection {
                        options: vec![("fastMode".into(), OptionValue::Flag(false))],
                        ..choice.clone()
                    },
                },
                json!({"type":"thread.delegate","parentThreadId":"t1","task":"Check it","provider":"codex","model":"gpt","speedMode":"standard","wait":false,"isolation":"shared"}),
            ),
            (
                ThreadAction::SideQuestion("Why?".into()),
                json!({"type":"thread.side-question","threadId":"t1","question":"Why?"}),
            ),
            (
                ThreadAction::Revert {
                    turn_count: 0,
                    restore_files: false,
                    draft: Some("Prompt".into()),
                },
                json!({"type":"thread.conversation.revert","threadId":"t1","turnCount":0}),
            ),
            (
                ThreadAction::Revert {
                    turn_count: 2,
                    restore_files: true,
                    draft: None,
                },
                json!({"type":"thread.conversation.revert","threadId":"t1","turnCount":2,"restoreFiles":true}),
            ),
        ];
        let restore_at = 21 + cases.len();
        for (at, (action, expected)) in cases.into_iter().enumerate() {
            source.thread_action(0, action);
            assert_eq!(sent(21 + at), expected);
            wait_for("thread action acknowledgement", || {
                !source.action_pending(0)
            });
        }
        assert_eq!(source.take_settled(), Some(0));
        assert_eq!(source.take_opened(), Some(1));
        assert_eq!(
            source.read_side_answer(0, true).as_deref(),
            Some("Separate answer")
        );
        assert_eq!(source.take_reverted(), Some((0, None)));
        assert_eq!(
            source.archived(),
            [("archived".into(), "Archived work".into())]
        );
        source.restore_thread("archived");
        assert_eq!(
            sent(restore_at),
            json!({"type":"thread.restore","threadId":"archived"})
        );
        assert!(source.archived().is_empty());
        source.thread_action(0, ThreadAction::ContinueAtReset);
        assert_eq!(
            sent(restore_at + 1),
            json!({
                "type": "thread.turn.start", "threadId": "t1",
                "message": {"text": "The usage limit that stopped the last turn has reset. Continue the task where you left off."},
                "scheduledFor": "2099-01-01T00:01:00.000Z", "scheduleReason": "usage-reset",
            })
        );
        wait_for("continue schedule acknowledgement", || {
            !source.action_pending(0)
        });
        source
            .shared
            .update(|state| state.slots[1].scheduled_continue = Some("reset-turn".into()));
        assert!(source.notifies_parent(1));
        assert!(!source.notifies_parent(0));
        let guarded_cases = [
            (
                1,
                ThreadAction::CancelContinue {
                    notify_parent: false,
                },
                None,
                Some(
                    json!({"type":"thread.turn.interrupt","threadId":"child","turnId":"reset-turn","notifyParent":false}),
                ),
            ),
            (
                1,
                ThreadAction::CancelContinue {
                    notify_parent: true,
                },
                None,
                Some(
                    json!({"type":"thread.turn.interrupt","threadId":"child","turnId":"reset-turn"}),
                ),
            ),
            (
                1,
                ThreadAction::ContinueAtReset,
                parse_iso_ms("2099-01-01T00:00:00Z"),
                None,
            ),
            (0, ThreadAction::ContinueAtReset, None, None),
            (
                0,
                ThreadAction::ContinueAtReset,
                parse_iso_ms("2000-01-01T00:00:00Z"),
                None,
            ),
            (
                0,
                ThreadAction::Handover {
                    prompt: "Missing checkout".into(),
                    selection: choice,
                },
                None,
                None,
            ),
            (
                0,
                ThreadAction::Continue { selection: None },
                None,
                Some(json!({"type":"thread.continue","threadId":"t1"})),
            ),
        ];
        let mut sent_through = restore_at + 1;
        for (id, action, reset, expected) in guarded_cases {
            source.shared.update(|state| {
                state.slots[id].cwd = None;
                state.transcripts.entry(id).or_default().usage_reset = reset;
            });
            source.thread_action(id, action);
            if let Some(expected) = expected {
                assert_eq!(sent(sent_through + 1), expected);
                sent_through += 1;
                wait_for("guarded action acknowledgement", || {
                    !source.action_pending(id)
                });
            } else {
                // Commands reserve their slot synchronously before writing.
                assert!(!source.action_pending(id));
            }
            assert_eq!(commands.lock().unwrap().len(), sent_through);
        }
        let mut expect = |payload: Value| {
            sent_through += 1;
            assert_eq!(sent(sent_through), payload);
        };
        source.set_modes(0, "full-access", "orchestrate");
        expect(
            json!({"type":"thread.interaction-mode.set","threadId":"t1","interactionMode":"orchestrate"}),
        );
        let destination = Destination::Project("p".into());
        let model = Selection::from_json(&json!({"instanceId":"claude","model":"opus"})).unwrap();
        source.read_skills(&destination, Some(&model));
        expect(json!({"type":"skills.list", "instanceId":"claude", "cwd":"/fake/project"}));
        wait_for("the skill inventory", || {
            source.skills(&destination, Some(&model)).is_some()
        });
        assert_eq!(
            source
                .skills(&destination, Some(&model))
                .unwrap()
                .as_ref()
                .as_ref()
                .unwrap()
                .0[0]
                .invocation,
            "/design-review"
        );
        source.read_skills(&destination, Some(&model));

        let stored = Picture::Stored("img-1".into());
        source.read_image(&stored);
        expect(json!({"type":"attachment.read", "attachmentId":"img-1"}));
        let path = std::path::PathBuf::from("screenshots")
            .join("result.png")
            .to_string_lossy()
            .into_owned();
        let reply = Picture::Reply {
            thread: 0,
            path: path.clone(),
        };
        source.read_image(&reply);
        expect(json!({"type":"image.read", "threadId":"t1", "path":path}));
        wait_for("both image reads", || {
            source.image(&stored).is_some() && source.image(&reply).is_some()
        });
        let image = source.image(&stored).unwrap().unwrap();
        assert_eq!(source.image(&reply).unwrap().unwrap(), image);

        let request = Improvement {
            destination,
            revision: 7,
            directory: "/fake/project".into(),
            selection: Some(model.clone()),
            original: "fix it".into(),
        };
        source.improve(request.clone());
        expect(
            json!({"type":"prompt.improve", "directory":"/fake/project", "prompt":"fix it",
            "modelSelection":{"instanceId":"claude","model":"opus"}, "protectedText":[]}),
        );
        let mut improved = None;
        wait_for("improved draft", || {
            improved = source.take_improvement();
            improved.is_some()
        });
        assert_eq!(
            improved,
            Some((request, Some("Clarify the expected result.".into())))
        );

        let asset = Asset::Image {
            name: "shot.png".into(),
            image,
        };
        let upload = json!({"type":"image","name":"shot.png","mimeType":"image/png","sizeBytes":68,"dataUrl":attachments::SAMPLE});
        let with = |text: &str, once: &str| Prompt {
            text: text.into(),
            assets: vec![asset.clone()],
            once: Some(once.into()),
        };
        source.send_message(0, with("inspect", "review"), Delivery::Queue);
        expect(
            json!({"type":"thread.turn.start", "threadId":"t1", "message":{"text":"inspect", "attachments":[upload]},
            "wakeSettled":true,"delivery":"queue"}),
        );
        source.shared.update(|state| {
            state.slots[0].thread.status = Status::Idle;
        });
        let rejected = with("reject draft", "review");
        source.send_message(0, rejected.clone(), Delivery::Steer);
        expect(
            json!({"type":"thread.turn.start", "threadId":"t1", "message":{"text":"reject draft", "attachments":[upload]},
            "wakeSettled":true,"interactionMode":"review"}),
        );
        let mut failed = None;
        wait_for("the rejected message", || {
            failed = source.take_problem();
            failed.is_some()
        });
        assert_eq!(failed.unwrap().unsent, Some((Some(0), rejected)));

        source.create_thread(NewThread {
            project: Some("p".into()),
            prompt: with("", "orchestrate"),
            runtime_mode: None,
            interaction_mode: "default".into(),
            model: Some(model),
        });
        expect(
            json!({"type":"thread.create","projectId":"p","title":"[Image #1]","interactionMode":"default",
            "modelSelection":{"instanceId":"claude","model":"opus"}}),
        );
        expect(
            json!({"type":"thread.turn.start","threadId":"new-thread","interactionMode":"orchestrate",
            "message":{"text":"[Image #1]","attachments":[upload]},"modelSelection":{"instanceId":"claude","model":"opus"}}),
        );

        // The settings surface: one read, writes that refresh from the answer,
        // and the profile, memory, skill, remote and update commands.
        source.read_settings();
        wait_for("the settings snapshot", || source.settings().is_some());
        let snapshot = source
            .settings()
            .expect("settings")
            .as_ref()
            .as_ref()
            .expect("snapshot")
            .clone();
        assert_eq!(snapshot.path, "/fake/config.json");
        assert_eq!(
            snapshot.sections(),
            vec!["interface", "provider:harness", "mcp", "skills"]
        );
        let theme = snapshot.find("ui.theme").expect("theme");
        assert_eq!(crate::settings::display_value(theme), "dark");
        // A secret reads as storage, never the key.
        let profiles = snapshot
            .find("providers.harness.profiles")
            .expect("profiles");
        let office = &profiles.items[0];
        assert_eq!(office.id, "office");
        let key = office
            .fields
            .iter()
            .find(|field| field.path == "apiKey")
            .expect("key");
        assert_eq!(
            crate::settings::display_field(key, profiles.field_schema("apiKey")),
            "Saved in the keychain"
        );
        source.set_setting("ui.theme", "dark");
        expect(json!({"type":"settings.set","key":"ui.theme","value":"dark"}));
        wait_for("the settings write", || source.settings_saving().is_none());
        source.duplicate_setting("providers.harness.profiles", "office", "office-2");
        expect(
            json!({"type":"settings.duplicate","key":"providers.harness.profiles",
            "id":"office","newId":"office-2"}),
        );
        source.test_harness("office", Some("large".into()));
        expect(json!({"type":"harness.profile.test","profileId":"office","model":"large"}));
        wait_for("the test answer", || {
            matches!(
                source.harness_run(),
                Some(HarnessRun::Done { ok: true, .. })
            )
        });
        source.probe_harness("office", None);
        expect(json!({"type":"harness.profile.probe","profileId":"office"}));
        wait_for("the probe answer", || {
            matches!(
                source.harness_run(),
                Some(HarnessRun::Done { kind, .. }) if kind == "probe"
            )
        });
        source.test_mcp("search");
        expect(json!({"type":"mcp.server.test","name":"search"}));
        wait_for("the MCP answer", || {
            matches!(
                source.harness_run(),
                Some(HarnessRun::Done { scope, .. }) if scope == "mcp"
            )
        });
        let tools = match source.harness_run() {
            Some(HarnessRun::Done { tools, .. }) => tools,
            _ => unreachable!(),
        };
        assert_eq!(
            tools,
            vec![
                "lookup".to_string(),
                "fetch".to_string(),
                "search".to_string()
            ]
        );
        source.discover_models("http://localhost:8080", "chat", Some("MODELS_KEY".into()));
        expect(
            json!({"type":"harness.models.discover","baseUrl":"http://localhost:8080",
            "apiFormat":"chat","apiKeyEnv":"MODELS_KEY"}),
        );
        let mut discovered = None;
        wait_for("the discovery answer", || {
            discovered = source.take_discovered();
            discovered.is_some()
        });
        assert_eq!(discovered.expect("discovered").models[0].id, "large");
        source.export_profile("office");
        expect(json!({"type":"harness.profile.export","profileId":"office"}));
        let mut document = None;
        wait_for("the export answer", || {
            document = source.take_profile_document();
            document.is_some()
        });
        assert_eq!(
            document.expect("document"),
            ("office".to_string(), "{\"id\": \"office\"}".to_string())
        );
        source.import_profile("{\"id\": \"branch\"}");
        expect(
            json!({"type":"harness.profile.import","text":"{\"id\": \"branch\"}",
            "onConflict":"rename"}),
        );
        let mut notice = None;
        wait_for("the import notice", || {
            notice = source.take_settings_notice();
            notice.is_some()
        });
        assert!(!notice.expect("notice").error);

        // Memories: the list, one entry in full, a search, and every write.
        source.read_memories(Some(0));
        wait_for("the memories", || source.memories().is_some());
        assert_eq!(
            source
                .memories()
                .expect("memories")
                .as_ref()
                .as_ref()
                .expect("list")
                .memories
                .len(),
            1
        );
        source.read_memory(Some(0), "tastes", "global");
        wait_for("the memory", || {
            source.memory_detail("tastes", "global").is_some()
        });
        assert_eq!(
            source
                .memory_detail("tastes", "global")
                .expect("detail")
                .as_ref()
                .as_ref()
                .expect("memory")
                .body
                .as_deref(),
            Some("Tea.")
        );
        source.search_memories(Some(0), "tea");
        wait_for("the search", || source.memory_search().is_some());
        assert_eq!(
            source
                .memory_search()
                .expect("search")
                .as_ref()
                .as_ref()
                .expect("results")
                .total,
            1
        );
        source.save_memory(
            Some(0),
            MemoryDraft {
                name: "n".into(),
                description: "d".into(),
                memory_type: "user".into(),
                body: "b".into(),
                scope: "global".into(),
            },
        );
        expect(
            json!({"type":"memory.save","threadId":"t1","name":"n","description":"d",
            "memoryType":"user","body":"b","scope":"global"}),
        );
        source.delete_memory(Some(0), "n", "global");
        expect(json!({"type":"memory.delete","threadId":"t1","name":"n","scope":"global"}));
        source.delete_memory(Some(0), "tastes", "global");
        expect(json!({"type":"memory.delete","threadId":"t1","name":"tastes","scope":"global"}));
        wait_for("the deleted memory to leave the detail cache", || {
            source.memory_detail("tastes", "global").is_none()
        });
        source.edit_memory(Some(0), "n", "global", "a", "b", None);
        expect(
            json!({"type":"memory.edit","threadId":"t1","name":"n","scope":"global",
            "oldText":"a","newText":"b"}),
        );
        source.append_memory(Some(0), "n", "global", "more");
        expect(
            json!({"type":"memory.append","threadId":"t1","name":"n","scope":"global",
            "text":"more"}),
        );
        source.import_claude_memory(Some(0));
        expect(json!({"type":"memory.import-claude","threadId":"t1"}));
        wait_for("the import notice", || {
            source.take_settings_notice().is_some()
        });
        source.read_embeddings();
        wait_for("the embeddings", || source.embeddings().is_some());
        assert_eq!(
            source
                .embeddings()
                .expect("embeddings")
                .as_ref()
                .as_ref()
                .expect("engine")
                .line(),
            "Ready · 2 memories indexed"
        );
        source.setup_embeddings(false);
        expect(json!({"type":"memory.embeddings.setup"}));
        source.rebuild_embeddings(true);
        expect(json!({"type":"memory.embeddings.rebuild","all":true}));
        source.unload_embeddings();
        expect(json!({"type":"memory.embeddings.unload"}));

        // Skills: the list, one text, and every write.
        source.read_managed_skills(Some(0));
        wait_for("the skills", || source.managed_skills().is_some());
        assert_eq!(
            source
                .managed_skills()
                .expect("skills")
                .as_ref()
                .as_ref()
                .expect("list")
                .len(),
            1
        );
        source.read_skill_text(Some(0), "agents", "review");
        wait_for("the skill text", || {
            source.skill_text("agents", "review").is_some()
        });
        assert_eq!(
            source
                .skill_text("agents", "review")
                .expect("text")
                .as_ref()
                .as_ref()
                .expect("skill")
                .as_str(),
            "# Review"
        );
        source.save_skill(Some(0), "agents", "review", "# R", "# Review");
        expect(
            json!({"type":"skills.save","projectId":"p","source":"agents","folder":"review",
            "text":"# R","previous":"# Review"}),
        );
        source.set_skill_enabled(Some(0), "agents", "review", false);
        expect(
            json!({"type":"skills.enabled.set","projectId":"p","source":"agents",
            "folder":"review","enabled":false}),
        );
        source.set_skill_providers(Some(0), "agents", "review", vec!["claude".into()]);
        expect(
            json!({"type":"skills.providers.set","projectId":"p","source":"agents",
            "folder":"review","providers":["claude"]}),
        );
        source.remove_skill(Some(0), "agents", "review");
        expect(json!({"type":"skills.remove","projectId":"p","source":"agents","folder":"review"}));
        source.import_skill(Some(0), "agents", "/docs/skill");
        expect(
            json!({"type":"skills.import","projectId":"p","source":"agents","from":"/docs/skill"}),
        );

        // Remote access and updates.
        source.read_remote();
        wait_for("remote access", || source.remote().is_some());
        let remote = source.remote().expect("remote");
        let remote = remote.as_ref().as_ref().expect("state");
        assert!(remote.enabled);
        assert_eq!(remote.devices.len(), 1);
        assert_eq!(remote.line(), "Listening on 192.168.1.2:47317.");
        source.pair_remote();
        expect(json!({"type":"remote.pairing.start"}));
        wait_for("the pairing code", || {
            source.remote().is_some_and(|state| {
                state
                    .as_ref()
                    .as_ref()
                    .is_ok_and(|state| state.pairing.is_some())
            })
        });
        source.cancel_pairing();
        expect(json!({"type":"remote.pairing.cancel"}));
        source.revoke_device("d1");
        expect(json!({"type":"remote.device.revoke","deviceId":"d1"}));
        source.set_setting("remote.enabled", "false");
        expect(json!({"type":"settings.set","key":"remote.enabled","value":"false"}));
        wait_for("the remote switch to refresh after the write", || {
            source
                .remote()
                .is_some_and(|state| state.as_ref().as_ref().is_ok_and(|state| !state.enabled))
        });
        source.read_updates();
        wait_for("the updates", || source.updates().is_some());
        let updates = source.updates().expect("updates");
        let updates = updates.as_ref().as_ref().expect("state");
        assert_eq!(updates.line(), "0.2.0 → 0.3.0 ready.");
        assert_eq!(updates.providers.len(), 2);
        assert_eq!(updates.providers[0].latest.as_deref(), Some("2.0.0"));
        source.update_provider("claude");
        expect(json!({"type":"provider.update","provider":"claude"}));
        source.apply_update();
        {
            wait_for("the update command", || {
                commands
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|command| command["type"] == "app.update.apply")
            });
            let sent = commands.lock().unwrap();
            let last = sent
                .iter()
                .find(|command| command["type"] == "app.update.apply")
                .unwrap();
            assert_eq!(
                last,
                &json!({"type":"app.update.apply","commandId":last["commandId"]})
            );
        }
        wait_for("the update notice", || {
            source.take_settings_notice().is_some()
        });
        assert!(matches!(
            source.app_update(),
            Some(Update::Finished {
                rollback: false,
                ..
            })
        ));
        wait_for("the shell restart notice", || source.restart_required());
        source.rollback_update();
        wait_for("the rollback result", || {
            matches!(
                source.app_update(),
                Some(Update::Finished { rollback: true, .. })
            )
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn inspector_reads_work_from_the_server_and_retains_released_background_output() {
        let dir = std::env::temp_dir().join(format!("moxen-work-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("s.sock");
        let _ = std::fs::remove_file(&path);
        let _commands = fake_server(path.clone());
        let mut source = ServerSource::connect(path.to_string_lossy().into_owned());
        wait_for("the parent and child threads", || source.children(0) == [1]);
        source.focus(0);
        wait_for("the thread snapshot's checklist", || {
            !source.inspector(0).tasks.is_empty()
        });
        let inspector = source.inspector(0);
        assert_eq!(work::completed(&inspector.tasks), 1);
        assert_eq!(
            inspector
                .tasks
                .iter()
                .map(|step| (step.title.as_str(), step.status))
                .collect::<Vec<_>>(),
            [
                ("Pending first", Status::Queued),
                ("In flight", Status::Running),
                ("Done out of order", Status::Idle),
            ]
        );
        assert_eq!(inspector.background_count, 1);
        assert_eq!(inspector.agents[0].id, "agent-1");
        assert!(inspector.agents[0].stoppable);
        assert_eq!(source.children(0), [1]);
        let delegated = source.delegated(1).expect("delegated");
        assert_eq!(delegated.parent, Some(0));
        assert_eq!(delegated.branch.as_deref(), Some("task/focus"));

        let agent = Read::Subagent("agent-1".into());
        let output = Read::Output("shell-1".into());
        for (id, read) in [
            (0, agent.clone()),
            (0, output.clone()),
            (0, Read::Background),
            (1, Read::Delegation),
        ] {
            source.read_work(id, read.clone());
            wait_for("the inspector read", || source.work(id, &read).is_some());
        }
        assert!(matches!(source.work(0, &agent).as_deref(),
            Some(Ok(View::Subagent(Some(rows)))) if rows.len() == 2
            && matches!(&rows[1].message, Message::Assistant { text, .. } if text == "Found the listener")));
        assert!(matches!(source.work(0, &output).as_deref(),
            Some(Ok(View::Output(Some(text)))) if text == "running\ndone"));
        assert!(matches!(source.work(0, &Read::Background).as_deref(),
            Some(Ok(View::Background(list))) if list.partial && list.tasks.len() == 2 && !list.tasks[1].stoppable));
        assert!(matches!(source.work(1, &Read::Delegation).as_deref(),
            Some(Ok(View::Delegation(link))) if link.notify && link.status.as_deref() == Some("running")));

        source.stop_background(0, "shell-1");
        wait_for("the refreshed background list", || {
            matches!(source.work(0, &Read::Background).as_deref(),
            Some(Ok(View::Background(list))) if list.tasks.is_empty())
        });
        source.read_work(0, output.clone());
        wait_for("the finished output read", || {
            !source
                .shared
                .state
                .lock()
                .unwrap()
                .work_reads
                .contains(&(0, output.clone()))
        });
        assert!(matches!(source.work(0, &output).as_deref(),
            Some(Ok(View::Output(Some(text)))) if text == "running\ndone"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
