import { act } from "react";

import type { RollbackResult, UpdateCheck, UpdateProgress, UpdateResult } from "../../../core/selfupdate/vocabulary.js";
import { UpdateModal } from "../../features/update/updatemodal.js";
import type { UpdateView } from "../../model/update.js";
import { Stage, type GalleryEntry } from "./registry.js";

const noop = (): void => {};

const NOTES = [
  "## Moxen 0.2.0",
  "",
  "An in-app updater, a quieter sidebar and a round of fixes.",
  "",
  "### Added",
  "",
  "- **Update Moxen** in the command palette: shows the new version, its notes and the download's progress.",
  "- `moxen self-update --rollback` goes back to the previous version.",
  "",
  "### Fixed",
  "",
  "- A thread that was settled while a turn ran no longer reopens by itself.",
  "- The stats card keeps its colours on a light terminal.",
].join("\n");

const LONG_NOTES = [NOTES, ...Array.from({ length: 6 }, (_, index) => `\n### Earlier changes ${index + 1}\n\n- A change that is worth a line of release notes, number ${index + 1}.\n- Another one, ${index + 1}b, long enough that it has to wrap onto a second line when the terminal is narrow.`)].join("\n");

const install = (kind: "release" | "source" = "release") => ({ version: "0.1.4", kind, folder: "/apps/moxen", target: { os: "macos", arch: "arm64" } }) as const;
const latest = (notes = NOTES) => ({ version: "0.2.0", tag: "v0.2.0", url: "https://github.com/moxen/moxen/releases/tag/v0.2.0", notes, archive: null, checksum: null });

const check = (overrides: Partial<UpdateCheck> = {}): UpdateCheck => ({ install: install(), status: "available", reason: null, latest: latest(), updatable: true, ...overrides });
const ready = (overrides: Partial<UpdateCheck> = {}): UpdateView => ({ phase: "ready", check: check(overrides) });
const running = (progress: UpdateProgress | null, op: "apply" | "rollback" = "apply"): UpdateView => ({ phase: "running", op, commandId: "c", progress, check: check() });

const UPDATED: UpdateResult = { action: "updated", version: "0.2.0", from: "0.1.4", previous: "0.1.4", folder: "/apps/moxen/versions/0.2.0", current: "/apps/moxen/current", warnings: [] };
const ROLLED: RollbackResult = { action: "rolled-back", version: "0.1.4", from: "0.2.0", previous: "0.2.0", folder: "/apps/moxen/versions/0.1.4", current: "/apps/moxen/current", warnings: [] };

const modal = (id: string, title: string, view: UpdateView, options: { width?: number; height?: number; server?: string | null; drive?: GalleryEntry["drive"] } = {}): GalleryEntry => {
  const width = options.width ?? 110;
  const height = options.height ?? 40;
  return {
    id: `update-${id}`,
    group: "update",
    title: `UpdateModal, ${title}`,
    width,
    height,
    settleMs: 400,
    element: () => (
      <Stage width={width} height={height}>
        <UpdateModal view={view} serverName={options.server ?? null} screenWidth={width} screenHeight={height} onInstall={noop} onRollback={noop} onCheck={noop} onClose={noop} />
      </Stage>
    ),
    ...(options.drive === undefined ? {} : { drive: options.drive }),
  };
};

/** The update screen in each state it can be in. The same views are what `model/update.ts` produces. */
export const UPDATE_GALLERY: readonly GalleryEntry[] = [
  modal("checking", "checking", { phase: "checking" }),
  modal("up-to-date", "up to date", ready({ status: "up-to-date", latest: { ...latest(), version: "0.1.4" }, updatable: false })),
  modal("available", "update available with release notes", ready()),
  modal("long-notes", "long release notes, scrolled", ready({ latest: latest(LONG_NOTES) }), {
    drive: async (setup) => {
      await act(async () => setup.mockInput.pressKey("\x1b[6~"));
      await setup.flush();
    },
  }),
  modal("downloading", "downloading", running({ stage: "downloading", version: "0.2.0", bytes: 38_000_000, total: 91_000_000 })),
  modal("testing", "a later stage", running({ stage: "testing", version: "0.2.0" })),
  modal("rollback-running", "going back", running({ stage: "switching", version: "0.1.4" }, "rollback")),
  modal("finished", "finished, with a warning", { phase: "finished", op: "apply", result: { ...UPDATED, warnings: ["Could not delete the old version 0.1.2: it is in use."] }, check: check() }),
  modal("rolled-back", "rolled back", { phase: "finished", op: "rollback", result: ROLLED, check: check() }),
  modal("failed", "failed", { phase: "failed", op: "apply", code: "SELF_UPDATE_BAD_CHECKSUM", message: "moxen-0.2.0-darwin-arm64.tar.gz.sha256 does not match the download, so it was not installed.", check: check() }),
  modal("busy", "another update running", { phase: "failed", op: "apply", code: "SELF_UPDATE_BUSY", message: "Another moxen self-update is running. Wait for it to finish, then try again.", check: check() }),
  modal("no-previous", "nothing to go back to", { phase: "failed", op: "rollback", code: "SELF_UPDATE_NO_PREVIOUS", message: "There is no previous version to go back to.", check: check({ status: "up-to-date", updatable: false }) }),
  modal("no-release", "no release published", ready({ status: "no-release", latest: null, updatable: false })),
  modal("offline", "could not check", ready({ status: "unavailable", reason: "could not reach api.github.com", latest: null, updatable: false })),
  modal("unreachable", "server did not answer", { phase: "unreachable", message: "The Moxen server is not answering." }),
  modal("source", "source checkout", ready({ install: install("source"), updatable: false })),
  modal("remote", "paired server", ready({ updatable: true }), { server: "studio" }),
  modal("lost", "lost track", { phase: "lost", op: "apply", commandId: "c", check: check() }),
  modal("narrow", "narrow terminal", ready(), { width: 60, height: 26 }),
  modal("small", "an 80 by 24 terminal", ready(), { width: 80, height: 24 }),
  modal("narrow-finished", "narrow terminal, finished", { phase: "finished", op: "apply", result: UPDATED, check: check() }, { width: 60, height: 26 }),
  modal("narrow-running", "narrow terminal, updating", running({ stage: "downloading", version: "0.2.0", bytes: 38_000_000, total: 91_000_000 }), { width: 60, height: 26 }),
];
