import { describe, expect, it } from "vitest";

import { LoopGuard, RepeatWatch } from "../guards.js";
import { applyToolDescriptions, builtinTools } from "../tools/index.js";
import { retryAfterOf, retryDelayMs } from "../transport/chat.js";

describe("LoopGuard", () => {
  it("warns and then stops on consecutive identical calls with the same result, normalizing JSON formatting and key order without stripping string whitespace", () => {
    const guard = new LoopGuard({ repeatWarn: 3, repeatStop: 5 });
    const verdicts = [
      guard.observe("read", '{"path": "a", "limit": 10}', "same"),
      guard.observe("read", '{"limit":10,"path":"a"}', "same"),
      guard.observe("read", '{ "path" : "a", "limit" : 10 }', "same"),
      guard.observe("read", '{"path":"a","limit":10}', "same"),
      guard.observe("read", '{"path":"a","limit":10}', "same"),
    ];
    expect(verdicts).toEqual(["ok", "ok", "warn", "warn", "stop"]);
    expect(guard.lastKind).toBe("repeat");
    expect(LoopGuard.key("bash", '{"command":"echo a b"}')).not.toBe(LoopGuard.key("bash", '{"command":"echo ab"}'));
  });

  it("does nothing when the call check is off", () => {
    const guard = new LoopGuard({ calls: false });
    expect(Array.from({ length: 12 }, () => guard.observe("read", "{}", "same")).every((verdict) => verdict === "ok")).toBe(true);
  });

  it("notices a consecutive rotation of calls getting the same results and respects repeatWarn/repeatStop", () => {
    const guard = new LoopGuard({ repeatWarn: 4, repeatStop: 6 });
    const out: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      out.push(guard.observe("read", "{}", "same file"));
      out.push(guard.observe("edit", "{}", "not found", true));
    }
    expect(out.indexOf("warn")).toBe(5);
    expect(out.at(-1)).toBe("stop");
    expect(guard.lastKind).toBe("cycle");

    // Higher thresholds let longer rotations run before warning or stopping.
    const loose = new LoopGuard({ repeatWarn: 8, repeatStop: 12 });
    const looseOut: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      looseOut.push(loose.observe("read", "{}", "same"));
      looseOut.push(loose.observe("edit", "{}", "err", true));
    }
    expect(looseOut.every((verdict) => verdict === "ok")).toBe(true);
  });

  it("does not warn or stop when a repeated call answers differently, even right on the warn or stop call", () => {
    const guard = new LoopGuard({ repeatWarn: 3, repeatStop: 5 });
    const verdicts: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      verdicts.push(guard.observe("bash", '{"command":"npm test"}', `${12 - i} failing`));
    }
    expect(verdicts.every((verdict) => verdict === "ok")).toBe(true);

    // 4 identical answers (warns at 3 and 4), then the 5th finally changes: must NOT stop or warn.
    const recovering = new LoopGuard({ repeatWarn: 3, repeatStop: 5 });
    expect(recovering.observe("bash", '{"command":"npm test"}', "3 failing")).toBe("ok");
    expect(recovering.observe("bash", '{"command":"npm test"}', "3 failing")).toBe("ok");
    expect(recovering.observe("bash", '{"command":"npm test"}', "3 failing")).toBe("warn");
    expect(recovering.observe("bash", '{"command":"npm test"}', "3 failing")).toBe("warn");
    expect(recovering.observe("bash", '{"command":"npm test"}', "0 failing")).toBe("ok");
  });

  it("does not count non-consecutive identical calls across a turn when other work runs in between", () => {
    const guard = new LoopGuard({ repeatWarn: 3, repeatStop: 5 });
    const verdicts: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      verdicts.push(guard.observe("edit", `{"file":"src/f${i}.ts"}`, "edited"));
      verdicts.push(guard.observe("bash", '{"command":"bun run typecheck"}', ""));
    }
    expect(verdicts.every((verdict) => verdict === "ok")).toBe(true);
  });

  it("does not take a read-edit rotation for a loop while the reads keep changing", () => {
    const guard = new LoopGuard();
    const out: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      out.push(guard.observe("read", "{}", `version ${i}`));
      out.push(guard.observe("edit", `{"step":${i}}`, "ok"));
    }
    expect(out.every((verdict) => verdict === "ok")).toBe(true);
  });

  it("leaves distinct work alone", () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 30; i += 1) expect(guard.observe("read", `{"path":"${i}"}`, `body ${i}`)).toBe("ok");
  });
});

describe("RepeatWatch", () => {
  it("does not falsely trip at character 50 on a fresh watch streaming normal text", () => {
    const reply = "I'm **Moxen Harness**, a coding agent running in your terminal. I can read and edit files, run commands, search the codebase, and help you build and debug software.";
    const whole = new RepeatWatch(10);
    expect(whole.push(reply)).toBe(false);

    const streamed = new RepeatWatch(10);
    for (const token of reply.match(/.{1,5}/g) ?? []) {
      expect(streamed.push(token)).toBe(false);
    }

    const prose = Array.from({ length: 400 }, (_, i) => `sentence number ${i} says something quite different from the others`).join(". ");
    expect(new RepeatWatch(6).push(prose)).toBe(false);
  });

  it("catches long, short-phrase, and self-overlapping stretches repeating back to back", () => {
    const watch = new RepeatWatch(6);
    const unit = "I will now check the configuration file again to be sure. ";
    let hit = false;
    for (let i = 0; i < 30 && !hit; i += 1) hit = watch.push(unit);
    expect(hit).toBe(true);

    // Short repeated word/token loop (fewer than 8 distinct chars, previously missed forever).
    const shortWatch = new RepeatWatch(10);
    expect(shortWatch.push("wait\n".repeat(10))).toBe(false);
    expect(shortWatch.push("wait\n".repeat(50))).toBe(true);

    // Period containing a duplicate 50-char substring inside one cycle (A + W + B + W).
    const shared = "checking the exact same configuration section now, ";
    const period = `First branch: ${shared}then second branch: ${shared}`;
    expect(new RepeatWatch(6).push(period.repeat(7))).toBe(true);
  });

  it("ignores layout runs, non-consecutive repeats, and long normal streams past the scan window", () => {
    expect(new RepeatWatch(6).push("-".repeat(2000))).toBe(false);
    expect(new RepeatWatch(6).push("| --- | --- | --- |\n".repeat(40))).toBe(false);
    expect(new RepeatWatch(6).push("0101010101".repeat(80))).toBe(false);
    expect(new RepeatWatch(6).push("a".repeat(2000))).toBe(false);

    // Same paragraph twice separated by different prose is not a loop.
    const paragraph = "This paragraph explains how the configuration loader resolves profile defaults and environment overrides cleanly.\n";
    expect(new RepeatWatch(4).push(`${paragraph}Middle note A.\n${paragraph}Middle note B.\n${paragraph}`)).toBe(false);

    // Stream exceeding SCAN * 2 (40,000 chars) stays false for normal prose and still catches a loop afterwards.
    const longWatch = new RepeatWatch(6);
    for (let i = 0; i < 700; i += 1) {
      expect(longWatch.push(`Section ${i}: unique explanation of module behavior and invariants number ${i * 7}.\n`)).toBe(false);
    }
    const loopUnit = "I will now re-read the exact same line to double check everything. ";
    expect(longWatch.push(loopUnit.repeat(7))).toBe(true);
  });
});

describe("retries", () => {
  it("reads Retry-After as seconds, a date or milliseconds", () => {
    expect(retryAfterOf(new Headers({ "retry-after": "7" }))).toBe(7000);
    expect(retryAfterOf(new Headers({ "retry-after-ms": "250" }))).toBe(250);
    expect(retryAfterOf(new Headers({ "retry-after": new Date(10_000).toUTCString() }), 4_000)).toBe(6000);
    expect(retryAfterOf(new Headers({ "retry-after": "soon" }))).toBeNull();
    expect(retryAfterOf(new Headers())).toBeNull();
  });

  it("waits what the server asked, capped, else backs off with jitter", () => {
    expect(retryDelayMs(1, 5000, () => 0)).toBe(5000);
    expect(retryDelayMs(1, 10 * 60_000, () => 0)).toBe(120_000);
    expect(retryDelayMs(3, null, () => 0.5)).toBe(4000);
    expect(retryDelayMs(10, null, () => 1)).toBeLessThanOrEqual(18_750);
  });
});

describe("tool descriptions", () => {
  it("replaces a description, or adds to it with a leading +", () => {
    const tools = builtinTools();
    const read = tools.find((tool) => tool.definition.name === "read")!;
    const [replaced] = applyToolDescriptions([read], { read: "Read a file." });
    expect(replaced!.definition.description).toBe("Read a file.");
    const [added] = applyToolDescriptions([read], { read: "+Always pass an absolute path." });
    expect(added!.definition.description).toBe(`${read.definition.description}\n\nAlways pass an absolute path.`);
    expect(added!.definition.name).toBe("read");
    expect(applyToolDescriptions([read], { nothing: "x" })[0]).toBe(read);
  });
});
