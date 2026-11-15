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

pub fn space(index: usize) -> f32 {
    TOKENS["spacing"]["tokens"][index - 1]["value"]
        .as_str()
        .unwrap()
        .trim_end_matches("px")
        .parse()
        .unwrap()
}

pub const SIDEBAR: f32 = 288.;
pub const READING: f32 = 720.;
pub const ROW: f32 = 88.;
pub const BODY: f32 = 15.;
pub const FONT: &str = "Atkinson Hyperlegible Next";
pub const META: f32 = 12.;
pub const LINE: f32 = 24.;
pub const COMPOSER: f32 = 144.;
pub const CURSOR: f32 = 2.;
pub const RADIUS: f32 = 8.;
pub const WIDTH: f32 = 1200.;
pub const HEIGHT: f32 = 800.;
