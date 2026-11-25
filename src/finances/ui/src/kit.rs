//! Small controls shared by the views, in the Moxen design system's terms.

use crate::theme::{self, TypeScale, color};
use gpui::{prelude::*, *};

pub fn icon(name: &'static str, token: &str, size: f32) -> Svg {
    svg()
        .path(name)
        .size(px(size))
        .flex_shrink_0()
        .text_color(color(token))
}

/// A small uppercase section label (`mono-caps`).
pub fn caps(label: &str) -> Div {
    div()
        .type_scale("mono-caps")
        .text_color(color("ink-2"))
        .child(label.to_uppercase())
}

pub struct Tooltip(pub SharedString);

impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(8.))
            .py(px(5.))
            .max_w(px(360.))
            .rounded(px(theme::radius("radius-sm")))
            .bg(color("raised"))
            .shadow(theme::float_shadow())
            .font_family(theme::FONT)
            .text_size(px(12.))
            .line_height(px(16.))
            .text_color(color("ink"))
            .child(self.0.clone())
    }
}

pub trait Control: Sized {
    /// An interactive control: hover and press fills, a focus ring, a tooltip.
    fn control(self, tooltip: impl Into<SharedString>) -> Self;
    /// Unavailable right now: dimmed, arrow cursor, a tooltip saying why.
    fn disabled(self, tooltip: impl Into<SharedString>) -> Self;
}

impl Control for Stateful<Div> {
    fn control(self, tooltip: impl Into<SharedString>) -> Self {
        let text = tooltip.into();
        self.cursor_pointer()
            .focusable()
            .tab_index(0)
            .hover(|s| s.bg(color("sunk")))
            .active(|s| s.bg(color("rule")))
            .focus_visible(|s| s.shadow(theme::focus_ring()))
            .tooltip(move |_, cx| cx.new(|_| Tooltip(text.clone())).into())
    }

    fn disabled(self, tooltip: impl Into<SharedString>) -> Self {
        let text = tooltip.into();
        self.opacity(0.45)
            .cursor(CursorStyle::Arrow)
            .tooltip(move |_, cx| cx.new(|_| Tooltip(text.clone())).into())
    }
}

/// A secondary button row.
pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(28.))
        .px(px(12.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(theme::radius("radius-md")))
        .bg(color("sunk"))
        .font_family(theme::FONT)
        .text_size(px(13.))
        .line_height(px(17.))
        .text_color(color("ink"))
        .child(label.into())
}

/// The design system's `Segmented`: options in a `sunk` tray, the chosen one
/// raised on a hairline ring.
pub fn segmented<E: 'static>(
    id: &'static str,
    options: &[SharedString],
    selected: usize,
    cx: &mut Context<E>,
    on_select: impl Fn(&mut E, usize, &mut Context<E>) + Clone + 'static,
) -> Div {
    div()
        .flex()
        .p(px(3.))
        .gap(px(2.))
        .rounded(px(theme::radius("radius-md")))
        .bg(color("sunk"))
        .children(options.iter().enumerate().map(|(i, label)| {
            let on = selected == i;
            let on_select = on_select.clone();
            div()
                .id((id, i))
                .h(px(24.))
                .px(px(11.))
                .flex()
                .items_center()
                .rounded(px(theme::radius("radius-sm")))
                .cursor_pointer()
                .font_family(theme::FONT)
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(color(if on { "ink" } else { "ink-2" }))
                .when(on, |s| {
                    s.bg(color("raised")).shadow(vec![BoxShadow {
                        inset: false,
                        color: color("rule"),
                        offset: point(px(0.), px(0.)),
                        blur_radius: px(0.),
                        spread_radius: px(1.),
                    }])
                })
                .hover(|s| s.text_color(color("ink")))
                .child(label.clone())
                .on_click(cx.listener(move |this, _, _, cx| {
                    on_select(this, i, cx);
                }))
        }))
}
