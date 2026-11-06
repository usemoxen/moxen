import { act, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "../testrender.js";

import type { ImageAttachmentUpload } from "../../../core/attachments.js";
import type { ClientApi } from "../../../server/api.js";
import { useNoticePager } from "../../app/hooks/useNoticePager.js";
import { compactNoticeKey } from "../../app/utils.js";
import { useComposer } from "../../features/composer/useComposer.js";
import { useDiffPanel } from "../../features/diffpanel/useDiffPanel.js";
import { useFileAttachments } from "../../features/composer/useFileAttachments.js";
import type { useToasts } from "../../hooks/useToasts.js";
import type { PickResult } from "../../model/filepicker.js";
import { emptyThreadState } from "../../model/thread.js";
import type { TimelineEntry, TurnCheckpoint } from "../../model/thread.js";
import type { TurnGroup } from "../../model/turns.js";
import { App, client as baseClient } from "../fixtures.js";
import { fail } from "../helpers.js";

const frame = (setup: TestRendererSetup) => setup.captureCharFrame();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Toasts = ReturnType<typeof useToasts>;
const toastStub = { push: () => undefined, dismiss: () => undefined } as unknown as Toasts;

// ── useDiffPanel on a thread switch ──────────────────────────────────────────

function emptyGroup(id: string, diff: TimelineEntry | null = null): TurnGroup {
  return {
    id, turnId: id, prompts: [], nudges: [], work: [], reply: null, live: null, diff,
    proposedPlan: null, durationMs: 0, tokensPerSecond: null, startedAt: "", waits: [],
    limited: false, usageWrapUp: false,
  };
}

function diffEntry(turnCount: number): TimelineEntry {
  const checkpoint: TurnCheckpoint = { turnId: "turn-1", checkpointTurnCount: turnCount, status: "", files: [] };
  return {
    id: `diff-${turnCount}`, at: "", turnId: "turn-1", kind: "turn-diff", text: "",
    streaming: false, tone: null, activityKind: null, message: null, activity: null,
    checkpoint, editStats: null, proposedPlan: null,
  };
}

type Panel = ReturnType<typeof useDiffPanel>;
type PanelApi = { current: Panel | null; switch?: (id: string) => void };

function DiffHarness({ initial, api, groups, pane }: {
  initial: string;
  api: PanelApi;
  groups: TurnGroup[];
  pane: { scrollTo: (top: number) => void; scrollTop: number; scrollHeight: number; viewport: { height: number } };
}) {
  const [threadId, setThreadId] = useState(initial);
  api.switch = setThreadId;
  const selectedIdRef = useRef<string | null>(null);
  // Mirrors the app: the subscription effect publishes the open thread id.
  useEffect(() => {
    selectedIdRef.current = threadId;
  }, [threadId]);
  const chatScrollRef = useRef(pane);
  const threadState = emptyThreadState();
  const panel = useDiffPanel({
    client: diffClient, width: 140, openThreadId: threadId, selected: null, shellProjects: [],
    threadState, threadStateRef: useRef(threadState), groups, selectedIdRef, chatScrollRef: chatScrollRef as unknown as MutableRefObject<ScrollBoxRenderable | null>,
    setThreadState: () => undefined, setFocus: () => undefined, setError: () => undefined, hideBinary: false,
  });
  api.current = panel;
  return <text>{`expanded:${panel.expandedTurn === null ? "none" : panel.expandedTurn} patch:${panel.patch === null ? "none" : "set"}`}</text>;
}

let resolvePatch!: (patch: string | null) => void;
const diffClient = {
  turnDiff: () => new Promise<string | null>((resolve) => {
    resolvePatch = resolve;
  }),
} as unknown as ClientApi;

async function diffSwitchesDropThePanel(): Promise<void> {
  const api: PanelApi = { current: null };
  const pane = { scrollTo: () => undefined, scrollTop: 0, scrollHeight: 100, viewport: { height: 10 } };
  const setup = await testRender(<DiffHarness initial="t-a" api={api} groups={[]} pane={pane} />, {
    width: 60, height: 3, exitOnCtrlC: false,
  });
  try {
    await setup.flush();
    // The open starts the fetch; the patch stays held.
    await act(async () => {
      api.current?.openDiff(7);
    });
    await setup.flush();
    // The switch lands before the fetch does.
    await act(async () => {
      api.switch?.("t-b");
    });
    await setup.flush();
    let screen = frame(setup);
    if (!screen.includes("expanded:none") || !screen.includes("patch:none")) {
      fail(`the old thread's open diff stayed on screen after the switch:\n${screen}`);
    }
    // The old thread's fetch lands late: it must not patch the new thread.
    await act(async () => {
      resolvePatch("diff --git a/old.txt b/old.txt");
    });
    await setup.flush();
    screen = frame(setup);
    if (!screen.includes("expanded:none") || !screen.includes("patch:none")) {
      fail(`a late patch fetch overwrote the new thread:\n${screen}`);
    }
    console.log("--- thread switch drops the diff panel ---");
    console.log(screen);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
}

async function pendingScrollsDieOnSwitch(): Promise<void> {
  const api: PanelApi = { current: null };
  const scrolls: number[] = [];
  const pane = { scrollTo: (top: number) => { scrolls.push(top); }, scrollTop: 0, scrollHeight: 100, viewport: { height: 10 } };
  const groups = [emptyGroup("g1"), emptyGroup("g2", diffEntry(5)), emptyGroup("g3")];
  const setup = await testRender(<DiffHarness initial="t-a" api={api} groups={groups} pane={pane} />, {
    width: 60, height: 3, exitOnCtrlC: false,
  });
  try {
    await setup.flush();
    // A stuck retry: the first jump lands, the 150ms re-assertions must not
    // follow the thread switch.
    await act(async () => {
      api.current?.scrollTimelineToIndex(2);
    });
    if (scrolls.length !== 1) fail(`the jump did not land once before the switch: ${JSON.stringify(scrolls)}`);
    await act(async () => {
      api.switch?.("t-b");
    });
    await act(async () => sleep(400));
    await setup.flush();
    if (scrolls.length !== 1) fail(`stale scroll retries scrolled the new thread: ${JSON.stringify(scrolls)}`);
    // The deferred pick jump: cancelled whole before it ever fires.
    scrolls.length = 0;
    await act(async () => {
      api.current?.deferScrollToTurn(5);
    });
    await act(async () => {
      api.switch?.("t-c");
    });
    await act(async () => sleep(400));
    await setup.flush();
    if (scrolls.length !== 0) fail(`the deferred pick jump scrolled the new thread: ${JSON.stringify(scrolls)}`);
    console.log("--- thread switch cancels pending scrolls ---");
    console.log(frame(setup));
  } finally {
    await act(async () => setup.renderer.destroy());
  }
}

// ── useFileAttachments resolves the thread at completion ────────────────────

type Attachments = ReturnType<typeof useFileAttachments>;

function AttachHarness({ initial, api, pick }: {
  initial: string;
  api: { current: Attachments | null; switch?: (id: string) => void };
  pick: () => Promise<PickResult>;
}) {
  const [threadId, setThreadId] = useState(initial);
  api.switch = setThreadId;
  const hook = useFileAttachments(threadId, toastStub, true, pick);
  api.current = hook;
  return <text>{`chips:${hook.items.map((item) => item.path).join(",")}`}</text>;
}

async function pickedFilesLandOnTheLiveThread(): Promise<void> {
  let resolvePick!: (result: PickResult) => void;
  const pick = () => new Promise<PickResult>((resolve) => {
    resolvePick = resolve;
  });
  const api: { current: Attachments | null; switch?: (id: string) => void } = { current: null };
  const setup = await testRender(<AttachHarness initial="t-a" api={api} pick={pick} />, {
    width: 60, height: 3, exitOnCtrlC: false,
  });
  try {
    await setup.flush();
    // The dialog opens on thread A and stays open across a switch to B.
    await act(async () => {
      void api.current?.attach();
    });
    await act(async () => {
      api.switch?.("t-b");
    });
    await setup.flush();
    await act(async () => {
      resolvePick({ status: "picked", items: [{ path: "/tmp/x.png", kind: "file" }] });
    });
    await setup.flush();
    const screen = frame(setup);
    if (!screen.includes("chips:/tmp/x.png")) {
      fail(`the picked file did not land on the live thread:\n${screen}`);
    }
    console.log("--- picked files land on the live thread ---");
    console.log(screen);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
}

// ── useComposer pending writes resolve the thread at call time ──────────────

type Composer = ReturnType<typeof useComposer>;

function ComposerHarness({ initial, api }: {
  initial: string;
  api: { current: Composer | null; switch?: (id: string) => void };
}) {
  const [threadId, setThreadId] = useState(initial);
  api.switch = setThreadId;
  const clipboard = { copyText: async () => true, isRemote: () => false };
  const composer = useComposer(threadId, clipboard as never, toastStub, () => undefined, () => undefined);
  api.current = composer;
  return <text>{`pendingKeys:${Object.keys(composer.pendings).join(",")}`}</text>;
}

const upload: ImageAttachmentUpload = {
  type: "image", name: "a.png", mimeType: "image/png", sizeBytes: 10, dataUrl: "data:image/png;base64,a",
};

async function pendingImagesLandOnTheLiveThread(): Promise<void> {
  const api: { current: Composer | null; switch?: (id: string) => void } = { current: null };
  const setup = await testRender(<ComposerHarness initial="t-a" api={api} />, {
    width: 60, height: 3, exitOnCtrlC: false,
  });
  try {
    await setup.flush();
    // A clipboard read started on A resolves after the switch to B. The
    // stale closure must still write where the person is now.
    const stale = api.current?.setPending;
    await act(async () => {
      api.switch?.("t-b");
    });
    await setup.flush();
    await act(async () => {
      stale?.([upload]);
    });
    await setup.flush();
    const screen = frame(setup);
    if (!screen.includes("pendingKeys:t-b")) {
      fail(`the pending image did not land on the live thread:\n${screen}`);
    }
    console.log("--- pending images land on the live thread ---");
    console.log(screen);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
}

// ── the compact notice keeps its pager page across usage ticks ──────────────

function PagerHarness({ api }: { api: { current: { setIndex: (index: number) => void } | null; bump?: () => void } }) {
  const [used, setUsed] = useState(100_000);
  api.bump = () => setUsed(100_001);
  const pager = useNoticePager([compactNoticeKey("t1", used) ?? "none", "other"]);
  api.current = pager;
  return <text>{`page:${pager.index}`}</text>;
}

async function compactNoticeKeepsItsPage(): Promise<void> {
  const api: { current: { setIndex: (index: number) => void } | null; bump?: () => void } = { current: null };
  const setup = await testRender(<PagerHarness api={api} />, { width: 40, height: 3, exitOnCtrlC: false });
  try {
    await setup.flush();
    await act(async () => {
      api.current?.setIndex(1);
    });
    await setup.flush();
    // A usage tick re-renders the notice with a new figure: same key, same page.
    await act(async () => {
      api.bump?.();
    });
    await setup.flush();
    const screen = frame(setup);
    if (!screen.includes("page:1")) fail(`a usage tick reset the notice pager to the first page:\n${screen}`);
    console.log("--- compact notice keeps its pager page ---");
    console.log(screen);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
}

// ── Ctrl+C clears the creating draft with no open thread ─────────────────────

async function creatingCtrlCClearsTheDraft(): Promise<void> {
  const emptyClient: ClientApi = {
    ...baseClient,
    subscribeShell(_options, onItem) {
      onItem({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 1,
          projects: [{ id: "p-cli", title: "moxen", workspaceRoot: "C:\\repo", defaultModelSelection: null }],
          threads: [],
        },
      });
      onItem({ kind: "synchronized" });
      return () => undefined;
    },
    subscribeThread() {
      return () => undefined;
    },
  };
  const setup = await testRender(<App client={emptyClient} onQuit={() => undefined} />, {
    width: 140, height: 26, exitOnCtrlC: false,
  });
  try {
    await setup.flush();
    await act(async () => sleep(400));
    await setup.flush();
    if (!frame(setup).includes("What should we build in")) {
      fail(`empty workspace did not land in the creating view:\n${frame(setup)}`);
    }
    // Focus the composer the same way typing does in the thread view, then draft.
    await act(async () => setup.mockInput.pressKey("i"));
    await setup.flush();
    await act(async () => setup.mockInput.typeText("ctrlcclearme"));
    await setup.flush();
    if (!frame(setup).includes("ctrlcclearme")) fail(`the creating draft did not take typing:\n${frame(setup)}`);
    await act(async () => setup.mockInput.pressKey("c", { ctrl: true }));
    await setup.flush();
    const screen = frame(setup);
    if (screen.includes("ctrlcclearme")) fail(`Ctrl+C left the creating draft behind:\n${screen}`);
    console.log("--- ctrl+c clears the creating draft ---");
    console.log(screen);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
}

/**
 * State that must follow the live thread across a switch, and the small
 * composer bugs beside them: each block fails on the unfixed code.
 */
export async function runThreadAffinity(): Promise<void> {
  await diffSwitchesDropThePanel();
  await pendingScrollsDieOnSwitch();
  await pickedFilesLandOnTheLiveThread();
  await pendingImagesLandOnTheLiveThread();
  await compactNoticeKeepsItsPage();
  await creatingCtrlCClearsTheDraft();
}
