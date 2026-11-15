# Composer

The input box for Agent prompts, Board comments and Music requests. Chat uses `ChatComposer`. It always says who will read what you type.

The consumer provides `to` (array of `{name, kind}`), `scope` (a short privacy or permission note: "only them", "max · full access"), `product` (to show its mark), `placeholder`, `meta` (right-aligned Mono meta such as "13% · 141k / 1m") and `onSend`.

- Never hide who will read it. In Chat the `to` line is the privacy promise. In Agent, `controls` (the model picker and access chip) does that job, so Agent doesn't use the `to` line.
- Placeholder names the place: "Message NVENC test", "Ask, or / for commands".
- Send is an ink square with an arrow and stays inert until there's text.

- In Agent, pass `controls` instead of `to`: a `ModelPicker` and an access chip. Together they name the model and its permissions, which is the to line's job. `onStop` adds a stop button while a turn runs. `below` holds the status line: branch and changes, then one pill for context and plan usage.
