use crate::theme::{self, color};
use gpui::{prelude::*, *};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

actions!(
    composer,
    [
        Send, Newline, Backspace, Delete, Left, Right, Up, Down, SelectAll, Paste
    ]
);
pub struct Submitted(pub String);
pub struct Changed;

pub struct Composer {
    pub focus: FocusHandle,
    pub enabled: bool,
    pub placeholder: &'static str,
    pub height: f32,
    pub surface: &'static str,
    text: String,
    selection: Range<usize>,
    marked: Option<Range<usize>>,
    layout: Vec<(usize, WrappedLine, Point<Pixels>)>,
    bounds: Option<Bounds<Pixels>>,
}
impl EventEmitter<Submitted> for Composer {}
impl EventEmitter<Changed> for Composer {}
impl Focusable for Composer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl Composer {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            enabled: true,
            placeholder: "Steer the agent…",
            height: theme::COMPOSER,
            surface: "ground",
            text: String::new(),
            selection: 0..0,
            marked: None,
            layout: vec![],
            bounds: None,
        }
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn set_text(&mut self, text: String, cx: &mut Context<Self>) {
        self.selection = text.len()..text.len();
        self.text = text;
        cx.emit(Changed);
        cx.notify();
    }
    pub fn demo_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.replace_text_in_range(None, "Show a safe streaming reply.", window, cx);
        self.left(&Left, window, cx);
        self.right(&Right, window, cx);
        self.newline(&Newline, window, cx);
        self.replace_text_in_range(None, "Keep it in this thread!", window, cx);
        self.backspace(&Backspace, window, cx);
        self.replace_text_in_range(None, ".", window, cx);
        self.up(&Up, window, cx);
        self.down(&Down, window, cx);
        assert_eq!(
            self.text,
            "Show a safe streaming reply.\nKeep it in this thread."
        );
        self.send(&Send, window, cx);
        assert!(self.text.is_empty());
    }
    fn send(&mut self, _: &Send, _: &mut Window, cx: &mut Context<Self>) {
        if self.enabled && self.marked.is_none() && !self.text.trim().is_empty() {
            let text = std::mem::take(&mut self.text);
            self.selection = 0..0;
            cx.emit(Submitted(text));
            cx.notify();
        }
    }
    fn newline(&mut self, _: &Newline, w: &mut Window, cx: &mut Context<Self>) {
        self.replace_text_in_range(None, "\n", w, cx);
    }
    fn move_to(&mut self, at: usize, w: &mut Window, cx: &mut Context<Self>) {
        self.selection = at..at;
        w.notify_text_selection_changed(&self.focus);
        cx.notify();
    }
    fn previous(&self) -> usize {
        self.text[..self.selection.start]
            .grapheme_indices(true)
            .next_back()
            .map_or(0, |(i, _)| i)
    }
    fn next(&self) -> usize {
        self.text[self.selection.end..]
            .graphemes(true)
            .next()
            .map_or(self.text.len(), |g| self.selection.end + g.len())
    }
    fn left(&mut self, _: &Left, w: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.previous(), w, cx);
    }
    fn right(&mut self, _: &Right, w: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.next(), w, cx);
    }
    fn vertical(&mut self, delta: f32, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(p) = self.caret() {
            let at = self.index_at(point(p.x, p.y + px(delta * theme::LINE)));
            self.move_to(at, w, cx);
        }
    }
    fn up(&mut self, _: &Up, w: &mut Window, cx: &mut Context<Self>) {
        self.vertical(-1., w, cx);
    }
    fn down(&mut self, _: &Down, w: &mut Window, cx: &mut Context<Self>) {
        self.vertical(1., w, cx);
    }
    fn backspace(&mut self, _: &Backspace, w: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            self.selection.start = self.previous();
        }
        self.replace_text_in_range(None, "", w, cx);
    }
    fn delete(&mut self, _: &Delete, w: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            self.selection.end = self.next();
        }
        self.replace_text_in_range(None, "", w, cx);
    }
    fn select_all(&mut self, _: &SelectAll, w: &mut Window, cx: &mut Context<Self>) {
        self.selection = 0..self.text.len();
        w.notify_text_selection_changed(&self.focus);
        cx.notify();
    }
    fn paste_action(&mut self, _: &Paste, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
            self.replace_text_in_range(None, &text, w, cx);
        }
    }
    fn byte(&self, utf16: usize) -> usize {
        let mut count = 0;
        for (i, ch) in self.text.char_indices() {
            if count >= utf16 {
                return i;
            }
            count += ch.len_utf16();
        }
        self.text.len()
    }
    fn utf16(&self, byte: usize) -> usize {
        self.text[..byte].encode_utf16().count()
    }
    fn bytes(&self, r: Range<usize>) -> Range<usize> {
        self.byte(r.start)..self.byte(r.end)
    }
    fn units(&self, r: Range<usize>) -> Range<usize> {
        self.utf16(r.start)..self.utf16(r.end)
    }
    fn caret(&self) -> Option<Point<Pixels>> {
        self.layout
            .iter()
            .rev()
            .find(|(start, _, _)| *start <= self.selection.end)
            .and_then(|(start, line, origin)| {
                line.position_for_index(self.selection.end - start, px(theme::LINE))
                    .map(|p| p + *origin)
            })
    }
    fn index_at(&self, p: Point<Pixels>) -> usize {
        for (start, line, origin) in &self.layout {
            if p.y < origin.y + line.size(px(theme::LINE)).height {
                return (start
                    + line
                        .closest_index_for_position(p - *origin, px(theme::LINE))
                        .unwrap_or_else(|i| i))
                .min(self.text.len());
            }
        }
        self.text.len()
    }
}
impl EntityInputHandler for Composer {
    fn text_for_range(
        &mut self,
        r: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let r = self.bytes(r);
        *actual = Some(self.units(r.clone()));
        Some(self.text[r].into())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.units(self.selection.clone()),
            reversed: false,
        })
    }
    fn set_selected_text_range(&mut self, r: Range<usize>, w: &mut Window, cx: &mut Context<Self>) {
        self.selection = self.bytes(r);
        w.notify_text_selection_changed(&self.focus);
        cx.notify();
    }
    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.utf16(self.text.len()))
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone().map(|r| self.units(r))
    }
    fn unmark_text(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.emit(Changed);
        w.notify_text_input_changed(&self.focus);
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let r = range
            .map(|r| self.bytes(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        self.text.replace_range(r.clone(), text);
        self.selection = r.start + text.len()..r.start + text.len();
        self.marked = None;
        cx.emit(Changed);
        w.notify_text_input_changed(&self.focus);
        cx.notify();
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let start = r
            .clone()
            .map(|r| self.byte(r.start))
            .or(self.marked.as_ref().map(|r| r.start))
            .unwrap_or(self.selection.start);
        self.replace_text_in_range(r, text, w, cx);
        self.marked = (!text.is_empty()).then_some(start..start + text.len());
        if let Some(r) = selected {
            let base = self.utf16(start);
            self.selection = self.bytes(base + r.start..base + r.end);
        }
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        self.caret()
            .map(|p| Bounds::new(p, size(px(theme::CURSOR), px(theme::LINE))))
    }
    fn character_index_for_point(
        &mut self,
        p: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.utf16(self.index_at(p)))
    }
}
impl Render for Composer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        div()
            .id("composer")
            .key_context("Composer")
            .track_focus(&self.focus)
            .border_b_1()
            .border_color(color("rule").opacity(0.))
            .focus_visible(|s| s.border_color(color("live")))
            .focus(|s| s.border_color(color("live")))
            .w_full()
            .h(px(self.height))
            .bg(color(self.surface))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::paste_action))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, w, cx| {
                    w.focus(&this.focus, cx);
                    this.move_to(this.index_at(event.position), w, cx);
                }),
            )
            .child(
                canvas(
                    move |bounds, window, cx| {
                        entity.update(cx, |this, _| {
                            let display = if this.text.is_empty() {
                                this.placeholder
                            } else {
                                &this.text
                            };
                            let style = window.text_style();
                            let run = TextRun {
                                len: display.len(),
                                font: style.font(),
                                color: color(if this.text.is_empty() { "ink-2" } else { "ink" }),
                                background_color: None,
                                underline: None,
                                strikethrough: None,
                            };
                            let lines = window
                                .text_system()
                                .shape_text(
                                    display.to_string().into(),
                                    px(theme::BODY),
                                    &[run],
                                    Some(bounds.size.width),
                                    None,
                                )
                                .unwrap();
                            this.layout.clear();
                            let mut y = bounds.top();
                            let mut start = 0;
                            for line in lines {
                                let height = line.size(px(theme::LINE)).height;
                                let len = line.len();
                                this.layout.push((start, line, point(bounds.left(), y)));
                                start += len + 1;
                                y += height;
                            }
                            // Keep the insertion point visible even for long multi-line drafts.
                            if let Some(caret) = this.caret() {
                                let shift =
                                    (caret.y + px(theme::LINE) - bounds.bottom()).max(px(0.));
                                for (_, _, origin) in &mut this.layout {
                                    origin.y -= shift;
                                }
                            }
                            this.bounds = Some(bounds);
                        });
                        entity
                    },
                    |bounds, entity, window, cx| {
                        let focus = entity.read(cx).focus.clone();
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, entity.clone()),
                            cx,
                        );
                        entity.update(cx, |this, cx| {
                            window.with_content_mask(Some(ContentMask { bounds }), |window| {
                                for (_, line, origin) in &this.layout {
                                    line.paint(
                                        *origin,
                                        px(theme::LINE),
                                        TextAlign::Left,
                                        None,
                                        window,
                                        cx,
                                    )
                                    .unwrap();
                                }
                                if this.focus.is_focused(window)
                                    && let Some(p) = this.caret()
                                {
                                    window.paint_quad(fill(
                                        Bounds::new(p, size(px(theme::CURSOR), px(theme::LINE))),
                                        color("live"),
                                    ));
                                }
                            })
                        });
                    },
                )
                .size_full(),
            )
    }
}

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("enter", Send, Some("Composer")),
        KeyBinding::new("shift-enter", Newline, Some("Composer")),
        KeyBinding::new("backspace", Backspace, Some("Composer")),
        KeyBinding::new("delete", Delete, Some("Composer")),
        KeyBinding::new("left", Left, Some("Composer")),
        KeyBinding::new("right", Right, Some("Composer")),
        KeyBinding::new("up", Up, Some("Composer")),
        KeyBinding::new("down", Down, Some("Composer")),
        KeyBinding::new("cmd-a", SelectAll, Some("Composer")),
        KeyBinding::new("ctrl-a", SelectAll, Some("Composer")),
        KeyBinding::new("cmd-v", Paste, Some("Composer")),
        KeyBinding::new("ctrl-v", Paste, Some("Composer")),
    ]);
}
