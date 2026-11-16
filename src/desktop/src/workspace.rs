use crate::{
    composer::{Composer, Submitted},
    live::ServerSource,
    mock::MockSource,
    model::{ThreadId, ThreadSource},
    theme::{self, color},
};
use gpui::{prelude::*, *};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

/// The turn keeps at least this width; the inspector gives way first.
const MIN_TURN: f32 = 480.;
const MIN_INSPECTOR: f32 = 320.;

/// Focus handles for toolbar controls that show a tip under keyboard focus.
pub struct Tips {
    pub jump: FocusHandle,
    pub tasks: FocusHandle,
    pub inspector: FocusHandle,
    pub stop: FocusHandle,
    pub send: FocusHandle,
}

pub struct Workspace {
    pub source: Box<dyn ThreadSource>,
    pub selected: ThreadId,
    /// Set once a thread has been picked by default, so a later snapshot does not move the selection.
    chosen: bool,
    pub sidebar_focus: FocusHandle,
    pub composers: Vec<Entity<Composer>>,
    pub lists: Vec<ListState>,
    /// Opened steps, with when each opened (for the expand transition).
    pub expanded: HashMap<(ThreadId, usize), Instant>,
    pub inspector_open: bool,
    pub tasks_open: bool,
    pub picker_open: bool,
    pub palette_open: bool,
    pub model_focus: FocusHandle,
    pub model: usize,
    pub effort: usize,
    pub group: usize,
    pub tab: usize,
    pub search: Entity<Composer>,
    pub folded: HashSet<ThreadId>,
    pub unfolded_at: HashMap<ThreadId, Instant>,
    pub picker_at: Option<Instant>,
    pub inspector_at: Option<Instant>,
    pub tips: Tips,
    pub settled_open: bool,
    pub inspector_width: f32,
    pub resizing_inspector: bool,
    pub expanded_files: HashSet<usize>,
    _subscriptions: Vec<Subscription>,
}
impl Workspace {
    pub fn new(demo: bool, window: &Window, cx: &mut Context<Self>) -> Self {
        // The real server, unless the window is a demo stage (the `live` stage
        // looks at the real server) or asked for the fixtures with `--mock`.
        let stage = std::env::args().nth(2);
        let mock =
            (demo && stage.as_deref() != Some("live")) || std::env::args().any(|a| a == "--mock");
        let source: Box<dyn ThreadSource> = if mock {
            Box::new(MockSource::preview())
        } else {
            Box::new(ServerSource::connect(crate::wire::default_endpoint()))
        };
        let mut subscriptions = vec![];
        let search = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.placeholder = "Search models";
            c.surface = "raised";
            c.height = 24.;
            c.size = 14.;
            c
        });
        subscriptions.push(
            cx.subscribe(&search, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        // Redraws when the source's data changes, and each second while a turn
        // runs so its timer counts.
        cx.spawn(async move |this, cx| {
            let mut seen = None;
            let mut ticks = 0u32;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                ticks = (ticks + 1) % 10;
                if this
                    .update(cx, |this, cx| {
                        let revision = this.source.revision();
                        if seen != Some(revision) {
                            seen = Some(revision);
                            this.sync_threads(cx);
                            cx.notify();
                        } else if ticks == 0
                            && this
                                .source
                                .list_threads()
                                .iter()
                                .any(|t| t.started_at.is_some())
                        {
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        if demo {
            cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let stage = std::env::args().nth(2).unwrap_or_else(|| "main".into());
                this.update_in(cx, |this, window, cx| {
                    match stage.as_str() {
                        "picker" => {
                            this.toggle_picker(window, cx);
                        }
                        "details" => {
                            this.expanded.insert((0, 4), Instant::now());
                            this.lists[0].splice(4..5, 1);
                            this.expanded_files.insert(1);
                        }
                        "focus" => {
                            window.focus(&this.tips.tasks, cx);
                        }
                        "input" => {
                            this.stop(cx);
                            this.composers[0]
                                .clone()
                                .update(cx, |c, cx| c.demo_send(window, cx));
                        }
                        _ => {}
                    }
                    cx.notify();
                })
                .expect("demo window is attached");
                if stage == "focus" {
                    cx.update(|window, cx| {
                        window.dispatch_event(
                            PlatformInput::KeyDown(KeyDownEvent {
                                keystroke: Keystroke::parse("tab").expect("tab keystroke"),
                                is_held: false,
                                prefer_character_input: false,
                            }),
                            cx,
                        );
                        // Tab put the window in keyboard mode; land on the
                        // inspector toggle, whose tip names its shortcut.
                        this.update(cx, |this, cx| window.focus(&this.tips.inspector, cx))
                            .expect("workspace is alive");
                    })
                    .expect("demo window is attached");
                }
                cx.background_executor().timer(Duration::from_secs(2)).await;
                #[cfg(feature = "render-harness")]
                capture(cx, &format!("harness-{stage}.png"));
                println!("demo: ready {stage} pid={}", std::process::id());
            })
            .detach();
        }
        let mut this = Self {
            expanded_files: HashSet::new(),
            source,
            folded: HashSet::new(),
            unfolded_at: HashMap::new(),
            picker_at: None,
            inspector_at: None,
            tips: Tips {
                jump: cx.focus_handle(),
                tasks: cx.focus_handle(),
                inspector: cx.focus_handle(),
                stop: cx.focus_handle(),
                send: cx.focus_handle(),
            },
            settled_open: false,
            inspector_width: theme::INSPECTOR,
            resizing_inspector: false,
            search,
            inspector_open: true,
            tasks_open: true,
            picker_open: false,
            palette_open: false,
            model_focus: cx.focus_handle(),
            model: 1,
            effort: 1,
            group: 1,
            tab: 1,
            selected: 0,
            chosen: false,
            sidebar_focus: cx.focus_handle(),
            composers: vec![],
            lists: vec![],
            expanded: HashMap::new(),
            _subscriptions: subscriptions,
        };
        this.sync_threads(cx);
        this
    }
    /// Gives every thread the source lists a composer and a transcript list,
    /// and keeps the selection on a thread that is still listed. Threads only
    /// ever appear: the source keeps a gone thread's id.
    pub fn sync_threads(&mut self, cx: &mut Context<Self>) {
        let count = self.source.list_threads().len();
        while self.composers.len() < count {
            let id = self.composers.len();
            let composer = cx.new(Composer::new);
            self._subscriptions.push(
                cx.subscribe(&composer, |_, _, _: &crate::composer::Changed, cx| {
                    cx.notify()
                }),
            );
            self._subscriptions.push(
                cx.subscribe(&composer, move |this, _, event: &Submitted, cx| {
                    this.send(id, event.0.clone(), cx)
                }),
            );
            self.composers.push(composer);
        }
        while self.lists.len() < count {
            let id = self.lists.len();
            self.lists.push(ListState::new(
                self.source.messages(id).len(),
                ListAlignment::Top,
                px(theme::HEIGHT),
            ));
        }
        let listed = self.source.order(false);
        if !self.chosen && !listed.is_empty() {
            // The first row the sidebar shows, not a settled thread behind
            // its closed section.
            let threads = self.source.list_threads();
            let top = self
                .source
                .order(true)
                .into_iter()
                .find(|&i| !threads[i].settled);
            self.selected = top.unwrap_or(listed[0]);
            self.chosen = true;
        } else if !listed.contains(&self.selected)
            && let Some(&first) = listed.first()
        {
            self.selected = first;
        }
    }
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        self.source.retry();
        cx.notify();
    }
    pub fn select(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        self.selected = id;
        cx.notify();
    }
    pub fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette_open = true;
        self.picker_open = false;
        self.search.update(cx, |c, cx| {
            c.placeholder = "Search threads";
            c.set_text(String::new(), cx);
        });
        window.focus(&self.search.read(cx).focus.clone(), cx);
        cx.notify();
    }
    /// Opens or closes the inspector, timing the slide.
    pub fn set_inspector(&mut self, open: bool) {
        if self.inspector_open != open {
            self.inspector_open = open;
            self.inspector_at = Some(Instant::now());
        }
    }
    pub fn toggle_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.picker_open = !self.picker_open;
        self.picker_at = Some(Instant::now());
        self.palette_open = false;
        self.search.update(cx, |c, cx| {
            c.placeholder = "Search models";
            c.set_text(String::new(), cx);
        });
        window.focus(
            &if self.picker_open {
                self.search.read(cx).focus.clone()
            } else {
                self.model_focus.clone()
            },
            cx,
        );
        cx.notify();
    }
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        self.source.stop(self.selected);
        self.composers[self.selected].update(cx, |c, cx| {
            c.enabled = true;
            cx.notify();
        });
        cx.notify();
    }
    fn send(&mut self, id: ThreadId, text: String, cx: &mut Context<Self>) {
        let Some(reply) = self.source.send_message(id, text) else {
            cx.notify();
            return;
        };
        self.lists[id].splice(reply.message - 1..reply.message - 1, 2);
        self.lists[id].scroll_to_end();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let count = reply.words.len();
            for (i, word) in reply.words.into_iter().enumerate() {
                cx.background_executor()
                    .timer(Duration::from_millis(65))
                    .await;
                if this
                    .update(cx, |this, cx| {
                        this.source
                            .stream_word(id, reply.message, &word, i + 1 == count);
                        if i + 1 == count
                            && this.source.list_threads()[id].status
                                != crate::model::Status::Running
                        {
                            this.composers[id].update(cx, |c, cx| {
                                c.enabled = true;
                                cx.notify();
                            });
                        }
                        this.lists[id].splice(reply.message..reply.message + 1, 1);
                        this.lists[id].scroll_to_end();
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }
    pub fn send_queued(&mut self, cx: &mut Context<Self>) {
        if let Some(text) = self.source.take_queued(self.selected) {
            self.stop(cx);
            self.send(self.selected, text, cx);
        }
    }
}

#[cfg(feature = "render-harness")]
fn capture(cx: &mut AsyncWindowContext, name: &str) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("screenshots")
            .join(name);
        window
            .render_to_image()
            .expect("render demo frame")
            .save(path)
            .expect("save demo frame");
    })
    .expect("demo window remains open");
}
impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.source.order(false).is_empty() {
            return crate::connection::render(self, cx).into_any_element();
        }
        let viewport = f32::from(window.viewport_size().width);
        let room = (viewport - theme::SIDEBAR - MIN_TURN).max(MIN_INSPECTOR);
        let slide = crate::ui::progress(self.inspector_at, 160, window);
        let shown = if self.inspector_open {
            slide
        } else {
            1. - slide
        };
        let inspector_width = self.inspector_width.clamp(MIN_INSPECTOR, room);
        div()
            .relative()
            .font_family(theme::FONT)
            .size_full()
            .flex()
            .flex_col()
            .bg(color("ground"))
            .on_action(
                cx.listener(|this, _: &crate::palette::OpenPalette, window, cx| {
                    this.open_palette(window, cx)
                }),
            )
            .on_action(
                cx.listener(|_, _: &crate::palette::NextFocus, window, cx| window.focus_next(cx)),
            )
            .on_action(
                cx.listener(|_, _: &crate::palette::PreviousFocus, window, cx| {
                    window.focus_prev(cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::palette::Dismiss, window, cx| {
                    if this.picker_open {
                        this.picker_open = false;
                        window.focus(&this.model_focus, cx);
                    } else if this.palette_open {
                        this.palette_open = false;
                        window.focus(&this.sidebar_focus, cx);
                    } else {
                        this.stop(cx);
                    }
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                if this.resizing_inspector {
                    let viewport = f32::from(window.viewport_size().width);
                    this.inspector_width =
                        f32::from(window.viewport_size().width - event.position.x).clamp(
                            MIN_INSPECTOR,
                            (viewport - theme::SIDEBAR - MIN_TURN).max(MIN_INSPECTOR),
                        );
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| {
                    this.resizing_inspector = false;
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::title_bar::ToggleInspector, _, cx| {
                    this.set_inspector(!this.inspector_open);
                    cx.notify();
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::title_bar::ToggleTasks, _, cx| {
                    if this.inspector_open {
                        this.tasks_open = !this.tasks_open;
                    } else {
                        this.tasks_open = true;
                        this.set_inspector(true);
                    }
                    cx.notify();
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::model_picker::TogglePicker, window, cx| {
                    this.toggle_picker(window, cx)
                }),
            )
            .text_size(px(theme::UI))
            .line_height(px(theme::UI_LINE))
            .text_color(color("ink"))
            .child(crate::title_bar::render(self, window, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(crate::sidebar::render(self, window, cx))
                    .child(crate::thread_view::render(self, window, cx))
                    .when(shown > 0. && self.source.preview(), |s| {
                        // Slides in from the window's right edge: the pane
                        // keeps its width and the clip around it grows.
                        s.child(
                            div()
                                .h_full()
                                .flex_shrink_0()
                                .flex()
                                .justify_end()
                                .overflow_hidden()
                                .w(px(inspector_width * shown))
                                .opacity(0.4 + 0.6 * shown)
                                .child(crate::inspector::render(self, inspector_width, cx)),
                        )
                    }),
            )
            .when(self.palette_open, |s| {
                s.child(crate::palette::render(self, cx))
            })
            .into_any_element()
    }
}
