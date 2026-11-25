//! Moxen Finances — the standalone GPUI app. Opens one window over the
//! [`FinancesData`] view-model: the store-backed `StoreData` (LOCAL-030) by
//! default, or the fictional [`DemoData`] when `MOXEN_FINANCES_DEMO=1` (tests
//! and the render harness). Only the chosen language is persisted.

#[cfg(feature = "render-harness")]
mod automation;
mod bank_sync;
#[cfg(feature = "render-harness")]
mod preview;
mod settings_file;
mod store_data;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod ui_tests;

use gpui::*;
use moxen_finances_ui::assets::FinancesAssets;
use moxen_finances_ui::commands::FinancesMutations;
use moxen_finances_ui::data::FinancesData;
use moxen_finances_ui::demo::DemoData;
use moxen_finances_ui::shell::FinancesApp;
use moxen_finances_ui::{theme, title_bar};
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

/// What `build_data` hands back: the read side, the write side (when the
/// store is behind it) and a startup error to show as the banner.
struct DataSource {
    data: Rc<dyn FinancesData>,
    mutations: Option<Rc<dyn FinancesMutations>>,
    startup_error: Option<String>,
}

/// The data source for the window: the store at `MOXEN_FINANCES_DB` or the
/// platform data path (seeded with the fictional demo data when the file is
/// new), or the demo data when `MOXEN_FINANCES_DEMO=1` asks for it. A store
/// that fails to open falls back to the demo with the error as the banner.
fn build_data() -> DataSource {
    let demo = std::env::var_os("MOXEN_FINANCES_DEMO")
        .is_some_and(|value| value == "1" || value == "true");
    #[cfg(feature = "render-harness")]
    if demo && preview::requested() {
        return DataSource {
            data: Rc::new(preview::PreviewData(DemoData::new())),
            mutations: Some(Rc::new(preview::NoMutations)),
            startup_error: None,
        };
    }
    if demo {
        return DataSource {
            data: Rc::new(DemoData::new()),
            mutations: None,
            startup_error: None,
        };
    }
    let path = match moxen_finances_store::paths::database_path() {
        Ok(path) => path,
        Err(error) => {
            return DataSource {
                data: Rc::new(DemoData::new()),
                mutations: None,
                startup_error: Some(store_data::map_error(error).localized()),
            };
        }
    };
    match store_data::StoreData::initialize(&path) {
        Ok(data) => {
            // The automatic bank sync runs for as long as the window is open,
            // on its own thread and its own connection to the file. With no
            // interval set (the default) a turn finds nothing due.
            bank_sync::start_scheduler(path.clone(), data.bank_runtime());
            let shared = Rc::new(data);
            let reads: Rc<dyn FinancesData> = shared.clone();
            let writes: Rc<dyn FinancesMutations> = shared;
            DataSource {
                data: reads,
                mutations: Some(writes),
                startup_error: None,
            }
        }
        Err(error) => DataSource {
            data: Rc::new(DemoData::new()),
            mutations: None,
            startup_error: Some(error.localized()),
        },
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
            let source = build_data();
            let _window = cx
                .open_window(
                    WindowOptions {
                        focus: visible,
                        show: visible,
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: Some(TitlebarOptions {
                            // Only macOS keeps its window buttons on a
                            // transparent title bar. Elsewhere gpui would hide
                            // them and this app draws none, so the system's
                            // title bar stays.
                            appears_transparent: cfg!(target_os = "macos"),
                            title: Some("Moxen Finances".into()),
                            traffic_light_position: Some(point(
                                px(title_bar::TRAFFIC_LIGHTS.0),
                                px(title_bar::TRAFFIC_LIGHTS.1),
                            )),
                        }),
                        ..Default::default()
                    },
                    |_window, cx| {
                        cx.new(|cx| {
                            let mut app = FinancesApp::new(
                                source.data,
                                language.as_deref(),
                                source.mutations,
                            )
                            .on_language_change(|language| {
                                settings_file::save_language(language.code())
                            });
                            if let Some(error) = source.startup_error {
                                app.set_error(error, cx);
                            }
                            app
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
