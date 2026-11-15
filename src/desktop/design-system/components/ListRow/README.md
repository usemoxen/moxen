# ListRow

A row in a list: threads, conversations, members, issues.

The consumer provides `title`, optional `subtitle`, `meta`, `count` (unread), `leading` (an avatar or glyph) or `state`, `selected` and `depth` (1 for a sub-thread). Selected rows sit on `sunk` with a `live` bar on the left edge, the TUI's ▌ marker.
