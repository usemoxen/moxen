use crate::theme::{self, TypeScale, color};
use crate::workspace::Workspace;
use gpui::{prelude::*, *};
use std::time::{Duration, Instant};

/// One icon size per context, so a stroke reads about 1px everywhere:
/// chrome buttons 16px, disclosure chevrons 12px, inline glyphs 14px.
/// The SVGs' stroke widths are set to match (1.5, 2 and 1.75).
pub fn icon_size(name: &str) -> f32 {
    match name {
        "panel-right" | "square-pen" | "paperclip" => 16.,
        "chevron-down" | "chevron-right" | "chevron-left" => 12.,
        _ => 14.,
    }
}

pub fn icon(name: &'static str, token: &str) -> Svg {
    svg()
        .path(name)
        .size(px(icon_size(name)))
        .flex_shrink_0()
        .text_color(color(token))
}

/// A state glyph: 12px, centred in a 14px slot so it lines up with inline
/// icons (the mockup's glyphs are text at 13px, about 10px of ink). The live
/// one breathes: a slow, shallow opacity pulse.
pub fn state(status: crate::model::Status) -> AnyElement {
    let glyph = icon(status.icon(), status.token()).size(px(12.));
    let slot = || {
        div()
            .size(px(14.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
    };
    if status == crate::model::Status::Running {
        slot()
            .child(glyph)
            .with_animation(
                "live-pulse",
                Animation::new(Duration::from_millis(1800))
                    .repeat_synced()
                    .with_max_fps(30.)
                    .with_easing(|v| 0.8 + 0.2 * (v * std::f32::consts::TAU).cos()),
                |s, v| s.opacity(v),
            )
            .into_any_element()
    } else {
        slot().child(glyph).into_any_element()
    }
}

pub trait Control: Sized {
    /// An interactive control: hover and press fills, a focus ring, a tooltip.
    fn control(self, tooltip: impl Into<SharedString>) -> Self;
    /// An interactive control whose visible label needs no tooltip.
    fn plain_control(self) -> Self;
    /// A control whose tooltip carries its keyboard shortcut as a key cap.
    fn shortcut(self, tooltip: impl Into<SharedString>, key: &'static str) -> Self;
    /// A text-only control (tabs, disclosures): hover brightens the text
    /// instead of filling a background.
    fn quiet(self) -> Self;
    /// Unavailable right now: dimmed, with a tooltip saying why.
    fn disabled(self, tooltip: impl Into<SharedString>) -> Self;
}
impl Control for Stateful<Div> {
    fn disabled(self, tooltip: impl Into<SharedString>) -> Self {
        let text = tooltip.into();
        self.opacity(0.45)
            .cursor(CursorStyle::Arrow)
            .tooltip(move |_, cx| cx.new(|_| Tooltip(text.clone(), None)).into())
    }
    fn quiet(self) -> Self {
        self.cursor_pointer()
            .focusable()
            .tab_index(0)
            .hover(|s| s.text_color(color("ink")))
            .focus_visible(|s| s.shadow(theme::focus_ring()))
    }
    fn control(self, tooltip: impl Into<SharedString>) -> Self {
        let text = tooltip.into();
        interactive(self).tooltip(move |_, cx| cx.new(|_| Tooltip(text.clone(), None)).into())
    }
    fn plain_control(self) -> Self {
        interactive(self)
    }
    fn shortcut(self, tooltip: impl Into<SharedString>, key: &'static str) -> Self {
        let text = tooltip.into();
        interactive(self).tooltip(move |_, cx| cx.new(|_| Tooltip(text.clone(), Some(key))).into())
    }
}
fn interactive(control: Stateful<Div>) -> Stateful<Div> {
    control
        .cursor_pointer()
        .focusable()
        .tab_index(0)
        .hover(|s| s.bg(color("sunk")))
        .active(|s| s.bg(color("rule")))
        .focus_visible(|s| s.shadow(theme::focus_ring()))
}

pub struct Tooltip(pub SharedString, pub Option<&'static str>);
impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.body()
    }
}
impl Tooltip {
    pub(crate) fn body(&self) -> Div {
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .pl(px(8.))
            .pr(px(if self.1.is_some() { 5. } else { 8. }))
            .py(px(5.))
            .max_w(px(360.))
            .rounded(px(theme::px_token("radius", "radius-sm")))
            .bg(color("raised"))
            .shadow(theme::float_shadow())
            .font_family(theme::FONT)
            .text_size(px(12.))
            .line_height(px(16.))
            .text_color(color("ink"))
            .child(self.0.clone())
            .when_some(self.1, |s, key| s.child(kbd(key)))
    }
}

/// A key cap: the design system's `Kbd`.
pub fn kbd(key: &'static str) -> Div {
    div()
        .flex_shrink_0()
        .px(px(5.))
        .h(px(18.))
        .flex()
        .items_center()
        .border_1()
        .border_b_2()
        .border_color(color("rule"))
        .rounded(px(theme::px_token("radius", "radius-xs")))
        .bg(color("raised"))
        .font_family(theme::MONO)
        .text_size(px(11.))
        .line_height(px(16.))
        .text_color(color("ink-2"))
        .child(key)
}

/// A small uppercase section label (`mono-caps`).
pub fn caps(label: &str) -> Div {
    div()
        .type_scale("mono-caps")
        .text_color(color("ink-2"))
        .child(label.to_uppercase())
}

pub fn switch_track(on: bool) -> Div {
    div()
        .w(px(30.))
        .h(px(16.))
        .px(px(2.))
        .flex()
        .items_center()
        .when(on, |track| track.justify_end())
        .rounded_full()
        .bg(color(if on { "live" } else { "rule" }))
        .child(
            div()
                .size(px(12.))
                .rounded_full()
                .bg(color(if on { "ground" } else { "ink-2" })),
        )
}

/// The design system's `Segmented`: options in a `sunk` tray, the chosen one
/// raised on a hairline ring. `pad` is each option's inline padding (the
/// design system's is 11; tight popovers use less).
pub fn segmented(
    id: &'static str,
    options: &[&'static str],
    selected: usize,
    pad: f32,
    cx: &mut Context<Workspace>,
    set: fn(&mut Workspace, usize),
) -> Div {
    let labels: Vec<SharedString> = options
        .iter()
        .map(|l| crate::language::capitalized(&crate::language::tr(l)).into())
        .collect();
    segments(id.into(), &labels, selected, pad, cx, move |this, i, _| {
        set(this, i)
    })
}

/// `segmented` for options only known at run time.
pub fn segments(
    id: SharedString,
    options: &[SharedString],
    selected: usize,
    pad: f32,
    cx: &mut Context<Workspace>,
    set: impl Fn(&mut Workspace, usize, &mut Context<Workspace>) + Clone + 'static,
) -> Div {
    div()
        .flex()
        .p(px(3.))
        .gap(px(2.))
        .rounded(px(theme::px_token("radius", "radius-md")))
        .bg(color("sunk"))
        .children(options.iter().enumerate().map(|(i, label)| {
            let on = selected == i;
            let set = set.clone();
            div()
                .id(ElementId::NamedInteger(id.clone(), i as u64))
                .control(label.clone())
                .flex()
                .items_center()
                .h(px(24.))
                .px(px(pad))
                .rounded(px(theme::px_token("radius", "radius-sm")))
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
                .child(label.clone())
                .on_click(cx.listener(move |this, _, _, cx| {
                    set(this, i, cx);
                    cx.notify();
                }))
        }))
}

/// Eased progress of a transition that started at `since`, from 0 to 1.
/// While it runs it asks for the next frame, so the caller just re-renders.
pub fn progress(since: Option<Instant>, ms: u64, window: &mut Window) -> f32 {
    let Some(since) = since else { return 1. };
    let t = (since.elapsed().as_secs_f32() / (ms as f32 / 1000.)).min(1.);
    if t < 1. {
        window.request_animation_frame();
    }
    1. - (1. - t).powi(3)
}

/// The expand transition for content that opens in place (150ms, ease-out).
pub fn expand() -> Animation {
    Animation::new(Duration::from_millis(150)).with_easing(|v| 1. - (1. - v).powi(3))
}

/// Where a keyboard-focus tip opens relative to its control.
#[derive(Clone, Copy)]
pub enum Tip {
    BelowRight,
    BelowLeft,
    AboveRight,
}

/// Hover tooltips never show for keyboard users (GPUI suppresses hover in
/// keyboard modality), so toolbar controls show the same tip, with its
/// shortcut, while they hold keyboard focus.
pub fn focus_tip(
    handle: &FocusHandle,
    window: &Window,
    label: &'static str,
    key: &'static str,
    place: Tip,
) -> Option<AnyElement> {
    if !(handle.is_focused(window) && window.last_input_was_keyboard()) {
        return None;
    }
    let tip = div()
        .absolute()
        .flex()
        .whitespace_nowrap()
        .child(Tooltip(label.into(), Some(key)).body());
    let tip = match place {
        Tip::BelowRight => tip.top(relative(1.)).mt(px(6.)).right_0(),
        Tip::BelowLeft => tip.top(relative(1.)).mt(px(6.)).left_0(),
        Tip::AboveRight => tip.bottom(relative(1.)).mb(px(6.)).right_0(),
    };
    Some(deferred(tip).with_priority(1).into_any_element())
}
