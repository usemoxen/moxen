import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderPage } from "../web/browser.js";
import { killGroup } from "../tools/shell.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../tools/shell.js", () => ({ commandEnv: () => ({}), killGroup: vi.fn() }));

class BrowserSocket extends EventTarget {
  constructor() {
    super();
    setTimeout(() => this.dispatchEvent(new Event("open")), 0);
  }

  send(text: string): void {
    const command = JSON.parse(text) as { id: number; method: string; sessionId?: string; params: { expression?: string } };
    const result = command.method === "Target.createTarget" ? { targetId: "target" }
      : command.method === "Target.attachToTarget" ? { sessionId: "session" }
      : command.method === "Page.navigate" ? { frameId: "frame" }
      : command.method === "Runtime.evaluate" ? { result: { value: command.params.expression === "location.href" ? "https://example.com/" : "<html><body>Ready</body></html>" } }
      : {};
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: command.id, result }) }));
    if (command.method === "Page.navigate") this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ method: "Page.loadEventFired", sessionId: command.sessionId, params: {} }) }));
  }

  close(): void { this.dispatchEvent(new Event("close")); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", BrowserSocket);
});
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function browser(startAfter: number | null): void {
  const child = Object.assign(new EventEmitter(), { pid: 123, stderr: new EventEmitter() });
  vi.mocked(spawn).mockImplementation(() => {
    if (startAfter !== null) setTimeout(() => child.stderr.emit("data", Buffer.from("DevTools listening on ws://127.0.0.1/devtools/browser/test\n")), startAfter);
    return child as unknown as ReturnType<typeof spawn>;
  });
  vi.mocked(killGroup).mockImplementation(() => { child.emit("exit", 0); });
}

it("does not abandon a cold browser at 15 seconds when the request still has time", async () => {
  browser(16_000);
  const result = renderPage("https://example.com/", { executable: "test-browser", policy: { allowPrivate: false }, timeoutMs: 30_000, settleMs: 0 });
  const settled = result.then((page) => ({ page }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(16_001);
  expect(await settled).toEqual({ page: { url: "https://example.com/", html: "<html><body>Ready</body></html>" } });
  await vi.runOnlyPendingTimersAsync();
});

it("still stops a browser that never becomes ready at the request deadline", async () => {
  browser(null);
  const result = renderPage("https://example.com/", { executable: "test-browser", policy: { allowPrivate: false }, timeoutMs: 30_000 });
  let ended = false;
  void result.then(() => { ended = true; }, () => { ended = true; });
  const failed = expect(result).rejects.toThrow("The browser did not start.");
  await vi.advanceTimersByTimeAsync(15_001);
  expect(ended).toBe(false);
  await vi.advanceTimersByTimeAsync(14_999);
  await failed;
  expect(killGroup).toHaveBeenCalledWith(123, "SIGTERM");
  await vi.runOnlyPendingTimersAsync();
});
