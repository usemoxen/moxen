# Managing your skills

Open **Settings → Skills** to manage your own skill packages. Moxen does not
ship Moxen-specific skills. The page is separate from the provider-resolved
skill picker in the composer: it shows stored packages, including disabled
ones and duplicate names in different locations.

Choose **Global (user)** or a registered project. Global skills live in the
user's `.agents/skills` and Claude's configured `skills` folder (normally
`.claude/skills`). Project skills live in `.agents/skills` and `.claude/skills`
under that project's workspace. Paths refer to the machine running the
Moxen server, including when connected to a remote server.

- **Add from folder** copies a folder containing `SKILL.md`, including its
  scripts, references and other resources. The frontmatter must contain
  `name` and `description`. The name becomes the destination folder name.
  An existing package is never replaced. Linked resources and special files
  are refused rather than copied from outside the chosen package.
- **Edit** changes `SKILL.md`, leaving resources alone. Moxen refuses to save
  over an external edit made since the file was opened.
- **Disable / Enable** removes or restores `SKILL.md` from discovery by
  renaming it to or from `SKILL.md.disabled`. This affects every provider
  that reads that package, not just the provider of the open thread. It is
  separate from any provider-native per-skill preference.
- **Remove** asks for confirmation, then moves the entire package to
  `moxen-removed-skills` beside its `skills` folder. The recovery path is
  shown on the page. Nothing is permanently deleted; import that folder
  again to restore it.

Linked skill folders and linked instruction files can be inspected but are
read-only here. Manage their original locations instead. Provider/system
bundles and obsolete Moxen-managed copies are not editable inventory.

Use `.agents/skills` for shared skills; Codex discovers that location natively,
Claude's Moxen skill bridge exposes it, and the Harness reads it. A provider's
own discovery rules and duplicate-name precedence still apply. The page does
not promise that every stored package is offered by every provider.

Changes apply to new provider sessions. A running session may retain the
inventory it started with; start a new session before relying on an edit or
disable. **Refresh** rereads the files on the management page.

Keyboard: **↑/↓** select, **e** edit, **p** choose the providers that get the skill (a checklist, applied at once; a skill needs at least one), **space** enable/disable, **a** add,
**s** choose scope, **d** remove, **r** refresh, **tab** another settings
page, **esc** back. A removal confirmation accepts **y** or **n**.
