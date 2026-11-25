use crate::{
    attachments::{Picture, Thumbnail},
    theme::{self, color},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
use std::sync::Arc;

#[derive(Clone)]
pub enum Source {
    Server(Picture),
    Draft(Arc<Image>),
}

#[derive(Clone)]
pub struct ImageItem {
    pub name: String,
    pub source: Source,
}

impl From<Thumbnail> for ImageItem {
    fn from(image: Thumbnail) -> Self {
        Self {
            name: image.name,
            source: Source::Server(image.source),
        }
    }
}
impl ImageItem {
    fn data(&self, w: &Workspace) -> Option<Result<Arc<Image>, String>> {
        match &self.source {
            Source::Draft(image) => Some(Ok(image.clone())),
            Source::Server(picture) => w.source.image(picture),
        }
    }
    pub fn missing(&self, w: &Workspace) -> Option<Picture> {
        match &self.source {
            Source::Server(picture) if self.data(w).is_none() => Some(picture.clone()),
            _ => None,
        }
    }
}

pub struct Viewer {
    items: Arc<Vec<ImageItem>>,
    at: usize,
    zoom: f32,
    pan: Point<Pixels>,
    drag: Option<Point<Pixels>>,
    back: Option<FocusHandle>,
}
impl Viewer {
    fn fit(&mut self) {
        self.zoom = 1.;
        self.pan = point(px(0.), px(0.));
        self.drag = None;
    }
    fn zoom(&mut self, multiplier: f32) {
        self.zoom = (self.zoom * multiplier).clamp(1., 4.);
        if self.zoom == 1. {
            self.fit();
        }
    }
}

impl Workspace {
    pub fn open_viewer(
        &mut self,
        items: Arc<Vec<ImageItem>>,
        at: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Source::Server(picture) = &items[at].source {
            self.source.read_image(picture);
        }
        self.viewer = Some(Viewer {
            items,
            at,
            zoom: 1.,
            pan: point(px(0.), px(0.)),
            drag: None,
            back: window.focused(cx),
        });
        window.focus(&self.viewer_focus, cx);
        cx.notify();
    }
    pub fn close_viewer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(back) = self.viewer.take().and_then(|viewer| viewer.back) {
            window.focus(&back, cx);
        }
        cx.notify();
    }
    fn step_image(&mut self, delta: isize, cx: &mut Context<Self>) {
        let Some(viewer) = &mut self.viewer else {
            return;
        };
        let at = viewer
            .at
            .saturating_add_signed(delta)
            .min(viewer.items.len() - 1);
        if at != viewer.at {
            viewer.at = at;
            viewer.fit();
            if let Source::Server(picture) = &viewer.items[at].source {
                self.source.read_image(picture);
            }
            cx.notify();
        }
    }
}

pub fn thumbnail(
    element: impl Into<ElementId>,
    at: usize,
    items: Arc<Vec<ImageItem>>,
    w: &Workspace,
    entity: Entity<Workspace>,
) -> Stateful<Div> {
    let item = &items[at];
    let image = item.data(w);
    let tile = div().id(element);
    let tile = if w.viewer.is_some() {
        tile.plain_control()
    } else {
        tile.control(item.name.clone())
    };
    tile.flex()
        .flex_col()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .bg(color("ground"))
        .border(px(theme::px_token("stroke", "stroke-rule")))
        .border_color(color("edge"))
        .rounded(px(theme::px_token("radius", "radius-md")))
        .w(px(116.))
        .h(px(82.))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .w_full()
                .flex()
                .items_center()
                .justify_center()
                .child(match image {
                    Some(Ok(image)) => img(image)
                        .size_full()
                        .object_fit(ObjectFit::Contain)
                        .into_any_element(),
                    Some(Err(_)) => ui::icon("x", "ink-2").into_any_element(),
                    None => ui::icon("file", "ink-2").into_any_element(),
                }),
        )
        .child(
            div()
                .w_full()
                .px(px(6.))
                .truncate()
                .text_size(px(11.5))
                .text_color(color("ink-2"))
                .child(item.name.clone()),
        )
        .on_click(move |_, window, cx| {
            entity.update(cx, |w, cx| w.open_viewer(items.clone(), at, window, cx));
        })
}

pub fn render(
    w: &Workspace,
    viewer: &Viewer,
    window: &Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let item = &viewer.items[viewer.at];
    let viewport = window.viewport_size();
    let image = item.data(w);
    let width = (viewport.width - px(140.)).max(px(200.));
    let height = (viewport.height - px(174.)).max(px(120.));
    let zoom = viewer.zoom;
    let max = point(width * (zoom - 1.) / 2., height * (zoom - 1.) / 2.);
    let pan = point(
        viewer.pan.x.clamp(-max.x, max.x),
        viewer.pan.y.clamp(-max.y, max.y),
    );
    deferred(
        div()
            .id("image-viewer")
            .track_focus(&w.viewer_focus)
            .occlude()
            .absolute()
            .inset_0()
            .bg(color("ground").opacity(0.9))
            .flex()
            .items_center()
            .justify_center()
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                match event.keystroke.key.as_str() {
                    "left" => this.step_image(-1, cx),
                    "right" => this.step_image(1, cx),
                    "escape" => this.close_viewer(window, cx),
                    "+" | "=" | "-" | "0" => {
                        if let Some(viewer) = &mut this.viewer {
                            match event.keystroke.key.as_str() {
                                "-" => viewer.zoom(1. / 1.25),
                                "0" => viewer.fit(),
                                _ => viewer.zoom(1.25),
                            }
                            cx.notify();
                        }
                    }
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .p(px(12.))
                    .bg(color("raised"))
                    .shadow(theme::float_shadow())
                    .rounded(px(theme::px_token("radius", "radius-lg")))
                    .child(
                        div()
                            .w(width)
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                div()
                                    .truncate()
                                    .flex_1()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(item.name.clone()),
                            )
                            .child(view_button("image-close", "Close image", "x").on_click(
                                cx.listener(|this, _, window, cx| this.close_viewer(window, cx)),
                            )),
                    )
                    .child(
                        div()
                            .id("image-stage")
                            .relative()
                            .w(width)
                            .h(height)
                            .overflow_hidden()
                            .bg(color("sunk"))
                            .rounded(px(theme::px_token("radius", "radius-md")))
                            .when(zoom > 1., |s| s.cursor(CursorStyle::OpenHand))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, event: &MouseDownEvent, _, _| {
                                    if let Some(viewer) = &mut this.viewer
                                        && viewer.zoom > 1.
                                    {
                                        viewer.drag = Some(event.position);
                                    }
                                }),
                            )
                            .on_mouse_up(
                                MouseButton::Left,
                                cx.listener(|this, _, _, _| {
                                    if let Some(viewer) = &mut this.viewer {
                                        viewer.drag = None;
                                    }
                                }),
                            )
                            .on_mouse_move(cx.listener(
                                move |this, event: &MouseMoveEvent, _, cx| {
                                    if let Some(viewer) = &mut this.viewer
                                        && let Some(last) = viewer.drag
                                    {
                                        if event.pressed_button == Some(MouseButton::Left) {
                                            let delta = event.position - last;
                                            viewer.pan = point(
                                                (viewer.pan.x + delta.x).clamp(-max.x, max.x),
                                                (viewer.pan.y + delta.y).clamp(-max.y, max.y),
                                            );
                                            viewer.drag = Some(event.position);
                                            cx.notify();
                                        } else {
                                            viewer.drag = None;
                                        }
                                    }
                                },
                            ))
                            .child(match image {
                                Some(Ok(image)) => img(image)
                                    .absolute()
                                    .w(width * zoom)
                                    .h(height * zoom)
                                    .left(width * (1. - zoom) / 2. + pan.x)
                                    .top(height * (1. - zoom) / 2. + pan.y)
                                    .object_fit(ObjectFit::Contain)
                                    .into_any_element(),
                                state => div()
                                    .size_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .text_color(color("ink-2"))
                                    .child(
                                        state
                                            .and_then(Result::err)
                                            .unwrap_or_else(|| "Loading image…".into()),
                                    )
                                    .into_any_element(),
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                view_button("image-prev", "Previous image", "chevron-left")
                                    .when(viewer.at == 0, |s| s.opacity(0.4))
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.step_image(-1, cx)),
                                    ),
                            )
                            .child(div().text_color(color("ink-2")).child(format!(
                                "{} of {}",
                                viewer.at + 1,
                                viewer.items.len()
                            )))
                            .child(
                                view_button("image-next", "Next image", "chevron-right")
                                    .when(viewer.at + 1 == viewer.items.len(), |s| s.opacity(0.4))
                                    .on_click(cx.listener(|this, _, _, cx| this.step_image(1, cx))),
                            )
                            .child(div().flex_1())
                            .child(
                                div()
                                    .id("image-out")
                                    .control("Zoom out")
                                    .px(px(8.))
                                    .child("−")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if let Some(viewer) = &mut this.viewer {
                                            viewer.zoom(1. / 1.25);
                                            cx.notify();
                                        }
                                    })),
                            )
                            .child(
                                div()
                                    .id("image-fit")
                                    .control("Fit to window")
                                    .px(px(8.))
                                    .child(format!("{}%", (zoom * 100.).round()))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if let Some(viewer) = &mut this.viewer {
                                            viewer.fit();
                                            cx.notify();
                                        }
                                    })),
                            )
                            .child(
                                div()
                                    .id("image-in")
                                    .control("Zoom in")
                                    .px(px(8.))
                                    .child("+")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if let Some(viewer) = &mut this.viewer {
                                            viewer.zoom(1.25);
                                            cx.notify();
                                        }
                                    })),
                            ),
                    ),
            ),
    )
    .with_priority(3)
}

fn view_button(id: &'static str, tip: &'static str, icon: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .control(tip)
        .size(px(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(theme::px_token("radius", "radius-md")))
        .child(ui::icon(icon, "ink-2"))
}
