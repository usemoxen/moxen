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
    pub model: usize,
    pub effort: usize,
    pub group: usize,
    pub tab: usize,
    pub search: Entity<Composer>,
    pub folded: HashSet<ThreadId>,
    pub settled_open: bool,
    pub inspector_width: f32,
    pub resizing_inspector: bool,
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
                composer.update(cx, |c, _| {
                    c.enabled = thread.status != crate::model::Status::Running
                });
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
        if demo {
            let message_count = source.messages(0).len();
            cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                #[cfg(feature = "render-harness")]
                capture(cx, "vs-mockup.png");
                let _ = this.update(cx, |this, cx| {
                    this.picker_open = false;
                    this.expanded.insert((0, 3));
                    this.lists[0].splice(3..4, 1);
                    cx.notify();
                });
                #[cfg(feature = "render-harness")]
                capture(cx, "steps.png");
                println!("demo: expanded tool ready");
                cx.background_executor()
                    .timer(Duration::from_secs(12))
                    .await;
                this.update_in(cx, |this, window, cx| {
                    this.stop(cx);
                    this.composers[0]
                        .clone()
                        .update(cx, |c, cx| c.demo_send(window, cx));
                })
                .expect("demo workspace is attached to its window");
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await;
                let _ = this.update(cx, |this, cx| this.select(2, cx));
                cx.background_executor().timer(Duration::from_secs(4)).await;
                let _ = this.update(cx, |this, cx| {
                    assert_eq!(this.source.messages(0).len(), message_count + 2);
                    assert_eq!(
                        this.source.list_threads()[0].status,
                        crate::model::Status::Idle
                    );
                    assert_eq!(this.source.messages(2).len(), message_count);
                    this.select(0, cx);
                });
                println!("demo: input, thread switch and completed reply verified");
            })
            .detach();
        }
        Self {
            source,
            folded: HashSet::new(),
            settled_open: false,
            inspector_width: theme::INSPECTOR,
            resizing_inspector: false,
            search,
            inspector_open: true,
            tasks_open: true,
            picker_open: demo,
            model: 1,
            effort: 1,
            group: 1,
            tab: 1,
            selected: 0,
            sidebar_focus: cx.focus_handle(),
            composers,
            lists,
            expanded: if demo {
                HashSet::from([(0, 3)])
            } else {
                HashSet::new()
            },
            _subscriptions: subscriptions,
        }
    }
    pub fn select(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        self.selected = id;
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
            return;
        };
        self.composers[id].update(cx, |c, cx| {
            c.enabled = false;
            cx.notify();
        });
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
            .font_family(theme::FONT)
            .size_full()
            .flex()
            .flex_col()
            .bg(color("ground"))
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
                        s.child(crate::inspector::render(self, cx))
                    }),
            )
    }
}
