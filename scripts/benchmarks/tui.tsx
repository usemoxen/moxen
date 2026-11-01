import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { useState } from "react";
import { MessageBody } from "../../src/tui/features/timeline/timeline.js";
import { emptyThreadState, timeline, type ThreadState, type TimelineEntry } from "../../src/tui/model/thread.js";
import { groupTurns } from "../../src/tui/model/turns.js";
import { buildSidebarSections } from "../../src/tui/model/sidebar.js";
import type { ShellState } from "../../src/tui/model/shell.js";

function fixture(turns: number): ThreadState {
  const state = emptyThreadState();
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = `turn-${turn}`;
    const at = (step: number) => new Date(Date.UTC(2026, 0, 1) + turn * 10_000 + step * 1000).toISOString();
    for (const [role, step] of [["user", 0], ["assistant", 5]] as const) {
      state.messages.push({ id: `${role}-${turn}`, role, text: `${role} ${turn}: ${"Some ordinary reply text. ".repeat(40)}`, turnId, streaming: false, createdAt: at(step), updatedAt: at(step) });
    }
    for (let step = 1; step < 5; step += 1) {
      state.activities.push({ id: `tool-${turn}-${step}`, turnId, kind: "tool.completed", tone: "tool", summary: "Read a file", createdAt: at(step), payload: { toolCallId: `call-${turn}-${step}`, data: { tool: "Read", state: { input: { file_path: "example.ts" }, status: "completed" } } } });
    }
    state.checkpoints.push({ turnId, checkpointTurnCount: turn + 1, status: "ready", files: [{ path: "example.ts", kind: "modified", additions: 1, deletions: 1 }] });
  }
  return state;
}

function summarize(name: string, samples: number[], cpu: NodeJS.CpuUsage, rss: number) {
  samples.sort((a, b) => a - b);
  return { name, samples: samples.length, medianMs: +samples[Math.floor(samples.length / 2)]!.toFixed(2), p95Ms: +samples[Math.floor(samples.length * 0.95)]!.toFixed(2), cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(1), rssMiB: +(rss / 1024 / 1024).toFixed(1) };
}

const results = [];
for (const turns of [100, 500, 2000]) {
  const state = fixture(turns);
  for (let index = 0; index < 3; index += 1) groupTurns(timeline(state));
  const samples = [];
  const cpu = process.cpuUsage();
  for (let index = 0; index < 15; index += 1) {
    const start = performance.now();
    groupTurns(timeline(state));
    samples.push(performance.now() - start);
  }
  results.push(summarize(`project ${turns} turns`, samples, process.cpuUsage(cpu), process.memoryUsage().rss));
}

for (const count of [100, 500, 2000]) {
  const now = Date.UTC(2026, 0, 2);
  const shell: ShellState = {
    snapshotSequence: 0, synchronized: true, unhandled: {},
    projects: [{ id: "project", title: "Benchmark", workspaceRoot: process.cwd(), defaultModelSelection: null }],
    threads: Array.from({ length: count }, (_, index) => ({
      id: `thread-${index}`, projectId: "project", title: `Thread ${index}`, archivedAt: null,
      createdAt: new Date(now - index * 1000).toISOString(), updatedAt: new Date(now - index * 1000).toISOString(),
      ...(index === count - 1 ? {} : { parentThreadId: `thread-${count - 1}` }),
    })),
  };
  const options = { settledExpanded: false, settledLimit: 10, now };
  for (let index = 0; index < 3; index += 1) buildSidebarSections(shell, options);
  const samples = [];
  const cpu = process.cpuUsage();
  for (let index = 0; index < 15; index += 1) {
    const start = performance.now();
    buildSidebarSections(shell, options);
    samples.push(performance.now() - start);
  }
  results.push(summarize(`sidebar ${count} delegated threads`, samples, process.cpuUsage(cpu), process.memoryUsage().rss));
}

// A clock/hover/selection update re-renders old bodies even when their text is unchanged.
// Use real OpenTUI nodes and the production React runtime, without a provider or terminal.
const entries = timeline(fixture(200)).filter((entry) => entry.kind === "assistant");
const setup = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
const root = createRoot(setup.renderer);
let update: (tick: number) => void = () => {};
function Harness() {
  const [tick, setTick] = useState(0);
  update = setTick;
  return (
  <box style={{ flexDirection: "column", width: 120, height: 40 }}>
    <text style={{ height: 1, flexShrink: 0 }}>{`clock ${tick}`}</text>
    <scrollbox style={{ flexGrow: 1 }}>
      {entries.map((entry: TimelineEntry) => <MessageBody key={entry.id} entry={entry} homeDir={undefined} background="#000000" />)}
    </scrollbox>
  </box>,
  );
}
root.render(<Harness />);
const commit = async (tick: number) => {
  update(tick);
  for (let pass = 0; pass < 100; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.flush();
    if (setup.captureCharFrame().includes(`clock ${tick}`)) return;
  }
  throw new Error(`benchmark render ${tick} did not settle: ${setup.captureCharFrame()}`);
};
await commit(0);
for (let tick = 1; tick <= 3; tick += 1) await commit(tick);
const samples = [];
const cpu = process.cpuUsage();
for (let tick = 4; tick < 24; tick += 1) {
  const start = performance.now();
  await commit(tick);
  samples.push(performance.now() - start);
}
results.push(summarize("update 200 unchanged reply bodies", samples, process.cpuUsage(cpu), process.memoryUsage().rss));
const idleCpu = process.cpuUsage();
const idleFrames = setup.getNativeStats().nativeFrameCount;
await new Promise((resolve) => setTimeout(resolve, 1000));
const idle = { cpuMs: +((process.cpuUsage(idleCpu).user + process.cpuUsage(idleCpu).system) / 1000).toFixed(1), frames: setup.getNativeStats().nativeFrameCount - idleFrames };
root.unmount();
setup.renderer.destroy();
console.log(JSON.stringify({ bun: Bun.version, nodeCompatibility: process.version, platform: process.platform, architecture: process.arch, results, idle }, null, 2));
process.exit(0);
