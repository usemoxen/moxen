//! The desktop's client for the Moxen server: the same newline-delimited JSON
//! protocol the TUI and CLI speak (`src/server/transport/wire.ts`). The
//! launcher bridges it over stdio to a local or paired server.
//! A request carries a numeric `id` its response echoes; a subscription is named
//! by the `id` of the request that opened it, and its frames arrive as
//! `{subscription, item}` until the connection closes.
//!
//! The launcher enforces its build and config against the server; the Rust
//! client uses the bridge's build label and checks the wire protocol version.

use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    time::Duration,
};

/// Bumped by the server on any incompatible change to the messages.
pub const PROTOCOL_VERSION: u64 = 1;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// The build sent to learn the server's: never equal to a real build identity.
const PROBE_BUILD: &str = "moxen-desktop";
const DISPLAY: &str = "Moxen Agent desktop";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WireError {
    pub code: String,
    pub message: String,
}
impl WireError {
    pub(crate) fn local(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub(crate) fn failed(code: &str, message: impl Into<String>) -> Self {
        Self::local(code, message)
    }
    pub(crate) fn from_json(value: &Value) -> Self {
        let text = |key| value.get(key).and_then(Value::as_str).unwrap_or_default();
        Self::local(text("code"), text("message"))
    }
}
impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// What the server answers a `hello` with (the parts the desktop reads).
#[derive(Clone, Debug)]
pub struct Hello {
    #[cfg(all(test, unix))]
    pub build: String,
    #[cfg(all(test, unix))]
    pub build_display: String,
    pub paired_name: Option<String>,
    pub client_locale: Option<String>,
    pub restart_required: bool,
}

type Pending = HashMap<u64, Sender<Result<Value, WireError>>>;
type Subscriptions = HashMap<u64, Sender<Result<Value, WireError>>>;

struct Shared {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    next_id: AtomicU64,
    pending: Mutex<Pending>,
    subscriptions: Mutex<Subscriptions>,
    open: AtomicBool,
    close: Box<dyn Fn() + Send + Sync>,
}

impl Shared {
    fn send(&self, id: u64, method: &str, params: Option<Value>) -> Result<(), WireError> {
        let mut message = json!({ "id": id, "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        let mut line = message.to_string();
        line.push('\n');
        let mut writer = self.writer.lock().expect("wire writer");
        let writer = writer.as_mut().ok_or_else(closed)?;
        writer
            .write_all(line.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|cause| WireError::local("CONNECTION_CLOSED", cause.to_string()))
    }
}

/// One open subscription. Dropping it tells the server to stop sending.
pub struct Subscription {
    id: u64,
    shared: Arc<Shared>,
    /// Frames as the server sends them, and a final error; the channel ends
    /// when the connection does.
    pub frames: Receiver<Result<Value, WireError>>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.shared
            .subscriptions
            .lock()
            .expect("wire subscriptions")
            .remove(&self.id);
        if self.shared.open.load(Ordering::SeqCst) {
            let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
            let _ = self
                .shared
                .send(id, "unsubscribe", Some(json!({ "subscription": self.id })));
        }
    }
}

/// A live connection. Dropping it closes the socket and ends its subscriptions.
pub struct Wire {
    shared: Arc<Shared>,
}
impl Drop for Wire {
    fn drop(&mut self) {
        self.shared.open.store(false, Ordering::SeqCst);
        // Close the bridge's stdin even if the launcher is a Windows .cmd
        // wrapper whose own process can exit before the bridge does.
        self.shared.writer.lock().expect("wire writer").take();
        (self.shared.close)();
    }
}

pub(crate) type Halves = (
    Box<dyn io::Read + Send>,
    Box<dyn Write + Send>,
    Box<dyn Fn() + Send + Sync>,
);

#[cfg(all(test, unix))]
fn open_stream(endpoint: &str) -> io::Result<Halves> {
    use std::os::unix::net::UnixStream;
    let stream = UnixStream::connect(endpoint)?;
    let reader = stream.try_clone()?;
    let closer = stream.try_clone()?;
    Ok((
        Box::new(reader),
        Box::new(stream),
        Box::new(move || {
            let _ = closer.shutdown(std::net::Shutdown::Both);
        }),
    ))
}

impl Wire {
    #[cfg(all(test, unix))]
    fn open(endpoint: &str) -> Result<Self, WireError> {
        let (reader, writer, close) = open_stream(endpoint).map_err(|cause| {
            let code = match cause.kind() {
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => "SERVER_NOT_RUNNING",
                io::ErrorKind::Unsupported => "UNSUPPORTED_PLATFORM",
                _ => "CONNECT_FAILED",
            };
            let message = if code == "SERVER_NOT_RUNNING" {
                format!("No Moxen server is running at {endpoint}.")
            } else {
                format!("Could not connect to the Moxen server at {endpoint}: {cause}.")
            };
            WireError::local(code, message)
        })?;
        Self::from_stream((reader, writer, close))
    }

    fn from_stream((reader, writer, close): Halves) -> Result<Self, WireError> {
        let shared = Arc::new(Shared {
            writer: Mutex::new(Some(writer)),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            subscriptions: Mutex::new(HashMap::new()),
            open: AtomicBool::new(true),
            close,
        });
        let reading = shared.clone();
        let wire = Self { shared };
        std::thread::Builder::new()
            .name("moxen-wire".into())
            .spawn(move || read_loop(reader, &reading))
            .map_err(|cause| WireError::local("CONNECT_FAILED", cause.to_string()))?;
        Ok(wire)
    }

    pub fn desktop(server: Option<&str>, starting: impl Fn()) -> Result<(Self, Hello), WireError> {
        let wire = Self::from_stream(crate::client::open(server, starting)?)?;
        let hello = wire.hello(PROBE_BUILD, DISPLAY)?;
        Ok((wire, hello))
    }

    /// Connects to the server at `endpoint` and completes the build handshake.
    #[cfg(all(test, unix))]
    pub fn connect(endpoint: &str) -> Result<(Self, Hello), WireError> {
        let probe = Self::open(endpoint)?;
        let greeted = probe.hello(PROBE_BUILD, DISPLAY)?;
        if greeted.build == PROBE_BUILD {
            return Ok((probe, greeted));
        }
        drop(probe);
        let wire = Self::open(endpoint)?;
        let hello = wire.hello(&greeted.build, &greeted.build_display)?;
        Ok((wire, hello))
    }

    fn hello(&self, build: &str, display: &str) -> Result<Hello, WireError> {
        let result = self.request(
            "hello",
            Some(json!({ "protocol": PROTOCOL_VERSION, "build": build, "buildDisplay": display })),
        )?;
        Ok(Hello {
            #[cfg(all(test, unix))]
            build: result["build"].as_str().unwrap_or_default().to_string(),
            #[cfg(all(test, unix))]
            build_display: result["buildDisplay"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            paired_name: result["pairedName"].as_str().map(str::to_owned),
            client_locale: result["clientLocale"].as_str().map(str::to_owned),
            restart_required: result["restartRequired"].as_bool().unwrap_or(false),
        })
    }

    fn send(&self, id: u64, method: &str, params: Option<Value>) -> Result<(), WireError> {
        self.shared.send(id, method, params)
    }

    /// Sends one request and waits for its answer.
    pub fn request(&self, method: &str, params: Option<Value>) -> Result<Value, WireError> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT)
    }

    fn request_with_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, WireError> {
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply, answer) = mpsc::channel();
        self.shared
            .pending
            .lock()
            .expect("wire pending")
            .insert(id, reply);
        if !self.shared.open.load(Ordering::SeqCst) {
            self.shared
                .pending
                .lock()
                .expect("wire pending")
                .remove(&id);
            return Err(closed());
        }
        if let Err(error) = self.send(id, method, params) {
            self.shared
                .pending
                .lock()
                .expect("wire pending")
                .remove(&id);
            return Err(error);
        }
        match answer.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.shared
                    .pending
                    .lock()
                    .expect("wire pending")
                    .remove(&id);
                Err(WireError::local(
                    "TIMEOUT",
                    format!("The Moxen server did not answer {method}."),
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(closed()),
        }
    }

    /// A query (`type` names it, the rest are its fields).
    #[allow(dead_code)]
    pub fn query(&self, kind: &str, fields: Value) -> Result<Value, WireError> {
        self.request("query", Some(typed(kind, fields)))
    }

    /// A command (`type` names it, the rest are its fields).
    #[allow(dead_code)]
    pub fn dispatch(&self, kind: &str, fields: Value) -> Result<Value, WireError> {
        let installs_memory = kind == "settings.set"
            && fields["key"] == "memoryEmbeddings"
            && fields["value"] == "true";
        let timeout = if installs_memory
            || matches!(
                kind,
                "app.update.apply"
                    | "app.update.rollback"
                    | "memory.embeddings.setup"
                    | "memory.embeddings.rebuild"
            ) {
            Duration::from_secs(600)
        } else if kind == "prompt.improve" {
            // The server gives the provider completion 90 seconds.
            Duration::from_secs(100)
        } else {
            REQUEST_TIMEOUT
        };
        self.request_with_timeout("dispatch", Some(typed(kind, fields)), timeout)
    }

    /// Opens the shell subscription. Frames (and a final error) arrive on the
    /// receiver, which ends when the connection does. Threads in `research`
    /// opt in to answering their run-size question through it.
    pub fn subscribe_shell(&self, research: &[String]) -> Result<Subscription, WireError> {
        let mut params = json!({});
        if !research.is_empty() {
            params["researchProposals"] = research.to_vec().into();
        }
        self.subscribe("subscribeShell", params)
    }

    /// Opens one thread's subscription.
    pub fn subscribe_thread(&self, thread_id: &str) -> Result<Subscription, WireError> {
        self.subscribe("subscribeThread", json!({ "threadId": thread_id }))
    }

    fn subscribe(&self, method: &str, params: Value) -> Result<Subscription, WireError> {
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let (items, frames) = mpsc::channel();
        let (reply, answer) = mpsc::channel();
        // Registered before the request: the server may send a frame straight
        // after acknowledging it.
        self.shared
            .subscriptions
            .lock()
            .expect("wire subscriptions")
            .insert(id, items);
        self.shared
            .pending
            .lock()
            .expect("wire pending")
            .insert(id, reply);
        let sent = if self.shared.open.load(Ordering::SeqCst) {
            self.send(id, method, Some(params))
        } else {
            Err(closed())
        };
        let acknowledged = sent.and_then(|_| match answer.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result.map(|_| ()),
            Err(_) => Err(closed()),
        });
        if let Err(error) = acknowledged {
            self.shared
                .subscriptions
                .lock()
                .expect("wire subscriptions")
                .remove(&id);
            self.shared
                .pending
                .lock()
                .expect("wire pending")
                .remove(&id);
            return Err(error);
        }
        Ok(Subscription {
            id,
            shared: self.shared.clone(),
            frames,
        })
    }
}

fn typed(kind: &str, fields: Value) -> Value {
    let mut body = match fields {
        Value::Object(map) => Value::Object(map),
        _ => json!({}),
    };
    body["type"] = json!(kind);
    body
}

fn closed() -> WireError {
    WireError::local(
        "CONNECTION_CLOSED",
        "The connection to the Moxen server closed.",
    )
}

/// Routes every line the server sends until it hangs up, then wakes whoever
/// is still waiting by dropping their senders.
fn read_loop(reader: Box<dyn io::Read + Send>, shared: &Shared) {
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        route(&message, shared);
    }
    shared.open.store(false, Ordering::SeqCst);
    shared.pending.lock().expect("wire pending").clear();
    shared
        .subscriptions
        .lock()
        .expect("wire subscriptions")
        .clear();
}

fn route(message: &Value, shared: &Shared) {
    let outcome = || match message.get("error") {
        Some(error) => Err(WireError::from_json(error)),
        None => Ok(message.get("item").cloned().unwrap_or(Value::Null)),
    };
    if let Some(subscription) = message.get("subscription").and_then(Value::as_u64) {
        let subscriptions = shared.subscriptions.lock().expect("wire subscriptions");
        if let Some(items) = subscriptions.get(&subscription) {
            let _ = items.send(outcome());
        }
        return;
    }
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        return;
    };
    let reply = shared.pending.lock().expect("wire pending").remove(&id);
    if let Some(reply) = reply {
        let _ = reply.send(match message.get("error") {
            Some(error) => Err(WireError::from_json(error)),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn learns_the_server_build_and_streams_shell_frames() {
        use std::io::{BufRead, Write};
        use std::os::unix::net::UnixListener;
        let dir = std::env::temp_dir().join(format!("moxen-wire-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("s.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind");
        // A server that greets any build with its own, as the real one does on
        // a local socket, and refuses everything but `hello` from a build it
        // does not know.
        let server = std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let stream = stream.expect("accept");
                let mut writer = stream.try_clone().expect("clone");
                let mut limited = false;
                for line in std::io::BufReader::new(stream).lines() {
                    let Ok(line) = line else { break };
                    let message: Value = serde_json::from_str(&line).expect("json");
                    let id = message["id"].as_u64().expect("id");
                    let reply = match message["method"].as_str().expect("method") {
                        "hello" => {
                            limited = message["params"]["build"] != "build-1";
                            json!({"id": id, "result": {"protocol": 1, "server": "moxen", "pid": 1,
                                "build": "build-1", "buildDisplay": "Build 1", "restartRequired": false}})
                        }
                        _ if limited => {
                            json!({"id": id, "error": {"code": "BUILD_MISMATCH", "message": "no", "exitCode": 1}})
                        }
                        "subscribeShell" => {
                            let frame =
                                json!({"subscription": id, "item": {"kind": "synchronized"}});
                            writeln!(
                                writer,
                                "{}",
                                json!({"id": id, "result": {"subscription": id}})
                            )
                            .unwrap();
                            writeln!(writer, "{frame}").unwrap();
                            continue;
                        }
                        _ => json!({"id": id, "result": null}),
                    };
                    writeln!(writer, "{reply}").unwrap();
                }
            }
        });
        let (wire, hello) = Wire::connect(path.to_str().expect("utf8")).expect("connect");
        assert_eq!(hello.build, "build-1");
        let subscription = wire.subscribe_shell(&[]).expect("subscribe");
        let frame = subscription
            .frames
            .recv_timeout(Duration::from_secs(5))
            .expect("frame")
            .expect("ok");
        assert_eq!(frame["kind"], "synchronized");
        drop(wire);
        server.join().expect("server");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
