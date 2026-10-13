# Providers

Moxen drives two provider runtimes through their own CLIs. Each driver is
a thin adapter over one runtime: no shared layers, no host services, only
our own root types plus type-level imports, so drivers stay
dependency-clean.

| # | Provider | Transport | Auth |
|---|---|---|---|
| 1 | Claude Code | Official `claude` CLI via the Agent SDK | Inherited CLI login (Pro/Max), API key, Bedrock |
| 2 | OpenCode | OpenCode v2 (2.0+): `opencode serve` plus the generated client | API keys; ChatGPT Pro/Plus and SuperGrok logins are built into v2 (`opencode auth login`) |

Credentials live with the provider CLIs (OpenCode keeps them in its own
SQLite, read only as provider type). This CLI never handles a token.

GPT (ChatGPT Pro/Plus) and Grok (SuperGrok) models run through
OpenCode; there are no native Codex or Grok drivers.

## Defaults

When nothing names a model — no flag, no config, no project or thread
selection — a thread runs on Claude, on its bundled catalog default, when
it is installed. OpenCode
routes to many providers, so picking one would be a guess; it is never
the implicit default. `MOXEN_DEFAULT_MODEL` (`<instance>/<model>`) pins
the default outright.

## Per-provider gaps

- Plan mode maps to Claude's plan permission mode and OpenCode's
  read-only `plan` agent.
- After a 5-hour limit Anthropic may keep serving a subscription on spare
  capacity (Claude Code's `/low-priority`). Moxen cannot drive that lane:
  the SDK never forwards the offer, only the slash command reaches us as
  an ordinary command.
