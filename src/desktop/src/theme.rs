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
pub const BODY: f32 = 15.;
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
    vec![gpui::BoxShadow {
        inset: false,
        color: Hsla::from(tint).opacity(channels[3]),
        offset: gpui::point(gpui::px(lengths[0]), gpui::px(lengths[1])),
        blur_radius: gpui::px(lengths[2]),
        spread_radius: gpui::px(0.),
    }]
}
