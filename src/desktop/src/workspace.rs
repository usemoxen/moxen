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
    _subscriptions: Vec<Subscription>,
}
impl Workspace {
    pub fn new(demo: bool, window: &Window, cx: &mut Context<Self>) -> Self {
        let source = Box::new(MockSource::new());
        let mut subscriptions = vec![];
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
            cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                #[cfg(feature = "render-harness")]
                capture(cx, "expanded-tool.png");
                println!("demo: expanded tool ready");
                cx.background_executor()
                    .timer(Duration::from_secs(12))
                    .await;
                this.update_in(cx, |this, window, cx| {
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
                    assert_eq!(this.source.messages(0).len(), 8);
                    assert_eq!(
                        this.source.list_threads()[0].status,
                        crate::model::Status::Idle
                    );
                    assert_eq!(this.source.messages(2).len(), 6);
                    this.select(0, cx);
                });
                println!("demo: input, thread switch and completed reply verified");
                #[cfg(feature = "render-harness")]
                capture(cx, "completed-reply.png");
            })
            .detach();
        }
        Self {
            source,
            selected: 0,
            sidebar_focus: cx.focus_handle(),
            composers,
            lists,
            expanded: if demo {
                HashSet::from([(0, 2)])
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
                        if i + 1 == count {
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
            .text_size(px(theme::BODY))
            .line_height(px(theme::LINE))
            .text_color(color("ink"))
            .child(crate::sidebar::render(self, cx))
            .child(crate::thread_view::render(self, cx))
    }
}
