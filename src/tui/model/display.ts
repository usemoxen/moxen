import { type MessageKey, t } from "../i18n/index.js";
import type { ProviderSummary } from "../../core/catalog/summary.js";
import type { EffortDescriptor, ModelSummary } from "../../core/catalog/summary.js";
import type { ModelSelection, ThreadEnvelope } from "../../core/types.js";

/**
 * btop-style viewport floor enforced by `MinSizeGate`. Below either
 * dimension the app shows a resize notice instead of a broken layout.
 */
export const MIN_TERMINAL_WIDTH = 180;
export const MIN_TERMINAL_HEIGHT = 47;

/**
 * Viewport check for `MinSizeGate`. Pure so it stays unit testable; the
 * live dimensions come from `useTerminalDimensions`, which follows pty
 * resizes (local, tmux, and SSH alike — all arrive as SIGWINCH on stdout,
 * no local-only APIs involved).
 */
export function isTerminalTooSmall(width: number, height: number): boolean {
  return width < MIN_TERMINAL_WIDTH || height < MIN_TERMINAL_HEIGHT;
}

/**
 * The `model` field on a thread's `modelSelection` is a provider-side slug
 * (`opencode/muse-spark-1.3-contributor-free`). The human-readable name lives
 * in the provider catalog (`server.getConfig`), so the composer footer and
 * timeline resolve it there and only fall back to prettifying the slug when
 * the catalog has not loaded yet.
 */
export function prettifyModelSlug(slug: string): string {
  const tail = slug.split("/").pop() ?? slug;
  const words = tail.split(/[-_]+/g).filter((word) => word.length > 0);
  if (words.length === 0) return slug;
  return words
    .map((word) =>
      /^[vV]?\d/.test(word) || /^x\d/i.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

export function displayModelName(
  providers: readonly ProviderSummary[] | null,
  selection: ModelSelection | undefined,
): string {
  if (selection === undefined) return "-";
  const model = providers
    ?.find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  if (model !== undefined) return model.name;
  return prettifyModelSlug(selection.model);
}

/**
 * The model a turn ran on. `thread.modelSelection` is only the *current*
 * choice — labelling every turn with it is what relabelled a whole
 * conversation after a mid-thread model switch. Turns recorded before the
 * server stored a per-turn model (and a live turn whose snapshot has not
 * landed yet) fall back to the thread's selection, which for the live
 * turn is exactly what it was sent with.
 */
export function turnModelSelection(
  thread: {
    readonly modelSelection?: ModelSelection | undefined;
    readonly turnModelSelections?: ThreadEnvelope["turnModelSelections"] | undefined;
  } | null,
  turnId: string | null,
): ModelSelection | undefined {
  if (thread === null) return undefined;
  return (turnId === null ? undefined : thread.turnModelSelections?.[turnId]) ?? thread.modelSelection;
}

/**
 * Whether a descriptor id is an effort knob (as opposed to display-only
 * selects like a context window). Defaults attach and resolve only on
 * these; anything else stays unset until explicitly picked.
 */
export function isEffortDescriptor(id: string): boolean {
  return /effort|reasoning|thinking/i.test(id);
}

/**
 * One line on what a reasoning level means, for the line under a slider. The
 * providers name their levels but do not describe them, so these say it in
 * general terms; a level they do not name has no line of its own.
 */
const EFFORT_HINTS: Readonly<Record<string, MessageKey>> = {
  minimal: "effort.minimal",
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
  xhigh: "effort.xhigh",
  max: "effort.max",
};

/** The line under a reasoning level: what it means, and that it is the model's default when it is. */
/** The level that applies when none is chosen: the model's own default, else medium, else high, else the first listed. */
export function defaultEffortId(choices: readonly { readonly id: string; readonly isDefault?: boolean | null | undefined }[]): string | undefined {
  return (choices.find((choice) => choice.isDefault === true) ?? choices.find((choice) => choice.id === "medium") ?? choices.find((choice) => choice.id === "high") ?? choices[0])?.id;
}

export function describeEffort(id: string, isDefault: boolean): string | undefined {
  const key = EFFORT_HINTS[id.toLowerCase()];
  if (key === undefined) return isDefault ? t("effort.defaultOnly") : undefined;
  return isDefault ? t("effort.defaultHint", { hint: t(key) }) : t(key);
}

/**
 * What a model's row in a picker says beside its name: a "default" tag when it
 * is the provider's default, and the range of reasoning levels it takes
 * ("low–max"; one level alone, nothing for a model with none).
 */
export function modelRowDetail(model: Pick<ModelSummary, "isDefault" | "efforts">, isDefault: boolean = model.isDefault === true): { badge?: string; meta?: string } {
  const levels = model.efforts.filter((descriptor) => isEffortDescriptor(descriptor.id)).flatMap((descriptor) => descriptor.choices.map((choice) => choice.label));
  const meta = levels.length === 0 ? undefined : levels.length === 1 ? levels[0] : `${levels[0]}–${levels[levels.length - 1]}`;
  return { ...(isDefault ? { badge: t("picker.defaultBadge") } : {}), ...(meta === undefined ? {} : { meta }) };
}

/**
 * Enforced default for one effort descriptor: `medium` when offered,
 * else the middle choice (median-ish for ordered low→high lists), else
 * null. The footer and the pick flow resolve through this so the knob
 * never reads blank and sends carry a real value.
 */
export function defaultEffortChoice(descriptor: EffortDescriptor): string | null {
  if (descriptor.choices.some((choice) => choice.id === "medium")) return "medium";
  const middle = descriptor.choices[Math.floor((descriptor.choices.length - 1) / 2)];
  return middle?.id ?? null;
}

/**
 * The effort knob (e.g. `xhigh`) rides on `modelSelection.options`. Resolve
 * its display label through the model's select-type effort descriptors:
 * explicit choice first, then the catalog default (`currentValue`, then
 * the `isDefault` flag — some drivers never populate `currentValue`),
 * then the enforced default above. Switching models (or drafting a new
 * thread) often drops the previous option because its id doesn't exist on
 * the new model; the enforced default keeps the knob populated instead of
 * going blank. Boolean flags are never effort.
 */
export function displayEffort(
  providers: readonly ProviderSummary[] | null,
  selection: ModelSelection | undefined,
): string | null {
  if (selection === undefined) return null;
  const strings = (selection.options ?? []).filter(
    (option): option is { id: string; value: string } => typeof option.value === "string",
  );

  const model = providers
    ?.find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  if (model !== undefined) {
    for (const effort of model.efforts) {
      const explicit = strings.find((option) => option.id === effort.id)?.value;
      if (explicit !== undefined) {
        const choice = effort.choices.find((candidate) => candidate.id === explicit);
        return choice?.label ?? explicit;
      }
      const fallback = effort.currentValue ??
        effort.choices.find((choice) => choice.isDefault === true)?.id ??
        (isEffortDescriptor(effort.id) ? defaultEffortChoice(effort) : null);
      if (fallback === null) continue;
      const choice = effort.choices.find((candidate) => candidate.id === fallback);
      return choice?.label ?? fallback;
    }
    return null;
  }

  if (strings.length === 0) return null;
  const preferred = strings.find((option) => /effort|reasoning|thinking/i.test(option.id)) ?? strings[0];
  return preferred === undefined ? null : preferred.value;
}
