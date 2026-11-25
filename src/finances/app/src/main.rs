//! Moxen Finances — the standalone GPUI app. Opens one window over the
//! [`FinancesData`] view-model (the fictional [`DemoData`] until the store
//! crate plugs in) and persists only the chosen language.

#[cfg(feature = "render-harness")]
mod automation;
mod settings_file;

use gpui::*;
use moxen_finances_ui::assets::FinancesAssets;
use moxen_finances_ui::demo::DemoData;
use moxen_finances_ui::shell::FinancesApp;
use moxen_finances_ui::theme;
use std::borrow::Cow;
use std::rc::Rc;

actions!(app, [Quit]);

fn primary_key(mac: &'static str, other: &'static str) -> &'static str {
    if cfg!(target_os = "macos") {
        mac
    } else {
        other
    }
}

fn main() {
    #[cfg(feature = "render-harness")]
    let script = automation::requested();
    #[cfg(not(feature = "render-harness"))]
    let script: Option<std::path::PathBuf> = None;
    // The harness window never shows, focuses or activates itself.
    let visible = script.is_none();
    gpui_platform::application()
        .with_assets(FinancesAssets)
        .run(move |cx| {
            cx.text_system()
                .add_fonts(vec![
                    Cow::Borrowed(
                        include_bytes!("../../../desktop/fonts/AtkinsonHyperlegibleNext.ttf")
                            .as_slice(),
                    ),
                    Cow::Borrowed(
                        include_bytes!("../../../desktop/fonts/AtkinsonHyperlegibleNext-500.ttf")
                            .as_slice(),
                    ),
                    Cow::Borrowed(
                        include_bytes!("../../../desktop/fonts/AtkinsonHyperlegibleNext-600.ttf")
                            .as_slice(),
                    ),
                    Cow::Borrowed(
                        include_bytes!("../../../desktop/fonts/AtkinsonHyperlegibleNext-700.ttf")
                            .as_slice(),
                    ),
                    Cow::Borrowed(
                        include_bytes!("../../../desktop/fonts/AtkinsonHyperlegibleNext-800.ttf")
                            .as_slice(),
                    ),
                    Cow::Borrowed(
                        include_bytes!(
                            "../../../desktop/fonts/AtkinsonHyperlegibleNext-Italic.ttf"
                        )
                        .as_slice(),
                    ),
                    Cow::Borrowed(
                        include_bytes!("../../../desktop/fonts/AtkinsonHyperlegibleMono.ttf")
                            .as_slice(),
                    ),
                    Cow::Borrowed(
                        include_bytes!("../../../desktop/fonts/AtkinsonHyperlegibleMono-500.ttf")
                            .as_slice(),
                    ),
                ])
                .expect("load bundled fonts");
            cx.bind_keys([KeyBinding::new(primary_key("cmd-q", "ctrl-q"), Quit, None)]);
            cx.on_action(|_: &Quit, cx| cx.quit());
            let language = settings_file::load_language();
            // The render harness may ask for a taller window (MOXEN_FINANCES_WINDOW
            // = "WxH") so a screenshot captures a whole page, not just the fold.
            let (width, height) = script
                .as_ref()
                .and_then(|_| std::env::var("MOXEN_FINANCES_WINDOW").ok())
                .and_then(|value| {
                    let (w, h) = value.split_once('x')?;
                    Some((w.parse().ok()?, h.parse().ok()?))
                })
                .unwrap_or((theme::WIDTH, theme::HEIGHT));
            let bounds = Bounds::centered(None, size(px(width), px(height)), cx);
            let _window = cx
                .open_window(
                    WindowOptions {
                        focus: visible,
                        show: visible,
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: Some(TitlebarOptions {
                            appears_transparent: true,
                            title: Some("Moxen Finances".into()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                    |_window, cx| {
                        cx.new(|_cx| {
                            FinancesApp::new(Rc::new(DemoData::new()), language.as_deref())
                                .on_language_change(|language| {
                                    settings_file::save_language(language.code())
                                })
                        })
                    },
                )
                .expect("open the Moxen Finances window");
            if let Some(_script) = script {
                #[cfg(feature = "render-harness")]
                automation::start(cx, _window, _script);
            } else {
                cx.activate(true);
            }
        });
}
