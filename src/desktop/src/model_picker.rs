use crate::{
    catalog::{Catalog, Knob, ModelInfo, Provider, Selection, knob_value, provider_color},
    model::CatalogState,
    theme::{self, color},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
actions!(model_picker, [TogglePicker]);
/// The mockup's 320 lets the effort control overhang the popover's edge; 400
/// holds five levels with the longest real labels ("Extra High") inside it.
const WIDTH: f32 = 400.;
/// The model list scrolls past this; the search and the effort controls stay.
const LIST_HEIGHT: f32 = 360.;

pub fn render(w: &Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    // Fades in and grows from 96% over 120ms, anchored at its bottom left.
    let p = ui::progress(w.picker_at, 120, window);
    let scale = 0.96 + 0.04 * p;
    let pane = div()
        .id("model-picker")
        .occlude()
        // Anchored 8pt above the composer box, which is its parent.
        .absolute()
        .bottom(relative(1.))
        .mb(px(8. - 4. * (1. - p)))
        .left(px(-2.))
        .w(px(WIDTH * scale))
        .opacity(p)
        .p(px(6.))
        .rounded(px(12.))
        .bg(color("raised"))
        .shadow(theme::float_shadow())
        .text_size(px(14.))
        .line_height(px(18.));
    body(w, pane, cx)
}

pub fn body(w: &Workspace, mut pane: Stateful<Div>, cx: &mut Context<Workspace>) -> Stateful<Div> {
    let query = w.search.read(cx).text().to_lowercase();
    let current = w.effective_selection();
    pane = pane.child(
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .pt(px(6.))
            .pb(px(8.))
            .text_color(color("ink-2"))
            .child(ui::icon("search", "ink-2"))
            .child(div().flex_1().child(w.search.clone())),
    );
    let catalog = match w.source.catalog() {
        CatalogState::Ready(catalog) => catalog,
        CatalogState::Loading => {
            return pane.child(note(&crate::language::capitalized(
                crate::language::message("picker.loading_3da3").trim_start(),
            )));
        }
        CatalogState::Failed(message) => {
            return pane.child(note(&format!("Could not read the models: {message}")));
        }
    };
    let list = list(w, &catalog, current.as_ref(), &query, cx);
    pane = pane.child(
        div()
            .id("model-list")
            .max_h(px(LIST_HEIGHT))
            .overflow_y_scroll()
            .child(list),
    );
    let knobs = current
        .as_ref()
        .and_then(|selection| Some((selection, catalog.model(selection)?)))
        .filter(|(_, model)| !model.knobs.is_empty());
    match knobs {
        Some((selection, model)) => {
            pane = pane.child(div().h(px(1.)).mx(px(2.)).my(px(6.)).bg(color("rule")));
            for (at, knob) in model.knobs.iter().enumerate() {
                pane = pane.child(knob_row(knob, at, selection, cx));
            }
            pane
        }
        None => pane,
    }
}

fn note(text: &str) -> Div {
    div()
        .px(px(8.))
        .py(px(10.))
        .text_size(px(13.))
        .text_color(color("ink-2"))
        .child(text.to_string())
}

/// The providers on offer with their models. A thread already running on a
/// provider stays on it, so only its models are listed (even if it has been
/// turned off since); a new thread, or one with no known model, lists every
/// enabled provider.
fn list(
    w: &Workspace,
    catalog: &Catalog,
    current: Option<&Selection>,
    query: &str,
    cx: &mut Context<Workspace>,
) -> Div {
    let locked = if w.creating || w.choosing_action_model() {
        None
    } else {
        current.and_then(|c| catalog.provider(&c.instance))
    };
    let providers: Vec<&Provider> = match locked {
        Some(provider) => vec![provider],
        None => catalog.offerable().collect(),
    };
    let mut out = div().flex().flex_col();
    let mut row = 0usize;
    for provider in providers {
        let shown: Vec<&ModelInfo> = provider
            .offerable_models(
                current
                    .filter(|c| c.instance == provider.instance)
                    .map(|c| c.model.as_str()),
            )
            .filter(|model| matches(model, query))
            .collect();
        if shown.is_empty() {
            continue;
        }
        let limits_data = w.source.limits();
        let limits = crate::usage::provider_limits(
            limits_data.as_deref(),
            Some(catalog),
            &provider.instance,
        );
        out = out.child(header(provider, limits));
        for model in shown {
            out = out.child(model_row(provider, model, current, row, cx));
            row += 1;
        }
    }
    if row == 0 {
        out = out.child(note(if query.is_empty() {
            "No provider is turned on. Turn one on in the Moxen settings."
        } else {
            crate::language::message("app.no_matching_models_74d5")
        }));
    }
    out
}

fn matches(model: &ModelInfo, query: &str) -> bool {
    query.is_empty()
        || model.name.to_lowercase().contains(query)
        || model
            .effort_range()
            .is_some_and(|range| range.to_lowercase().contains(query))
}

fn header(provider: &Provider, limits: Option<&crate::usage::ProviderLimits>) -> Div {
    let mut head = div()
        .flex()
        .items_center()
        .gap(px(6.))
        .px(px(8.))
        .pt(px(8.))
        .pb(px(4.))
        .child(
            div()
                .size(px(6.))
                .rounded(px(2.))
                .bg(color(provider_color(&provider.driver, &provider.instance))),
        )
        .child(ui::caps(&provider.name));
    if let Some(why) = provider.unavailable() {
        head = head.child(div().flex_1()).child(
            div()
                .text_size(px(11.5))
                .text_color(color("ink-2"))
                .child(why),
        );
    } else if let Some((summary, tone)) =
        crate::usage::compact_usage_summary(limits, crate::live::now_ms())
    {
        head = head.child(div().flex_1()).child(
            div()
                .font_family(theme::MONO)
                .text_size(px(11.))
                .text_color(color(tone))
                .child(summary),
        );
    }
    head
}

fn model_row(
    provider: &Provider,
    model: &ModelInfo,
    current: Option<&Selection>,
    at: usize,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let selected =
        current.is_some_and(|c| c.instance == provider.instance && c.model == model.slug);
    // A provider that is not installed cannot start a thread.
    let blocked = !provider.installed;
    let (instance, slug) = (provider.instance.clone(), model.slug.clone());
    let row = div()
        .id(("model", at))
        .h(px(32.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(6.))
        .when(selected, |s| s.bg(color("sunk")))
        .child(div().flex_1().truncate().child(model.name.clone()))
        .when(model.default, |s| {
            s.child(div().text_size(px(11.5)).text_color(color("ink-2")).child(
                crate::language::capitalized(crate::language::message("picker.defaultBadge")),
            ))
        })
        .when_some(model.effort_range(), |s, range| {
            s.child(
                div()
                    .font_family(theme::MONO)
                    .text_size(px(11.5))
                    .text_color(color("ink-2"))
                    .child(range),
            )
        })
        .child(
            div()
                .w(px(14.))
                .when(selected, |s| s.child(ui::icon("check", "ink"))),
        );
    if blocked {
        return row
            .disabled(format!("{} is not installed", provider.name))
            .into_any_element();
    }
    row.control(format!("Select {}", model.name))
        .on_click(cx.listener(move |this, _, window, cx| {
            this.choose_model(&instance, &slug, cx);
            if !this.choosing_action_model() {
                window.focus(&this.model_focus, cx);
            }
        }))
        .into_any_element()
}

/// One option of the chosen model (its reasoning effort, say) as a row of
/// levels; the level in force is raised.
fn knob_row(
    knob: &Knob,
    at: usize,
    selection: &Selection,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let value = knob_value(knob, selection);
    let selected = knob
        .choices
        .iter()
        .position(|choice| Some(&choice.id) == value.as_ref())
        .unwrap_or(usize::MAX);
    let labels: Vec<SharedString> = knob
        .choices
        .iter()
        .map(|choice| choice.label.clone().into())
        .collect();
    let ids: Vec<String> = knob
        .choices
        .iter()
        .map(|choice| choice.id.clone())
        .collect();
    let option = knob.id.clone();
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .pl(px(8.))
        .pr(px(6.))
        .py(px(4.))
        .child(
            div()
                .text_size(px(13.))
                .text_color(color("ink-2"))
                .child(knob.label.clone()),
        )
        .child(div().flex_1())
        .child(ui::segments(
            SharedString::from(format!("knob-{at}")),
            &labels,
            selected,
            8.,
            cx,
            move |this, i, cx| {
                if let Some(choice) = ids.get(i) {
                    this.choose_option(&option, choice, cx);
                }
            },
        ))
}
