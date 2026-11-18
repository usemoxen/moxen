use gpui::{AssetSource, Result, SharedString};
use std::borrow::Cow;
pub struct DesktopAssets;
const ASSETS: &[(&str, &[u8])] = &[
    (
        "agent-mark",
        include_bytes!("../design-system/assets/logos/agent-mark-on-dark.svg"),
    ),
    ("arrow-up", include_bytes!("../icons/arrow-up.svg")),
    ("asterisk", include_bytes!("../icons/asterisk.svg")),
    ("check", include_bytes!("../icons/check.svg")),
    ("chevron-down", include_bytes!("../icons/chevron-down.svg")),
    ("chevron-left", include_bytes!("../icons/chevron-left.svg")),
    (
        "chevron-right",
        include_bytes!("../icons/chevron-right.svg"),
    ),
    ("circle", include_bytes!("../icons/circle.svg")),
    ("circle-gauge", include_bytes!("../icons/circle-gauge.svg")),
    ("copy", include_bytes!("../icons/copy.svg")),
    ("dollar-sign", include_bytes!("../icons/dollar-sign.svg")),
    (
        "external-link",
        include_bytes!("../icons/external-link.svg"),
    ),
    ("file", include_bytes!("../icons/file.svg")),
    ("git-branch", include_bytes!("../icons/git-branch.svg")),
    ("maximize", include_bytes!("../icons/maximize.svg")),
    ("panel-right", include_bytes!("../icons/panel-right.svg")),
    ("paperclip", include_bytes!("../icons/paperclip.svg")),
    ("pencil", include_bytes!("../icons/pencil.svg")),
    ("search", include_bytes!("../icons/search.svg")),
    ("settings", include_bytes!("../icons/settings.svg")),
    ("square-pen", include_bytes!("../icons/square-pen.svg")),
    ("square", include_bytes!("../icons/square.svg")),
    ("state-held", include_bytes!("../icons/state-held.svg")),
    (
        "state-running",
        include_bytes!("../icons/state-running.svg"),
    ),
    ("wrench", include_bytes!("../icons/wrench.svg")),
    ("x", include_bytes!("../icons/x.svg")),
];
impl AssetSource for DesktopAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(ASSETS
            .iter()
            .find(|(name, _)| *name == path)
            .map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }
    fn list(&self, prefix: &str) -> Result<Vec<SharedString>> {
        Ok(ASSETS
            .iter()
            .filter(|(name, _)| name.starts_with(prefix))
            .map(|(name, _)| (*name).into())
            .collect())
    }
}
