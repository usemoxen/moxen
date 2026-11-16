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
        Connection, DiffLine, InspectorData, Message, Reply, Status, Thread, ThreadId, ThreadSource,
    },
    transcript::{self, Row},
    wire::{Wire, WireError},
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
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
            };
            let slot = Slot {
                uuid: uuid.to_string(),
                thread: value,
                stamp_ms: stamp_of(thread, status),
                present: true,
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
        shared.update(|state| {
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
    fn queued(&self, _: ThreadId) -> &[String] {
        &[]
    }
    fn take_queued(&mut self, _: ThreadId) -> Option<String> {
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
    fn send_message(&mut self, _: ThreadId, _: String) -> Option<Reply> {
        None
    }
    fn stop(&mut self, _: ThreadId) {}
    fn stream_word(&mut self, _: ThreadId, _: usize, _: &str, _: bool) {}
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
}
