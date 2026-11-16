use gpui::{FontWeight, Styled, px};
use gpui::{Hsla, rgb};
use std::sync::LazyLock;

static TOKENS: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../design-system/tokens.json"))
        .expect("pinned design tokens")
});

pub fn color(name: &str) -> Hsla {
    let token = TOKENS["color"]["tokens"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .expect("known color token");
    if let Some(alias) = token["value"].as_str() {
        return color(alias.trim_matches(['{', '}']));
    }
    let hex = token["value"]["dark"]
        .as_str()
        .unwrap()
        .trim_start_matches('#');
    rgb(u32::from_str_radix(hex, 16).unwrap()).into()
}

pub const SIDEBAR: f32 = 272.;
pub const INSPECTOR: f32 = 420.;
pub const MONO: &str = "Atkinson Hyperlegible Mono";
pub const READING: f32 = 720.;
pub const ROW: f32 = 30.;
/// Transcript prose: `body` at 15/1.6, per the desktop doc.
pub const BODY: f32 = 15.;
/// Interface text (rows, controls, panes): 13/1.3, the mockup's UI size.
pub const UI: f32 = 13.;
pub const UI_LINE: f32 = 17.;
pub const FONT: &str = "Atkinson Hyperlegible Next";
pub const LINE: f32 = 24.;
pub const COMPOSER: f32 = 48.;
pub const CURSOR: f32 = 2.;
pub const WIDTH: f32 = 1440.;
pub const HEIGHT: f32 = 900.;

pub trait TypeScale: Styled + Sized {
    fn type_scale(self, name: &str) -> Self {
        let groups = TOKENS["type"]["groups"].as_array().unwrap();
        let (group, style) = groups
            .iter()
            .find_map(|group| {
                group["styles"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|style| style["name"] == name)
                    .map(|style| (group, style))
            })
            .expect("known type token");
        let size: f32 = style["fontSize"]
            .as_str()
            .unwrap()
            .trim_end_matches("px")
            .parse()
            .unwrap();
        self.font_family(if group["family"] == "machine" {
            MONO
        } else {
            FONT
        })
        .text_size(px(size))
        .line_height(px(size * style["lineHeight"].as_f64().unwrap() as f32))
        .font_weight(FontWeight(style["fontWeight"].as_f64().unwrap() as f32))
    }
}
impl<T: Styled> TypeScale for T {}

/// A design token's pixel value, e.g. `px_token("stroke", "stroke-rule")`.
pub fn px_token(group: &str, name: &str) -> f32 {
    TOKENS[group]["tokens"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .and_then(|t| t["value"].as_str())
        .expect("known pixel token")
        .trim_end_matches("px")
        .parse()
        .unwrap()
}

/// The keyboard focus ring: the design system's `:focus-visible` outline,
/// 2px of `live`. GPUI drop shadows fill beneath the element, so the ring is
/// drawn inset to keep transparent controls transparent.
pub fn focus_ring() -> Vec<gpui::BoxShadow> {
    vec![gpui::BoxShadow {
        inset: true,
        color: color("live"),
        offset: gpui::point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(px_token("stroke", "stroke-furrow")),
    }]
}

pub fn float_shadow() -> Vec<gpui::BoxShadow> {
    let value = TOKENS["shadow"]["tokens"][0]["value"]["dark"]
        .as_str()
        .unwrap();
    let (geometry, rgba) = value.split_once("rgba(").expect("shadow-float rgba");
    let lengths: Vec<f32> = geometry
        .split_whitespace()
        .map(|v| v.trim_end_matches("px").parse().unwrap())
        .collect();
    let channels: Vec<f32> = rgba
        .split(')')
        .next()
        .unwrap()
        .split(',')
        .map(|v| v.parse().unwrap())
        .collect();
    let tint = rgb(((channels[0] as u32) << 16) | ((channels[1] as u32) << 8) | channels[2] as u32);
    let mut shadows = vec![gpui::BoxShadow {
        inset: false,
        color: Hsla::from(tint).opacity(channels[3]),
        offset: gpui::point(gpui::px(lengths[0]), gpui::px(lengths[1])),
        blur_radius: gpui::px(lengths[2]),
        spread_radius: gpui::px(0.),
    }];
    // The second layer is a hairline ring ("0 0 0 1px #…"): it replaces a border.
    if let Some(ring) = value.split("), ").nth(1) {
        let parts: Vec<&str> = ring.split_whitespace().collect();
        shadows.push(gpui::BoxShadow {
            inset: false,
            color: rgb(u32::from_str_radix(parts[4].trim_start_matches('#'), 16).unwrap()).into(),
            offset: gpui::point(gpui::px(0.), gpui::px(0.)),
            blur_radius: gpui::px(0.),
            spread_radius: gpui::px(parts[3].trim_end_matches("px").parse().unwrap()),
        });
    }
    shadows
}
