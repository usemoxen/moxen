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
    model::{
        Connection, Delivery, DiffLine, InspectorData, Message, NewThread, Problem, Project,
        QueueEdit, Queued, Reply, Status, Thread, ThreadId, ThreadSource,
    },
    transcript::{self, Row},
    wire::{Wire, WireError},
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
    let flat_of = |settled: bool| -> Vec<(ThreadId, usize)> {
        nest(
            &entries
                .iter()
                .filter(|e| e.settled == settled)
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
            .filter(|e| e.project == project && e.settled == settled)
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
                .filter(|e| e.project == project && e.settled == settled)
                .collect();
            arranged
                .grouped
                .extend(nest(&of_project).into_iter().map(|(id, _)| id));
        }
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
}

/// What is known of one thread's conversation.
#[derive(Default)]
struct Transcript {
    rows: Vec<Row>,
    /// `rows` as the window reads them, rebuilt when they change.
    messages: Option<Arc<Vec<Message>>>,
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
    /// A thread being started, until the shell lists it.
    opening: Option<String>,
    opened: Option<ThreadId>,
    added: Option<String>,
}
impl State {
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
            let next = self.slots.len();
            let id = *self.ids.entry(uuid.to_string()).or_insert(next);
            let status = status_of(thread);
            let settled = is_settled(thread) && status != Status::Running;
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
    fn update(&self, change: impl FnOnce(&mut State)) {
        change(&mut self.state.lock().expect("live state"));
        self.revision.fetch_add(1, Ordering::SeqCst);
    }
}

pub struct ServerSource {
    shared: Arc<Shared>,
    endpoint: String,
}
impl ServerSource {
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
    let subscription = wire.subscribe_shell()?;
    shared.update(|state| {
        state.wire_epoch += 1;
        state.wire = Some(wire.clone());
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
            if frame["kind"] == "snapshot" {
                let thread = &frame["snapshot"]["thread"];
                state.queues.insert(id, queue_of(thread, read.as_ref()));
                if let Some(read) = &read {
                    state.global_queue = global_queue(read);
                }
            }
            let entry = state.transcripts.entry(id).or_default();
            if frame["kind"] == "snapshot" {
                entry.rows = transcript::project(&frame["snapshot"]["thread"]);
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
    fn order(&self, by_project: bool) -> Vec<ThreadId> {
        let state = self.shared.state.lock().expect("live state");
        if by_project {
            state.arranged.grouped.clone()
        } else {
            state.arranged.flat.clone()
        }
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
    fn inspector(&self, _: ThreadId) -> InspectorData {
        InspectorData {
            tasks: vec![],
            subject: String::new(),
            author: String::new(),
            message: String::new(),
            files: vec![],
        }
    }
    fn file_diff(&self, _: ThreadId, _: usize) -> Vec<DiffLine> {
        vec![]
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
    fn create_thread(&mut self, draft: NewThread) {
        // The thread starts on the model the project's newest thread runs on;
        // with none, the server's default for the project. Choosing one is the
        // model picker's job.
        let selection = {
            let state = self.shared.state.lock().expect("live state");
            state
                .slots
                .iter()
                .filter(|slot| slot.present && slot.project_id == draft.project)
                .max_by_key(|slot| slot.sort_ms)
                .and_then(|slot| slot.selection.clone())
        };
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

impl ServerSource {
    fn uuid_of(&self, id: ThreadId) -> Option<String> {
        let state = self.shared.state.lock().expect("live state");
        state.slots.get(id).map(|slot| slot.uuid.clone())
    }
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
    let wire = shared.state.lock().expect("live state").wire.clone();
    let shared = shared.clone();
    let spawned = std::thread::Builder::new()
        .name("moxen-command".into())
        .spawn(move || {
            let outcome = match wire {
                Some(wire) => job(&wire),
                None => Err(Problem {
                    message: "Not connected to the Moxen server.".into(),
                    unsent: None,
                }),
            };
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
        let commands = Arc::new(Mutex::new(vec![]));
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
                                        "projects": [{"id": "p", "title": "moxen"}],
                                        "threads": [{"id": "t1", "projectId": "p", "title": "Fix",
                                            "session": {"status": "running"},
                                            "modelSelection": {"instanceId": "claude", "model": "opus"}}]}})
                                } else {
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
                            "query" => json!({"entries": [
                                {"threadId": "t1", "turnId": "t1", "policy": {"held": false}},
                                {"threadId": "other", "turnId": "x", "policy": {"held": false}},
                                {"threadId": "t1", "turnId": "t2", "policy": {"held": true}},
                            ]}),
                            "dispatch" => {
                                seen.lock().unwrap().push(params.clone());
                                json!({"accepted": true, "threadId": "new-thread"})
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
        let _ = std::fs::remove_dir_all(&dir);
    }
}
