# Steps

What an agent did during a turn, one line per step, thoughts included. This is how Agent shows tool calls. Board's history and Dispatch's build log keep using `Trail`.

The consumer provides `items`. Each item has a `kind` (`read`, `command`, `edit`, `thought` or `other`), a `verb` ("Read", "Ran", "Edited", "Thought"), a `target`, a `meta` and an optional `body`. It can also have `state: 'live'` or `'broken'`. Give a `summary` ("Ran 4 commands, read 3 files · 38s") to make the run foldable, and `collapsed` to start it folded. `open` lists the ids to start expanded.

- The verb is set in Next and the target in Mono. Put a command's target in `Command` to give it syntax colours.
- Put the time or size in `meta`, on the right: `3.4s`, `551 lines`, `+5 −1`. Leave out the exit code when it's 0. On failure, use `state: 'broken'` and say what failed.
- A thought's target is the start of the thought, in italic. Its `body` is the whole thought. Show thoughts; don't hide them.
- Clicking a step with a `body` opens it under a thin rule: output, diff or script. No boxes, no tree lines.
- A step with `state: 'live'` shows the turning ◐ and its meta in `live`. Only the running step is live.
