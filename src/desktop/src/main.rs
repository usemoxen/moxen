mod composer;
mod mock;
mod model;
mod sidebar;
mod theme;
mod thread_view;
mod workspace;

use gpui::*;
actions!(app, [Quit]);

fn main() {
    let demo = std::env::args().any(|a| a == "--demo");
    gpui_platform::application().run(move |cx| {
        cx.text_system()
            .add_fonts(vec![std::borrow::Cow::Borrowed(
                include_bytes!("../fonts/AtkinsonHyperlegibleNext.ttf").as_slice(),
            )])
            .expect("load bundled font");
        composer::bind_keys(cx);
        cx.bind_keys([
            KeyBinding::new("up", sidebar::PreviousThread, Some("Sidebar")),
            KeyBinding::new("down", sidebar::NextThread, Some("Sidebar")),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        let bounds = Bounds::centered(None, size(px(theme::WIDTH), px(theme::HEIGHT)), cx);
        cx.open_window(
            WindowOptions {
                focus: !demo,
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
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
