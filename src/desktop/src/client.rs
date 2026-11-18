//! Launch the private stdio connection. Server discovery, the platform
//! endpoint, starting the daemon and paired credentials belong to `openClient`.

use crate::wire::{Halves, WireError};
use serde_json::Value;
use std::{
    ffi::OsStr,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};

const BRIDGE: &str = "--moxen-internal-desktop";

pub fn server_arg(args: impl IntoIterator<Item = String>) -> Result<Option<String>, WireError> {
    let mut args = args.into_iter();
    let mut server = None;
    while let Some(arg) = args.next() {
        let value = if arg == "--server" {
            args.next().filter(|value| !value.starts_with('-'))
        } else if let Some(value) = arg.strip_prefix("--server=") {
            Some(value.to_owned())
        } else {
            continue;
        };
        server = Some(value.filter(|value| !value.is_empty()).ok_or_else(|| {
            WireError::local("INVALID_SERVER", "Specify a paired server after --server.")
        })?);
    }
    Ok(server)
}

fn launcher(
    configured: Option<&OsStr>,
    desktop: Option<&Path>,
    home: Option<&Path>,
    store: Option<&OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    if let Some(configured) = configured.filter(|path| !path.is_empty()) {
        return configured.into();
    }
    let binary = if cfg!(windows) { "moxen.exe" } else { "moxen" };
    let installed = if cfg!(windows) { "moxen.cmd" } else { "moxen" };
    let app = store
        .filter(|root| !root.is_empty())
        .map(|root| Path::new(root).join("app"))
        .or_else(|| home.map(|home| home.join(".moxen").join("app")));
    desktop
        .and_then(Path::parent)
        .map(|folder| folder.join(binary))
        .filter(|path| exists(path))
        .or_else(|| {
            app.map(|app| app.join("bin").join(installed))
                .filter(|path| exists(path))
        })
        .unwrap_or_else(|| PathBuf::from(binary))
}

pub fn open(server: Option<&str>, starting: impl Fn()) -> Result<Halves, WireError> {
    let binary = launcher(
        std::env::var_os("MOXEN_DESKTOP_CLI").as_deref(),
        std::env::current_exe().ok().as_deref(),
        dirs::home_dir().as_deref(),
        std::env::var_os("MOXEN_STORE_ROOT").as_deref(),
        Path::is_file,
    );
    let mut command = Command::new(&binary);
    command
        .arg(BRIDGE)
        .env_remove("MOXEN_DESKTOP_SERVER")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(server) = server {
        command.env("MOXEN_DESKTOP_SERVER", server);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    open_command(&mut command, starting).map_err(|error| {
        if error.code == "BRIDGE_LAUNCH_FAILED" {
            WireError::local(
                &error.code,
                format!("Could not run {}: {}", binary.display(), error.message),
            )
        } else {
            error
        }
    })
}

fn open_command(command: &mut Command, starting: impl Fn()) -> Result<Halves, WireError> {
    let mut child = command
        .spawn()
        .map_err(|error| WireError::local("BRIDGE_LAUNCH_FAILED", error.to_string()))?;
    let writer = child.stdin.take().expect("piped desktop stdin");
    let mut reader = BufReader::new(child.stdout.take().expect("piped desktop stdout"));
    let result = read_status(&mut reader, starting);
    if let Err(error) = result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let child = Mutex::new(child);
    Ok((
        Box::new(reader),
        Box::new(writer),
        Box::new(move || {
            let mut child = child.lock().expect("desktop bridge child");
            let _ = child.kill();
            let _ = child.wait();
        }),
    ))
}

fn read_status(reader: &mut impl BufRead, starting: impl Fn()) -> Result<(), WireError> {
    for line in reader.lines() {
        let line = line.map_err(|error| WireError::local("CONNECT_FAILED", error.to_string()))?;
        let status: Value = serde_json::from_str(&line).map_err(|_| no_bridge())?;
        match status["status"].as_str() {
            Some("starting") => starting(),
            Some("ready") => return Ok(()),
            Some("failed") => return Err(WireError::from_json(&status["error"])),
            _ => return Err(no_bridge()),
        }
    }
    Err(no_bridge())
}

fn no_bridge() -> WireError {
    WireError::local(
        "CONNECT_FAILED",
        "The Moxen launcher did not open a desktop connection. Use a current Moxen launcher.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn a_named_server_is_passed_as_given_and_a_missing_flag_value_is_refused() {
        let args = |items: &[&str]| items.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        assert_eq!(
            server_arg(args(&["--server", "Office Mac"]))
                .unwrap()
                .as_deref(),
            Some("Office Mac")
        );
        assert_eq!(
            server_arg(args(&["--server=[::1]:7711"]))
                .unwrap()
                .as_deref(),
            Some("[::1]:7711")
        );
        assert_eq!(server_arg(args(&["--mock"])).unwrap(), None);
        assert!(server_arg(args(&["--server", "--mock"])).is_err());
    }

    #[test]
    fn an_explicit_launcher_wins_then_the_installed_launcher_then_path() {
        let root = std::env::temp_dir().join("desktop store with spaces");
        let installed =
            root.join("app")
                .join("bin")
                .join(if cfg!(windows) { "moxen.cmd" } else { "moxen" });
        let choose = |configured, installed_exists| {
            launcher(configured, None, None, Some(root.as_os_str()), |path| {
                installed_exists && path == installed
            })
        };
        let explicit = root.join("explicit");
        assert_eq!(choose(Some(explicit.as_os_str()), true), explicit);
        assert_eq!(choose(None, true), installed);
        assert_eq!(
            choose(None, false),
            PathBuf::from(if cfg!(windows) { "moxen.exe" } else { "moxen" })
        );
    }

    #[test]
    fn startup_is_shown_only_on_a_starting_frame_and_preserves_start_failures() {
        let calls = Cell::new(0);
        let starting = || calls.set(calls.get() + 1);
        let mut ready = br#"{"status":"ready"}"#.as_slice();
        read_status(&mut ready, starting).unwrap();
        assert_eq!(calls.get(), 0);
        let mut failed = br#"{"status":"starting"}
{"status":"failed","error":{"code":"SERVER_START_FAILED","message":"fake launcher failed"}}"#
            .as_slice();
        assert_eq!(
            read_status(&mut failed, starting).unwrap_err().code,
            "SERVER_START_FAILED"
        );
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn a_fake_launcher_in_a_temp_directory_can_report_startup_and_ready_over_stdio() {
        use std::io::{Read, Write};
        let directory = std::env::temp_dir().join(format!("mx-bridge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).expect("temporary fixture directory");
        let binary = directory.join(format!("fixture{}", std::env::consts::EXE_SUFFIX));
        let mut compiler = Command::new("rustc")
            .args(["--crate-name", "desktop_fixture", "-o"])
            .arg(&binary)
            .arg("-")
            .stdin(Stdio::piped())
            .spawn()
            .expect("compile fake launcher");
        compiler
            .stdin
            .take()
            .unwrap()
            .write_all(
                br###"
use std::io::{self, BufRead};
fn main() {
    assert_eq!(std::env::args().nth(1).as_deref(), Some("--moxen-internal-desktop"));
    println!("{}", r#"{"status":"starting"}"#);
    println!("{}", r#"{"status":"ready"}"#);
    let line = io::stdin().lock().lines().next().unwrap().unwrap();
    println!("{line}");
}
"###,
            )
            .unwrap();
        assert!(compiler.wait().unwrap().success());
        let mut command = Command::new(binary);
        command
            .arg(BRIDGE)
            .current_dir(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let started = Cell::new(false);
        let (mut reader, mut writer, close) =
            open_command(&mut command, || started.set(true)).unwrap();
        assert!(started.get());
        writer.write_all(b"hello\n").unwrap();
        let mut response = String::new();
        reader.read_to_string(&mut response).unwrap();
        assert_eq!(response.trim_end(), "hello");
        close();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
