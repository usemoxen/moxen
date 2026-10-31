import { describe, expect, it } from "vitest";
import { Message, Media } from "@opencode/ai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { locateCompactionMod } from "../config.js";

const model = { providerID: "openai", id: "test" };
const image = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIUlEQVR4nGP8z0AaYCJRPcOoBmIAE1GqkMCoBmIAyaEEAEAuAR9UPEsJAAAAAElFTkSuQmCC";
const user = (id: string, text: string, attachment = false) => Message.make({ id, role: "user", content: [{ type: "text", text }, ...(attachment ? [{ type: "media" as const, media: Media.base64(image, "image/png"), filename: `${id}.png` }] : [])] });
const summary = (id = "msg_100", keepID: string | undefined = "msg_003") => Message.make({ id, role: "user", content: `<conversation-checkpoint>\n<summary>\n## Objective\nFix compaction.\n\n<recent-context>\nQuoted markup inside the summary.\n</recent-context>\n</summary>\n\n<recent-context>\nSerialized and truncated recent text.\n</recent-context>\n</conversation-checkpoint>`, metadata: { ...(keepID ? { keepID } : {}), recent: "Serialized and truncated recent text." } });
const window = () => [
  user("msg_001", "Old reference", true),
  Message.make({ id: "msg_002", role: "assistant", content: "Older output ".repeat(5000) }),
  user("msg_003", "Use this recent image; preserve this exact request.", true),
  Message.make({ id: "msg_004", role: "assistant", content: [{ type: "tool-call", id: "call", name: "read", input: { path: "src/file.ts" } }] }),
  Message.make({ role: "tool", content: [{ type: "tool-result", id: "call", name: "read", result: { type: "text", value: "FULL_RESULT\n".repeat(500) } }] }),
  Message.make({ id: "msg_006", role: "assistant", content: "Still implementing; checks pending." }),
];

async function harness() {
  const values = new Map<string, unknown>();
  let native: Array<Record<string, unknown>> = [];
  const plugin = (await import(pathToFileURL(path.join(locateCompactionMod()!, "index.js")).href)).default;
  const setup = async () => {
    const hooks = new Map<string, (event: any) => Promise<void>>();
    await plugin.setup({ storage: { get: async (key: string) => structuredClone(values.get(key)), set: async (key: string, value: unknown) => { values.set(key, JSON.parse(JSON.stringify(value))); } }, session: { context: async () => ({ data: native }), hook: async (name: string, fn: (event: any) => Promise<void>) => { hooks.set(name, fn); } } });
    return async (kind: string, messages: Message[], selection = model) => {
      const event = { sessionID: "session", model: selection, messages, system: [], options: {} };
      await hooks.get(kind)!(event);
      return event;
    };
  };
  return { values, setup, checkpoint: (item: Message) => { native = [{ id: item.id, type: "compaction", status: "completed", metadata: item.metadata }]; } };
}

describe("OpenCode compaction retention", () => {
  it("replays real images, exact roles and complete unshortened tool pairs after restart and repeated compaction", async () => {
    const h = await harness();
    let run = await h.setup();
    const source = window();
    const prepared = await run("compaction", source);
    expect(prepared).not.toHaveProperty("result"); // native retries and usage recording stay in charge
    const checkpoint = summary();
    h.checkpoint(checkpoint);
    run = await h.setup(); // only durable JSON survives
    const restored = await run("context", [checkpoint]);
    expect(restored.messages.map((message) => message.id)).toEqual(["msg_100", "msg_003", "msg_004", undefined, "msg_006"]);
    expect(restored.messages.slice(1).map((message) => ({ role: message.role, content: JSON.parse(JSON.stringify(message.content)) }))).toEqual(source.slice(2).map((message) => ({ role: message.role, content: JSON.parse(JSON.stringify(message.content)) })));
    const media = restored.messages[1]!.content.find((part) => part.type === "media")!;
    expect(media.type).toBe("media");
    if (media.type === "media") {
      expect(media.media).toBeInstanceOf(Media.Asset);
      expect(media.media.source).toEqual({ type: "base64", data: image, mediaType: "image/png" });
    }
    expect(JSON.stringify(restored.messages[0]!.content)).not.toContain("Serialized and truncated recent text.");
    expect(JSON.stringify(restored.messages[0]!.content)).toContain("Quoted markup inside the summary.");
    // A request may revisit retention after another hook already restored it.
    // Tool-result messages have no message ID in OpenCode's live runner.
    const restoredLength = restored.messages.length;
    const revisited = await run("generate", restored.messages);
    expect(revisited.messages).toHaveLength(restoredLength);
    expect(revisited.messages.flatMap((message) => message.content).filter((part) => part.type === "tool-result")).toHaveLength(1);
    // The next compaction sees the same real content, not its earlier flattened rendering.
    await run("compaction", [summary()]);
    const second = summary("msg_200", undefined);
    h.checkpoint(second);
    run = await h.setup();
    const again = await run("generate", [second]);
    expect(again.messages.map((message) => message.id)).toEqual(restored.messages.map((message) => message.id === "msg_100" ? "msg_200" : message.id));
    expect(JSON.stringify(again.messages)).not.toContain("msg_001.png");
  });

  it("does not duplicate post-compaction input or attach future images after a revert", async () => {
    const h = await harness();
    const run = await h.setup();
    await run("context", window());
    h.checkpoint(summary());
    await run("context", [summary(), user("msg_101", "New request", true)]);
    const next = await run("context", [summary(), user("msg_101", "New request", true)]);
    expect(next.messages.filter((message) => message.id === "msg_101")).toHaveLength(1);
    const older = summary("msg_050", undefined);
    h.checkpoint(older);
    expect((await run("context", [older])).messages).toHaveLength(1);
  });

  it("keeps native serialized history when only a bounded suffix can be restored, and drops oversized or unpaired exchanges", async () => {
    const h = await harness();
    const run = await h.setup();
    await run("compaction", window());
    const checkpoint = summary("msg_100", "msg_001");
    h.checkpoint(checkpoint);
    const restored = await run("context", [checkpoint]);
    expect(JSON.stringify(restored.messages[0])).toContain("recent-context");
    expect(restored.messages.some((message) => message.id === "msg_003")).toBe(true);
    await run("compaction", [user("msg_201", "Too big ".repeat(50_000), true)]);
    const large = summary("msg_300", undefined);
    h.checkpoint(large);
    expect((await run("context", [large])).messages).toHaveLength(1);
    await run("compaction", window().slice(2, 4)); // dangling tool call
    const incomplete = summary("msg_400", undefined);
    h.checkpoint(incomplete);
    expect((await run("context", [incomplete])).messages).toHaveLength(1);
  });

  it("does not treat user-written checkpoint markup as a native compaction", async () => {
    const h = await harness();
    const run = await h.setup();
    await run("compaction", window());
    expect((await run("context", [summary()])).messages).toHaveLength(1);
  });

  it("restores a background summary's newer tail without replaying another model's native proof", async () => {
    const h = await harness();
    const run = await h.setup();
    await run("compaction", window()); // background summary begins here
    const later = Message.make({ ...user("msg_007", "Latest request with its own image", true), native: { proof: "model-bound" }, providerMetadata: { openai: { proof: "model-bound" } } });
    await run("context", [...window(), later]); // the agent kept working
    const checkpoint = summary("msg_100", "msg_007");
    h.checkpoint(checkpoint);
    const next = await run("context", [checkpoint], { ...model, id: "another-model" });
    expect(next.messages.map((message) => message.id)).toEqual(["msg_100", "msg_003", "msg_004", undefined, "msg_006", "msg_007"]);
    expect(JSON.stringify(next.messages)).not.toContain("model-bound");
    expect(next.messages[1]!.content.find((part) => part.type === "media")).toBeDefined();
  });
});
