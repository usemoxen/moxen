import { describe, expect, it } from "vitest";

import { decodeCommand, decodeQuery, LOCAL_ONLY_COMMANDS } from "../protocol.js";

describe("harness.models.discover on the wire", () => {
  it("keeps a missing apiFormat as chat, and refuses one it does not know", () => {
    expect(
      decodeCommand({ type: "harness.models.discover", baseUrl: "http://h" }),
    ).toMatchObject({ type: "harness.models.discover", apiFormat: "chat" });
    for (const format of ["chat", "responses", "anthropic"]) {
      expect(
        decodeCommand({ type: "harness.models.discover", baseUrl: "http://h", apiFormat: format }),
      ).toMatchObject({ apiFormat: format });
    }
    expect(() => decodeCommand({ type: "harness.models.discover", baseUrl: "http://h", apiFormat: "openai" })).toThrow(
      /apiFormat must be one of chat, responses, anthropic/,
    );
  });
});

describe("provider.update on the wire", () => {
  it("takes only a provider that can update", () => {
    expect(decodeCommand({ type: "provider.update", provider: "opencode" })).toMatchObject({ type: "provider.update", provider: "opencode" });
    expect(decodeCommand({ type: "provider.update", provider: "codex" })).toMatchObject({ provider: "codex" });
    for (const provider of ["grok", "", undefined, 3]) {
      expect(() => decodeCommand({ type: "provider.update", provider })).toThrow(/provider to be one of claude, opencode, codex/);
    }
  });
});

describe("provider.update-all and account CRUD on the wire", () => {
  it("decodes provider.update-all with or without an explicit provider list", () => {
    expect(decodeCommand({ type: "provider.update-all" })).toEqual({ type: "provider.update-all" });
    expect(decodeCommand({ type: "provider.update-all", providers: ["claude", "antigravity"] })).toEqual({
      type: "provider.update-all",
      providers: ["claude", "antigravity"],
    });
    expect(() => decodeCommand({ type: "provider.update-all", providers: "claude" })).toThrow(/must be an array/);
    expect(() => decodeCommand({ type: "provider.update-all", providers: ["grok"] })).toThrow(/providers\[\]/);
  });

  it("decodes providers.accounts and account save/toggle/remove commands", () => {
    expect(decodeQuery({ type: "providers.accounts" })).toEqual({ type: "providers.accounts" });
    expect(
      decodeCommand({
        type: "provider.account.save",
        kind: "claude",
        id: "work",
        label: "Work",
        homePath: "~/.claude-work",
        env: { FOO: "bar" },
      }),
    ).toEqual({
      type: "provider.account.save",
      kind: "claude",
      id: "work",
      label: "Work",
      homePath: "~/.claude-work",
      env: { FOO: "bar" },
    });
    expect(
      decodeCommand({ type: "provider.account.toggle", kind: "antigravity", id: "alt", enabled: false }),
    ).toEqual({ type: "provider.account.toggle", kind: "antigravity", id: "alt", enabled: false });
    expect(
      decodeCommand({ type: "provider.account.remove", kind: "chatgpt", id: "personal" }),
    ).toEqual({ type: "provider.account.remove", kind: "chatgpt", id: "personal" });
    expect(() => decodeCommand({ type: "provider.account.save", kind: "codex", id: "x" })).toThrow(/kind/);
    expect(() => decodeCommand({ type: "provider.account.toggle", kind: "claude", id: "work", enabled: "no" })).toThrow(/boolean/);
  });
});

describe("app.update.check on the wire", () => {
  it("is a query with no arguments", () => {
    expect(decodeQuery({ type: "app.update.check" })).toEqual({ type: "app.update.check" });
  });
});

describe("app.update.apply and app.update.rollback on the wire", () => {
  it("take no arguments but a commandId, and are the commands a remote client is refused", () => {
    expect(decodeCommand({ type: "app.update.apply", commandId: "a", junk: 1 })).toEqual({ type: "app.update.apply", commandId: "a" });
    expect(decodeCommand({ type: "app.update.rollback" })).toEqual({ type: "app.update.rollback" });
    expect([...LOCAL_ONLY_COMMANDS].sort()).toEqual(["app.update.apply", "app.update.rollback"]);
  });
});
