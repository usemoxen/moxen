use crate::theme::{self, color};
use gpui::{prelude::*, *};
use std::time::Duration;

pub fn icon(name: &'static str, token: &str) -> Svg {
    svg()
        .path(name)
        .size(px(14.))
        .flex_shrink_0()
        .text_color(color(token))
}

pub fn state(status: crate::model::Status) -> AnyElement {
    let glyph = icon(status.icon(), status.token());
    if status == crate::model::Status::Running {
        glyph
            .with_animation(
                "live-pulse",
                Animation::new(Duration::from_secs(2))
                    .repeat_synced()
                    .with_max_fps(30.)
                    .with_easing(|v| 0.75 + 0.25 * (v * std::f32::consts::TAU).cos()),
                |s, v| s.opacity(v),
            )
            .into_any_element()
    } else {
        glyph.into_any_element()
    }
}

pub trait Control: Sized {
    fn control(self, tooltip: impl Into<SharedString>) -> Self;
}
impl Control for Stateful<Div> {
    fn control(self, tooltip: impl Into<SharedString>) -> Self {
        let text = tooltip.into();
        self.cursor_pointer()
            .focusable()
            .tab_index(0)
            .hover(|s| s.bg(color("sunk")))
            .active(|s| s.bg(color("rule")))
            .focus_visible(|s| {
                s.shadow(vec![BoxShadow {
                    inset: true,
                    color: color("live"),
                    offset: point(px(0.), px(0.)),
                    blur_radius: px(0.),
                    spread_radius: px(1.),
                }])
            })
            .tooltip(move |_, cx| cx.new(|_| Tooltip(text.clone())).into())
    }
}
pub struct Tooltip(pub SharedString);
impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(10.))
            .py(px(5.))
            .max_w(px(420.))
            .rounded(px(6.))
            .bg(color("raised"))
            .border_1()
            .border_color(color("rule"))
            .shadow(theme::float_shadow())
            .font_family(theme::FONT)
            .text_size(px(12.))
            .text_color(color("ink"))
            .child(self.0.clone())
    }
}

pub fn reveal() -> Animation {
    Animation::new(Duration::from_millis(160)).with_easing(|v| 1. - (1. - v).powi(3))
}
