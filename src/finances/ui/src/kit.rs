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
    /// [`Control::control`] for a filled primary button: it keeps its fill and
    /// fades on hover.
    fn primary_control(self, tooltip: impl Into<SharedString>) -> Self;
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

    fn primary_control(self, tooltip: impl Into<SharedString>) -> Self {
        let text = tooltip.into();
        self.cursor_pointer()
            .focusable()
            .tab_index(0)
            .hover(|s| s.opacity(0.88))
            .active(|s| s.opacity(0.75))
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

fn button_base(id: impl Into<ElementId>) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(30.))
        .px(px(12.))
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .whitespace_nowrap()
        .rounded(px(theme::radius("radius-md")))
        .border(px(theme::px_token("stroke", "stroke-rule")))
        .font_family(theme::FONT)
        .font_weight(FontWeight::SEMIBOLD)
        .text_size(px(13.))
        .line_height(px(17.))
}

/// The design system's secondary `Button`: an `edge` outline, so an enabled
/// button never reads as a disabled one. [`Control::disabled`] dims it.
pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Stateful<Div> {
    button_base(id)
        .border_color(color("edge"))
        .text_color(color("ink"))
        .child(label.into())
}

/// A secondary button with its icon before the label.
pub fn icon_label_button(
    id: impl Into<ElementId>,
    icon_name: &'static str,
    label: impl Into<SharedString>,
) -> Stateful<Div> {
    button_base(id)
        .border_color(color("edge"))
        .text_color(color("ink"))
        .child(icon(icon_name, "ink", 13.))
        .child(label.into())
}

/// The primary `Button` (`ink` fill), one per view: the main action.
pub fn primary_button(
    id: impl Into<ElementId>,
    icon_name: Option<&'static str>,
    label: impl Into<SharedString>,
) -> Stateful<Div> {
    button_base(id)
        .bg(color("ink"))
        .border_color(color("ink"))
        .text_color(color("on-ink"))
        .when_some(icon_name, |s, name| s.child(icon(name, "on-ink", 13.)))
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
    segmented_with_ids(
        move |option| ElementId::NamedInteger(id.into(), option as u64),
        options,
        selected,
        cx,
        on_select,
    )
}

/// The same control for a page that draws it once per row (one chooser per
/// linked account, say): `row` keeps the element ids apart, which gpui requires
/// of two elements of one kind on one page.
pub fn segmented_at<E: 'static>(
    id: &'static str,
    row: usize,
    options: &[SharedString],
    selected: usize,
    cx: &mut Context<E>,
    on_select: impl Fn(&mut E, usize, &mut Context<E>) + Clone + 'static,
) -> Div {
    segmented_with_ids(
        move |option| ElementId::Name(format!("{id}-{row}-{option}").into()),
        options,
        selected,
        cx,
        on_select,
    )
}

fn segmented_with_ids<E: 'static>(
    element_id: impl Fn(usize) -> ElementId,
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
                .id(element_id(i))
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

/// The keystroke-to-text reduction of the search fields, pure so it is
/// testable: a printable character appends, backspace removes the last one,
/// escape clears; with control, platform (cmd/ctrl) or alt held nothing is
/// typed.
pub fn apply_keystroke(
    current: &str,
    key: &str,
    key_char: Option<&str>,
    control: bool,
    platform: bool,
    alt: bool,
) -> String {
    if control || platform || alt {
        return current.to_string();
    }
    match key {
        "backspace" => {
            let mut out = current.to_string();
            out.pop();
            out
        }
        "escape" => String::new(),
        _ => {
            let c = key_char.unwrap_or(key);
            if c.chars().count() == 1 {
                format!("{current}{c}")
            } else {
                current.to_string()
            }
        }
    }
}

/// A single-line text field driven by keystrokes (the shell has no text
/// input element of its own): click to focus, type to append, backspace to
/// delete, escape to clear, the `x` clears too. The value lives in the app
/// entity, so every render rebuilds this with the current text.
pub fn search_field<E: 'static>(
    id: &'static str,
    value: &str,
    placeholder: &str,
    window: &Window,
    cx: &mut Context<E>,
    on_change: impl Fn(&mut E, String, &mut Context<E>) + Clone + 'static,
) -> Stateful<Div> {
    field_base(
        id,
        Some("search"),
        value,
        placeholder,
        window,
        cx,
        on_change,
    )
}

/// The same field for a form value: no search icon.
pub fn text_field<E: 'static>(
    id: &'static str,
    value: &str,
    placeholder: &str,
    window: &Window,
    cx: &mut Context<E>,
    on_change: impl Fn(&mut E, String, &mut Context<E>) + Clone + 'static,
) -> Stateful<Div> {
    field_base(id, None, value, placeholder, window, cx, on_change)
}

fn field_base<E: 'static>(
    id: &'static str,
    leading: Option<&'static str>,
    value: &str,
    placeholder: &str,
    window: &Window,
    cx: &mut Context<E>,
    on_change: impl Fn(&mut E, String, &mut Context<E>) + Clone + 'static,
) -> Stateful<Div> {
    let handle = cx.focus_handle();
    let focused = handle.is_focused(window);
    let entity = cx.entity();
    let current = value.to_string();
    let mut field = div()
        .id(id)
        .h(px(30.))
        .pl(px(9.))
        .pr(px(7.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(theme::radius("radius-md")))
        .bg(color("raised"))
        .border(px(theme::px_token("stroke", "stroke-rule")))
        .border_color(color(if focused { "live" } else { "edge" }))
        .cursor_text()
        .focusable()
        .tab_index(0)
        .track_focus(&handle)
        .when_some(leading, |s, name| s.child(icon(name, "ink-2", 13.)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(theme::FONT)
                .text_size(px(13.))
                .line_height(px(17.))
                .text_color(color(if value.is_empty() { "ink-2" } else { "ink" }))
                .child(if value.is_empty() {
                    placeholder.to_string()
                } else {
                    value.to_string()
                }),
        )
        .on_click(cx.listener({
            let handle = handle.clone();
            move |_, _, window, cx| {
                window.focus(&handle, cx);
            }
        }));
    if !value.is_empty() {
        field = field.child(
            div()
                .id((id, 0usize))
                .size(px(16.))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .cursor_pointer()
                .hover(|s| s.bg(color("rule")))
                .child(icon("action-x", "ink-2", 10.))
                .on_click(cx.listener({
                    let on_change = on_change.clone();
                    move |this, _, _, cx| on_change(this, String::new(), cx)
                })),
        );
    }
    field.on_key_down(move |event, _window, cx| {
        let ks = &event.keystroke;
        let next = apply_keystroke(
            &current,
            &ks.key,
            ks.key_char.as_deref(),
            ks.modifiers.control,
            ks.modifiers.platform,
            ks.modifiers.alt,
        );
        if next != current {
            let on_change = on_change.clone();
            entity.update(cx, move |this, cx| on_change(this, next, cx));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::apply_keystroke;

    #[test]
    fn keystrokes_edit_the_query() {
        assert_eq!(
            apply_keystroke("", "a", Some("a"), false, false, false),
            "a"
        );
        assert_eq!(
            apply_keystroke("ab", "c", Some("c"), false, false, false),
            "abc"
        );
        assert_eq!(
            apply_keystroke("ab", "backspace", None, false, false, false),
            "a"
        );
        assert_eq!(
            apply_keystroke("ab", "escape", None, false, false, false),
            ""
        );
        // Modifiers held: nothing is typed (shortcuts stay shortcuts).
        assert_eq!(
            apply_keystroke("ab", "q", Some("q"), false, true, false),
            "ab"
        );
        assert_eq!(
            apply_keystroke("ab", "a", Some("a"), true, false, false),
            "ab"
        );
        assert_eq!(
            apply_keystroke("ab", "a", Some("a"), false, false, true),
            "ab"
        );
        // Non-printable keys do not append.
        assert_eq!(
            apply_keystroke("ab", "shift", None, false, false, false),
            "ab"
        );
        assert_eq!(
            apply_keystroke("ab", "enter", None, false, false, false),
            "ab"
        );
        // key_char wins over the ascii-equivalent key.
        assert_eq!(
            apply_keystroke("", "s", Some("ß"), false, false, false),
            "ß"
        );
    }
}
