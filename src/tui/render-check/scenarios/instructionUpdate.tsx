import { testRender } from "../testrender.js";

import { toMessageEnvelope } from "../../../core/threads/project.js";
import { Timeline } from "../../features/timeline/timeline.js";
import { emptyThreadState, timeline } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { fail } from "../helpers.js";

/**
 * The structured marker a turn carries once the provider answered the prompt
 * with new runtime instructions: one compact system card, never the
 * instructions' text and never a prompt bubble. A `/compact` turn carries it
 * too — its one-line compaction block does not swallow the card.
 */
export async function runInstructionUpdate(): Promise<void> {
  const createdAt = "2026-09-25T14:00:00.000Z";
  const at = (seconds: number) => new Date(Date.parse(createdAt) + seconds * 1000).toISOString();
  const marker = (id: string, turnId: string, atIso: string) => ({
    id,
    kind: "instructions.updated",
    summary: "Runtime instructions updated",
    tone: "info",
    turnId,
    createdAt: atIso,
    payload: { provider: "claude" },
  });
  const groups = groupTurns(timeline({
    ...emptyThreadState(),
    messages: [
      toMessageEnvelope({ id: "prompt", threadId: "t", turnId: "turn-1", role: "user", text: "Keep going", createdAt }),
      toMessageEnvelope({ id: "reply", threadId: "t", turnId: "turn-1", role: "assistant", text: "Done.", createdAt: at(2) }),
      toMessageEnvelope({ id: "compact", threadId: "t", turnId: "turn-2", role: "user", text: "/compact", createdAt: at(10) }),
    ],
    activities: [
      marker("instructions-updated", "turn-1", at(3)),
      marker("instructions-updated-compact", "turn-2", at(11)),
    ],
  }));
  const noop = () => {};
  const setup = await testRender(<Timeline groups={groups} title="Runtime instructions" subtitle="" modelForTurn={() => ({ name: "Claude Opus 5", color: null })}
    modelLabel={(model) => ({ name: model, color: null })} homeDir={undefined} expandedTurn={null} expandedWork={new Map()} scrollRef={{ current: null }}
    onFocus={noop} onOpenDiff={noop} onToggleWork={noop} onOpenMessageActions={noop} onOpenUrl={noop} focused width={100}
    sessionStatus="idle" now={Date.parse(at(15))} turnStartedAt={null} turnFileDiffs={new Map()} gitFiles={[]} />, { width: 100, height: 36, exitOnCtrlC: false });
  try {
    await setup.flush();
    const frame = setup.captureCharFrame();
    console.log("--- acknowledged instruction update ---");
    console.log(frame);
    const cards = frame.split("Runtime instructions updated").length - 1;
    if (cards !== 2) fail(`expected the card on both turns (a normal one and a /compact one), saw ${cards}`);
    if (!frame.includes("updated runtime instructions")) fail("the instruction update card does not say what changed");
    // The card is the record; the instructions themselves never reach the transcript.
    if (frame.includes("<moxen-instructions-update>")) fail("the instruction text leaked into the transcript");
  } finally {
    setup.renderer.destroy();
  }
}
