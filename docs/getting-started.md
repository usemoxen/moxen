# Getting started and release notes

The TUI offers a short guide the first time you connect to a Moxen store.
It recognises existing settings rather than replacing them. Use **Getting
started** in the command palette (`ctrl+p`) to reopen it at any time.

The guide is a page of its own, with a step list, a quiet animated field of
threads, and a fixed navigation bar. It covers appearance, a provider and
model, memory, MCP servers, and the project for your next thread. Appearance
choices are visible together and apply immediately. Models and projects are
selected inline for the thread you are about to start; choosing one does not
change an existing thread. Model-server and MCP connection forms open inside
the guide, so setup never takes you to a separate settings page or picker.

A provider CLI must be installed and signed in through its own login.
The Models step lists providers and their available models. You can filter
the list and refresh it after signing in. **Connect a model server** opens
the existing endpoint setup directly in the page. Moxen does not ask for
your provider CLI credentials in the guide.

## Memory

The Memory step uses the same slider as Settings. Choose **Memory off**,
**Memory**, or **With embeddings**.
Memory keeps project and global preferences and decisions across
threads, for every provider. A project's own memory-off setting still wins.

Choosing **With embeddings** starts setup directly in the guide. It installs
the optional runtime on the server, downloads the q4 text model (about 207 MB
of weights plus runtime dependencies), checks retrieval and speed, and indexes
existing memories before activating semantic search. Progress and measured
results appear inline. You can cancel, retry a failed check, or continue with
keyword memory. No terminal command is required.

Settings has a dedicated **Memory** page with the global switches, setup
status and model loading policy. **Keep loaded** loads a validated local model
when the server starts and keeps it ready; **On demand** releases it after a
minute without inference. Startup never downloads a model. Each provider
still has a Memory switch, and global/project memory off takes precedence.

## Tools and the first thread

MCP servers connect agents to services you use. The guide shows the names
of servers already configured. **Add an MCP server** opens the existing
connection editor inline. Use its presets or a custom connection, choose
the providers that receive it, and test it there. **Back to this step**
returns to the Tools overview. Adding an MCP is optional.

Choose a project folder or **No project**, then finish the guide to enter
the composer. Finishing sends no message and starts no agent work.
**Later** or Escape closes the guide for this launch; it is offered again
next launch until you finish. Settings already saved stay saved.

Use the mouse, or Up/Down and Tab to focus a control and Enter to activate
it. Left/Right adjust the focused choice; on the memory slider they preview
the choice, and Enter applies it. Click a slider label to apply it directly.
Use Continue/Back, the step list, or `[` / `]` to change pages. The guide's own
background follows Animated / Static / Off, and it supports English and Spanish.

## What's new

**What's new** in the command palette opens the bundled release history.
After onboarding, an unobtrusive notice offers unread release notes.
Choose a version from the history. **Highlights** showcases features with
optional actions; **All changes** shows the release's complete change list,
grouped into sections supplied by that release. A release can contain only
the detailed change list without feature highlights. Left/Right browse
versions, `d` switches views, and Page Up/Down scroll the content. **Mark read and
close** acknowledges only the displayed release; closing with Escape or
Later leaves it unread.

Release notes are bundled and work offline. No update check, download or
installation is performed here; the in-app updater is a separate feature
(MXN-197).

Completion and read acknowledgements live in `experience.json` under the
connected server's store root. They are shared by clients using that store,
including paired remote clients; they are not tied to a project. An older
server that does not offer the guide API can still run the rest of the TUI.

## Maintaining release notes

Add releases newest first to `RELEASES` in
`src/core/experience/experience.ts`. Keep each released version fixed,
retain older entries for browsing, and write both English and Spanish text.
Describe shipped behaviour and label placeholders explicitly. `highlights`
may be empty; highlight `action` is optional. Add detailed `sections`, each
with a translated `title` and translated `entries`; section names and counts
are not fixed by the viewer. Highlight actions use the existing guide or
settings pages. The running version is
read from `package.json` for both the CLI and server.
