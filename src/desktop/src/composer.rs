use crate::{
    attachments::{Asset, Prompt},
    composer_menu::{Choice, slash_prefix},
    theme::{self, color},
};
use gpui::{prelude::*, *};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

actions!(
    composer,
    [
        Send, QueueSend, Newline, Backspace, Delete, Left, Right, Up, Down, SelectAll, Paste
    ]
);
pub struct Submitted(pub String);
/// The draft, sent to wait for the running turn instead of steering it.
pub struct Queued(pub String);
pub struct Changed;
pub struct Pasted(pub Vec<ClipboardEntry>);

pub struct Composer {
    pub focus: FocusHandle,
    pub enabled: bool,
    pub placeholder: &'static str,
    pub height: f32,
    pub surface: &'static str,
    /// Text size: transcript prose (15) in the composer, 14 in search fields.
    pub size: f32,
    /// A secret entry: drawn as bullets, and the platform (clipboard, screen
    /// readers, IME) only ever sees bullets — never the key being typed.
    pub masked: bool,
    pub accepts_assets: bool,
    pub assets: Vec<Asset>,
    pub loading_assets: usize,
    pub once: Option<String>,
    pub revision: u64,
    pub undo_improvement: Option<String>,
    pub choices: Vec<Choice>,
    pub choice: usize,
    pub slash_dismissed: bool,
    text: String,
    selection: Range<usize>,
    marked: Option<Range<usize>>,
    layout: Vec<(usize, WrappedLine, Point<Pixels>)>,
    bounds: Option<Bounds<Pixels>>,
}
impl EventEmitter<Submitted> for Composer {}
impl EventEmitter<Queued> for Composer {}
impl EventEmitter<Changed> for Composer {}
impl EventEmitter<Pasted> for Composer {}
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
            size: theme::BODY,
            masked: false,
            accepts_assets: false,
            assets: vec![],
            loading_assets: 0,
            once: None,
            revision: 0,
            undo_improvement: None,
            choices: vec![],
            choice: 0,
            slash_dismissed: false,
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
        self.marked = None;
        self.changed(cx);
    }
    pub fn empty(&self) -> bool {
        self.text.trim().is_empty() && self.assets.is_empty()
    }
    pub fn slash(&self) -> Option<(usize, &str)> {
        if !self.accepts_assets
            || self.slash_dismissed
            || self.marked.is_some()
            || !self.selection.is_empty()
        {
            return None;
        }
        slash_prefix(&self.text, self.selection.end)
    }
    pub fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision = self.revision.wrapping_add(1);
        self.undo_improvement = None;
        self.slash_dismissed = false;
        self.choice = 0;
        self.choices.clear();
        cx.emit(Changed);
        cx.notify();
    }
    pub fn restore(&mut self, mut prompt: Prompt, cx: &mut Context<Self>) {
        prompt.assets.append(&mut self.assets);
        self.assets = prompt.assets;
        if self.once.is_none() {
            self.once = prompt.once;
        }
        let text = if prompt.text.is_empty() {
            self.text.clone()
        } else if self.text.is_empty() {
            prompt.text
        } else {
            format!("{}\n{}", prompt.text, self.text)
        };
        self.set_text(text, cx);
    }
    pub fn choose(&mut self, index: usize, w: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some((start, _)) = self.slash() else {
            return false;
        };
        let Some(choice) = self.choices.get(index) else {
            return false;
        };
        let end = self.selection.end;
        let mut invocation = choice.invocation.clone();
        if self.text[end..]
            .chars()
            .next()
            .is_none_or(|ch| !ch.is_whitespace())
        {
            invocation.push(' ');
        }
        self.replace_text_in_range(Some(self.units(start..end)), &invocation, w, cx);
        true
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
    fn send(&mut self, _: &Send, w: &mut Window, cx: &mut Context<Self>) {
        if crate::composer_menu::mode_command(&self.text).is_none()
            && self.choose(self.choice, w, cx)
        {
            return;
        }
        if self.enabled && self.loading_assets == 0 && self.marked.is_none() {
            // An empty Enter still reaches the workspace: with a run-size
            // question waiting it starts the run, otherwise it is dropped.
            let text = std::mem::take(&mut self.text);
            self.selection = 0..0;
            self.changed(cx);
            cx.emit(Submitted(text));
        }
    }
    fn queue_send(&mut self, _: &QueueSend, _: &mut Window, cx: &mut Context<Self>) {
        if self.enabled && self.loading_assets == 0 && self.marked.is_none() && !self.empty() {
            let text = std::mem::take(&mut self.text);
            self.selection = 0..0;
            self.changed(cx);
            cx.emit(Queued(text));
        }
    }
    fn newline(&mut self, _: &Newline, w: &mut Window, cx: &mut Context<Self>) {
        self.replace_text_in_range(None, "\n", w, cx);
    }
    fn move_to(&mut self, at: usize, w: &mut Window, cx: &mut Context<Self>) {
        self.selection = at..at;
        cx.emit(Changed);
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
        if !self.choices.is_empty() {
            self.choice = self.choice.saturating_sub(1);
            cx.emit(Changed);
            return;
        }
        self.vertical(-1., w, cx);
    }
    fn down(&mut self, _: &Down, w: &mut Window, cx: &mut Context<Self>) {
        if !self.choices.is_empty() {
            self.choice = (self.choice + 1).min(self.choices.len() - 1);
            cx.emit(Changed);
            return;
        }
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
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        if self.accepts_assets
            && item.entries().iter().any(|entry| {
                matches!(
                    entry,
                    ClipboardEntry::Image(_) | ClipboardEntry::ExternalPaths(_)
                )
            })
        {
            cx.emit(Pasted(item.entries().to_vec()));
        } else if let Some(text) = item.text() {
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
    /// What lands for typed or pasted text: a masked entry is one line, so
    /// pasted newlines never land (they would desync the bullet mapping).
    fn scrub(&self, text: &str) -> String {
        if self.masked {
            text.replace(['\r', '\n'], "")
        } else {
            text.to_string()
        }
    }
    fn units(&self, r: Range<usize>) -> Range<usize> {
        self.utf16(r.start)..self.utf16(r.end)
    }
    /// What the canvas shapes: bullets per character while masked, so the
    /// layout's byte offsets are in display coordinates.
    fn display(&self) -> std::borrow::Cow<'_, str> {
        if self.masked {
            std::borrow::Cow::Owned(mask_display(&self.text))
        } else {
            std::borrow::Cow::Borrowed(&self.text)
        }
    }
    /// A real byte offset as a display one (masked: one bullet per character).
    fn display_end(&self, byte: usize) -> usize {
        if self.masked {
            masked_end(&self.text, byte)
        } else {
            byte
        }
    }
    /// A display byte offset back to a real one.
    fn real_end(&self, masked: usize) -> usize {
        if self.masked {
            unmasked_end(&self.text, masked)
        } else {
            masked.min(self.text.len())
        }
    }
    fn caret(&self) -> Option<Point<Pixels>> {
        let end = self.display_end(self.selection.end);
        self.layout
            .iter()
            .rev()
            .find(|(start, _, _)| *start <= end)
            .and_then(|(start, line, origin)| {
                line.position_for_index(end - start, px(theme::LINE))
                    .map(|p| p + *origin)
            })
    }
    fn index_at(&self, p: Point<Pixels>) -> usize {
        for (start, line, origin) in &self.layout {
            if p.y < origin.y + line.size(px(theme::LINE)).height {
                let at = (start
                    + line
                        .closest_index_for_position(p - *origin, px(theme::LINE))
                        .unwrap_or_else(|i| i))
                .min(self.display().len());
                return self.real_end(at);
            }
        }
        self.text.len()
    }
}

/// The masking bridge: one bullet per character, so a masked field leaks
/// nothing — not even its length in bytes — while the caret still tracks.
const MASK: char = '•';

fn mask_display(text: &str) -> String {
    text.chars().map(|_| MASK).collect()
}

/// Display byte offset of a real one: characters before it, times the bullet.
fn masked_end(text: &str, byte: usize) -> usize {
    text.get(..byte.min(text.len()))
        .map_or(0, |before| before.chars().count() * MASK.len_utf8())
}

/// Real byte offset of a display one: the nth character's start.
fn unmasked_end(text: &str, masked: usize) -> usize {
    let mut chars = masked / MASK.len_utf8();
    for (i, _) in text.char_indices() {
        if chars == 0 {
            return i;
        }
        chars -= 1;
    }
    text.len()
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
        // Masked fields never hand the platform their text: clipboard,
        // screen readers and IME see bullets, like the canvas does.
        Some(if self.masked {
            mask_display(&self.text[r])
        } else {
            self.text[r].into()
        })
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
        self.changed(cx);
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
        // A masked entry is one line: pasted newlines would desync the
        // bullet mapping, so they never land.
        let text = self.scrub(text);
        self.text.replace_range(r.clone(), &text);
        self.selection = r.start + text.len()..r.start + text.len();
        self.marked = None;
        self.changed(cx);
        w.notify_text_input_changed(&self.focus);
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
        let text = self.scrub(text);
        self.replace_text_in_range(r, &text, w, cx);
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
            .w_full()
            .h(px(self.height))
            .bg(color(self.surface))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(Self::queue_send))
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
                                std::borrow::Cow::Borrowed(this.placeholder)
                            } else {
                                this.display()
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
                                    px(this.size),
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
        KeyBinding::new("cmd-enter", QueueSend, Some("Composer")),
        KeyBinding::new("ctrl-enter", QueueSend, Some("Composer")),
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

#[cfg(test)]
mod tests {
    use super::{MASK, mask_display, masked_end, unmasked_end};

    #[test]
    fn masked_offsets_track_characters_not_bytes() {
        let text = "aé…b";
        let masked = mask_display(text);
        assert_eq!(masked.chars().count(), text.chars().count());
        assert!(masked.chars().all(|ch| ch == MASK));
        assert!(!masked.contains('a'));
        // Real byte offset of "é" (2 bytes in) maps to one bullet (3 bytes out).
        assert_eq!(masked_end(text, 1), MASK.len_utf8());
        assert_eq!(masked_end(text, 3), 2 * MASK.len_utf8());
        // Display bytes map back to the character's real start.
        assert_eq!(unmasked_end(text, 0), 0);
        assert_eq!(unmasked_end(text, MASK.len_utf8()), 1);
        assert_eq!(unmasked_end(text, 2 * MASK.len_utf8()), 3);
        assert_eq!(unmasked_end(text, usize::MAX / 2), text.len());
    }
}
