//! Shared test plumbing: every test gets its own temporary folder, never a
//! real data path, and never the `MOXEN_FINANCES_DB` variable.

// Each test file compiles this module on its own and uses a different part
// of it.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use moxen_finances_store::Store;
use tempfile::TempDir;

/// A store in a throwaway folder.
///
/// `store` is declared before `dir` so it is dropped first: on Windows the
/// folder cannot be removed while the database file is still open.
pub struct TestStore {
    pub store: Store,
    #[allow(dead_code)]
    pub dir: TempDir,
}

impl TestStore {
    /// A brand-new database, seeded with the demo data, as first run leaves it.
    pub fn initialized() -> Self {
        let dir = tempfile::tempdir().expect("temporary folder");
        let store = Store::initialize(dir.path().join("finances.db")).expect("initialize");
        Self { store, dir }
    }

    /// A brand-new database with the schema and nothing in it.
    pub fn empty() -> Self {
        let dir = tempfile::tempdir().expect("temporary folder");
        let store = Store::open(dir.path().join("finances.db")).expect("open");
        Self { store, dir }
    }

    /// A fresh, unused path for the tests that create the file themselves.
    pub fn path(&self) -> PathBuf {
        self.dir.path().join("finances.db")
    }

    /// Reopen the same file, with the first handle still open (WAL allows
    /// it), so the folder survives and the second open sees the file.
    pub fn reopen(&self) -> Store {
        Store::initialize(self.path()).expect("reopen")
    }
}

/// A file under `tests/fixtures`.
pub fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

/// A fixture's text, with the platform's line endings left alone.
pub fn fixture(name: &str) -> String {
    let path = fixture_path(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// `\r\n` and `\r` folded to `\n`, for comparing text whatever git did to it.
pub fn normalized(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}
