import { t, tx } from "../../i18n/index.js";
import { useEffect, useMemo, useRef, useState } from "react";

import { extractProviders, type ProviderSummary } from "../../../core/catalog/summary.js";
import {
  compatibleRuntimeMode,
  displayRuntimeMode,
  runtimeModeChoicesForProvider,
} from "../../../core/catalog/permissions.js";
import type { ModelSelection, ProviderOptionSelection, RuntimeMode } from "../../../core/types.js";
import { defaultEffortChoice, displayEffort, displayModelName, isEffortDescriptor } from "../../model/display.js";
import { providerColor } from "../../theme.js";
import type { ClientApi } from "../../../server/api.js";
import type { PickerName } from "./pickerTypes.js";

/** How soon a catalog read that failed is tried again. */
const CATALOG_RETRY_MS = 3_000;

/**
 * The catalog loads once per session from `server.getConfig` and feeds both
 * the composer footer labels and the model/effort/permission pickers;
 * picking dispatches the matching `thread.*.set` command and the thread
 * subscription projects the change back into the footer.
 */
export interface ModelLabel {
  readonly name: string;
  readonly color: string | null;
}

export function useProviderCatalog(params: {
  client: ClientApi;
  selected: { id: string } | null;
  openThreadId: string | null;
  creating: boolean;
  effectiveModelSelection: ModelSelection | undefined;
  effectiveRuntimeMode: RuntimeMode | null;
  setCreatingModelSelection: (selection: ModelSelection) => void;
  setCreatingRuntimeMode: (mode: RuntimeMode) => void;
  setPicker: (picker: PickerName) => void;
  setPickerFilter: (filter: string) => void;
  setFocus: (focus: "chat") => void;
  setError: (message: string) => void;
  closePicker: (returnFocus?: "composer" | "chat" | "diff") => void;
  /** Moves each time the connection comes back (`useReconnects`): the catalog is read again. */
  reconnects?: number;
  /**
   * Moves each time the settings page closes with something changed (a Harness
   * profile added, a model hidden): the catalog is read again, so the composer
   * and the model picker show it without a restart.
   */
  settingsChanges?: number;
}) {
  const {
    client,
    selected,
    openThreadId,
    creating,
    effectiveModelSelection,
    effectiveRuntimeMode,
    setCreatingModelSelection,
    setCreatingRuntimeMode,
    setPicker,
    setPickerFilter,
    setFocus,
    setError,
    closePicker,
    reconnects = 0,
    settingsChanges = 0,
  } = params;

  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);

  /** Which load is current: a reply to an older one (before a reconnect) is dropped. */
  const generation = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = () => {
    const mine = (generation.current += 1);
    if (retry.current !== null) clearTimeout(retry.current);
    retry.current = null;
    setProvidersLoading(true);
    void client.getConfig().then(
      (response) => {
        if (mine !== generation.current) return;
        try {
          setProviders(extractProviders(response));
          setProvidersError(null);
        } catch (cause: unknown) {
          setProvidersError(String(cause).slice(0, 120));
        }
        setProvidersLoading(false);
      },
      (cause: unknown) => {
        if (mine !== generation.current) return;
        setProvidersError(String(cause).slice(0, 120));
        setProvidersLoading(false);
        // The server may be restarting: without the catalog the footer
        // falls back to raw ids and loses its usage gauge, so keep asking.
        retry.current = setTimeout(load, CATALOG_RETRY_MS);
      },
    );
  };
  const ensureProviders = () => {
    if (providers !== null || providersLoading) return;
    load();
  };

  // Footer labels need the catalog even when the picker never opens; a
  // reconnect reads it again, since the server answering now may be a new one.
  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
      if (retry.current !== null) clearTimeout(retry.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, reconnects, settingsChanges]);

  const openModelPicker = () => {
    // Drafting a new thread stores the pick locally (`creatingModelSelection`)
    // with nothing to dispatch against, so it needs no source thread — a
    // fresh install with zero threads lands here with `selected === null`.
    if (selected === null && !creating) {
      setError(t("picker.no_open_thread_to_9af4"));
      return;
    }
    setProvidersError(null);
    setPickerFilter("");
    setPicker("model");
    setFocus("chat");
    ensureProviders();
  };

  const openEffortPicker = () => {
    if (selected === null && !creating) {
      setError(t("picker.no_open_thread_to_2c29"));
      return;
    }
    setProvidersError(null);
    setPickerFilter("");
    setPicker("effort");
    setFocus("chat");
    ensureProviders();
  };

  /**
   * While drafting a new thread this only lands in `creatingModelSelection`
   * — the new thread doesn't exist yet, so there is nothing to dispatch
   * against; `createThread` reads it back when it actually sends the
   * `thread.create`/`thread.turn.start` pair. Otherwise it dispatches
   * `thread.model-selection.set` against the open thread, same as before.
   */
  const setThreadModel = (modelSelection: {
    instanceId: string;
    model: string;
    options?: ProviderOptionSelection[];
  }) => {
    if (creating) {
      setCreatingModelSelection(modelSelection);
      closePicker();
      return;
    }
    if (openThreadId === null) return;
    void client
      .dispatch({
        type: "thread.model-selection.set",
        threadId: openThreadId,
        modelSelection,
      })
      .then(() => {
        closePicker();
      })
      .catch((cause: unknown) => setError(String(cause).slice(0, 120)));
  };

  /**
   * Switching models keeps the effort-style options that still exist on the
   * new model; dropping them would silently reset the effort knob.
   */
  const pickModel = (choice: { instanceId: string; model: string }) => {
    const catalogModel = providers
      ?.find((provider) => provider.instanceId === choice.instanceId)
      ?.models.find((model) => model.slug === choice.model);
    const kept = (effectiveModelSelection?.options ?? []).filter(
      (option) =>
        typeof option.value === "boolean" ||
        catalogModel?.efforts.some((effort) => effort.id === option.id) === true,
    );
    // Enforced effort default: effort knobs missing from the kept options
    // land on the descriptor default, so sends carry a real value and the
    // footer never reads blank. Non-effort descriptors stay unset.
    const defaults: ProviderOptionSelection[] = [];
    for (const descriptor of catalogModel?.efforts ?? []) {
      if (!isEffortDescriptor(descriptor.id)) continue;
      if (kept.some((option) => option.id === descriptor.id)) continue;
      const value = defaultEffortChoice(descriptor);
      if (value !== null) defaults.push({ id: descriptor.id, value });
    }
    const options = [...kept, ...defaults];
    setThreadModel({
      instanceId: choice.instanceId,
      model: choice.model,
      ...(options.length > 0 ? { options } : {}),
    });
  };

  const pickEffort = (descriptorId: string, choiceId: string) => {
    const current = effectiveModelSelection;
    if (current === undefined) return;
    setThreadModel({
      instanceId: current.instanceId,
      model: current.model,
      options: [...(current.options ?? []).filter((option) => option.id !== descriptorId), { id: descriptorId, value: choiceId }],
    });
  };

  const openPermissionPicker = () => {
    if (selected === null && !creating) {
      setError(t("picker.no_open_thread_to_a1a2"));
      return;
    }
    setPickerFilter("");
    setPicker("permission");
    setFocus("chat");
  };

  /**
   * While drafting a new thread this only lands in `creatingRuntimeMode`
   * (same rule as the model override); otherwise it dispatches
   * `thread.runtime-mode.set` against the open thread and the thread
   * subscription projects the new mode into the footer.
   */
  const setThreadRuntimeMode = (runtimeMode: RuntimeMode) => {
    if (creating) {
      setCreatingRuntimeMode(runtimeMode);
      closePicker();
      return;
    }
    if (openThreadId === null) return;
    void client
      .dispatch({
        type: "thread.runtime-mode.set",
        threadId: openThreadId,
        runtimeMode,
      })
      .then(() => {
        closePicker();
      })
      .catch((cause: unknown) => setError(String(cause).slice(0, 120)));
  };

  // Pretty catalog name, never the raw slug; the effort knob (e.g. xhigh)
  // comes from the selection options. Interaction mode ("Build") is
  // intentionally not shown. The model lives in exactly one place: the
  // composer footer. The timeline subtitle and status bar carry status only.
  const model = displayModelName(providers, effectiveModelSelection);
  const effort = displayEffort(providers, effectiveModelSelection);

  /** The open thread's own provider — undefined until the catalog has
      loaded at least once. Backs both the `$` skill picker and the
      provider-brand color on the model name. */
  const currentProvider = providers?.find((candidate) => candidate.instanceId === effectiveModelSelection?.instanceId);
  /**
   * Offerable permission levels for the open thread's provider (every known
   * mode until the catalog loads or when the driver states nothing), and
   * the mode actually shown: the effective one while offered, else the
   * provider's first — display-only fallback, never written back until the
   * user picks, mirroring the desktop composer.
   */
  const supportedModes = currentProvider?.supportedRuntimeModes ?? null;
  const permissionChoices = useMemo(
    () => runtimeModeChoicesForProvider({ supportedRuntimeModes: supportedModes }),
    [supportedModes],
  );
  const permission = tx(
    displayRuntimeMode(compatibleRuntimeMode(effectiveRuntimeMode ?? "full-access", permissionChoices)),
  );
  const modelColor = providerColor(currentProvider?.driver, effectiveModelSelection?.instanceId, model);
  /**
   * Name and brand color for any selection, not just the current one — the
   * transcript labels each turn with the model that actually ran it.
   */
  const labelFor = (selection: ModelSelection | undefined): ModelLabel => {
    const name = displayModelName(providers, selection);
    const driver = providers?.find((candidate) => candidate.instanceId === selection?.instanceId)?.driver;
    return { name, color: providerColor(driver, selection?.instanceId, name) };
  };

  return {
    providers,
    providersError,
    model,
    effort,
    permission,
    permissionChoices,
    modelColor,
    labelFor,
    openModelPicker,
    openEffortPicker,
    openPermissionPicker,
    pickModel,
    pickEffort,
    setThreadRuntimeMode,
  };
}
