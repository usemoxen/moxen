mod composer;
mod inspector;
mod mock;
mod model;
mod model_picker;
mod sidebar;
mod steps;
mod theme;
mod thread_view;
mod title_bar;
mod workspace;

use gpui::*;
actions!(app, [Quit]);

fn main() {
    let demo = std::env::args().any(|a| a == "--demo");
    gpui_platform::application()
        .with_assets(DesktopAssets)
        .run(move |cx| {
            cx.text_system()
                .add_fonts(vec![
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
            ]);
            cx.on_action(|_: &Quit, cx| cx.quit());
            let bounds = Bounds::centered(None, size(px(theme::WIDTH), px(theme::HEIGHT)), cx);
            cx.open_window(
                WindowOptions {
                    focus: !demo,
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
            if !demo {
                cx.activate(true);
            }
        });
}

struct DesktopAssets;
impl AssetSource for DesktopAssets {
    fn load(&self, path: &str) -> Result<Option<std::borrow::Cow<'static, [u8]>>> {
        Ok((path == "agent-mark").then(|| {
            std::borrow::Cow::Borrowed(
                include_bytes!("../design-system/assets/logos/agent-mark-on-dark.svg").as_slice(),
            )
        }))
    }
    fn list(&self, _: &str) -> Result<Vec<SharedString>> {
        Ok(vec!["agent-mark".into()])
    }
}
