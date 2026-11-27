/**
 * A delegated review's durable outcome.
 *
 * The parent reads what the task's newest report said: its trailing verdict,
 * the report, and the model that produced it. That decision is written when
 * the turn settles — on the terminal turn and on the delegation row — so a
 * continuation copies it instead of replaying an earlier transcript, and a
 * status poll is never what makes a verdict stick.
 *
 * A continued review also gets an explicit hand-off acknowledgement: the
 * model either does the work and ends with a verdict, or answers the exact
 * `MOXEN_REVIEW_HANDOFF_ACK` token. The token is the only reply that leaves
 * the carried outcome alone, so no language or phrasing can hide a report
 * inside an acknowledgement.
 */
import type { ThreadStore } from "./store.js";
import { isMaintenanceTurn } from "./maintenance.js";
import { reviewVerdictOf } from "./notify.js";
import type {
  StoredActivity,
  StoredDelegation,
  StoredMessage,
  StoredReviewDecision,
  StoredThread,
  StoredTurn,
} from "./types.js";

export const REVIEW_HANDOFF_ACK = "MOXEN_REVIEW_HANDOFF_ACK";

/**
 * The instruction a continued review's opening prompt carries, after the
 * hand-off document and any opening work request. The token is written bare:
 * the matcher accepts exactly that line, so quotes or backticks around it
 * would make a correct acknowledgement read as a report.
 */
export const REVIEW_HANDOFF_INSTRUCTION =
  `If you only acknowledge this hand-off and do no review work or tool calls, reply with exactly the single line ${REVIEW_HANDOFF_ACK}, with no quotes, backticks or formatting, and nothing else. ` +
  "Otherwise do the requested work and end your report with `VERDICT: MERGE` or `VERDICT: FIX FIRST`.";

/** A settle-time review outcome with the thread and turn that settled it. */
export interface ReviewOutcome extends StoredReviewDecision {
  readonly threadId: string;
  readonly turnId: string;
}

export interface ReviewTaskFacts {
  /** Whether the delegation is a review at all: the parent reads review facts only then. */
  readonly reviewTask: boolean;
  /**
   * The row records outcomes durably (a modern row), so a missing outcome is
   * authoritative and the transcript must not be parsed again.
   */
  readonly durable: boolean;
  /** The newest settled outcome, or null while no report has settled. */
  readonly outcome: ReviewOutcome | null;
}

/** `instance/model` of the selection a turn ran on; null when it recorded none. */
export function modelOfTurn(turn: StoredTurn | null | undefined): string | null {
  return turn?.modelSelection ? `${turn.modelSelection.instanceId}/${turn.modelSelection.model}` : null;
}

/** Each turn's final assistant message: the last non-empty one, not a mid-turn progress note. */
export function finalTexts(messages: readonly StoredMessage[]): Map<string, string> {
  const finals = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.text.trim().length > 0) finals.set(message.turnId, message.text);
  }
  return finals;
}

/** Whether a reply is the exact hand-off acknowledgement: nothing else, no fence, no translation. */
export function isHandoffAck(finalText: string | null): boolean {
  return (finalText ?? "").trim() === REVIEW_HANDOFF_ACK;
}

/**
 * What a settling turn decides for its review task; null when it changes
 * nothing.
 *
 * - A source-side hand-off preparation turn, a hand-off summary turn, Moxen's
 *   own compaction and a message taken back before it ran are not review
 *   attempts.
 * - The opening hand-off turn that completed with the exact token, no tool
 *   work and nothing else acknowledged the hand-off, so the carried outcome
 *   stands.
 * - A trailing verdict always replaces the carried outcome.
 * - A real attempt without one replaces it with a no-verdict outcome, so a
 *   later hand-off carries "no verdict" rather than resurrecting an older
 *   one — except a verdictless follow-up after this thread already pinned its
 *   own verdict, which leaves that verdict in place.
 */
export function reviewDecisionForSettle(input: {
  readonly turn: StoredTurn;
  readonly turns: readonly StoredTurn[];
  readonly finals: ReadonlyMap<string, string>;
  /** Tool-call activity recorded for this turn. */
  readonly toolWork: boolean;
}): StoredReviewDecision | null {
  const { turn } = input;
  if (turn.status === "queued") return null;
  if (turn.handoff !== undefined || turn.queue?.summaryFor !== undefined || turn.maintenance === true) return null;
  // Only a completed turn has a completion text; a failed or interrupted one
  // reports nothing, and is still a real attempt.
  const finalText = turn.status === "completed" ? input.finals.get(turn.id) ?? null : null;
  if (turn.status === "completed" && turn.reviewHandoff === true && !input.toolWork && isHandoffAck(finalText)) return null;
  const model = modelOfTurn(turn);
  const verdict = reviewVerdictOf(finalText);
  if (verdict !== null && finalText !== null) return { verdict, report: finalText, model };
  const pinnedHere = input.turns.some(
    (other) => other.id !== turn.id && other.status === "completed" && reviewVerdictOf(input.finals.get(other.id) ?? null) !== null,
  );
  return pinnedHere ? null : { verdict: null, report: finalText, model };
}

/**
 * The live delegation row whose thread is a review task (or continues one).
 * Null for an ordinary task, or a thread nobody delegated.
 */
export async function liveReviewRow(store: ThreadStore, thread: StoredThread): Promise<StoredDelegation | null> {
  const rows = await store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === thread.id && candidate.continuedIn === undefined);
  if (row === undefined) return null;
  if (row.reviewTask !== true && row.review === undefined && thread.interactionMode !== "review") return null;
  return row;
}

/**
 * The decision a settling turn makes for the thread's live delegation, with
 * the row to bring up to date; null when the thread is not a review task or
 * the turn changes nothing. Called before the terminal turn update so the
 * decision is recorded with it.
 */
export async function settleReviewDecision(input: {
  readonly store: ThreadStore;
  readonly thread: StoredThread;
  readonly turn: StoredTurn;
  readonly turns: readonly StoredTurn[];
  readonly status: StoredTurn["status"];
  /** The turn actually ran; a queued message taken back before it started did not. */
  readonly attempted: boolean;
}): Promise<{ readonly rowId: string; readonly decision: StoredReviewDecision } | null> {
  if (!input.attempted) return null;
  const row = await liveReviewRow(input.store, input.thread);
  if (row === null) return null;
  const messages = await input.store.readMessages(input.thread.id).catch(() => [] as StoredMessage[]);
  // A compaction written before the turn marker existed is known by its prompt.
  if (isMaintenanceTurn(input.turn, messages)) return null;
  const finals = finalTexts(messages);
  const terminal: StoredTurn = { ...input.turn, status: input.status };
  const marker = input.status === "completed" && input.turn.reviewHandoff === true && isHandoffAck(finals.get(input.turn.id) ?? null);
  const activities = marker ? await input.store.readActivities(input.thread.id).catch(() => [] as StoredActivity[]) : [];
  const decision = reviewDecisionForSettle({
    turn: terminal,
    turns: input.turns,
    finals,
    toolWork: marker && turnDidToolWork(activities, input.turn.id),
  });
  return decision === null ? null : { rowId: row.id, decision };
}

/**
 * Bring the delegation row up to the terminal turns, after the thread lock a
 * decision was written under is released. It copies the newest decision the
 * turn ledger holds, read under the ledger lock, so two settles committing out
 * of order both write the newer one.
 */
export async function commitReviewDecision(store: ThreadStore, rowId: string, threadId: string): Promise<void> {
  await store.updateDelegationWith(rowId, async () => {
    const outcome = outcomeFromTurns(await store.readTurns(threadId), threadId);
    return outcome === null ? null : { review: storedOutcome(outcome), reviewTask: true };
  });
}

/** The newest outcome recorded on a thread's own turns, newest ledger row first. */
export function outcomeFromTurns(turns: readonly StoredTurn[], threadId: string): ReviewOutcome | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.reviewDecision === undefined) continue;
    return { ...turn.reviewDecision, threadId, turnId: turn.id };
  }
  return null;
}

/** The outcome a delegation row carries, when it names the turn that produced it. */
export function outcomeFromRow(row: StoredDelegation): ReviewOutcome | null {
  const review = row.review;
  if (review === undefined || review.threadId === undefined || review.turnId === undefined) return null;
  return { verdict: review.verdict, report: review.report, model: review.model ?? null, threadId: review.threadId, turnId: review.turnId };
}

/** The stored shape of an outcome. */
export function storedOutcome(outcome: ReviewOutcome): NonNullable<StoredDelegation["review"]> {
  return { verdict: outcome.verdict, report: outcome.report, model: outcome.model, threadId: outcome.threadId, turnId: outcome.turnId };
}

/**
 * The legacy chain a row belongs to, oldest first, following the
 * `continuedIn` links hand-offs write. Used only to seed a row that predates
 * durable outcomes.
 */
function legacyChain(rows: readonly StoredDelegation[], row: StoredDelegation): StoredDelegation[] {
  const chain = [row];
  const seen = new Set([row.id]);
  for (;;) {
    const predecessor = rows.find((candidate) => candidate.continuedIn === chain[chain.length - 1]!.childThreadId);
    if (predecessor === undefined || seen.has(predecessor.id)) break;
    seen.add(predecessor.id);
    chain.push(predecessor);
  }
  return chain.reverse();
}

/**
 * Seed a row written before outcomes were durable: replay only its legacy
 * chain, oldest first, and take the newest settled report. An old pin never
 * beats a newer local verdict; it stands only when no turn in the chain
 * settled one, and its provenance is its own recorded model, then the
 * snapshot on the row that held it, otherwise unknown — never the model of a
 * later continuation. Unmarked replies are treated as non-acknowledgements:
 * a legacy row cannot prove otherwise.
 */
export async function legacyReviewFacts(
  store: ThreadStore,
  row: StoredDelegation,
  rows: readonly StoredDelegation[],
): Promise<ReviewTaskFacts> {
  const chain = legacyChain(rows, row);
  const pinRow = chain.find((entry) => entry.review !== undefined);
  const pin = pinRow?.review;
  let outcome: ReviewOutcome | null = null;
  for (const entry of chain) {
    const [turns, messages] = await Promise.all([
      store.readTurns(entry.childThreadId).catch(() => [] as StoredTurn[]),
      store.readMessages(entry.childThreadId).catch(() => [] as StoredMessage[]),
    ]);
    const finals = finalTexts(messages);
    let settled: StoredTurn | null = null;
    let verdictTurn: StoredTurn | null = null;
    for (const turn of turns) {
      if (turn.status !== "completed" || isMaintenanceTurn(turn, messages)) continue;
      settled = turn;
      if (reviewVerdictOf(finals.get(turn.id) ?? null) !== null) verdictTurn = turn;
    }
    if (verdictTurn !== null) {
      const report = finals.get(verdictTurn.id)!;
      // An old pin's provenance is its own row, never a later continuation's
      // model: its recorded model, then that row's delegation snapshot, then
      // unknown. A newer turn-derived verdict uses the model it recorded.
      const heldPin = pinRow?.id === entry.id && pin?.report === report ? pin : undefined;
      outcome = {
        verdict: reviewVerdictOf(report)!,
        report,
        model: heldPin !== undefined
          ? heldPin.model ?? pinRow?.modelSnapshot?.child ?? null
          : modelOfTurn(verdictTurn),
        threadId: entry.childThreadId,
        turnId: verdictTurn.id,
      };
    } else if (settled !== null) {
      outcome = {
        verdict: null,
        report: finals.get(settled.id) ?? null,
        model: modelOfTurn(settled),
        threadId: entry.childThreadId,
        turnId: settled.id,
      };
    }
  }
  if (outcome === null && pin !== undefined) {
    // No turn settled a verdict: the pin stands, located by its exact report
    // where a turn still carries it. Its author is the pin's own row, never a
    // later continuation's model.
    let located: { threadId: string; turnId: string } | null = null;
    if (pin.report !== null) {
      for (const entry of [...chain].reverse()) {
        const [turns, messages] = await Promise.all([
          store.readTurns(entry.childThreadId).catch(() => [] as StoredTurn[]),
          store.readMessages(entry.childThreadId).catch(() => [] as StoredMessage[]),
        ]);
        const finals = finalTexts(messages);
        const match = turns.find((turn) => turn.status === "completed" && finals.get(turn.id) === pin.report);
        if (match) {
          located = { threadId: entry.childThreadId, turnId: match.id };
          break;
        }
      }
    }
    outcome = {
      verdict: pin.verdict,
      report: pin.report,
      model: pin.model ?? pinRow?.modelSnapshot?.child ?? null,
      threadId: located?.threadId ?? pinRow!.childThreadId,
      turnId: located?.turnId ?? "",
    };
  }
  return { reviewTask: true, durable: false, outcome };
}

/**
 * A task's review facts for `task_status` and the notification: the live
 * row's durable outcome, or a newer decision the live thread's turns already
 * carry (a crash between the turn and the row). A modern row never reads an
 * earlier transcript; only a row written before outcomes were durable is
 * seeded from its legacy chain.
 */
export async function reviewFactsFor(
  input: {
    readonly store: ThreadStore;
    readonly row: StoredDelegation | null;
    readonly rows: readonly StoredDelegation[];
    readonly childTurns: readonly StoredTurn[];
    readonly childThreadId: string;
    readonly interactionMode: string | undefined;
  },
): Promise<ReviewTaskFacts> {
  const { row } = input;
  const reviewTask = row?.reviewTask === true || row?.review !== undefined || input.interactionMode === "review";
  if (!reviewTask || row === null) return { reviewTask, durable: false, outcome: null };
  const local = outcomeFromTurns(input.childTurns, input.childThreadId);
  if (local !== null) return { reviewTask: true, durable: row.reviewTask === true, outcome: local };
  const carried = outcomeFromRow(row);
  if (carried !== null) return { reviewTask: true, durable: true, outcome: carried };
  if (row.reviewTask === true) return { reviewTask: true, durable: true, outcome: null };
  return await legacyReviewFacts(input.store, row, input.rows);
}

/** Tool-call activity recorded for one turn. */
export function turnDidToolWork(activities: readonly StoredActivity[], turnId: string): boolean {
  return activities.some((activity) => activity.turnId === turnId && activity.kind.startsWith("tool-call."));
}
