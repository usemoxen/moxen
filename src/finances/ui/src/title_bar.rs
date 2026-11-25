//! The window's title bar: the app mark and name on the left, the current
//! date on the right.

use crate::format;
use crate::language::message;
use crate::shell::FinancesApp;
use crate::theme::{self, color};
use gpui::{prelude::*, *};

/// The Finances mark: a `tile` with the euro sign in `tile-ink`.
fn mark() -> Div {
    div()
        .size(px(22.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(theme::radius("radius-sm")))
        .bg(color("tile"))
        .font_family(theme::MONO)
        .font_weight(FontWeight::BOLD)
        .text_size(px(13.))
        .text_color(color("tile-ink"))
        .child("€")
}

/// The bar's height, which the standalone window centres the macOS traffic
/// lights in.
pub const HEIGHT: f32 = 44.;
/// Where the standalone window puts the first traffic light.
pub const TRAFFIC_LIGHTS: (f32, f32) = (12., 15.);
/// Where the mark starts when the traffic lights share the bar: just past the
/// third one.
const AFTER_TRAFFIC_LIGHTS: f32 = 84.;
const EDGE: f32 = 16.;

/// The bar's left padding. Only a windowed macOS app draws native controls
/// over it: full screen hides them, and Windows keeps its own title bar.
fn leading(macos: bool, fullscreen: bool) -> f32 {
    if macos && !fullscreen {
        AFTER_TRAFFIC_LIGHTS
    } else {
        EDGE
    }
}

pub fn render(
    app: &FinancesApp,
    window: &Window,
    _cx: &mut Context<FinancesApp>,
) -> impl IntoElement {
    div()
        .h(px(HEIGHT))
        .flex_shrink_0()
        .pl(px(leading(
            cfg!(target_os = "macos"),
            window.is_fullscreen(),
        )))
        .pr(px(12.))
        .flex()
        .items_center()
        .gap(px(8.))
        .border_b_1()
        .border_color(color("rule"))
        .bg(color("ground"))
        .child(mark())
        .child(
            div()
                .text_size(px(14.))
                .line_height(px(18.))
                .font_weight(FontWeight::BOLD)
                .child(message("app.title")),
        )
        .child(div().flex_1())
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(12.))
                .line_height(px(16.))
                .text_color(color("ink-2"))
                .child(format::long_date(app.data.today())),
        )
}

#[cfg(test)]
mod tests {
    use super::leading;

    #[test]
    fn the_bar_only_clears_controls_that_are_there() {
        assert_eq!(leading(true, false), 84.);
        assert_eq!(leading(true, true), 16.);
        assert_eq!(leading(false, false), 16.);
    }
}
