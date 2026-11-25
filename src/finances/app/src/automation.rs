//! Drives the window from a script without ever taking focus, for checking
//! the app's look in every language and theme while someone else is using the
//! computer. Compiled only with the `render-harness` feature and only active
//! when `MOXEN_FINANCES_AUTOMATION` names a script; the window is created
//! hidden and never activated. A screenshot is GPUI's own offscreen render of
//! the frame.
//!
//! A script is one command per line; a line starting with `#` is a comment:
//!
//! ```text
//! wait 300                 # run frames for 300 ms
//! page subscriptions       # dashboard | subscriptions | movements | projection | calendar | analysis | settings
//! lang es-ES               # en | es-ES
//! theme light              # dark | light
//! account all              # all | <index of the account in the selector>
//! dialog new-subscription  # new-subscription | new-expense | new-account | transfer
//! scenario 350.00 5 Compra puntual   # add a scenario event: amount, days ahead, label
//! screenshot out/main.png  # draws a frame and saves it
//! quit
//! ```

use gpui::{prelude::*, *};
use moxen_finances_ui::data::{AccountSelection, MovementKind};
use moxen_finances_ui::dialog::{self, Dialog};
use moxen_finances_ui::language::Language;
use moxen_finances_ui::shell::{FinancesApp, Page};
use moxen_finances_ui::theme::ThemeMode;
use std::path::PathBuf;
use std::time::Duration;

/// The frame time while a `wait` runs, so timers progress.
const FRAME: Duration = Duration::from_millis(16);

/// Whether a script was asked for.
pub fn requested() -> Option<PathBuf> {
    std::env::var_os("MOXEN_FINANCES_AUTOMATION")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Wait(u64),
    Page(String),
    Lang(String),
    Theme(String),
    Account(String),
    Dialog(String),
    Scenario(String, i64, String),
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
        let rest = rest.trim();
        commands.push(match name {
            "wait" => Command::Wait(rest.parse().map_err(|_| at("expected milliseconds"))?),
            "page" if !rest.is_empty() => Command::Page(rest.to_string()),
            "lang" if !rest.is_empty() => Command::Lang(rest.to_string()),
            "theme" if !rest.is_empty() => Command::Theme(rest.to_string()),
            "account" if !rest.is_empty() => Command::Account(rest.to_string()),
            "dialog" if !rest.is_empty() => Command::Dialog(rest.to_string()),
            "scenario" => {
                let (amount, rest) = rest
                    .split_once(' ')
                    .ok_or_else(|| at("scenario <amount> <days-ahead> <label…>"))?;
                let (days, label) = rest
                    .split_once(' ')
                    .ok_or_else(|| at("scenario <amount> <days-ahead> <label…>"))?;
                Command::Scenario(
                    amount.to_string(),
                    days.parse()
                        .map_err(|_| at("days-ahead must be an integer"))?,
                    label.to_string(),
                )
            }
            "screenshot" if !rest.is_empty() => Command::Screenshot(rest.into()),
            "quit" => Command::Quit,
            _ => return Err(at("unknown command")),
        });
    }
    Ok(commands)
}

/// Runs the script against `window` as a task on the app's executor.
pub fn start(cx: &mut App, window: WindowHandle<FinancesApp>, script: PathBuf) {
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
    let any_window = window.into();
    cx.spawn(async move |cx| {
        // Let the first frame settle: fonts and layout.
        run_frames(cx, any_window, Duration::from_millis(1200)).await;
        for command in commands {
            if let Err(message) = execute(cx, window, any_window, command).await {
                eprintln!("automation: {message}");
                std::process::exit(1);
            }
        }
        println!("automation: done");
        cx.update(|cx| cx.quit());
    })
    .detach();
}

/// Draws a frame so the next command sees what is on screen.
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

async fn execute(
    cx: &mut AsyncApp,
    window: WindowHandle<FinancesApp>,
    any_window: AnyWindowHandle,
    command: Command,
) -> Result<(), String> {
    match command {
        Command::Wait(ms) => run_frames(cx, any_window, Duration::from_millis(ms)).await,
        Command::Page(id) => {
            let page = Page::from_id(&id).ok_or_else(|| format!("unknown page: {id}"))?;
            draw(cx, any_window)?;
            window
                .update(cx, |app, _, cx| app.set_page(page, cx))
                .map_err(|cause| cause.to_string())?;
            draw(cx, any_window)?;
        }
        Command::Lang(code) => {
            let language = Language::from_setting(Some(&code));
            if language.code() != code {
                return Err(format!("unknown language: {code}"));
            }
            draw(cx, any_window)?;
            window
                .update(cx, |app, _, cx| app.set_language(language, cx))
                .map_err(|cause| cause.to_string())?;
            draw(cx, any_window)?;
        }
        Command::Theme(name) => {
            let mode = match name.as_str() {
                "dark" => ThemeMode::Dark,
                "light" => ThemeMode::Light,
                _ => return Err(format!("unknown theme: {name}")),
            };
            draw(cx, any_window)?;
            window
                .update(cx, |app, _, cx| app.set_theme(mode, cx))
                .map_err(|cause| cause.to_string())?;
            draw(cx, any_window)?;
        }
        Command::Account(which) => {
            draw(cx, any_window)?;
            window
                .update(cx, |app, _, cx| -> Result<(), String> {
                    let selection = if which == "all" {
                        AccountSelection::All
                    } else {
                        let index: usize = which
                            .parse()
                            .map_err(|_| format!("account <all|index>: {which}"))?;
                        app.data
                            .accounts()
                            .iter()
                            .filter(|account| !account.archived)
                            .nth(index)
                            .map(|account| AccountSelection::One(account.id.clone()))
                            .ok_or_else(|| format!("no account at index {index}"))?
                    };
                    app.select_account(selection, cx);
                    Ok(())
                })
                .map_err(|cause| cause.to_string())??;
            draw(cx, any_window)?;
        }
        Command::Dialog(which) => {
            let wanted = match which.as_str() {
                "new-subscription" => Dialog::NewSubscription,
                "new-expense" => Dialog::NewMovement(MovementKind::Expense),
                "new-account" => Dialog::NewAccount,
                "transfer" => Dialog::Transfer,
                _ => return Err(format!("unknown dialog: {which}")),
            };
            draw(cx, any_window)?;
            window
                .update(cx, |app, _, cx| dialog::open(app, wanted, cx))
                .map_err(|cause| cause.to_string())?;
            draw(cx, any_window)?;
        }
        Command::Scenario(amount, days, label) => {
            draw(cx, any_window)?;
            window
                .update(cx, |app, _, cx| {
                    let today = app.data.today();
                    app.projection.draft_amount = amount;
                    app.projection.draft_name = label;
                    app.projection.draft_date = today + chrono::Duration::days(days);
                    app.add_scenario_event(cx);
                })
                .map_err(|cause| cause.to_string())?;
            draw(cx, any_window)?;
        }
        Command::Screenshot(path) => {
            draw(cx, any_window)?;
            let image = cx
                .update_window(any_window, |_, window, _| window.render_to_image())
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

#[cfg(test)]
mod tests {
    use super::{Command, parse};

    #[test]
    fn reads_a_script() {
        let commands = parse(
            "# render the dashboard in Spanish\npage dashboard\nlang es-ES\ntheme light\naccount all\naccount 1\nwait 300\nscenario 350.00 5 Compra puntual\nscreenshot shots/a.png\nquit\n",
        )
        .expect("script");
        assert_eq!(
            commands,
            vec![
                Command::Page("dashboard".into()),
                Command::Lang("es-ES".into()),
                Command::Theme("light".into()),
                Command::Account("all".into()),
                Command::Account("1".into()),
                Command::Wait(300),
                Command::Scenario("350.00".into(), 5, "Compra puntual".into()),
                Command::Screenshot("shots/a.png".into()),
                Command::Quit,
            ]
        );
    }

    #[test]
    fn names_the_line_that_is_wrong() {
        assert!(parse("page").unwrap_err().starts_with("line 1:"));
        assert!(parse("dance").unwrap_err().contains("unknown command"));
        assert!(
            parse("scenario 10")
                .unwrap_err()
                .contains("scenario <amount>")
        );
        assert!(
            parse("scenario 10 x label")
                .unwrap_err()
                .contains("days-ahead")
        );
    }
}
