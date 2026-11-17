//! The fixtures' Git and Diff data, written as the server would answer and
//! read by the same decoders as the live source, so the tabs draw the same way.

use crate::git::{
    self, CommitDetail, Forge, Git, Overview, Patch, RequestStatus, TurnDiff, commit_checks_of,
    requests_of,
};
use serde_json::json;
use std::sync::Arc;

const PATCH: &str = "diff --git a/tests/picker.rs b/tests/picker.rs
new file mode 100644
--- /dev/null
+++ b/tests/picker.rs
@@ -0,0 +1,7 @@
+#[test]
+fn escape_restores_trigger() {
+    let mut picker = Picker::new();
+    picker.open();
+    picker.dismiss();
+    assert!(picker.trigger_focused());
+}
diff --git a/src/model_picker.rs b/src/model_picker.rs
--- a/src/model_picker.rs
+++ b/src/model_picker.rs
@@ -26,3 +26,4 @@ impl Workspace {
 fn open_picker(&mut self) {
-    self.picker_open = true;
+    self.open_picker(window, cx);
+    self.search.focus(window, cx);
 }
diff --git a/src/workspace.rs b/src/workspace.rs
--- a/src/workspace.rs
+++ b/src/workspace.rs
@@ -8,3 +8,4 @@ struct Workspace {
 struct Workspace {
+    model_focus: FocusHandle,
     selected: ThreadId,
 }
";

/// The tabs' data for every fixture thread.
pub fn fixture() -> Arc<Git> {
    let overview = Overview::from_json(&json!({
        "isRepository": true,
        "root": "/Users/aaron/work/moxen",
        "status": {"branch": "picker-focus", "staged": 0, "unstaged": 10, "untracked": 1, "conflicted": 0},
        "branches": [
            {"name": "picker-focus", "current": true, "remote": false, "ahead": 3, "behind": 0},
            {"name": "main", "current": false, "remote": false, "ahead": 0, "behind": 0},
            {"name": "opencode-v2", "current": false, "remote": false, "ahead": 12, "behind": 4},
            {"name": "origin/main", "current": false, "remote": true, "ahead": null, "behind": null}
        ],
        "commits": [
            commit("5a7bee1", "Keep model selection in the keyboard flow", "2026-11-17T11:48:00Z"),
            commit("86553cd", "Return focus to the trigger on Escape", "2026-11-17T09:12:00Z"),
            commit("c1d09ab", "Preserve the draft when choosing a model", "2026-11-16T16:30:00Z"),
            commit("9e3f4d2", "Add the model picker", "2026-11-14T10:05:00Z"),
        ],
        "branch": "picker-focus",
        "defaultBranch": "main"
    }));
    let status = RequestStatus::from_json(&json!({"request": {
        "number": 412, "title": "Keep model selection in the keyboard flow", "state": "open",
        "url": "https://github.com/usemoxen/moxen/pull/412", "targetBranch": "main",
        "reviewDecision": "REVIEW_REQUIRED", "checks": null,
        "runs": [
            {"name": "build (macos)", "state": "passed", "url": null},
            {"name": "build (windows)", "state": "pending", "url": null},
            {"name": "clippy", "state": "passed", "url": null},
            {"name": "test", "state": "failed", "url": "https://github.com/usemoxen/moxen/actions/runs/1"},
            {"name": "fmt", "state": "passed", "url": null}
        ],
        "mergeable": "mergeable", "additions": 68, "deletions": 9, "changedFiles": 3
    }}));
    Arc::new(Git {
        overview: Some(overview),
        forge: Some(Forge::from_json(
            &json!({"kind": "github", "slug": "usemoxen/moxen"}),
        )),
        requests: requests_of(&json!({"requests": [
            {"number": 412, "title": "Keep model selection in the keyboard flow", "state": "open"},
            {"number": 409, "title": "Resync after a bad frame", "state": "open",
             "checks": {"passed": 18, "failed": 0, "pending": 0}},
            {"number": 398, "title": "Draft: queue edits", "state": "draft",
             "checks": {"passed": 6, "failed": 2, "pending": 0}}
        ]})),
        status,
        commit_checks: commit_checks_of(&json!({"checks": {
            "5a7bee1": {"passed": 4, "failed": 1, "pending": 1},
            "86553cd": {"passed": 6, "failed": 0, "pending": 0}
        }})),
        ..Git::default()
    })
}

fn commit(short: &str, subject: &str, date: &str) -> serde_json::Value {
    json!({"sha": format!("{short}0000000000000000000000000000000"), "shortSha": short,
           "author": "Aaron Mompié", "date": date, "subject": subject, "refs": []})
}

/// A commit in full: the fixtures have one, whichever sha is opened.
pub fn detail(sha: &str) -> Option<CommitDetail> {
    CommitDetail::from_json(&json!({"commit": {
        "sha": sha, "subject": "Keep model selection in the keyboard flow",
        "body": "Focus search when the picker opens, return to the trigger on Escape, and preserve the thread’s draft when choosing a model. The selection and focus-return paths have regression tests.",
        "author": "Aaron Mompié", "date": "2026-11-17T11:48:00Z",
        "committer": "Aaron Mompié", "committerDate": "2026-11-17T11:48:00Z",
        "parents": ["86553cd0000"], "refs": ["picker-focus"],
        "files": [{"path": "tests/picker.rs", "added": 7, "removed": 0},
                  {"path": "src/model_picker.rs", "added": 2, "removed": 1},
                  {"path": "src/workspace.rs", "added": 1, "removed": 0}],
        "diff": PATCH
    }}))
}

pub fn turns() -> Vec<TurnDiff> {
    vec![
        TurnDiff {
            turn: 1,
            files: vec![("tests/picker.rs".into(), 7, 0)],
        },
        TurnDiff {
            turn: 2,
            files: vec![
                ("src/model_picker.rs".into(), 2, 1),
                ("src/workspace.rs".into(), 1, 0),
            ],
        },
    ]
}

pub fn patch() -> Patch {
    Patch::Ready(git::parse_patch(PATCH))
}

/// What one fixture turn changed: its own files of the patch.
pub fn patch_of(turn: i64) -> Patch {
    let wanted: Vec<String> = turns()
        .into_iter()
        .find(|t| t.turn == turn)
        .map(|t| t.files.into_iter().map(|(path, ..)| path).collect())
        .unwrap_or_default();
    Patch::Ready(
        git::parse_patch(PATCH)
            .into_iter()
            .filter(|file| wanted.contains(&file.path))
            .collect(),
    )
}
