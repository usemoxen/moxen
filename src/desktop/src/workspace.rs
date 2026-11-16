use crate::theme::TypeScale;
use crate::{
    composer::{Composer, Submitted},
    mock::MockSource,
    model::{ThreadId, ThreadSource},
    theme::{self, color},
};
use gpui::{prelude::*, *};
use std::{collections::HashSet, time::Duration};

pub struct Workspace {
    pub source: Box<dyn ThreadSource>,
    pub selected: ThreadId,
    pub sidebar_focus: FocusHandle,
    pub composers: Vec<Entity<Composer>>,
    pub lists: Vec<ListState>,
    pub expanded: HashSet<(ThreadId, usize)>,
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
    pub settled_open: bool,
    pub inspector_width: f32,
    pub resizing_inspector: bool,
    pub expanded_files: HashSet<usize>,
    _subscriptions: Vec<Subscription>,
}
impl Workspace {
    pub fn new(demo: bool, window: &Window, cx: &mut Context<Self>) -> Self {
        let source = Box::new(MockSource::preview());
        let mut subscriptions = vec![];
        let search = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.placeholder = "Search models";
            c.surface = "raised";
            c.height = 26.;
            c
        });
        subscriptions.push(
            cx.subscribe(&search, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        let composers = source
            .list_threads()
            .iter()
            .map(|thread| {
                let id = thread.id;
                let composer = cx.new(Composer::new);
                subscriptions.push(
                    cx.subscribe(&composer, |_, _, _: &crate::composer::Changed, cx| {
                        cx.notify()
                    }),
                );
                subscriptions.push(
                    cx.subscribe(&composer, move |this, _, event: &Submitted, cx| {
                        this.send(id, event.0.clone(), cx)
                    }),
                );
                composer
            })
            .collect();
        let lists = source
            .list_threads()
            .iter()
            .map(|t| {
                ListState::new(
                    source.messages(t.id).len(),
                    ListAlignment::Top,
                    px(theme::HEIGHT),
                )
            })
            .collect();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this
                    .update(cx, |this, cx| {
                        if this
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
                            this.picker_open = true;
                        }
                        "details" => {
                            this.expanded.insert((0, 4));
                            this.lists[0].splice(4..5, 1);
                            this.expanded_files.insert(1);
                        }
                        "focus" => {
                            window.focus(&this.composers[0].read(cx).focus.clone(), cx);
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
                            PlatformInput::MouseMove(MouseMoveEvent {
                                position: point(px(130.), px(184.)),
                                pressed_button: None,
                                modifiers: Modifiers::default(),
                            }),
                            cx,
                        );
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
        Self {
            expanded_files: HashSet::new(),
            source,
            folded: HashSet::new(),
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
            sidebar_focus: cx.focus_handle(),
            composers,
            lists,
            expanded: HashSet::new(),
            _subscriptions: subscriptions,
        }
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
    pub fn toggle_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.picker_open = !self.picker_open;
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
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .relative()
            .type_scale("body")
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
                    this.inspector_width =
                        f32::from(window.viewport_size().width - event.position.x)
                            .clamp(420., 800.);
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
                    this.inspector_open = !this.inspector_open;
                    cx.notify();
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::title_bar::ToggleTasks, _, cx| {
                    this.tasks_open = !this.tasks_open;
                    this.inspector_open = true;
                    cx.notify();
                }),
            )
            .text_size(px(theme::BODY))
            .line_height(px(theme::LINE))
            .text_color(color("ink"))
            .child(crate::title_bar::render(self, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(crate::sidebar::render(self, cx))
                    .child(crate::thread_view::render(self, cx))
                    .when(self.inspector_open, |s| {
                        let width = self.inspector_width;
                        s.child(
                            div()
                                .h_full()
                                .overflow_hidden()
                                .flex_shrink_0()
                                .child(crate::inspector::render(self, cx))
                                .with_animation(
                                    "inspector-reveal",
                                    crate::ui::reveal(),
                                    move |s, v| s.w(px(width * v)).opacity(v),
                                ),
                        )
                    }),
            )
            .when(self.palette_open, |s| {
                s.child(crate::palette::render(self, cx))
            })
    }
}
