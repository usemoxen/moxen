//! Where the database lives.
//!
//! The default is `<platform data dir>/Moxen/Finances/finances.db`
//! (`~/Library/Application Support`, `%APPDATA%` or `$XDG_DATA_HOME`
//! depending on the system, decided by `dirs` — never by a path we build
//! ourselves). `MOXEN_FINANCES_DB` wins over that default, and an explicit
//! path passed to [`crate::Store::open`] bypasses both, which is what tests
//! and the CLI's `--db` need.
//!
//! The file name stays `finances.db` rather than the reference's
//! `finanzas.db`: this is a different app in a different folder, and the
//! reference's own folder is its own.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{Result, StoreError};

/// The environment variable that redirects the database.
pub const DATABASE_ENV_VAR: &str = "MOXEN_FINANCES_DB";

/// The file name inside the app's data folder.
pub const DATABASE_FILE: &str = "finances.db";

/// The app's data folder: `<platform data dir>/Moxen/Finances`.
pub fn data_directory() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or(StoreError::NoDataDirectory)?;
    Ok(base.join("Moxen").join("Finances"))
}

/// The default database path, ignoring the environment.
pub fn default_database_path() -> Result<PathBuf> {
    Ok(data_directory()?.join(DATABASE_FILE))
}

/// The path the app opens: `MOXEN_FINANCES_DB` when it names something,
/// otherwise [`default_database_path`]. Pure, so a test can check both
/// branches without touching the process environment.
pub fn resolve_database_path(from_env: Option<&Path>) -> Result<PathBuf> {
    match from_env {
        Some(path) if !path.as_os_str().is_empty() => Ok(path.to_path_buf()),
        _ => default_database_path(),
    }
}

/// The path the app opens, read from the current environment.
pub fn database_path() -> Result<PathBuf> {
    let from_env: Option<OsString> = std::env::var_os(DATABASE_ENV_VAR);
    resolve_database_path(from_env.as_deref().map(Path::new))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_path_is_the_platform_data_folder() {
        let path = default_database_path().unwrap();
        assert!(path.ends_with(Path::new(DATABASE_FILE)));
        assert!(path.ends_with(Path::new("Moxen").join("Finances").join(DATABASE_FILE)));
        // Built from `dirs`, never from a literal home or separator.
        let base = dirs::data_dir().unwrap();
        assert_eq!(path.parent().unwrap(), base.join("Moxen").join("Finances"));
    }

    #[test]
    fn the_environment_wins_over_the_default() {
        let explicit = Path::new("somewhere").join("custom.db");
        assert_eq!(
            resolve_database_path(Some(explicit.as_path())).unwrap(),
            explicit
        );
        // An empty variable is treated as unset, like a shell export of "".
        assert_eq!(
            resolve_database_path(Some(Path::new(""))).unwrap(),
            default_database_path().unwrap()
        );
        assert_eq!(
            resolve_database_path(None).unwrap(),
            default_database_path().unwrap()
        );
    }
}
