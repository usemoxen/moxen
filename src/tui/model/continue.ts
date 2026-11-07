import type { ModelSelection } from "../../core/types.js";
import type { ProviderSummary } from "../../core/catalog/summary.js";
import { defaultEffortChoice, isEffortDescriptor } from "./display.js";

export interface ContinueModelChoice {
  readonly instanceId: string;
  readonly model: string;
}

/**
 * Rebase a model selection onto another model, keeping what still applies:
 * boolean flags always survive, and a string option survives only when the
 * new model offers that value for that descriptor — a stale level from the
 * old model would otherwise ride along unseen. Effort descriptors missing
 * from the kept options land on their enforced default, so sends carry a
 * real value and the footer never reads blank. Non-effort descriptors stay
 * unset.
 *
 * This is the model picker's rule (`buildModelSelection`), shared so the
 * continue modal and the picker cannot disagree.
 */
export function rebaseContinueSelection(
  base: ModelSelection | undefined,
  providers: readonly ProviderSummary[] | null,
  choice: ContinueModelChoice,
): ModelSelection {
  const catalogModel = providers
    ?.find((provider) => provider.instanceId === choice.instanceId)
    ?.models.find((model) => model.slug === choice.model);
  const kept = (base?.options ?? []).filter((option) => {
    if (typeof option.value === "boolean") return true;
    const descriptor = catalogModel?.efforts.find((effort) => effort.id === option.id);
    return descriptor !== undefined && descriptor.choices.some((candidate) => candidate.id === option.value);
  });
  const defaults: ModelSelection["options"] = [];
  for (const descriptor of catalogModel?.efforts ?? []) {
    if (!isEffortDescriptor(descriptor.id)) continue;
    if (kept.some((option) => option.id === descriptor.id)) continue;
    const value = defaultEffortChoice(descriptor);
    if (value !== null) defaults!.push({ id: descriptor.id, value });
  }
  const options = [...kept, ...defaults!];
  return {
    instanceId: choice.instanceId,
    model: choice.model,
    ...(options.length > 0 ? { options } : {}),
  };
}

/**
 * Whether a continue draft still names the thread's own selection: an
 * untouched draft dispatches exactly like today's continue (no
 * `modelSelection`), so the new thread resolves like a follow-up.
 */
export function continueSelectionsEqual(a: ModelSelection, b: ModelSelection): boolean {
  if (a.instanceId !== b.instanceId || a.model !== b.model) return false;
  const left = [...(a.options ?? [])].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const right = [...(b.options ?? [])].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return left.length === right.length && left.every((option, at) => option.id === right[at]?.id && option.value === right[at]?.value);
}

/**
 * When the continuation's first turn starts: on the same provider as the
 * limited thread it waits for that provider's reset (plus a grace, mirroring
 * the same-thread continue); on another provider it starts at once — the old
 * provider's allowance is not its own. Undefined once the reset has passed
 * or when no limit stands.
 */
export function continueScheduledFor(params: {
  resetsAt: Date | null;
  sameProvider: boolean;
  now: number;
  graceMs: number;
}): string | undefined {
  const { resetsAt, sameProvider, now, graceMs } = params;
  if (!sameProvider || resetsAt === null || resetsAt.getTime() <= now) return undefined;
  return new Date(resetsAt.getTime() + graceMs).toISOString();
}
