// Moxen's summary turn for an OpenCode session: the same instruction and
// checks as the Harness (`src/core/compaction/summaryprompt.ts`, handed over
// as `options.brief`), asked inside the thread with no tools.

const CHECKPOINT = "<conversation-checkpoint>\n";
const hasCheckpoint = (message) => message?.role === "user" && message.content?.some((part) => part.type === "text" && part.text.startsWith(CHECKPOINT));

function stripAnalysis(reply) {
  return reply
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    // A scratchpad that never closed (the reply ran out) takes everything after it with it.
    .replace(/<analysis>[\s\S]*$/i, "")
    .trim();
}

export function summarizer(ctx, brief) {
  const required = brief.required.map((heading) => ({ name: heading.name, pattern: new RegExp(heading.source, heading.flags) }));
  // Sessions whose next `generate` is a summary turn, counted: `session.generate` runs the hook below for the request it sends.
  const summarizing = new Map();

  const missing = (reply) => {
    const text = stripAnalysis(reply);
    return required.filter((heading) => !heading.pattern.test(text)).map((heading) => heading.name);
  };

  const ask = async (sessionID, prompt) => {
    summarizing.set(sessionID, (summarizing.get(sessionID) ?? 0) + 1);
    try {
      const response = await ctx.session.generate({ sessionID, prompt });
      return typeof response?.text === "string" ? response.text : "";
    } finally {
      const left = (summarizing.get(sessionID) ?? 1) - 1;
      if (left > 0) summarizing.set(sessionID, left);
      else summarizing.delete(sessionID);
    }
  };

  return {
    /** The summary request is a `generate` request: it carries the session's tools unless they are taken out here. */
    prepare(event) {
      if (!summarizing.has(event.sessionID)) return;
      for (const name of Object.keys(event.tools ?? {})) delete event.tools[name];
    },
    /** Writes the summary and records it as the compaction; throws, failing the compaction, when no reply followed the template. */
    async run(event) {
      const update = hasCheckpoint(event.messages[0]);
      const instruction = update ? brief.update : brief.first;
      const first = await ask(event.sessionID, instruction);
      let lacking = missing(first);
      let text = first;
      if (lacking.length > 0) {
        text = await ask(event.sessionID, `${instruction}\n\n${brief.nudge} Missing: ${lacking.join(", ")}.`);
        lacking = missing(text);
      }
      if (lacking.length > 0) {
        throw new Error(`Moxen could not compact this conversation: the model's summary did not follow the required format (missing ${lacking.join(", ")}).`);
      }
      event.result = { summary: stripAnalysis(text), metadata: { moxen: { format: 1 } } };
    },
  };
}
