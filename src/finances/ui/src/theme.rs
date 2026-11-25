//! The Moxen design tokens, loaded from the desktop's pinned public copy
//! (`src/desktop/design-system/tokens.json`) by relative path — never copied —
//! so the tokens have one source of truth. The tokens define **both** a
//! `dark` and a `light` theme; both are supported here.

use gpui::{FontWeight, Hsla, Styled, px, rgb};
use std::cell::Cell;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeMode {
    Dark,
    Light,
}

impl ThemeMode {
    fn id(self) -> &'static str {
        match self {
            ThemeMode::Dark => "dark",
            ThemeMode::Light => "light",
        }
    }

    pub fn from_setting(setting: Option<&str>) -> Self {
        match setting {
            Some("light") => ThemeMode::Light,
            _ => ThemeMode::Dark,
        }
    }
}

thread_local! {
    static THEME: Cell<ThemeMode> = const { Cell::new(ThemeMode::Dark) };
}

/// Applies the theme for the current render thread, like the desktop does at
/// the top of every frame.
pub fn apply(mode: ThemeMode) {
    THEME.set(mode);
}

pub fn mode() -> ThemeMode {
    THEME.get()
}

static TOKENS: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../desktop/design-system/tokens.json"))
        .expect("pinned design tokens")
});

fn color_tokens() -> &'static [serde_json::Value] {
    TOKENS["color"]["tokens"].as_array().expect("color tokens")
}

/// The theme ids the token file declares (`dark` and `light`).
pub fn themes() -> Vec<&'static str> {
    TOKENS["color"]["themes"]
        .as_array()
        .expect("color themes")
        .iter()
        .map(|theme| theme["id"].as_str().expect("theme id"))
        .collect()
}

/// A design color token for the current theme, e.g. `color("ground")`.
/// Aliases (`"{label-1}"`) resolve recursively.
pub fn color(name: &str) -> Hsla {
    token_color(name, THEME.get())
}

fn token_color(name: &str, mode: ThemeMode) -> Hsla {
    let token = color_tokens()
        .iter()
        .find(|t| t["name"] == name)
        .unwrap_or_else(|| panic!("known color token: {name}"));
    if let Some(alias) = token["value"].as_str() {
        return token_color(alias.trim_matches(['{', '}']), mode);
    }
    let hex = token["value"][mode.id()]
        .as_str()
        .unwrap_or_else(|| panic!("color token {name} has no value for {:?}", mode));
    hex_color(name, hex)
}

fn hex_color(name: &str, hex: &str) -> Hsla {
    let hex = hex.strip_prefix('#').unwrap_or(hex);
    assert!(
        hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()),
        "color token {name} is not six hex digits: #{hex}"
    );
    rgb(u32::from_str_radix(hex, 16).expect("color token hex")).into()
}

pub const SIDEBAR: f32 = 232.;
pub const MONO: &str = "Atkinson Hyperlegible Mono";
pub const FONT: &str = "Atkinson Hyperlegible Next";
pub const WIDTH: f32 = 1280.;
pub const HEIGHT: f32 = 800.;

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

/// A design token's pixel value, e.g. `px_token("radius", "radius-md")`.
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

pub fn radius(name: &str) -> f32 {
    px_token("radius", name)
}

pub fn space(name: &str) -> f32 {
    px_token("spacing", name)
}

/// The keyboard focus ring: the design system's `:focus-visible` outline,
/// 2px of `live`, drawn inset so transparent controls stay transparent.
pub fn focus_ring() -> Vec<gpui::BoxShadow> {
    vec![gpui::BoxShadow {
        inset: true,
        color: color("live"),
        offset: gpui::point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(px_token("stroke", "stroke-furrow")),
    }]
}

/// The design system's `shadow-float`, for things that float above the window.
pub fn float_shadow() -> Vec<gpui::BoxShadow> {
    let value = TOKENS["shadow"]["tokens"][0]["value"][THEME.get().id()]
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
            color: hex_color("shadow-float", parts[4]),
            offset: gpui::point(gpui::px(0.), gpui::px(0.)),
            blur_radius: gpui::px(0.),
            spread_radius: gpui::px(parts[3].trim_end_matches("px").parse().unwrap()),
        });
    }
    shadows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_file_declares_dark_and_light() {
        assert_eq!(themes(), ["dark", "light"]);
    }

    #[test]
    fn every_color_token_has_both_modes_or_a_known_alias() {
        let names: Vec<&str> = color_tokens()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        for token in color_tokens() {
            let name = token["name"].as_str().unwrap();
            if let Some(alias) = token["value"].as_str() {
                let target = alias.trim_matches(['{', '}']);
                assert!(
                    names.contains(&target),
                    "color token {name} aliases unknown token {target}"
                );
            } else {
                for mode in ["dark", "light"] {
                    let hex = token["value"][mode]
                        .as_str()
                        .unwrap_or_else(|| panic!("color token {name} has no {mode} value"));
                    let hex = hex.strip_prefix('#').unwrap_or(hex);
                    assert!(
                        hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()),
                        "color token {name} {mode} is not six hex digits: {hex}"
                    );
                }
            }
        }
    }

    #[test]
    fn aliases_resolve_and_match_their_target() {
        apply(ThemeMode::Dark);
        assert_eq!(color("provider-claude"), color("label-1"));
        assert_eq!(color("effort"), color("label-5"));
        apply(ThemeMode::Light);
        assert_eq!(color("provider-claude"), color("label-1"));
    }

    #[test]
    fn known_token_values_are_the_pinned_ones() {
        apply(ThemeMode::Dark);
        assert_eq!(color("ground"), rgb(0x0b0c0e).into());
        assert_eq!(color("live"), rgb(0x7dd3fc).into());
        apply(ThemeMode::Light);
        assert_eq!(color("ground"), rgb(0xf5f6f7).into());
        assert_eq!(color("live"), rgb(0x0871a3).into());
        assert_ne!(color("ground"), token_color("ground", ThemeMode::Dark));
    }

    #[test]
    fn pixel_tokens_parse() {
        assert_eq!(space("space-3"), 12.);
        assert_eq!(space("space-5"), 24.);
        assert_eq!(radius("radius-md"), 8.);
        assert_eq!(radius("radius-full"), 9999.);
        assert_eq!(px_token("stroke", "stroke-hair"), 1.);
        assert_eq!(px_token("stroke", "stroke-furrow"), 2.);
    }

    #[test]
    fn every_type_style_has_a_parseable_size() {
        let groups = TOKENS["type"]["groups"].as_array().unwrap();
        let mut count = 0;
        for group in groups {
            for style in group["styles"].as_array().unwrap() {
                let size: f32 = style["fontSize"]
                    .as_str()
                    .unwrap()
                    .trim_end_matches("px")
                    .parse()
                    .unwrap();
                assert!(size > 0.);
                assert!(style["lineHeight"].as_f64().unwrap() > 0.);
                assert!(style["fontWeight"].as_f64().unwrap() >= 100.);
                count += 1;
            }
        }
        assert!(count >= 10);
    }

    #[test]
    fn float_shadow_has_the_blur_and_the_hairline_ring() {
        apply(ThemeMode::Dark);
        let shadows = float_shadow();
        assert_eq!(shadows.len(), 2);
        assert_eq!(shadows[0].blur_radius, px(32.));
        assert_eq!(shadows[1].spread_radius, px(1.));
        apply(ThemeMode::Light);
        assert_eq!(float_shadow()[0].blur_radius, px(32.));
    }

    #[test]
    #[should_panic(expected = "known color token")]
    fn an_unknown_color_token_names_itself() {
        color("not-a-token");
    }
}
