/**
 * Representative store records for the SQLite schema tests (MXN-392): one row
 * with every promoted field and every `rest` field set, and one with only the
 * required ones, for each table. The round-trip test reads them back and
 * compares, so a column/`rest` change that loses a field fails there.
 */
import type { ModelSelection } from "../../../types.js";
import type {
  StoredActivity,
  StoredCheckpoint,
  StoredDelegation,
  StoredMessage,
  StoredThread,
  StoredTurn,
} from "../../types.js";

export const AT = "2026-11-19T10:20:30.000Z";
export const LATER = "2026-11-19T11:00:00.000Z";
export const MODEL: ModelSelection = { instanceId: "claude", model: "claude-test-1" };

export function fullThread(): StoredThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Ünïcode 🧵 “quoted” — thread\nsecond line",
    titleSource: "user",
    hidden: true,
    modelSelection: { ...MODEL, options: [{ id: "speed", value: "fast" }, { id: "caching", value: true }] },
    runtimeMode: "full-access",
    interactionMode: "research",
    env: { mode: "worktree", path: "/tmp/a b/ünïcode", branch: "feature/ünïcode" },
    createdAt: AT,
    updatedAt: LATER,
    archivedAt: null,
    deletedAt: null,
    settledAt: LATER,
    unsettledAt: null,
    settledOverride: "active",
    snoozedUntil: LATER,
    snoozedAt: AT,
    snoozeGeneration: "snooze-1",
    snoozeConditions: [{ type: "provider", provider: "claude", state: "exhausted", mode: "after" }],
    snoozeLatched: [0],
    hasPendingApprovals: true,
    hasPendingUserInput: false,
    continuedFrom: "thread-0",
    adoptingFrom: "thread-0",
    pendingContinuation: {
      request: {
        threadId: "thread-0",
        modelSelection: MODEL,
        byAgent: true,
        scheduledFor: LATER,
        firstMessage: "Preserve the original first action.",
        queuedTurnIds: ["turn-0"],
        modelSummary: "Model-produced handoff.",
        idempotencyKey: "original-request",
        queue: { conditions: [{ type: "thread", threadId: "thread-0" }], held: false, order: 1, sequential: false, continuation: "same-thread" },
      },
      document: "# Handoff\n\nOriginal snapshot.",
      gated: [{ sourceThreadId: "thread-0", turnId: "turn-0", messageId: "deferred", text: "Wait first.", scheduledFor: LATER }],
    },
    handoffFacts: {
      sourceThreadId: "thread-0",
      goal: { text: "Ship the audit; the goalfinder marker tells it apart.", sourceThreadId: "thread-0" },
      lastRequest: { text: "Finish the remaining work.", sourceThreadId: "thread-0" },
      firstAction: { text: "Wire the handler and run the tests.", sourceThreadId: "thread-0" },
      wrapUp: { text: "Done: scaffolding. Next: the handler.", sourceThreadId: "thread-0" },
      plan: ["- [x] scaffold", "- [ ] wire the handler"],
      files: [{ path: "src/audited/route.ts", additions: 12, deletions: 3 }],
      images: [{ name: "screen.png", path: "/store/attachments/screen.png" }],
      pending: [{ sourceThreadId: "thread-0", turnId: "turn-1", messageId: "msg-1", text: "Finish the requested audit, whole and untruncated.", scheduledFor: "2026-11-26T09:00:00.000Z" }],
    },
    usagePause: {
      provider: "claude",
      phase: "waiting",
      resetsAt: null,
      order: 2,
      handoff: false,
      windows: [{ id: "session", kind: "session", label: "Session", resetsAt: LATER }],
    },
    researchRun: {
      leadThreadId: "thread-1",
      size: { researchers: 2, critics: 1 },
      models: { critic: { provider: "claude", model: "claude-test-1" } },
      messages: [{ id: "rm-1", threadId: "thread-1", kind: "report", text: "ünïcode report", findings: 3, createdAt: AT }],
      roles: [{ threadId: "thread-role-1", role: "critic", question: "Is it sourced?" }],
      state: "running",
      createdAt: AT,
      updatedAt: LATER,
      report: null,
    },
    pastResearchRuns: [],
    researchRole: { leadThreadId: "thread-lead", role: "finalizer" },
    researchPicker: true,
    continueClaim: { token: "claim-1", pid: 4242, host: "host-1", at: AT },
    usageProtectionOverride: {
      provider: "claude",
      since: AT,
      windows: [{ id: "session", label: "Session", usedPercent: 97.5, resetsAt: LATER }],
    },
    usageNotices: {
      claude: {
        key: "session:2026-11-19T11:00:00.000Z",
        provider: "claude",
        windows: [{ id: "session", label: "Session", usedPercent: 96, resetsAt: LATER }],
        delivered: "runtime",
        waiting: true,
        raisedAt: AT,
        deliveredAt: AT,
        attemptId: "attempt-1",
      },
    },
    providerSessions: { claude: "session-abc" },
    instructionState: { claude: { baseline: "båseline", delivered: "delivered" } },
    modeState: { claude: "orchestrate" },
    nativeSubagents: [
      { agentId: "agent-1", agentType: "Explore", description: null, status: "completed", startedAt: AT, stoppedAt: LATER },
    ],
    turnSeq: 4,
  };
}

/** Only the required fields: the defaults must not turn into stored data. */
export function sparseThread(): StoredThread {
  return {
    id: "thread-2",
    projectId: "project-1",
    title: "Sparse",
    modelSelection: MODEL,
    runtimeMode: "approval-required",
    interactionMode: "default",
    env: { mode: "local", path: "", branch: null },
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    unsettledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
}

/** A queued turn with every queue, handoff, owner and usage field set. */
export function queuedTurn(threadId = "thread-1"): StoredTurn {
  return {
    id: "turn-1",
    threadId,
    messageId: "msg-1",
    status: "queued",
    delivery: "queued",
    runtimeMode: "full-access",
    interactionMode: "orchestrate",
    interactionModeExplicit: true,
    modelSelection: MODEL,
    parentTurnId: "turn-0",
    scheduledFor: "2026-11-20T00:00:00.000Z",
    scheduleReason: "usage-reset",
    continueAttempt: 2,
    heldAtSettle: true,
    heldBySnooze: true,
    automatic: true,
    consent: "replayed",
    control: true,
    queue: {
      conditions: [{ type: "usage", provider: "claude", window: "session", minimum: 5 }],
      held: true,
      // A model-handoff summary sorts just before the turn it summarises
      // (operations.ts: `turn.queue.order - 0.5`), so this is a REAL.
      order: 7.5,
      sequential: false,
      continuation: "model",
      latched: [1, 2],
      automatic: true,
      wakeUp: false,
      requestId: "req-1",
      summaryFor: "turn-0",
      eventAfter: "exhausted",
      removed: false,
    },
    handoff: {
      requestId: "req-2",
      destinationThreadId: "thread-9",
      summaryTurnId: "turn-8",
      summary: "summary ünïcode",
      fallback: true,
    },
    owner: { pid: 4242, host: "host-1" },
    error: null,
    usage: { input: 1, cacheRead: 2, cacheCreate: 3, output: 4, thinking: 5, costUsd: 0.25 },
    unanswered: true,
    generation: { characters: 100, durationMs: 2_500 },
    turnOutputTokens: 42,
    usagePause: { provider: "claude", windows: [], resetsAt: null, pausedAt: AT, hasUncommittedChanges: null, forced: true },
    agentThreadId: "thread-agent",
    reviewHandoff: true,
    parentNotice: true,
    reviewDecision: { verdict: null, report: "No verdict yet 🧵", model: "claude/claude-test-1" },
    createdAt: AT,
    updatedAt: LATER,
    startedAt: AT,
    executionSeq: 3,
    completedAt: null,
  };
}

/** A settled turn with the nullable fields at null and no optional ones. */
export function completedTurn(threadId = "thread-1"): StoredTurn {
  return {
    id: "turn-2",
    threadId,
    messageId: "msg-2",
    handoffOpen: true,
    status: "completed",
    delivery: "started",
    runtimeMode: "auto",
    interactionMode: "default",
    modelSelection: null,
    parentTurnId: null,
    error: null,
    usage: null,
    createdAt: AT,
    updatedAt: LATER,
    completedAt: LATER,
  };
}

export function fullMessage(): StoredMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    turnId: "turn-1",
    role: "assistant",
    origin: "task-notification",
    automatic: true,
    control: true,
    createdAt: AT,
    text: "ligne un\nlínea dos\r\n三行目 🧵 \"quoted\" \\ backslash\tend",
    attachments: [
      { type: "image", id: "att-1", name: "ünïcode image.png", mimeType: "image/png", sizeBytes: 1_234, path: "/tmp/a b/ünïcode image.png" },
    ],
    notification: {
      notices: ["settle:task-1:turn-2"],
      noticeEntries: ["settle:task-1:turn-1"],
      tasks: [
        {
          taskId: "task-1",
          title: "Review ünïcode",
          status: "completed",
          durationMs: 1_234,
          model: null,
          branch: "feature/ünïcode",
          headline: "MERGE",
          filesChanged: 2,
          additions: 3,
          deletions: 1,
          background: [],
          backgroundUnknown: false,
        },
      ],
    },
  };
}

/** Only the required fields: no attachments, origin or notification. */
export function sparseMessage(): StoredMessage {
  return { id: "msg-2", threadId: "thread-1", turnId: "turn-2", role: "user", createdAt: AT, text: "" };
}

export function activityWithPayload(payload: Record<string, unknown> = { tool: "read", state: { input: { path: "ünïcode.ts" } } }): StoredActivity {
  return { id: "act-1", threadId: "thread-1", turnId: "turn-1", kind: "tool-call.completed", summary: "Read ünïcode.ts", payload, createdAt: AT };
}

/** A lifecycle row: no turn, no payload. */
export function activityWithoutPayload(): StoredActivity {
  return { id: "act-2", threadId: "thread-1", turnId: null, kind: "thread.created", summary: "Created", createdAt: AT };
}

export function fullCheckpoint(): StoredCheckpoint {
  return {
    id: "cp-1",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "available",
    ref: "abc123",
    baseRef: "def456",
    createdAt: AT,
    files: [{ path: "src/a b.ts", additions: 3, deletions: 1 }],
  };
}

/** The pre/post captures are missing, and so is the file list. */
export function sparseCheckpoint(): StoredCheckpoint {
  return { id: "cp-2", threadId: "thread-1", turnId: "turn-2", status: "unavailable", ref: null, baseRef: null, createdAt: AT };
}

export function fullDelegation(): StoredDelegation {
  return {
    id: "del-1",
    parentThreadId: "thread-1",
    childThreadId: "thread-2",
    prompt: "Review ünïcode\nwith a newline",
    baseBranch: "feature/ünïcode",
    notify: true,
    continuedIn: "thread-3",
    continuesTaskId: "task-0",
    idempotencyKey: "idem-1",
    modelSnapshot: { parent: "claude/claude-test-1" },
    review: { verdict: "MERGE", report: "Looks good 🧵" },
    cancelledTurnId: "turn-2",
    cancelledAfterSeq: 2,
    cancelledGeneration: 2,
    lastSettledTurnId: "turn-3",
    lastSettledSeq: 3,
    reviewTask: true,
    settleGeneration: 2,
    reportedGeneration: 1,
    status: "completed",
    createdAt: AT,
    updatedAt: LATER,
  };
}

export function sparseDelegation(): StoredDelegation {
  return { id: "del-2", parentThreadId: "thread-1", childThreadId: "thread-2", prompt: "do it", status: "running", createdAt: AT, updatedAt: AT };
}
