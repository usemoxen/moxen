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
    catalog::{Catalog, OptionValue, is_effort},
    git::{self, CommitDetail, Forge, Git, OpenCommit, Overview, Patch, RequestStatus, TurnDiff},
    model::{
        Answer, Ask, CatalogState, Connection, Decision, Delivery, MergeStrategy, Message,
        NewRequest, NewThread, Permission, Problem, Project, QueueEdit, Queued, Reply, Selection,
        Status, Thread, ThreadAction, ThreadId, ThreadSource,
    },
    pending,
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
    slots: Vec<Slot>,
    ids: HashMap<String, ThreadId>,
    arranged: Arranged,
    projects: Vec<Project>,
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
    side_answer: Option<(ThreadId, String)>,
    reverted: Option<(ThreadId, Option<String>)>,
}
impl State {
    /// The thread's Git tab data, to change.
    fn git_of(&mut self, id: ThreadId) -> &mut Git {
        Arc::make_mut(self.git.entry(id).or_default())
    }

    /// Replaces the listed threads with a shell snapshot's.
    fn apply(&mut self, snapshot: &Value) {
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
        waiting.push((
            listed.unwrap_or(usize::MAX),
            Queued {
                key: turn_id.to_string(),
                text: text(message, &["text"]).unwrap_or_default().to_string(),
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
    endpoint: String,
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
                if let Some(choice) = selection.filter(|choice| Some(choice) != current.as_ref()) {
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
        if !self.shared.update(|state| state.actions.insert(id)) {
            return;
        }
        background_result(&self.shared, move |wire, shared| {
            let result = wire.and_then(|wire| wire.dispatch(name, fields));
            shared.update(|state| {
                state.actions.remove(&id);
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
                if name == "thread.side-question" {
                    state.side_answer =
                        text(result, &["text"]).map(|answer| (id, answer.to_string()));
                }
                if name == "thread.conversation.revert" {
                    state.reverted = Some((id, draft));
                    state.patches.retain(|(thread, _), _| *thread != id);
                }
            });
            result.map(|_| ()).map_err(|error| problem(&error, None))
        });
    }
    pub fn connect(endpoint: String) -> Self {
        let source = Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                revision: AtomicU64::new(0),
            }),
            endpoint,
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
        let endpoint = self.endpoint.clone();
        let spawned = std::thread::Builder::new()
            .name("moxen-live".into())
            .spawn(move || {
                let failed = match session(&endpoint, &shared) {
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

fn session(endpoint: &str, shared: &Arc<Shared>) -> Result<(), WireError> {
    let (wire, _hello) = Wire::connect(endpoint)?;
    let wire = Arc::new(wire);
    load_catalog(shared, &wire);
    let subscription = wire.subscribe_shell()?;
    shared.update(|state| {
        state.wire_epoch += 1;
        state.wire = Some(wire.clone());
        state.work.clear();
        state.work_reads.clear();
    });
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
            }
        }
        Ok(())
    })();
    shared.update(|state| {
        state.wire = None;
        // Ends the open thread's watcher.
        state.watch += 1;
    });
    ended
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
    fn take_side_answer(&mut self) -> Option<(ThreadId, String)> {
        self.shared
            .state
            .lock()
            .expect("live state")
            .side_answer
            .take()
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
    fn take_queued(&mut self, id: ThreadId, key: &str) -> Option<String> {
        let text = {
            let state = self.shared.state.lock().expect("live state");
            state
                .queues
                .get(&id)?
                .iter()
                .find(|queued| queued.key == key)?
                .text
                .clone()
        };
        self.edit_queued(id, key, QueueEdit::Remove);
        Some(text)
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
    fn send_message(&mut self, id: ThreadId, text: String, delivery: Delivery) -> Option<Reply> {
        let (uuid, busy) = {
            let state = self.shared.state.lock().expect("live state");
            let slot = state.slots.get(id)?;
            (slot.uuid.clone(), slot.thread.status == Status::Running)
        };
        let mut command = json!({
            "threadId": uuid,
            "message": { "text": text },
            // A settled thread wakes on the send, as the TUI's does.
            "wakeSettled": true,
        });
        if busy {
            command["delivery"] = match delivery {
                Delivery::Steer => "steer",
                Delivery::Queue => "queue",
            }
            .into();
        }
        background(&self.shared, move |wire| {
            wire.dispatch("thread.turn.start", command)
                .map(|_| ())
                .map_err(|error| problem(&error, Some((Some(id), text))))
        });
        None
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
            project_selection(&state, &draft.project)
        });
        let shared = self.shared.clone();
        background(&self.shared, move |wire| {
            let unsent = || Some((None, draft.text.clone()));
            let title: String = draft
                .text
                .lines()
                .next()
                .unwrap_or_default()
                .chars()
                .take(60)
                .collect();
            let mut create = json!({
                "projectId": draft.project,
                "title": title,
                "interactionMode": draft.interaction_mode,
            });
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
            shared.update(|state| state.opening = Some(uuid.clone()));
            let mut start = json!({ "threadId": uuid, "message": { "text": draft.text } });
            if let Some(selection) = selection {
                start["modelSelection"] = selection;
            }
            wire.dispatch("thread.turn.start", start)
                .map(|_| ())
                .map_err(|error| problem(&error, unsent()))
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
        shared.update(|state| {
            state.answered.insert(request.clone());
        });
        background(&self.shared, move |wire| {
            let Err(error) = wire.dispatch(command, body) else {
                return Ok(());
            };
            std::thread::sleep(REFUSAL_GRACE);
            let mut state = shared.state.lock().expect("live state");
            let open = state.waiting.get(&id).is_some_and(|waiting| {
                waiting.permissions.iter().any(|p| p.request == request)
                    || waiting.asks.iter().any(|a| a.request == request)
            });
            if open {
                state.answered.remove(&request);
                Err(problem(&error, None))
            } else {
                Ok(())
            }
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
    with_wire(shared, move |wire| {
        read_history(&history, &wire, id, read, &history_uuid, branch.as_deref())
    });
    with_wire(shared, move |wire| {
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
    with_wire(shared, move |wire| {
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
fn problem(error: &WireError, unsent: Option<(Option<ThreadId>, String)>) -> Problem {
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
            let outcome = job(
                wire.ok_or_else(|| WireError {
                    code: "NOT_CONNECTED".into(),
                    message: "Not connected to the Moxen server.".into(),
                }),
                &shared,
            );
            if let Err(failed) = outcome {
                shared.update(|state| state.problems.push_back(failed));
            }
        });
    drop(spawned);
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
        assert_eq!(state.arranged.sections[&0], false);
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
    fn fake_server(path: std::path::PathBuf) -> Arc<Mutex<Vec<Value>>> {
        use std::io::{BufRead, Write};
        use std::os::unix::net::UnixListener;
        let listener = UnixListener::bind(&path).expect("bind");
        let commands = Arc::new(Mutex::new(Vec::<Value>::new()));
        let seen = commands.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let stream = stream.expect("accept");
                let seen = seen.clone();
                std::thread::spawn(move || {
                    let mut writer = stream.try_clone().expect("clone");
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
                                    json!({"kind": "snapshot", "snapshot": {
                                        "projects": [{"id": "p", "title": "moxen", "workspaceRoot": "/fake/project"}],
                                        "archivedThreads": [{"id": "archived", "title": "Archived work"}],
                                        "threads": [{"id": "t1", "projectId": "p", "title": "Fix",
                                            "session": {"status": "running"},
                                            "modelSelection": {"instanceId": "claude", "model": "opus"}},
                                            {"id": "child", "projectId": "p", "title": "Check focus",
                                             "parentThreadId": "t1", "branch": "task/focus",
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
                                other => panic!("unexpected fake-server query: {other:?}"),
                            },
                            "dispatch" => {
                                seen.lock().unwrap().push(params.clone());
                                match params["type"].as_str() {
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
                                    Some("thread.turn.start" | "thread.turn.interrupt") => {
                                        json!({"accepted": true, "threadId": "new-thread"})
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
        assert_eq!(source.take_queued(0, "t1").as_deref(), Some("first"));
        let cancel = sent(6);
        assert_eq!(cancel["type"], "thread.turn.interrupt");
        assert_eq!(cancel["turnId"], "t1");
        assert!(source.queued(0).iter().all(|q| q.key != "t1"));

        // A new thread is created in the project on the project's model, then
        // started with its message.
        source.create_thread(NewThread {
            project: "p".into(),
            text: "build it\nplease".into(),
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
            project: "p".into(),
            text: "again".into(),
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
        let old = source.selection(0).unwrap();
        source.shared.update(|state| {
            state.transcripts.get_mut(&0).unwrap().usage_reset =
                parse_iso_ms("2099-01-01T00:00:00Z");
        });
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
                    selection: choice.clone(),
                },
                json!({"type":"thread.handover","cwd":"/fake/project","prompt":"Handoff","provider":"codex","model":"gpt","thinkingEffort":"high","wait":false}),
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
                    selection: choice.clone(),
                },
                json!({"type":"thread.delegate","parentThreadId":"t1","task":"Check it","provider":"codex","model":"gpt","thinkingEffort":"high","wait":false,"isolation":"shared"}),
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
            source.take_side_answer(),
            Some((0, "Separate answer".into()))
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
        source.thread_action(
            1,
            ThreadAction::CancelContinue {
                notify_parent: false,
            },
        );
        assert_eq!(
            sent(restore_at + 2),
            json!({
                "type": "thread.turn.interrupt", "threadId": "child", "turnId": "reset-turn", "notifyParent": false,
            })
        );
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
