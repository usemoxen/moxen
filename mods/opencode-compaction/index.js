import { retention } from "./retention.js";
import { summarizer } from "./summary.js";
import { watcher } from "./trigger.js";

// OpenCode's Plugin.define is an identity function; the definition is portable
// between the checkout and installed Moxen package.
//
// Moxen runs OpenCode's compaction. Moxen's server config (`config.ts`) turns
// OpenCode's own `compaction.auto` off and hands this plugin `options.brief`:
// the one summary prompt Moxen uses for every provider, and the checks on the
// reply. Without a brief (the plugin loaded on a server Moxen did not set up)
// only retention runs and OpenCode keeps writing its own summaries.
//
// - `compaction` (every compaction: `/compact`, the trigger below, an
//   overflow rescue): the summary is written here, in the thread, by the
//   session's own model with no tools, validated against the template, and
//   recorded as the compaction through `event.result`, which skips OpenCode's
//   own summary request. A reply that fails the check is asked for again once;
//   after that the hook throws and the compaction fails. OpenCode's own prompt
//   is never the fallback.
// - `generate` / `context`: the retained recent exchanges come back as real
//   messages after the checkpoint (`retention.js`), and the summary request
//   offers the model no tools.
// - `context` also starts a compaction when the thread crosses OpenCode's own
//   line, which OpenCode no longer does itself (`options.trigger`).
export default {
  id: "moxen.compaction",
  async setup(ctx) {
    const options = ctx.options ?? {};
    const retain = retention(ctx);
    const summary = options.brief ? summarizer(ctx, options.brief) : null;
    const watch = options.trigger ? watcher(ctx, options) : null;
    await ctx.session.hook("context", async (event) => {
      await retain(event, true);
      await watch?.(event);
    });
    await ctx.session.hook("generate", async (event) => {
      await retain(event);
      summary?.prepare(event);
    });
    await ctx.session.hook("compaction", async (event) => {
      await retain(event, true);
      if (summary) await summary.run(event);
    });
  },
};
