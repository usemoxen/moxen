//! Drives the window from a script without ever taking focus, for checking the
//! app's look and behaviour while someone else is using the computer.
//!
//! Compiled only with the `render-harness` feature, and only active when
//! `MOXEN_DESKTOP_AUTOMATION` names a script. The window is created hidden and
//! never activated, so it cannot come to the front or take keyboard focus.
//! Input is fed to GPUI as platform events (no OS event, no accessibility
//! permission), and a screenshot is GPUI's own offscreen render of the frame.
//!
//! A script is one command per line; a line starting with `#` is a comment:
//!
//! ```text
//! # run frames for 500 ms, so animations advance
//! wait 500
//! # pointer to window point X,Y (points, origin top-left)
//! move X Y
//! # move, press and release the left button
//! click X Y
//! rightclick X Y
//! # a scroll of DX,DY points at X,Y
//! scroll X Y DX DY
//! # drop one local fixture path at X,Y without an OS drag
//! drop-file X Y path with spaces.png
//! # a keystroke as GPUI writes them: enter, escape, tab, shift-tab, cmd-k
//! key cmd-k
//! # types the rest of the line, as written, into the focused input
//! type some text
//! # draws a frame and saves it
//! screenshot out.png
//! quit
//! ```

use gpui::{prelude::*, *};
use std::{path::PathBuf, time::Duration};

/// The frame time while a `wait` runs, so animations and timers progress.
const FRAME: Duration = Duration::from_millis(16);

/// Whether a script was asked for.
pub fn requested() -> Option<PathBuf> {
    std::env::var_os("MOXEN_DESKTOP_AUTOMATION")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Wait(u64),
    Move(f32, f32),
    Click(f32, f32, MouseButton),
    Scroll(f32, f32, f32, f32),
    DropFile(f32, f32, PathBuf),
    Key(String),
    Type(String),
    Screenshot(PathBuf),
    Quit,
}

pub fn parse(script: &str) -> Result<Vec<Command>, String> {
    let mut commands = vec![];
    for (number, line) in script.lines().enumerate() {
        let line = line.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let at = |message: &str| format!("line {}: {message}: {line}", number + 1);
        let (name, rest) = line.split_once(' ').unwrap_or((line, ""));
        let numbers = |count: usize| -> Result<Vec<f32>, String> {
            let values: Vec<f32> = rest
                .split_whitespace()
                .map(str::parse)
                .collect::<Result<_, _>>()
                .map_err(|_| at("expected numbers"))?;
            if values.len() == count {
                Ok(values)
            } else {
                Err(at(&format!("expected {count} numbers")))
            }
        };
        commands.push(match name {
            "wait" => Command::Wait(
                rest.trim()
                    .parse()
                    .map_err(|_| at("expected milliseconds"))?,
            ),
            "move" => {
                let n = numbers(2)?;
                Command::Move(n[0], n[1])
            }
            "click" => {
                let n = numbers(2)?;
                Command::Click(n[0], n[1], MouseButton::Left)
            }
            "rightclick" => {
                let n = numbers(2)?;
                Command::Click(n[0], n[1], MouseButton::Right)
            }
            "scroll" => {
                let n = numbers(4)?;
                Command::Scroll(n[0], n[1], n[2], n[3])
            }
            "drop-file" => {
                let mut fields = rest.splitn(3, ' ');
                let x = fields
                    .next()
                    .and_then(|x| x.parse().ok())
                    .ok_or_else(|| at("expected x"))?;
                let y = fields
                    .next()
                    .and_then(|y| y.parse().ok())
                    .ok_or_else(|| at("expected y"))?;
                let path = fields
                    .next()
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| at("expected path"))?;
                Command::DropFile(x, y, path.into())
            }
            "key" if !rest.trim().is_empty() => Command::Key(rest.trim().to_string()),
            // The text is the rest of the line as written, spaces included.
            "type" => Command::Type(rest.to_string()),
            "screenshot" if !rest.trim().is_empty() => Command::Screenshot(rest.trim().into()),
            "quit" => Command::Quit,
            _ => return Err(at("unknown command")),
        });
    }
    Ok(commands)
}

/// Runs the script against `window` as a task on the app's executor.
pub fn start(cx: &mut App, window: AnyWindowHandle, script: PathBuf) {
    let commands = std::fs::read_to_string(&script)
        .map_err(|cause| format!("cannot read {}: {cause}", script.display()))
        .and_then(|text| parse(&text));
    let commands = match commands {
        Ok(commands) => commands,
        Err(message) => {
            eprintln!("automation: {message}");
            std::process::exit(2);
        }
    };
    cx.spawn(async move |cx| {
        // Let the first frame settle: fonts, layout and the server's first snapshot.
        run_frames(cx, window, Duration::from_millis(1500)).await;
        for command in commands {
            if let Err(message) = execute(cx, window, command).await {
                eprintln!("automation: {message}");
                std::process::exit(1);
            }
        }
        println!("automation: done");
        cx.update(|cx| cx.quit());
    })
    .detach();
}

/// Draws a frame so the next event hits what is on screen.
fn draw(cx: &mut AsyncApp, window: AnyWindowHandle) -> Result<(), String> {
    cx.update_window(window, |_, window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    })
    .map_err(|cause| cause.to_string())
}

async fn run_frames(cx: &mut AsyncApp, window: AnyWindowHandle, total: Duration) {
    let mut left = total;
    while !left.is_zero() {
        if draw(cx, window).is_err() {
            return;
        }
        cx.background_executor().timer(FRAME).await;
        left = left.saturating_sub(FRAME);
    }
}

fn dispatch(
    cx: &mut AsyncApp,
    window: AnyWindowHandle,
    events: Vec<PlatformInput>,
) -> Result<(), String> {
    for event in events {
        // Each event sees the frame the one before it produced.
        draw(cx, window)?;
        cx.update_window(window, |_, window, cx| {
            window.dispatch_event(event, cx);
        })
        .map_err(|cause| cause.to_string())?;
    }
    draw(cx, window)
}

fn at(x: f32, y: f32) -> Point<Pixels> {
    point(px(x), px(y))
}

async fn execute(
    cx: &mut AsyncApp,
    window: AnyWindowHandle,
    command: Command,
) -> Result<(), String> {
    match command {
        Command::Wait(ms) => run_frames(cx, window, Duration::from_millis(ms)).await,
        Command::Move(x, y) => dispatch(cx, window, vec![moved(x, y)])?,
        Command::Click(x, y, button) => dispatch(
            cx,
            window,
            vec![
                moved(x, y),
                PlatformInput::MouseDown(MouseDownEvent {
                    button,
                    position: at(x, y),
                    modifiers: Modifiers::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                PlatformInput::MouseUp(MouseUpEvent {
                    button,
                    position: at(x, y),
                    modifiers: Modifiers::default(),
                    click_count: 1,
                }),
            ],
        )?,
        Command::Scroll(x, y, dx, dy) => dispatch(
            cx,
            window,
            vec![
                moved(x, y),
                PlatformInput::Scroll(ScrollEvent {
                    position: at(x, y),
                    delta: ScrollDelta::Pixels(at(dx, dy)),
                    ..Default::default()
                }),
            ],
        )?,
        Command::DropFile(x, y, path) => {
            let position = at(x, y);
            let paths = ExternalPaths(std::iter::once(path).collect());
            dispatch(
                cx,
                window,
                vec![
                    PlatformInput::FileDrop(FileDropEvent::Entered { position, paths }),
                    PlatformInput::FileDrop(FileDropEvent::Pending { position }),
                    PlatformInput::FileDrop(FileDropEvent::Submit { position }),
                ],
            )?;
        }
        Command::Key(keys) => {
            // A leaked string: `Keystroke::parse` wants `'static`, and a script
            // is a handful of lines in a short-lived process.
            let keystroke = Keystroke::parse(Box::leak(keys.clone().into_boxed_str()))
                .map_err(|cause| format!("key {keys}: {cause}"))?;
            keystroke_dispatch(cx, window, vec![keystroke])?;
        }
        Command::Type(text) => {
            let strokes = text
                .chars()
                .map(|c| Keystroke {
                    modifiers: Modifiers::default(),
                    key: c.to_string(),
                    key_char: Some(c.to_string()),
                })
                .collect();
            keystroke_dispatch(cx, window, strokes)?;
        }
        Command::Screenshot(path) => {
            draw(cx, window)?;
            let image = cx
                .update_window(window, |_, window, _| window.render_to_image())
                .map_err(|cause| cause.to_string())?
                .map_err(|cause| format!("render: {cause}"))?;
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent).map_err(|cause| cause.to_string())?;
            }
            image
                .save(&path)
                .map_err(|cause| format!("save {}: {cause}", path.display()))?;
            println!("automation: screenshot {}", path.display());
        }
        Command::Quit => {
            cx.update(|cx| cx.quit());
        }
    }
    Ok(())
}

fn moved(x: f32, y: f32) -> PlatformInput {
    PlatformInput::MouseMove(MouseMoveEvent {
        position: at(x, y),
        pressed_button: None,
        modifiers: Modifiers::default(),
    })
}

fn keystroke_dispatch(
    cx: &mut AsyncApp,
    window: AnyWindowHandle,
    strokes: Vec<Keystroke>,
) -> Result<(), String> {
    for stroke in strokes {
        draw(cx, window)?;
        cx.update_window(window, |_, window, cx| {
            window.dispatch_keystroke(stroke, cx);
        })
        .map_err(|cause| cause.to_string())?;
    }
    draw(cx, window)
}

#[cfg(test)]
mod tests {
    // Not a glob: with `test-support`, `gpui::test` would shadow `#[test]`.
    use super::{Command, parse};
    use gpui::MouseButton;

    #[test]
    fn reads_a_script() {
        let commands = parse(
            "# open the palette\nkey cmd-k\ntype  two  words # kept as typed\nclick 10 20.5\nscroll 5 5 0 -40\nscreenshot a/b.png\nwait 100\nquit\n",
        )
        .expect("script");
        assert_eq!(
            commands,
            vec![
                Command::Key("cmd-k".into()),
                Command::Type(" two  words # kept as typed".into()),
                Command::Click(10., 20.5, MouseButton::Left),
                Command::Scroll(5., 5., 0., -40.),
                Command::Screenshot("a/b.png".into()),
                Command::Wait(100),
                Command::Quit,
            ]
        );
    }

    #[test]
    fn names_the_line_that_is_wrong() {
        assert!(
            parse("wait 10\nclick 1")
                .unwrap_err()
                .starts_with("line 2:")
        );
        assert!(parse("dance").unwrap_err().contains("unknown command"));
    }
}
