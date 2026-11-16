mod assets;
#[cfg(feature = "render-harness")]
mod automation;
mod composer;
mod connection;
mod diff;
mod inspector;
mod live;
mod mock;
mod model;
mod model_picker;
mod palette;
mod sidebar;
mod steps;
mod theme;
mod thread_view;
mod title_bar;
mod transcript;
mod ui;
mod usage;
mod wire;
mod workspace;

use gpui::*;
actions!(app, [Quit]);

fn main() {
    let demo = std::env::args().any(|a| a == "--demo");
    gpui_platform::application()
        .with_assets(assets::DesktopAssets)
        .run(move |cx| {
            cx.text_system()
                .add_fonts(vec![
                    std::borrow::Cow::Borrowed(
                        include_bytes!("../fonts/AtkinsonHyperlegibleNext-500.ttf").as_slice(),
                    ),
                    std::borrow::Cow::Borrowed(
                        include_bytes!("../fonts/AtkinsonHyperlegibleNext-600.ttf").as_slice(),
                    ),
                    std::borrow::Cow::Borrowed(
                        include_bytes!("../fonts/AtkinsonHyperlegibleNext-700.ttf").as_slice(),
                    ),
                    std::borrow::Cow::Borrowed(
                        include_bytes!("../fonts/AtkinsonHyperlegibleNext-800.ttf").as_slice(),
                    ),
                    std::borrow::Cow::Borrowed(
                        include_bytes!("../fonts/AtkinsonHyperlegibleMono-500.ttf").as_slice(),
                    ),
                    std::borrow::Cow::Borrowed(
                        include_bytes!("../fonts/AtkinsonHyperlegibleNext-Italic.ttf").as_slice(),
                    ),
                    std::borrow::Cow::Borrowed(
                        include_bytes!("../fonts/AtkinsonHyperlegibleMono.ttf").as_slice(),
                    ),
                    std::borrow::Cow::Borrowed(
                        include_bytes!("../fonts/AtkinsonHyperlegibleNext.ttf").as_slice(),
                    ),
                ])
                .expect("load bundled font");
            composer::bind_keys(cx);
            cx.bind_keys([
                KeyBinding::new("up", sidebar::PreviousThread, Some("Sidebar")),
                KeyBinding::new("down", sidebar::NextThread, Some("Sidebar")),
                KeyBinding::new("cmd-q", Quit, None),
                KeyBinding::new("cmd-i", title_bar::ToggleInspector, None),
                KeyBinding::new("ctrl-t", title_bar::ToggleTasks, None),
                KeyBinding::new("cmd-k", palette::OpenPalette, None),
                KeyBinding::new("cmd-m", model_picker::TogglePicker, None),
                KeyBinding::new("escape", palette::Dismiss, None),
                KeyBinding::new("tab", palette::NextFocus, None),
                KeyBinding::new("shift-tab", palette::PreviousFocus, None),
            ]);
            cx.on_action(|_: &Quit, cx| cx.quit());
            // The "small" demo stage checks that all three regions fit a
            // 1280×800 window as well as the 1440×900 reference.
            let small = std::env::args().nth(2).as_deref() == Some("small");
            let (width, height) = if small {
                (1280., 800.)
            } else {
                (theme::WIDTH, theme::HEIGHT)
            };
            let bounds = Bounds::centered(None, size(px(width), px(height)), cx);
            // Automation never shows, focuses or activates the window.
            #[cfg(feature = "render-harness")]
            let automation = automation::requested();
            #[cfg(not(feature = "render-harness"))]
            let automation: Option<std::path::PathBuf> = None;
            let visible = automation.is_none();
            let _window = cx
                .open_window(
                    WindowOptions {
                        focus: visible,
                        show: visible,
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: Some(TitlebarOptions {
                            appears_transparent: true,
                            title: Some("Moxen Agent".into()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                    |window, cx| {
                        let workspace = cx.new(|cx| workspace::Workspace::new(demo, window, cx));
                        window.focus(&workspace.read(cx).sidebar_focus.clone(), cx);
                        workspace
                    },
                )
                .expect("open Moxen Agent window");
            if let Some(_script) = automation {
                #[cfg(feature = "render-harness")]
                automation::start(cx, _window.into(), _script);
            } else {
                cx.activate(true);
            }
        });
}
