import type { ActivityEnvelope, LatestTurnEnvelope, MessageEnvelope, ModelSelection, SessionEnvelope, ThreadEnvelope } from "../../core/types.js";
import type { ClientApi, ResearchProposal, ResearchRole, ShellFrame, StoredResearchRun, ThreadFrame } from "../../server/api.js";
import { client as baseClient } from "./fixtures.js";
import { summarizeRun, type RunSummary } from "../model/researchrun.js";

/**
 * A research run as the server sends it, for the run view's scenarios. The
 * shapes are the ones core writes (checked against a real run's shell
 * snapshot and role thread): a lead whose `parentThreadId` is the thread that
 * delegated it, role threads titled `<role>: <question>` that nest under the
 * lead and run in Research mode, and a `StoredResearchRun` naming them. Only
 * the words and timings are made up.
 */

export type RunStage = "researching" | "reviewing" | "finished";

const MINUTE = 60_000;
// Set when a client is made: the scenarios run minutes after this module loads, and elapsed times are read off the clock.
let now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();

const OPUS: ModelSelection = { instanceId: "claudeAgent", model: "claude-opus-5" };
const PROJECT = "p-cli";

export const IDS = {
  orchestrator: "t-orch",
  lead: "t-lead",
  own: "t-own",
  draft: "t-draft",
  plain: "t-plain",
} as const;

type AgentSpec = {
  readonly id: string;
  readonly role: ResearchRole;
  readonly question: string;
  readonly state: "working" | "done";
  /** What the agent has said so far. */
  readonly said: string;
  readonly tools: readonly string[];
};

function turnOf(id: string, state: LatestTurnEnvelope["state"], startedMs: number, endedMs: number | null): LatestTurnEnvelope {
  return { turnId: `turn-${id}`, state, requestedAt: ago(startedMs), startedAt: ago(startedMs), completedAt: endedMs === null ? null : ago(endedMs), assistantMessageId: null };
}

function sessionOf(id: string, running: boolean): SessionEnvelope {
  return { threadId: id, status: running ? "running" : "idle", providerName: "claudeAgent", runtimeMode: "full-access", activeTurnId: running ? `turn-${id}` : null, lastError: null, updatedAt: ago(5_000) };
}

function envelope(id: string, title: string, extra: Partial<ThreadEnvelope>): ThreadEnvelope {
  return {
    id, projectId: PROJECT, title, modelSelection: OPUS, runtimeMode: "full-access", interactionMode: "research", branch: "main", worktreePath: null,
    archivedAt: null, deletedAt: null, createdAt: ago(5 * MINUTE), updatedAt: ago(10_000), latestUserMessageAt: ago(5 * MINUTE),
    settledOverride: null, settledAt: null, unsettledAt: null, snoozedUntil: null, snoozedAt: null,
    hasPendingApprovals: false, hasPendingUserInput: false,
    ...extra,
  };
}

function roleThread(spec: AgentSpec, leadId: string, startedMs: number): ThreadEnvelope {
  const done = spec.state === "done";
  return envelope(spec.id, `${spec.role}: ${spec.question}`, {
    parentThreadId: leadId,
    createdAt: ago(startedMs),
    latestUserMessageAt: ago(startedMs),
    latestTurn: turnOf(spec.id, done ? "completed" : "running", startedMs, done ? startedMs - 2 * MINUTE : null),
    session: sessionOf(spec.id, !done),
  });
}

const researcher = (n: number, state: AgentSpec["state"], question: string, said: string, tools: readonly string[]): AgentSpec => ({ id: `t-res-${n}`, role: "researcher", question, state, said, tools });
const critic = (n: number, state: AgentSpec["state"], question: string, said: string, tools: readonly string[]): AgentSpec => ({ id: `t-cri-${n}`, role: "critic", question, state, said, tools });

const RESEARCHERS: readonly AgentSpec[] = [
  researcher(1, "done", "How do the three projects retry failed HTTP calls?", "Report 1 headline: all three retry on 5xx and timeouts, only one backs off.\n\n- `api-gateway` retries 3 times with a fixed 200 ms delay.\n- `billing` uses exponential backoff with full jitter.\n- `ingest` retries forever and has no cap.\n\nSources: `src/http/retry.ts`, `lib/backoff.go`, `ingest/client.py`.", ["rg \"retry\" src/http", "cat lib/backoff.go"]),
  researcher(2, "done", "What does the literature say about jitter?", "Report 2 headline: full jitter beats equal jitter under contention.\n\nThe AWS architecture note measures total work and completion time for no jitter, full jitter and equal jitter with 100 clients; full jitter finishes in roughly half the calls.", ["fetch aws.amazon.com/builders-library"]),
  researcher(3, "working", "Which retry budgets do the three projects set?", "Reading the retry code in three projects, looking for the place each one gives up. `billing` stops after a deadline, `api-gateway` after a count, `ingest` never", ["rg \"max_attempts|deadline\" -n", "sed -n 1,80p ingest/client.py"]),
  researcher(4, "working", "Are idempotency keys sent on retried writes?", "Checking each client for an `Idempotency-Key` header on POST and PATCH.", ["rg \"Idempotency\" -n"]),
];

const CRITICS: readonly AgentSpec[] = [
  critic(1, "done", "Review the findings for evidence.", "Evidence: Report 1 holds, every claim names a file.\n\nReport 2: the claim about jitter has no source for the 100 client figure; it is quoted from memory.", ["cat research/report-2.md"]),
  critic(2, "working", "Review the findings for risks.", "Risks: the `ingest` retry loop has no cap, so a down dependency pins a worker forever. Checking whether the others share its failure mode", ["rg \"while True\" ingest"]),
  critic(3, "working", "Review the findings for alternatives.", "Alternatives: nobody looked at a shared retry library, or at circuit breakers in place of retries", []),
];

const FINALIZER: AgentSpec = {
  id: "t-fin", role: "finalizer", question: "Write the final report from the validated reports.", state: "done",
  said: "# Retry strategies\n\nUse exponential backoff with full jitter and a deadline, not a count.\n\n1. `billing` already does this; copy its client.\n2. Put a cap on `ingest`: it retries forever today.\n3. Send an `Idempotency-Key` on retried writes.\n\nSources are in the reports; the jitter figure is from the AWS Builders' Library note.",
  tools: [],
};

const STARTED = 4 * MINUTE + 12_000;

function specsFor(stage: RunStage): readonly AgentSpec[] {
  if (stage === "researching") return RESEARCHERS;
  const researchers = RESEARCHERS.map((spec) => ({ ...spec, state: "done" as const }));
  if (stage === "reviewing") return [...researchers, ...CRITICS];
  return [...researchers, ...CRITICS.map((spec) => ({ ...spec, state: "done" as const })), FINALIZER];
}

function leadRun(stage: RunStage): { run: StoredResearchRun; threads: ThreadEnvelope[]; specs: readonly AgentSpec[] } {
  const specs = specsFor(stage);
  const finished = stage === "finished";
  const roles = specs.map((spec) => ({ threadId: spec.id, role: spec.role, question: spec.question }));
  const startedAt = ago(STARTED);
  const run: StoredResearchRun = {
    leadThreadId: IDS.lead,
    size: { researchers: 5, critics: 3 },
    models: { researcher: { provider: "claudeAgent", model: "claude-opus-5", thinkingEffort: "medium" }, critic: { provider: "claudeAgent", model: "claude-opus-5", thinkingEffort: "medium" }, finalizer: { provider: "claudeAgent", model: "claude-opus-5", thinkingEffort: "medium" } },
    messages: [],
    roles,
    state: finished ? "completed" : "running",
    createdAt: startedAt,
    updatedAt: ago(finished ? 30_000 : 5_000),
  };
  const threads = [
    envelope(IDS.lead, "Retry strategies", {
      parentThreadId: IDS.orchestrator, createdAt: startedAt,
      latestTurn: turnOf(IDS.lead, finished ? "completed" : "running", STARTED, finished ? 30_000 : null),
      session: sessionOf(IDS.lead, !finished),
    }),
    ...specs.map((spec, at) => roleThread(spec, IDS.lead, STARTED - (at + 1) * 9_000)),
  ];
  return { run, threads, specs };
}

/** A user's own thread that leads a small run: no delegation behind it, Research mode on. */
function ownRun(): { run: StoredResearchRun; threads: ThreadEnvelope[]; specs: readonly AgentSpec[] } {
  const specs: AgentSpec[] = [
    { id: "t-own-res-1", role: "researcher", question: "Which libraries verify webhook signatures?", state: "done", said: "Three libraries do it: `stripe`, `svix` and a hand-rolled HMAC check.", tools: ["rg \"hmac\" -n"] },
    { id: "t-own-res-2", role: "researcher", question: "How do they treat replayed deliveries?", state: "working", said: "Looking at the timestamp tolerance each one enforces", tools: [] },
  ];
  const run: StoredResearchRun = {
    leadThreadId: IDS.own, size: { researchers: 2, critics: 1 }, messages: [],
    roles: specs.map((spec) => ({ threadId: spec.id, role: spec.role, question: spec.question })),
    state: "running", createdAt: ago(2 * MINUTE + 5_000), updatedAt: ago(4_000), startedAfterTurnId: null,
  };
  const threads = [
    envelope(IDS.own, "Webhook signature options", { latestTurn: turnOf(IDS.own, "running", 2 * MINUTE, null), session: sessionOf(IDS.own, true) }),
    ...specs.map((spec, at) => roleThread(spec, IDS.own, 2 * MINUTE - (at + 1) * 9_000)),
  ];
  return { run, threads, specs };
}

const PLAIN: ThreadEnvelope[] = [
  envelope(IDS.orchestrator, "API hardening plan", { interactionMode: "orchestrate", latestUserMessageAt: ago(6 * MINUTE), latestTurn: turnOf(IDS.orchestrator, "running", 6 * MINUTE, null), session: sessionOf(IDS.orchestrator, true) }),
  envelope(IDS.draft, "Compare webhook libraries", { latestUserMessageAt: ago(20 * MINUTE), latestTurn: turnOf(IDS.draft, "completed", 21 * MINUTE, 20 * MINUTE), session: sessionOf(IDS.draft, false) }),
  envelope(IDS.plain, "Fix the flaky upload test", { interactionMode: "default", latestUserMessageAt: ago(40 * MINUTE), latestTurn: turnOf(IDS.plain, "completed", 41 * MINUTE, 40 * MINUTE), session: sessionOf(IDS.plain, false) }),
];

function transcript(spec: AgentSpec): MessageEnvelope[] {
  const turnId = `turn-${spec.id}`;
  return [
    { id: `${spec.id}-u`, role: "user", text: spec.question, turnId, streaming: false, createdAt: ago(STARTED - 20_000), updatedAt: ago(STARTED - 20_000) },
    { id: `${spec.id}-a`, role: "assistant", text: spec.said, turnId, streaming: spec.state === "working", createdAt: ago(60_000), updatedAt: ago(5_000) },
  ];
}

function toolRows(spec: AgentSpec): ActivityEnvelope[] {
  return spec.tools.map((command, at) => ({
    id: `${spec.id}-tool-${at}`, tone: "tool", kind: "tool.completed", summary: command, turnId: `turn-${spec.id}`, createdAt: ago(STARTED - 60_000 - at * 20_000),
    payload: {
      itemType: "command_execution", toolCallId: `${spec.id}-call-${at}`, status: "completed", title: command, detail: "ok\n",
      data: { tool: "bash", state: { status: "completed", input: { command, workdir: "/repo" }, output: "ok\n", metadata: { exit: 0 }, time: { start: 1000, end: 4000 } } },
    },
  }));
}

export interface ResearchFixtureClient {
  readonly client: ClientApi;
  /** Moves the delegated run to a stage and pushes the new shell to every subscriber. */
  setStage(stage: RunStage): void;
  /** Every `research.proposal.answer`, `thread.turn.start` and mode change the screen sent. */
  readonly dispatched: Array<Record<string, unknown>>;
  /** A run size waiting for an answer on the draft thread, the way the server holds it. */
  propose(): void;
  /** The proposal waiting for an answer, if any. */
  pending(): ResearchProposal | null;
  /** The opt-ins this client has made (`subscribeShell`'s `researchProposals`). */
  readonly optedIn: Set<string>;
}

export function researchClient(initial: RunStage = "researching"): ResearchFixtureClient {
  now = Date.now();
  let stage = initial;
  let pending: ResearchProposal | null = null;
  const dispatched: Array<Record<string, unknown>> = [];
  const optedIn = new Set<string>();
  const listeners = new Set<(item: ShellFrame) => void>();
  const threadListeners = new Map<string, Set<(item: ThreadFrame) => void>>();

  const world = () => {
    const delegated = leadRun(stage);
    const own = ownRun();
    return {
      specs: [...delegated.specs, ...own.specs],
      threads: [...PLAIN, ...delegated.threads, ...own.threads],
      runs: [delegated.run, own.run],
    };
  };
  const snapshot = (): ShellFrame => {
    const { threads, runs } = world();
    return {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: [{ id: PROJECT, title: "moxen", workspaceRoot: "/repo", defaultModelSelection: null }],
        threads, researchRuns: runs, ...(pending ? { researchProposals: [pending] } : {}),
      },
    } as unknown as ShellFrame;
  };

  const client: ClientApi = {
    ...baseClient,
    subscribeShell(options, onItem) {
      for (const id of options.researchProposals ?? []) optedIn.add(id);
      onItem(snapshot());
      onItem({ kind: "synchronized" } as ShellFrame);
      listeners.add(onItem);
      return () => {
        listeners.delete(onItem);
        for (const id of options.researchProposals ?? []) optedIn.delete(id);
      };
    },
    subscribeThread(threadId, options, onItem, onError) {
      if (!world().specs.some((candidate) => candidate.id === threadId)) return baseClient.subscribeThread(threadId, options, onItem, onError);
      const frames = (): ThreadFrame => {
        const spec = world().specs.find((candidate) => candidate.id === threadId)!;
        const thread = world().threads.find((candidate) => candidate.id === threadId)!;
        return { kind: "snapshot", snapshot: { snapshotSequence: 1, thread: { ...thread, messages: transcript(spec), activities: toolRows(spec), checkpoints: [], proposedPlans: [] } } } as unknown as ThreadFrame;
      };
      onItem(frames());
      onItem({ kind: "synchronized" } as ThreadFrame);
      const set = threadListeners.get(threadId) ?? new Set();
      const push = (frame: ThreadFrame) => onItem(frame);
      set.add(push);
      threadListeners.set(threadId, set);
      (push as unknown as { frames: () => ThreadFrame }).frames = frames;
      return () => set.delete(push);
    },
    dispatch: (async (command: Record<string, unknown>) => {
      dispatched.push(command);
      if (command.type === "research.proposal.answer") pending = null;
      return { accepted: true };
    }) as unknown as ClientApi["dispatch"],
    query: (async (query: Record<string, unknown>) => {
      if (query.type === "research.proposals") return pending && pending.threadId === query.threadId && optedIn.has(pending.threadId) ? [pending] : [];
      return await (baseClient.query as (q: unknown) => Promise<unknown>)(query);
    }) as unknown as ClientApi["query"],
  };

  return {
    client,
    dispatched,
    optedIn,
    pending: () => pending,
    setStage(next) {
      stage = next;
      for (const listener of listeners) listener(snapshot());
      for (const set of threadListeners.values()) {
        for (const push of set) push((push as unknown as { frames: () => ThreadFrame }).frames());
      }
    },
    propose() {
      pending = {
        id: "proposal-1", threadId: IDS.draft, task: "Compare webhook signature libraries and how they treat replays", target: "user-thread",
        plan: {
          size: { researchers: 5, critics: 3 },
          models: {
            researcher: { provider: "claudeAgent", model: "claude-opus-5", thinkingEffort: "medium" },
            critic: { provider: "claudeAgent", model: "claude-opus-5", thinkingEffort: "high" },
            finalizer: { provider: "claudeAgent", model: "claude-opus-5", thinkingEffort: "medium" },
          },
        },
        leadModel: OPUS, expiresAt: null,
      };
      for (const listener of listeners) listener(snapshot());
    },
  };
}

/** The delegated run at a stage, projected the way the view reads it, for the gallery. */
export function fixtureSummary(stage: RunStage): RunSummary {
  now = Date.now();
  const { run, threads } = leadRun(stage);
  return summarizeRun(run, threads);
}

/** A proposal as the server holds it, for the gallery's picker. */
export function fixtureProposal(): ResearchProposal {
  const holder = researchClient();
  holder.propose();
  return holder.pending()!;
}
