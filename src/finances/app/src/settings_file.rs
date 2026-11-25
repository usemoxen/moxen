//! The one thing the standalone app persists: the chosen language, in a
//! small JSON file under the platform's data directory (`dirs::data_dir()`),
//! e.g. `~/Library/Application Support/moxen-finances/settings.json` on macOS
//! and `%APPDATA%\moxen-finances\settings.json` on Windows.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
struct SettingsFile {
    language: Option<String>,
}

fn path() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("moxen-finances").join("settings.json"))
}

fn encode(language: Option<&str>) -> String {
    serde_json::to_string(&SettingsFile {
        language: language.map(str::to_string),
    })
    .unwrap_or_else(|_| "{}".to_string())
}

fn decode(text: &str) -> Option<String> {
    serde_json::from_str::<SettingsFile>(text)
        .ok()?
        .language
        .filter(|code| !code.is_empty())
}

pub fn load_language() -> Option<String> {
    let text = std::fs::read_to_string(path()?).ok()?;
    decode(&text)
}

pub fn save_language(code: &str) {
    let Some(file) = path() else { return };
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(file, encode(Some(code)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_settings_file_round_trips_the_language() {
        assert_eq!(decode(&encode(Some("es-ES"))), Some("es-ES".to_string()));
        assert_eq!(decode(&encode(Some("en"))), Some("en".to_string()));
        assert_eq!(decode(&encode(None)), None);
        assert_eq!(decode("not json"), None);
        assert_eq!(decode("{}"), None);
        assert_eq!(decode(r#"{"language": ""}"#), None);
    }

    #[test]
    fn the_path_lives_under_the_platform_data_dir() {
        let path = path().expect("a data dir on this platform");
        assert!(
            path.ends_with("moxen-finances/settings.json")
                || path.ends_with("moxen-finances\\settings.json")
        );
        assert!(path.is_absolute());
    }
}
