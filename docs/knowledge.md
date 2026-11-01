# Moxen knowledge base

Models can consult Moxen's bundled reference without a source checkout or a
network connection. `knowledge_search(query)` returns up to six matching
sections. Pass a result's `id` and `section` to `knowledge_read`. Small pages
can be read whole; large pages return an outline instead of truncated text.

The content covers settings, Harness profiles, MCP servers, providers and
models, projects, threads, modes, memory, skills, permissions, remote access
and troubleshooting. It describes the serving Moxen version, not the user's
current settings. It grants no permission to change anything and never reads
configuration, credentials or personal memory.

The tools use the server's corpus, including over paired connections. They
remain available to delegated tasks and do not depend on memory, web fetch
or embeddings. If the built-in `moxen` MCP server is removed, replaced,
excluded or not attached, its knowledge tools are unavailable too. Turning
off orchestration, web fetch and memory together still omits that server.
Runtime guidance names the KB only when both tools reach the session.

## Maintain it

- Write short procedures in `src/core/knowledge/workflows.ts`. State what to
  inspect, the supported operation, its consequences and how to verify it.
  Do not restate field definitions, add credentials or invent capabilities.
- Settings and list fields come from their owning schemas through
  `reference.ts`. Commands come from the import-safe tree in
  `src/cli/program.ts`; importing it never parses arguments or runs actions.
- Run `bun scripts/build-knowledge.ts` after content, schema or CLI changes.
  Commit `src/core/knowledge/generated.json` with its sources. The build also
  regenerates it before bundling. Tests refuse a stale corpus or index.
- Keep page and section IDs stable. Split oversized sections; each section
  and each page outline must fit the read budget. Search uses a generated
  lexical index with exact identifiers, word components and authored aliases.
- Add retrieval examples for a missed task, not a test for each paragraph.
  Run `bun run check`, `bun run build`, then `bun scripts/verify-knowledge.ts`.
  The last command tests the bundled server and MCP entry in an isolated
  temporary folder without source docs or corpus files.

There is no separate KB database, download, user setting or embedding model.
