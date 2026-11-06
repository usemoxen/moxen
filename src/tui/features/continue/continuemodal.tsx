import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";

import type { ModelSelection } from "../../../core/types.js";
import { offerableModels, offerableProviders, type ProviderSummary } from "../../../core/catalog/summary.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { rebaseContinueSelection } from "../../model/continue.js";
import { defaultEffortId, describeEffort, displayModelName, isEffortDescriptor, modelRowDetail } from "../../model/display.js";
import { effortTones } from "../../model/slider.js";
import { t, tx } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { ModalShell } from "../../ui/modalshell.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { Slider } from "../../ui/slider.js";
import { PICK_BG, PICK_FG } from "../pickers/pickermodal.js";

const LABEL_WIDTH = 10;

/**
 * "Continue in a new thread" as one modal: the provider, the model and the
 * effort the continuation runs on, preselected to the thread's own so enter
 * at once continues exactly as the palette row used to. Left and right
 * change the focused row, up and down move between rows (and the sliders
 * below them), enter continues, esc closes. A click cycles a row, a slider
 * stop or the buttons.
 */
export function ContinueModal({
  providers,
  initial,
  resetsAt,
  screenWidth,
  screenHeight,
  onConfirm,
  onClose,
}: {
  providers: ProviderSummary[] | null;
  /** The thread's own selection: the draft starts as it, untouched. */
  initial: ModelSelection;
  /** The usage-limit reset the thread is held for, if any stands. */
  resetsAt: Date | null;
  screenWidth: number;
  screenHeight: number;
  onConfirm: (selection: ModelSelection) => void;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<ModelSelection>(initial);
  const [row, setRow] = useState(0);
  /**
   * Whether the continuation waits for the reset: only on the thread's own
   * provider while the reset has not come. Another provider starts at once,
   * so switching provider flips this from under the confirm button.
   */
  const waiting = resetsAt !== null && resetsAt.getTime() > Date.now() && selection.instanceId === initial.instanceId;

  // Every *enabled* provider (a handoff can cross providers), plus the
  // draft's own when it is not offered — the same rule the model picker
  // uses for a since-hidden model, so the current choice still reads.
  const offeredProviders = useMemo(() => {
    if (providers === null) return [];
    const offered = offerableProviders(providers);
    if (offered.some((provider) => provider.instanceId === selection.instanceId)) return offered;
    const current = providers.find((provider) => provider.instanceId === selection.instanceId);
    return current === undefined ? offered : [...offered, current];
  }, [providers, selection.instanceId]);
  const provider = providers?.find((candidate) => candidate.instanceId === selection.instanceId) ?? null;
  const offeredModels = useMemo(() => {
    if (provider === null) return [];
    const models = offerableModels(provider, selection.model);
    return models.some((model) => model.slug === selection.model)
      ? models
      : [...models, ...provider.models.filter((model) => model.slug === selection.model)];
  }, [provider, selection.model]);
  const catalogModel = provider?.models.find((model) => model.slug === selection.model) ?? null;
  const sliders = catalogModel?.efforts ?? [];
  const rows = 2 + sliders.length;
  const focused = Math.min(row, Math.max(0, rows - 1));

  const cycleProvider = (delta: number) => {
    if (offeredProviders.length === 0) return;
    const at = offeredProviders.findIndex((candidate) => candidate.instanceId === selection.instanceId);
    const next = offeredProviders[at < 0 ? (delta > 0 ? 0 : offeredProviders.length - 1) : (at + delta + offeredProviders.length) % offeredProviders.length];
    if (next === undefined) return;
    const models = offerableModels(next, next.instanceId === selection.instanceId ? selection.model : undefined);
    const model = models.some((candidate) => candidate.slug === selection.model) && next.instanceId === selection.instanceId
      ? selection.model
      : (models.find((candidate) => candidate.isDefault === true)?.slug ?? models[0]?.slug);
    if (model === undefined || (next.instanceId === selection.instanceId && model === selection.model)) return;
    setSelection(rebaseContinueSelection(selection, providers, { instanceId: next.instanceId, model }));
  };

  const cycleModel = (delta: number) => {
    if (offeredModels.length === 0) return;
    const at = offeredModels.findIndex((model) => model.slug === selection.model);
    const next = offeredModels[(at < 0 ? 0 : at + delta + offeredModels.length) % offeredModels.length];
    if (next === undefined || next.slug === selection.model) return;
    setSelection(rebaseContinueSelection(selection, providers, { instanceId: selection.instanceId, model: next.slug }));
  };

  const applyEffort = (descriptorId: string, choiceId: string) =>
    setSelection((current) => ({
      ...current,
      options: [...(current.options ?? []).filter((option) => option.id !== descriptorId), { id: descriptorId, value: choiceId }],
    }));

  const stopIndex = (descriptorId: string): number => {
    const descriptor = sliders.find((candidate) => candidate.id === descriptorId);
    if (descriptor === undefined) return 0;
    const picked = (selection.options ?? []).find((option) => option.id === descriptorId)?.value;
    const current = descriptor.choices.findIndex((choice) => choice.id === picked);
    if (current >= 0) return current;
    return Math.max(0, descriptor.choices.findIndex((choice) => choice.id === defaultEffortId(descriptor.choices)));
  };

  const stepEffort = (descriptorId: string, delta: number) => {
    const descriptor = sliders.find((candidate) => candidate.id === descriptorId);
    if (descriptor === undefined) return;
    const next = descriptor.choices[Math.min(descriptor.choices.length - 1, Math.max(0, stopIndex(descriptorId) + delta))];
    if (next !== undefined) applyEffort(descriptorId, next.id);
  };

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "esc") {
      markModalDismissed();
      onClose();
      return;
    }
    if (key.name === "return" || key.name === "kpenter") {
      onConfirm(selection);
      return;
    }
    if (key.name === "up") {
      setRow((current) => (current - 1 + rows) % rows);
      return;
    }
    if (key.name === "down") {
      setRow((current) => (current + 1) % rows);
      return;
    }
    if (key.name === "left" || key.name === "right") {
      const delta = key.name === "left" ? -1 : 1;
      if (focused === 0) cycleProvider(delta);
      else if (focused === 1) cycleModel(delta);
      else {
        const descriptor = sliders[focused - 2];
        if (descriptor !== undefined) stepEffort(descriptor.id, delta);
      }
    }
  });

  const width = Math.min(72, Math.max(40, screenWidth - 6));
  // Title, the provider and model rows and every slider, plus the buttons
  // and the keys line — capped to the window, scrolling inside when many
  // knobs overflow a short one (the wheel still reaches them).
  const needed = 11 + sliders.length * 10;
  const height = Math.min(Math.max(12, screenHeight - 6), needed);
  const inner = Math.max(10, width - 4);
  const valueWidth = Math.max(10, inner - LABEL_WIDTH - 5);

  const cycleRow = (
    key: string,
    at: number,
    label: string,
    value: string,
    meta: string | undefined,
    onStep: (delta: number) => void,
  ) => {
    const active = focused === at;
    const bg = active ? PICK_BG : SURFACE.raised;
    const fg = active ? PICK_FG : COLOR.text;
    return (
      <box
        key={key}
        style={{ width: inner, flexDirection: "row", height: 1, flexShrink: 0, marginTop: at === 0 ? 1 : 0 }}
        backgroundColor={bg}
        onMouseDown={() => {
          setRow(at);
          onStep(1);
        }}
        onMouseOver={() => setRow(at)}
        selectable={false}
      >
        <text fg={active ? PICK_FG : COLOR.dim} bg={bg} selectable={false}>{`${active ? "▌" : " "}${label.padEnd(LABEL_WIDTH)}`}</text>
        <text fg={fg} bg={bg} selectable={false}>{"‹ "}</text>
        <OverflowText fg={fg} bg={bg} selectable={false} width={valueWidth} active={active}>{value}</OverflowText>
        <text fg={fg} bg={bg} selectable={false}>{" ›"}</text>
        {meta === undefined || meta === "" ? null : <text fg={active ? PICK_FG : COLOR.faint} bg={bg} selectable={false}>{` ${meta}`}</text>}
      </box>
    );
  };

  const sliderWidth = Math.max(10, width - 6);
  return (
    <ModalShell
      screenWidth={screenWidth}
      screenHeight={screenHeight}
      left={Math.max(0, Math.floor((screenWidth - width) / 2))}
      top={Math.max(0, Math.floor((screenHeight - height) / 2))}
      width={width}
      height={height}
      onClose={onClose}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <text fg={COLOR.bright} bg={SURFACE.raised}>{t("continue.title")}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised}>{"esc"}</text>
      </box>
      <scrollbox style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" contentOptions={{ paddingRight: 1 }} verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
        {providers === null ? (
          <text fg={COLOR.dim} bg={SURFACE.raised}>{t("picker.loading_3da3")}</text>
        ) : (
          <>
            {cycleRow("provider", 0, t("continue.provider"), provider?.displayName ?? selection.instanceId, undefined, cycleProvider)}
            {cycleRow("model", 1, t("continue.model"), catalogModel?.name ?? displayModelName(providers, selection), catalogModel === null ? undefined : modelRowDetail(catalogModel).meta, cycleModel)}
            {sliders.map((descriptor, at) => {
              const labels = descriptor.choices.map((choice) => tx(choice.label));
              const active = stopIndex(descriptor.id);
              const chosen = descriptor.choices.findIndex((choice) => choice.id === (selection.options ?? []).find((option) => option.id === descriptor.id)?.value);
              const fallbackId = isEffortDescriptor(descriptor.id) ? defaultEffortId(descriptor.choices) : descriptor.choices.find((choice) => choice.isDefault === true)?.id;
              const stops = descriptor.choices.map((choice) => ({
                key: choice.id,
                label: choice.isDefault === true ? t("picker.withDefault", { label: tx(choice.label) }) : tx(choice.label),
                isDefault: choice.id === fallbackId,
                ...(isEffortDescriptor(descriptor.id) ? { description: describeEffort(choice.id, choice.id === fallbackId) } : {}),
              }));
              const highlighted = stops[active];
              return (
                <box key={descriptor.id} style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }} onMouseOver={() => setRow(2 + at)} selectable={false}>
                  <text fg={focused === 2 + at ? COLOR.bright : COLOR.dim} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{tx(descriptor.label)}</text>
                  <Slider
                    idPrefix={`continue-${descriptor.id}`}
                    stops={labels}
                    active={active}
                    chosen={chosen}
                    width={sliderWidth}
                    {...(isEffortDescriptor(descriptor.id) ? { ends: { low: t("settings.faster"), high: t("settings.smarter") }, tones: effortTones(descriptor.choices.map((choice) => choice.id)) } : {})}
                    caption={highlighted?.description ?? (highlighted?.isDefault === true ? t("effort.defaultCaption", { what: tx(descriptor.label).toLowerCase() }) : undefined)}
                    onMove={(next) => {
                      setRow(2 + at);
                      const stop = descriptor.choices[next];
                      if (stop !== undefined) applyEffort(descriptor.id, stop.id);
                    }}
                    onPick={(next) => {
                      const stop = descriptor.choices[next];
                      if (stop !== undefined) applyEffort(descriptor.id, stop.id);
                    }}
                  />
                </box>
              );
            })}
          </>
        )}
      </scrollbox>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <HoverButton label={` ${t("continue.start")} `} fg={COLOR.bright} bg={SURFACE.hover} hoverBg={COLOR.accent} hoverFg="#09090b" onClick={() => onConfirm(selection)} />
        <text bg={SURFACE.raised}>{"  "}</text>
        <HoverButton label={` ${t("continue.cancel")} `} fg={COLOR.dim} hoverFg={COLOR.bright} onClick={onClose} />
        <text bg={SURFACE.raised}>{"  "}</text>
        <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={Math.max(8, inner - 24)}>{t(waiting ? "continue.startsAfterReset" : "continue.startsNow")}</OverflowText>
      </box>
      <box style={{ height: 1, flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={inner}>{t("continue.keys")}</OverflowText>
      </box>
    </ModalShell>
  );
}
