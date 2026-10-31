/** Nonblocking questions live in the ledger, not in a parked provider RPC. */
import { CliError } from "../errors.js";
import { driverKindOfInstance } from "../types.js";
import { codexAsyncReply } from "../providers/codex/questions.js";
import { startTurn, type OperationContext } from "./operations.js";
import { inspectThread } from "./threads.js";

/** False delegates to the provider's ordinary blocking request handler. */
export async function respondToAsyncInput(
  ctx: OperationContext, threadId: string, requestId: string,
  answers: Readonly<Record<string, string | readonly string[]>> | null,
): Promise<boolean> {
  const { store } = ctx;
  // A separate operation key lets startTurn take its normal thread lock while
  // two clients answering this question cannot submit it twice.
  return store.withThreadLock(`async-input:${threadId}`, async () => {
    const activities = await store.readActivities(threadId);
    const request = activities.findLast((activity) => activity.kind === "user-input.requested" && activity.payload?.requestId === requestId);
    const payload = request?.payload;
    if (payload?.delivery !== "async" || payload.provider !== "codex" || !Array.isArray(payload.questions)) return false;
    if (activities.some((activity) => activity.kind === "user-input.resolved" && activity.payload?.requestId === requestId)) return true;
    if (answers !== null) {
      const thread = await inspectThread(store, threadId);
      const turn = (await store.readTurns(threadId)).find((turn) => turn.id === request?.turnId);
      const selection = turn?.modelSelection ?? thread.modelSelection;
      if (driverKindOfInstance(selection.instanceId) !== "codex" || (typeof payload.nativeThreadId === "string" && thread.providerSessions?.codex !== payload.nativeThreadId)) {
        throw new CliError("REQUEST_EXPIRED", "This question belongs to a different provider conversation.");
      }
      const reply = codexAsyncReply(payload.questions, answers);
      const started = await startTurn(ctx, {
        threadId, prompt: reply.display, driverPrompt: reply.prompt,
        origin: "question-answer",
        modelSelection: selection, ifBusy: "inject", onEvent: () => undefined,
      });
      const saved = (await store.readTurns(threadId)).find((turn) => turn.id === started.turn.id);
      if (started.steerDelivered === false || saved?.status === "failed") {
        throw new CliError("REQUEST_DELIVERY_FAILED", "The answer could not be delivered. The question is still pending.");
      }
    }
    await store.appendLedger(threadId, "activity", {
      id: store.newId(), threadId, turnId: request?.turnId ?? null,
      kind: "user-input.resolved", summary: answers === null ? "Question dismissed" : "Question answered",
      payload: { requestId, provider: "codex", delivery: "async" }, createdAt: store.nowIso(),
    });
    store.emit(threadId, "activity");
    return true;
  });
}
