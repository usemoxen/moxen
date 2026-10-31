import { Schema } from "effect";

// Keep whole exchanges. In particular, never shorten a tool result or separate
// an image from the prompt that introduced it. OpenCode keeps the older prefix
// in its normal summary even when the latest exchange exceeds this allowance.
const TOKEN_LIMIT = 12_000;
const BYTE_LIMIT = 16 * 1024 * 1024;
function decode(messages, sample) {
  // Message is a Schema.Class. Use the host's constructor and Effect runtime:
  // a second SDK's Media.Asset fails the host's instanceof validation. The JSON
  // codec also restores byte sources and provider metadata without guessing.
  const codec = Schema.toCodecJson(Schema.Array(sample.constructor));
  return Schema.decodeUnknownSync(codec)(messages);
}

function estimate(part) {
  if (part.type === "media") return 1_500;
  if (part.type === "tool-result" && part.result.type === "content") {
    return part.result.value.reduce((sum, value) => sum + (value.type === "text" ? Math.ceil(value.text.length / 4) : 1_500), 0);
  }
  return Math.ceil(JSON.stringify(part).length / 4);
}

function paired(messages) {
  const calls = new Set();
  for (const message of messages) for (const part of message.content) {
    if (part.type === "tool-call") calls.add(part.id);
    if (part.type === "tool-result" && !calls.delete(part.id)) return false;
  }
  return calls.size === 0;
}

function tail(messages) {
  let tokens = 0;
  let result = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (checkpoint(message)) break;
    tokens += message.content.reduce((sum, part) => sum + estimate(part), 0);
    if (tokens > TOKEN_LIMIT) break;
    if (message.role !== "user") continue;
    const candidate = messages.slice(index);
    if (paired(candidate) && new TextEncoder().encode(JSON.stringify(candidate)).byteLength <= BYTE_LIMIT) result = candidate;
  }
  return result;
}

function checkpoint(message) {
  return message?.role === "user" && message.content?.some((part) => part.type === "text" && part.text.startsWith("<conversation-checkpoint>\n"));
}

const sameModel = (left, right) => left?.providerID === right?.providerID && left?.id === right?.id;

function identity(message) {
  if (message.id !== undefined) return `message:${message.id}`;
  // OpenCode emits tool results without message IDs. Their call IDs still
  // identify them across repeated hook visits and model changes.
  const results = message.content.filter((part) => part.type === "tool-result");
  return results.length ? `results:${JSON.stringify(results.map((part) => part.id))}` : undefined;
}

function portable(messages) {
  // Native proof belongs to the producing model. A different model can still
  // replay the exact visible text, media and paired tools without that proof.
  const withoutProof = (value) => {
    const copy = { ...value };
    delete copy.native;
    delete copy.providerMetadata;
    return copy;
  };
  return messages.map((message) => ({
    ...withoutProof(message),
    content: message.content.filter((part) => part.type !== "reasoning" && part.type !== "compaction" && part.type !== "effort").map((part) => ({ ...withoutProof(part), ...(part.type === "media" ? { media: withoutProof(part.media) } : {}) })),
  })).filter((message) => message.content.length > 0);
}

/** Storage is one atomic JSON value per session, not a second growing transcript. */
export function retention(ctx) {
  const pending = new Map();
  const run = async (event, capture) => {
    const key = `history-v1/${event.sessionID}`;
    let saved = await ctx.storage.get(key);
    const first = event.messages[0];
    if (checkpoint(first) && saved) {
      // Verify the marker against native history: user-authored XML is not a
      // compaction, and a reverted checkpoint must not gain future messages.
      const response = await ctx.session.context({ sessionID: event.sessionID });
      const history = Array.isArray(response) ? response : response.data;
      const current = history.find((message) => message.id === first.id && message.type === "compaction" && message.status === "completed");
      // Native checkpoint IDs derive from ascending event IDs. Older ones are
      // reverts, not new compactions of the cached current window.
      if (current && (!saved.checkpoint || first.id >= saved.checkpoint)) {
        if (saved.checkpoint !== first.id) {
          const keepID = current.metadata?.keepID;
          // Background compaction can keep a longer tail than the one present
          // when its summary started. Capture on primary requests as well.
          const belongs = keepID === undefined || saved.window.ids.includes(keepID);
          if (belongs) {
            const start = saved.window.tail.findIndex((message) => message.id === keepID);
            saved = { ...saved, checkpoint: first.id, retained: saved.window.tail, model: saved.window.model, replaceRecent: keepID === undefined || start >= 0 };
          }
        }
        if (saved.checkpoint === first.id && saved.retained?.length) {
          const present = new Set(event.messages.slice(1).map(identity));
          const encoded = saved.retained.filter((message) => identity(message) === undefined || !present.has(identity(message)));
          const restored = decode(sameModel(saved.model, event.model) ? encoded : portable(encoded), first);
          // Only remove the serialized recent section when all of its messages
          // are present intact. Otherwise keep that historical prefix too.
          if (saved.replaceRecent && typeof current.metadata?.recent === "string") {
            const ending = `\n\n<recent-context>\n${current.metadata.recent}\n</recent-context>\n</conversation-checkpoint>`;
            first.content = first.content.map((part) => part.type === "text" && part.text.endsWith(ending) ? { ...part, text: part.text.slice(0, -ending.length) + "\n</conversation-checkpoint>" } : part);
          }
          event.messages.splice(1, 0, ...restored);
        }
      }
    }
    if (capture) {
      const selected = tail(event.messages);
      // Asset.toJSON deliberately excludes transient authentication headers.
      // Recreate real Media.Asset instances when reading after restart.
      saved = {
        ...saved,
        checkpoint: saved?.checkpoint ?? (checkpoint(first) ? first.id : null),
        window: { ids: event.messages.map((message) => message.id), tail: JSON.parse(JSON.stringify(selected)), model: event.model },
      };
    }
    if (saved) await ctx.storage.set(key, saved);
  };
  return (event, capture = false) => {
    // Primary calls and a background summary may visit the same session at
    // once. Serialize cache updates without serializing model generation.
    const previous = pending.get(event.sessionID) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => run(event, capture));
    pending.set(event.sessionID, next);
    return next.finally(() => { if (pending.get(event.sessionID) === next) pending.delete(event.sessionID); });
  };
}
