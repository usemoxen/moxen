import { describe, expect, it } from "vitest";

import { buildWireMessages, normalizeToolCallId } from "../normalize.js";
import { DEFAULT_QUIRKS, detectQuirkFamily, parseQuirkOverrides, resolveQuirks, type ModelQuirks } from "../quirks.js";
import type { TranscriptMessage } from "../types.js";

const quirks = (overrides: Partial<ModelQuirks> = {}): ModelQuirks => ({ ...DEFAULT_QUIRKS, ...overrides });

const call = { id: "call_1", name: "read", arguments: '{"file_path":"/a"}' };

describe("buildWireMessages", () => {
  it("does not send a system message after the first message when the template only allows it first", () => {
    const transcript: TranscriptMessage[] = [
      { role: "system", content: "You are an agent." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "Instructions changed." },
      { role: "user", content: "next" },
    ];
    const wire = buildWireMessages(transcript, quirks());
    expect(wire.filter((message) => message.role === "system")).toHaveLength(1);
    // The reminder sits next to the user message after it, so strict alternation holds too.
    expect(wire.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(wire[3]!.content).toBe("<system-reminder>\nInstructions changed.\n</system-reminder>\n\nnext");
  });

  it("keeps a later system message in place when the template accepts it", () => {
    const wire = buildWireMessages(
      [
        { role: "system", content: "a" },
        { role: "user", content: "b" },
        { role: "system", content: "c" },
      ],
      quirks({ systemFirstOnly: false }),
    );
    expect(wire.map((message) => message.role)).toEqual(["system", "user", "system"]);
  });

  it("joins leading system entries and honours the configured system role", () => {
    const wire = buildWireMessages(
      [
        { role: "system", content: "one" },
        { role: "system", content: "two" },
        { role: "user", content: "go" },
      ],
      quirks({ systemRole: "developer" }),
    );
    expect(wire[0]).toEqual({ role: "developer", content: "one\n\ntwo" });
  });

  it("replays reasoning in the configured field, as text, or not at all", () => {
    const transcript: TranscriptMessage[] = [{ role: "assistant", content: "answer", reasoning: " thought " }];
    expect(buildWireMessages(transcript, quirks({ reasoningReplay: "field", reasoningField: "reasoning" }))[0]).toEqual({
      role: "assistant",
      content: "answer",
      reasoning: "thought",
    });
    expect(buildWireMessages(transcript, quirks({ reasoningReplay: "text" }))[0]!.content).toBe("<thinking>thought</thinking>\nanswer");
    expect(buildWireMessages(transcript, quirks({ reasoningReplay: "none" }))[0]).toEqual({ role: "assistant", content: "answer" });
  });

  it("sends the same normalised id on a tool call and on its result", () => {
    const rule = { exactLength: 9, alphanumericOnly: true };
    const wire = buildWireMessages(
      [
        { role: "assistant", content: "", toolCalls: [{ ...call, id: "call-with-dashes_and_more" }] },
        { role: "tool", toolCallId: "call-with-dashes_and_more", name: "read", content: "ok" },
      ],
      quirks({ toolCallId: rule }),
    );
    const sent = (wire[0]!.tool_calls as Array<{ id: string }>)[0]!.id;
    expect(sent).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(wire[1]!.tool_call_id).toBe(sent);
    expect(normalizeToolCallId("short", {})).toBe("short");
  });

  it("replaces unparseable tool arguments so the template cannot fail on them", () => {
    const wire = buildWireMessages([{ role: "assistant", content: "", toolCalls: [{ ...call, arguments: '{"file_path": "/a' }] }], quirks());
    expect((wire[0]!.tool_calls as Array<{ function: { arguments: string } }>)[0]!.function.arguments).toBe("{}");
  });

  it("gives a tool-only assistant message the placeholder content the server requires", () => {
    const wire = buildWireMessages([{ role: "assistant", content: "", toolCalls: [call] }], quirks({ emptyAssistantContent: "dot" }));
    expect(wire[0]!.content).toBe(".");
  });

  it("puts an assistant message between a tool result and the next user message when strict alternation needs it", () => {
    const transcript: TranscriptMessage[] = [
      { role: "assistant", content: "", toolCalls: [call] },
      { role: "tool", toolCallId: "call_1", name: "read", content: "ok" },
      { role: "user", content: "thanks" },
    ];
    const wire = buildWireMessages(transcript, quirks({ assistantAfterToolResult: true, toolResultName: true }));
    expect(wire.map((message) => message.role)).toEqual(["assistant", "tool", "assistant", "user"]);
    expect(wire[1]!.name).toBe("read");
  });

  it("sends tool results as user messages when the template has no tool role", () => {
    const wire = buildWireMessages(
      [
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", toolCallId: "call_1", name: "read", content: "ok" },
      ],
      quirks({ toolResultsAsUser: true }),
    );
    expect(wire[1]).toEqual({ role: "user", content: "<tool_response>\nok\n</tool_response>" });
  });

  it("names an attached image in the text when the endpoint takes none, and sends it when it does", () => {
    const transcript: TranscriptMessage[] = [{ role: "user", content: "look", images: [{ name: "a.png", mimeType: "image/png", data: "AAAA" }] }];
    expect(buildWireMessages(transcript, quirks({ images: "none" }))[0]!.content).toBe("look\n\n[Attached image: a.png]");
    expect(buildWireMessages(transcript, quirks({ images: "native" }))[0]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("sends a picture a tool returned after the whole round of results, and only names it for an endpoint without vision", () => {
    const picture = { name: "shot.png", mimeType: "image/png", data: "AAAA" };
    const transcript: TranscriptMessage[] = [
      { role: "user", content: "look" },
      { role: "assistant", content: "", toolCalls: [call, { ...call, id: "call_2" }] },
      { role: "tool", toolCallId: "call_1", name: "read", content: "an image", images: [picture] },
      { role: "tool", toolCallId: "call_2", name: "read", content: "text" },
    ];
    const native = buildWireMessages(transcript, quirks({ images: "native" }));
    // Both results stay next to their call; the picture comes after them.
    expect(native.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(native[4]!.content).toEqual([
      { type: "text", text: "[Image returned by read: shot.png]" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
    const none = buildWireMessages(transcript, quirks({ images: "none" }));
    expect(none.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(none[2]!.content).toBe("an image\n[Image not sent: shot.png]");
  });
});

describe("quirks", () => {
  it("picks a preset from the model id and lets the profile's family win", () => {
    expect(detectQuirkFamily("qwen3.8-flash-next")).toBe("qwen3");
    expect(detectQuirkFamily("unsloth/Mistral-7B")).toBe("mistral");
    expect(detectQuirkFamily("llama-3")).toBe("generic");
    expect(resolveQuirks({ modelId: "my-finetune", family: "mistral" }).assistantAfterToolResult).toBe(true);
  });

  it("stops asking the template to render earlier thinking when the profile drops it", () => {
    const kept = resolveQuirks({ modelId: "qwen3.8-flash-next" });
    expect(kept.reasoningReplay).toBe("field");
    expect(kept.chatTemplateKwargs).toEqual({ preserve_thinking: true });
    const dropped = resolveQuirks({ modelId: "qwen3.8-flash-next", preserveThinking: false });
    expect(dropped.reasoningReplay).toBe("none");
    expect(dropped.chatTemplateKwargs).toEqual({});
  });

  it("rejects a known override with the wrong type and keeps unknown ones", () => {
    expect(() => parseQuirkOverrides({ systemRole: "robot" }, "q")).toThrow(/systemRole/);
    expect(() => parseQuirkOverrides({ systemFirstOnly: "yes" }, "q")).toThrow(/true or false/);
    expect(parseQuirkOverrides({ futureFlag: 1, systemRole: "developer" }, "q")).toEqual({ futureFlag: 1, systemRole: "developer" });
  });
});
