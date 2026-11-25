//! What the window shows while there are no threads to list: connecting to
//! the Moxen server, a server that cannot be reached, or an account with no
//! threads yet.

use crate::{
    language::{desktop, message},
    model::Connection,
    theme::{self, color},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let (title, detail, retry): (&str, String, bool) = match w.source.connection() {
        Connection::Connecting => (
            desktop(
                "Connecting to the Moxen server…",
                "Conectando con el servidor de Moxen…",
            ),
            String::new(),
            false,
        ),
        Connection::Starting => (
            desktop(
                "Starting the Moxen server…",
                "Iniciando el servidor de Moxen…",
            ),
            String::new(),
            false,
        ),
        Connection::Failed(why) => (
            desktop(
                "The Moxen server is not available",
                "El servidor de Moxen no está disponible",
            ),
            why,
            true,
        ),
        Connection::Live => (
            desktop("No threads yet", "Todavía no hay hilos"),
            desktop(
                "Start a thread or open Getting started from the command palette.",
                "Inicia un hilo o abre Primeros pasos desde la paleta de comandos.",
            )
            .into(),
            false,
        ),
    };
    div()
        .size_full()
        .bg(color("ground"))
        .font_family(theme::FONT)
        .text_size(px(theme::UI))
        .line_height(px(theme::UI_LINE))
        .text_color(color("ink"))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(12.))
        .when_some(w.source.paired_name(), |s, name| {
            s.child(div().text_color(color("live")).child(name))
        })
        .child(
            div()
                .text_size(px(theme::BODY))
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .when(!detail.is_empty(), |s| {
            s.child(
                div()
                    .max_w(px(420.))
                    .text_center()
                    .text_color(color("ink-2"))
                    .child(detail),
            )
        })
        .when(retry, |s| {
            s.child(
                div()
                    .id("retry")
                    .control(desktop("Try connecting again", "Volver a conectar"))
                    .h(px(30.))
                    .px(px(14.))
                    .flex()
                    .items_center()
                    .rounded(px(theme::px_token("radius", "radius-md")))
                    .border_1()
                    .border_color(color("rule"))
                    .bg(color("raised"))
                    .font_weight(FontWeight::MEDIUM)
                    .child(desktop("Retry", "Reintentar"))
                    .on_click(cx.listener(|this, _, _, cx| this.retry(cx))),
            )
        })
        .when(w.source.restart_required(), |s| {
            s.child(
                div()
                    .text_color(color("held"))
                    .child(message("update.beforeInstall")),
            )
        })
        .when(
            matches!(
                w.source.connection(),
                Connection::Connecting | Connection::Starting
            ),
            |s| s.child(ui::icon("state-running", "live")),
        )
}
