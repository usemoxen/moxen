/** Native Codex work observed on its item stream; no shell/process commands are synthesized. */
import type { BackgroundTaskSummary, ProviderRuntimeEvent } from "../spi.js";
import { asRecord, asString } from "./protocol.js";

export class CodexBackground {
  private readonly tasks = new Map<string, BackgroundTaskSummary>();
  private readonly output = new Map<string, string>();
  constructor(private readonly threadId: string, private readonly publish: (event: ProviderRuntimeEvent) => void) {}

  list(): readonly BackgroundTaskSummary[] { return [...this.tasks.values()]; }
  hasChild(id: string): boolean { return this.tasks.has(`agent:${id}`); }
  lines(taskId: string): readonly string[] | null { return this.output.has(taskId) ? this.output.get(taskId)!.split("\n").slice(-100) : null; }
  append(taskId: string, text: string): void {
    this.output.set(taskId, `${this.output.get(taskId) ?? ""}${text}`.slice(-64_000));
    for (const key of this.output.keys()) {
      if (this.output.size <= this.tasks.size + 20) break;
      if (!this.tasks.has(key)) this.output.delete(key);
    }
  }
  private changed(): void { this.publish({ type: "background.tasks.changed", provider: "codex", threadId: this.threadId, tasks: this.list() }); }
  finish(taskId: string): void { if (this.tasks.delete(taskId)) this.changed(); }
  clear(): void { if (this.tasks.size) { this.tasks.clear(); this.changed(); } }

  command(item: Record<string, unknown>, completed: boolean): void {
    const id = asString(item["id"]);
    if (!id) return;
    const taskId = `command:${id}`;
    const output = asString(item["aggregatedOutput"]);
    if (output !== null) { this.output.delete(taskId); this.append(taskId, output); }
    if (completed && item["status"] !== "inProgress") { this.finish(taskId); return; }
    if (this.tasks.has(taskId)) return;
    const command = asString(item["command"]) ?? "";
    this.tasks.set(taskId, { taskId, taskType: "local_bash", toolName: "Bash", command, description: command, startedAt: new Date().toISOString(), stoppable: false });
    this.append(taskId, "");
    this.changed();
  }

  agent(id: string, started: boolean, description: string | null, message: string | null): void {
    const taskId = `agent:${id}`;
    if (message !== null) { this.output.delete(taskId); this.append(taskId, message); }
    if (!started) { this.finish(taskId); return; }
    const previous = this.tasks.get(taskId);
    if (previous && (previous.description !== id || description === null)) return;
    this.tasks.set(taskId, { taskId, taskType: "local_agent", toolName: "Agent", description: description ?? id, command: description, startedAt: previous?.startedAt ?? new Date().toISOString() });
    this.append(taskId, "");
    this.changed();
  }

  childNotification(id: string, method: string, params: Record<string, unknown> | null): void {
    if (method === "item/agentMessage/delta") this.append(`agent:${id}`, asString(params?.["delta"]) ?? "");
    if (method === "turn/completed") {
      this.finish(`agent:${id}`);
      this.publish({ type: "subagent.updated", provider: "codex", threadId: this.threadId, turnId: null, agentId: id, agentType: "codex", status: "stopped", lastMessage: this.output.get(`agent:${id}`) ?? null });
    }
    if (method === "thread/status/changed" && asRecord(params?.["status"])?.["type"] === "notLoaded") this.finish(`agent:${id}`);
  }
}
