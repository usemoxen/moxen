import { useEffect, useRef } from "react";
import type { KeyEvent, KeyHandler } from "@opentui/core";
import { useAppContext } from "@opentui/react";

export interface KeyLayerOptions {
  /**
   * Explicit priority band. Higher priority runs before lower priority; ties break
   * by LIFO render/mount order (deepest/newest child runs first). Defaults to `0`.
   */
  readonly priority?: number;
  /** Inactive layers are skipped while keeping their registration order. Defaults to `true`. */
  readonly active?: boolean;
  /**
   * When true (or predicate returns true), stops dispatch to lower layers after this
   * layer runs — even if this layer unmounts itself synchronously during handling.
   * Defaults to `false`.
   */
  readonly capture?: boolean | ((key: KeyEvent) => boolean);
  /**
   * When true (or predicate returns true), allows this layer to run while a captured
   * form text input (`TextField` or modal `<input>`) is active. Defaults to `false`.
   */
  readonly allowDuringTextInput?: boolean | ((key: KeyEvent) => boolean);
}

export interface TextInputCaptureOptions {
  /** Whether this text input is currently capturing keys. Defaults to `true`. */
  readonly active?: boolean;
  /**
   * Invoked on Escape while this text input is topmost. Consumes the Escape key
   * (`preventDefault` + `stopPropagation`) so no lower layer sees it.
   */
  readonly onCancel?: (() => void) | undefined;
}

interface LayerEntry {
  readonly order: number;
  priority: number;
  active: boolean;
  capture: boolean | ((key: KeyEvent) => boolean);
  allowDuringTextInput: boolean | ((key: KeyEvent) => boolean);
  handler: (key: KeyEvent) => void;
}

interface TextInputEntry {
  readonly order: number;
  active: boolean;
  onCancel: (() => void) | undefined;
}

interface KeyRegistry {
  readonly layers: Set<LayerEntry>;
  readonly textInputs: Set<TextInputEntry>;
  readonly dispatch: (key: KeyEvent) => void;
  attached: boolean;
}

export interface KeyRouter {
  addLayer(entry: LayerEntry): void;
  removeLayer(entry: LayerEntry): void;
  addTextInput(entry: TextInputEntry): void;
  removeTextInput(entry: TextInputEntry): void;
  dispatch(key: KeyEvent): void;
}

let nextOrder = 1;
const registries = new WeakMap<KeyHandler, KeyRegistry>();

export function nextLayerOrder(): number {
  return nextOrder++;
}

function isEscapeKey(key: KeyEvent): boolean {
  return key.name === "escape" || key.name === "esc";
}

function matchesOption(opt: boolean | ((key: KeyEvent) => boolean), key: KeyEvent): boolean {
  return typeof opt === "function" ? opt(key) : opt;
}

export function createKeyRouter(): KeyRouter {
  const layers = new Set<LayerEntry>();
  const textInputs = new Set<TextInputEntry>();

  const dispatch = (key: KeyEvent) => {
    if (key.propagationStopped) return;

    const sortedLayers = [...layers]
      .filter((entry) => entry.active)
      .sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : b.order - a.order));

    const activeInputs = [...textInputs]
      .filter((entry) => entry.active)
      .sort((a, b) => b.order - a.order);

    if (activeInputs.length > 0) {
      // Allow explicitly exempt layers (e.g. MinSizeGate Ctrl+C, SkillsPanel Ctrl+O) first.
      for (const layer of sortedLayers) {
        if (!matchesOption(layer.allowDuringTextInput, key)) continue;
        const captured = matchesOption(layer.capture, key);
        layer.handler(key);
        if (key.defaultPrevented || key.propagationStopped || captured) return;
      }

      if (isEscapeKey(key)) {
        const topInput = activeInputs[0]!;
        if (topInput.onCancel !== undefined) {
          topInput.onCancel();
          key.preventDefault();
          key.stopPropagation();
          return;
        }
        // Fallback for inputs whose owner still handles Escape in its own layer:
        // deliver Escape ONLY to the topmost non-exempt layer so it never leaks underneath.
        const ownerLayer = sortedLayers.find((layer) => !matchesOption(layer.allowDuringTextInput, key));
        if (ownerLayer !== undefined) {
          ownerLayer.handler(key);
        }
        return;
      }

      // All other keys (Enter, typing, arrows, Tab, Ctrl+U, ...) skip global shortcut layers
      // WITHOUT calling preventDefault(), so OpenTUI delivers them cleanly to the focused
      // `<textarea>` / `<input>` renderable in its internal renderable phase.
      return;
    }

    for (const layer of sortedLayers) {
      if (key.defaultPrevented || key.propagationStopped) return;
      const captured = matchesOption(layer.capture, key);
      layer.handler(key);
      if (key.defaultPrevented || key.propagationStopped || captured) return;
    }
  };

  return {
    addLayer: (entry) => layers.add(entry),
    removeLayer: (entry) => layers.delete(entry),
    addTextInput: (entry) => textInputs.add(entry),
    removeTextInput: (entry) => textInputs.delete(entry),
    dispatch,
  };
}

function getRegistry(keyHandler: KeyHandler): KeyRegistry {
  let reg = registries.get(keyHandler);
  if (reg !== undefined) return reg;

  const router = createKeyRouter();
  const layers = new Set<LayerEntry>();
  const textInputs = new Set<TextInputEntry>();
  reg = {
    layers,
    textInputs,
    dispatch: router.dispatch,
    attached: false,
  };
  const origAddLayer = layers.add.bind(layers);
  const origDeleteLayer = layers.delete.bind(layers);
  layers.add = (entry) => {
    router.addLayer(entry);
    return origAddLayer(entry);
  };
  layers.delete = (entry) => {
    router.removeLayer(entry);
    return origDeleteLayer(entry);
  };
  const origAddInput = textInputs.add.bind(textInputs);
  const origDeleteInput = textInputs.delete.bind(textInputs);
  textInputs.add = (entry) => {
    router.addTextInput(entry);
    return origAddInput(entry);
  };
  textInputs.delete = (entry) => {
    router.removeTextInput(entry);
    return origDeleteInput(entry);
  };
  registries.set(keyHandler, reg);
  return reg;
}

function syncAttachment(keyHandler: KeyHandler, reg: KeyRegistry): void {
  const needed = reg.layers.size > 0 || reg.textInputs.size > 0;
  if (needed && !reg.attached) {
    keyHandler.on("keypress", reg.dispatch);
    reg.attached = true;
  } else if (!needed && reg.attached) {
    keyHandler.off("keypress", reg.dispatch);
    reg.attached = false;
  }
}

/**
 * Renderer-scoped LIFO keyboard layer hook.
 *
 * Replaces raw OpenTUI `useKeyboard` (which fires FIFO oldest-ancestor-first and
 * runs before focused `<textarea>`/`<input>` renderables). Layers run topmost-first
 * (`priority` descending, then render/mount order descending), stop at modal `capture`
 * boundaries even when a layer unmounts synchronously, and automatically yield to
 * captured form text inputs (`TextField` / `useTextInputCapture`).
 */
export function useKeyLayer(handler: (key: KeyEvent) => void, options: KeyLayerOptions = {}): void {
  const { keyHandler } = useAppContext();
  const entryRef = useRef<LayerEntry | null>(null);
  if (entryRef.current === null) {
    entryRef.current = {
      // Render-time order guarantees children always outrank ancestors even on same-commit mounts.
      order: nextOrder++,
      priority: options.priority ?? 0,
      active: options.active ?? true,
      capture: options.capture ?? false,
      allowDuringTextInput: options.allowDuringTextInput ?? false,
      handler,
    };
  }
  const entry = entryRef.current;
  entry.priority = options.priority ?? 0;
  entry.active = options.active ?? true;
  entry.capture = options.capture ?? false;
  entry.allowDuringTextInput = options.allowDuringTextInput ?? false;
  entry.handler = handler;

  useEffect(() => {
    if (keyHandler === null) return;
    const reg = getRegistry(keyHandler);
    reg.layers.add(entry);
    syncAttachment(keyHandler, reg);
    return () => {
      reg.layers.delete(entry);
      syncAttachment(keyHandler, reg);
    };
  }, [keyHandler, entry]);
}

/**
 * Register a mounted form text input (`TextField`, modal `<input>`) as the active
 * keyboard capture target. While active, non-exempt `useKeyLayer` handlers are
 * suppressed so typing, Enter, Tab, and Space go straight to OpenTUI's focused
 * renderable instead of leaking into ancestor modals or shortcuts.
 */
export function useTextInputCapture(options: TextInputCaptureOptions = {}): void {
  const { keyHandler } = useAppContext();
  const entryRef = useRef<TextInputEntry | null>(null);
  if (entryRef.current === null) {
    entryRef.current = {
      order: nextOrder++,
      active: options.active ?? true,
      onCancel: options.onCancel,
    };
  }
  const entry = entryRef.current;
  entry.active = options.active ?? true;
  entry.onCancel = options.onCancel;

  useEffect(() => {
    if (keyHandler === null) return;
    const reg = getRegistry(keyHandler);
    reg.textInputs.add(entry);
    syncAttachment(keyHandler, reg);
    return () => {
      reg.textInputs.delete(entry);
      syncAttachment(keyHandler, reg);
    };
  }, [keyHandler, entry]);
}
