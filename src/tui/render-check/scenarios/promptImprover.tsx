import { act, useState } from "react";

import type { ClientApi } from "../../../server/api.js";
import type { CommandResult } from "../../../server/protocol.js";
import { Composer } from "../../features/composer/composer.js";
import { usePromptImprover } from "../../features/composer/usePromptImprover.js";
import { client } from "../fixtures.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** Late model replies must never replace a newer draft, another thread, or another destination. */
export async function runPromptImprover(): Promise<void> {
  let controls!: ReturnType<typeof usePromptImprover>;
  let change!: (text: string) => void;
  let switchThread!: () => void;
  let switchModel!: () => void;
  let draft = "";
  let error = "";
  let calls = 0;
  let resolve!: (value: CommandResult<"prompt.improve">) => void;
  let reject!: (error: Error) => void;
  const api: ClientApi = { ...client, dispatch: async (command) => {
    if (command.type !== "prompt.improve") return client.dispatch(command);
    calls += 1;
    return await new Promise<never>((done, failed) => { resolve = (value) => done(value as never); reject = failed; });
  } };
  function Harness() {
    const [text, setText] = useState("Fix the title.");
    const [reset, setReset] = useState(0);
    const [model, setModel] = useState("gpt-6.1-terra");
    const [message, setMessage] = useState("");
    const restore = (value: string) => { setText(value); setReset((count) => count + 1); };
    switchThread = () => setReset((count) => count + 1);
    switchModel = () => setModel((value) => value === "gpt-6.1-terra" ? "gpt-6.1-sol" : "gpt-6.1-terra");
    draft = text;
    error = message;
    controls = usePromptImprover({ client: api, draft: text, resetKey: String(reset), directory: "/project", modelSelection: { instanceId: "codex", model }, protectedText: [], disabled: false, onInput: setText, restore, setError: setMessage });
    change = controls.onInput;
    return <box style={{ flexDirection: "column" }}>
      <Composer draft={text} resetKey={String(reset)} onInput={controls.onInput} onSubmit={() => {}} onEscape={() => {}} onFocus={() => {}} focused placeholder="Message the agent" model={model} permission="Full access" submitVerb="sends" running={false} width={110} onImproveClick={() => { void controls.improve(); }} onUndoImproveClick={controls.undoImprovement} improving={controls.improving} />
      <text>{message}</text>
    </box>;
  }
  const setup = await testRender(<Harness />, { width: 112, height: 15, exitOnCtrlC: false });
  const capture = async (label: string) => { await setup.flush(); console.log(`--- prompt improver: ${label} ---`); const frame = setup.captureCharFrame(); console.log(frame); return frame; };
  const result = { text: "Fix the title and verify it is trimmed.", provider: "claude", model: "claude-haiku-5-5" };
  let pending!: Promise<void>;
  try {
    if (!(await capture("ready")).includes("improve")) fail("the improve action is missing");
    await act(async () => { pending = controls.improve(); void controls.improve(); });
    if (calls !== 1) fail("double-click sent two improvement requests");
    if (!(await capture("waiting without blocking typing")).includes("improving")) fail("the pending improvement is not shown");
    await act(async () => { resolve(result); await pending; });
    if (draft !== result.text || !controls.undoImprovement) fail("the improvement was not applied with undo");
    if (!(await capture("editable result with undo")).includes("undo improve")) fail("undo is not visible");
    await act(async () => controls.undoImprovement?.());
    if (String(draft) !== "Fix the title.") fail("undo did not restore the original draft");

    for (const mutate of [() => change("Keep my newer typing."), switchThread, switchModel]) {
      await act(async () => { pending = controls.improve(); });
      await act(async () => mutate());
      const before = draft;
      await act(async () => { resolve(result); await pending; });
      if (draft !== before || !error.includes("changed")) fail("a stale improvement replaced the current draft");
    }
    await act(async () => { pending = controls.improve(); });
    await act(async () => { change("Typing before React commits."); resolve(result); await pending; });
    if (String(draft) !== "Typing before React commits.") fail("a reply beat the parent's input render and overwrote typing");
    await act(async () => { pending = controls.improve(); });
    const before = draft;
    await act(async () => { reject(new Error("Provider unavailable")); await pending; });
    if (draft !== before || !error.includes("Provider unavailable") || controls.improving) fail("a failed improvement did not leave the draft editable");
  } finally {
    setup.renderer.destroy();
  }
}
