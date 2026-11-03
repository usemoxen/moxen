// When Moxen starts a compaction that OpenCode no longer starts itself
// (`compaction.auto` is off): before a model request of the agent loop, the
// thread has crossed the line OpenCode would have used, which is the window the
// model can be given less a buffer (`compaction.buffer`, else a tenth of it, at
// least 16k on windows of 32k and up). The compaction is requested for the next
// step boundary, so the turn goes on afterwards without being stopped.

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Tokens at which a thread on a model with this limit is compacted; null without a usable window. */
export function compactionLine(limit, buffer) {
  const usable = limit?.input || limit?.context;
  if (!(usable > 0)) return null;
  const reserved = typeof buffer === "number" ? buffer : Math.max(Math.floor(usable * 0.1), usable >= 32_000 ? 16_000 : 0);
  return Math.max(0, usable - reserved);
}

/** What the latest answered request took, the way OpenCode itself counts it. */
export function usedTokens(message) {
  const tokens = message?.tokens;
  if (!tokens) return 0;
  return number(tokens.input) + number(tokens.cache?.read) + number(tokens.cache?.write) + number(tokens.output) + number(tokens.reasoning);
}

export function watcher(ctx, options) {
  // The assistant message a request was made for: once per reading, so a thread still past the line is not asked again every step.
  const requested = new Map();
  const limitOf = async (model) => {
    const models = await ctx.model.list();
    const found = (Array.isArray(models) ? models : models?.data ?? []).find((entry) => entry.providerID === model.providerID && (entry.id ?? entry.modelID) === model.id);
    return found?.limit;
  };
  return async (event) => {
    try {
      const response = await ctx.session.context({ sessionID: event.sessionID });
      const history = Array.isArray(response) ? response : response.data;
      const last = history.at(-1);
      // Right after a compaction nothing has been measured yet.
      if (last?.type === "compaction") return;
      const answered = history.findLast((message) => message.type === "assistant" && usedTokens(message) > 0);
      if (!answered || requested.get(event.sessionID) === answered.id) return;
      const line = compactionLine(await limitOf(event.model), options.buffer);
      if (line === null || usedTokens(answered) < line) return;
      requested.set(event.sessionID, answered.id);
      await ctx.session.compact({ sessionID: event.sessionID });
    } catch {
      // Advisory: a failed reading must never fail the model request it rides on.
    }
  };
}
