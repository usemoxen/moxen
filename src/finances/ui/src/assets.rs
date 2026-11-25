//! The app's inline SVG icons (24×24, stroke `currentColor`), served through
//! GPUI's `AssetSource` so `svg().path("nav-dashboard")` works.

use gpui::{AssetSource, Result, SharedString};
use std::borrow::Cow;

pub struct FinancesAssets;

const fn icon(body: &'static str) -> &'static str {
    body
}

const ICONS: &[(&str, &str)] = &[
    (
        "nav-dashboard",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>"#,
        ),
    ),
    (
        "nav-subscriptions",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18"/></svg>"#,
        ),
    ),
    (
        "nav-movements",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7H4m0 0 3-3M4 7l3 3"/><path d="M7 17h13m0 0-3-3m3 3-3 3"/></svg>"#,
        ),
    ),
    (
        "nav-projection",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>"#,
        ),
    ),
    (
        "nav-calendar",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M8 3v4M16 3v4M3.5 10.5h17"/></svg>"#,
        ),
    ),
    (
        "nav-analysis",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v16h16"/><path d="M8.5 16v-5M13 16V8M17.5 16v-3"/></svg>"#,
        ),
    ),
    (
        "nav-settings",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h8.5M17.5 8H20"/><path d="M15 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/><path d="M4 16h2.5M11.5 16H20"/><path d="M9 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>"#,
        ),
    ),
    (
        "action-pause",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6v12M15 6v12"/></svg>"#,
        ),
    ),
    (
        "action-play",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 5.5v13l10-6.5z"/></svg>"#,
        ),
    ),
    (
        "action-x",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>"#,
        ),
    ),
    (
        "alert",
        icon(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 21 19.5H3z"/><path d="M12 10v4M12 16.8v.2"/></svg>"#,
        ),
    ),
];

impl AssetSource for FinancesAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(ICONS
            .iter()
            .find(|(name, _)| *name == path)
            .map(|(_, svg)| Cow::Borrowed(svg.as_bytes())))
    }

    fn list(&self, prefix: &str) -> Result<Vec<SharedString>> {
        Ok(ICONS
            .iter()
            .filter(|(name, _)| name.starts_with(prefix))
            .map(|(name, _)| (*name).into())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_loads_and_lists() {
        let assets = FinancesAssets;
        let listed = assets.list("").unwrap();
        assert!(listed.len() >= 10);
        for name in listed {
            let bytes = assets
                .load(&name)
                .unwrap()
                .unwrap_or_else(|| panic!("icon {name} does not load"));
            let svg = std::str::from_utf8(&bytes).unwrap();
            assert!(svg.starts_with("<svg"), "icon {name} is not an svg");
            assert!(svg.contains("viewBox=\"0 0 24 24\""), "icon {name} viewBox");
        }
        assert!(assets.load("no-such-icon").unwrap().is_none());
    }
}
