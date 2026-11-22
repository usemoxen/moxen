import type { KeyEvent } from "@opentui/core";
import { describe, expect, it } from "vitest";

import { createKeyRouter, nextLayerOrder } from "../useKeyLayer.js";

function makeKey(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    name,
    sequence: extra.sequence ?? (name.length === 1 ? name : ""),
    ctrl: extra.ctrl ?? false,
    meta: extra.meta ?? false,
    shift: extra.shift ?? false,
    option: extra.option ?? false,
    get defaultPrevented() {
      return defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    },
    preventDefault() {
      defaultPrevented = true;
    },
    stopPropagation() {
      propagationStopped = true;
    },
  } as unknown as KeyEvent;
}

describe("useKeyLayer router", () => {
  it("dispatches LIFO (newest/child before oldest/parent) and respects priority bands", () => {
    const router = createKeyRouter();
    const seen: string[] = [];
    const appOrder = nextLayerOrder();
    const modalOrder = nextLayerOrder();
    const childOrder = nextLayerOrder();

    router.addLayer({ order: appOrder, priority: -10, active: true, capture: false, allowDuringTextInput: false, handler: () => seen.push("app") });
    router.addLayer({ order: modalOrder, priority: 0, active: true, capture: false, allowDuringTextInput: false, handler: () => seen.push("modal") });
    router.addLayer({ order: childOrder, priority: 0, active: true, capture: false, allowDuringTextInput: false, handler: () => seen.push("child") });
    router.addLayer({ order: appOrder, priority: 100, active: true, capture: false, allowDuringTextInput: false, handler: () => seen.push("gate") });

    router.dispatch(makeKey("j"));
    expect(seen).toEqual(["gate", "child", "modal", "app"]);
  });

  it("stops dispatch at capture boundaries even when the top modal unmounts itself synchronously", () => {
    const router = createKeyRouter();
    const seen: string[] = [];
    const parent = {
      order: nextLayerOrder(),
      priority: 0,
      active: true,
      capture: false,
      allowDuringTextInput: false,
      handler: () => seen.push("parent"),
    };
    const modal = {
      order: nextLayerOrder(),
      priority: 0,
      active: true,
      capture: true,
      allowDuringTextInput: false,
      handler: () => {
        seen.push("modal-close");
        router.removeLayer(modal);
      },
    };
    router.addLayer(parent);
    router.addLayer(modal);

    router.dispatch(makeKey("escape"));
    expect(seen).toEqual(["modal-close"]);

    // After unmount, the parent receives subsequent keys normally.
    router.dispatch(makeKey("j"));
    expect(seen).toEqual(["modal-close", "parent"]);
  });

  it("supports predicate capture (e.g. Tab passes through to SettingsModal while other keys stay captured)", () => {
    const router = createKeyRouter();
    const seen: string[] = [];
    router.addLayer({ order: nextLayerOrder(), priority: 0, active: true, capture: true, allowDuringTextInput: false, handler: (k) => seen.push(`settings:${k.name}`) });
    router.addLayer({
      order: nextLayerOrder(),
      priority: 0,
      active: true,
      capture: (k) => k.name !== "tab",
      allowDuringTextInput: false,
      handler: (k) => seen.push(`panel:${k.name}`),
    });

    router.dispatch(makeKey("return"));
    router.dispatch(makeKey("tab"));
    expect(seen).toEqual(["panel:return", "panel:tab", "settings:tab"]);
  });

  it("suppresses shortcut layers while a text input is captured without preventing OpenTUI renderable delivery", () => {
    const router = createKeyRouter();
    const seen: string[] = [];
    router.addLayer({ order: nextLayerOrder(), priority: 0, active: true, capture: true, allowDuringTextInput: false, handler: (k) => seen.push(`settings:${k.name}`) });
    router.addTextInput({ order: nextLayerOrder(), active: true, onCancel: () => seen.push("input-cancel") });

    const enter = makeKey("return");
    const letter = makeKey("u");
    const tab = makeKey("tab");
    router.dispatch(enter);
    router.dispatch(letter);
    router.dispatch(tab);

    // Ancestor never fired, and defaultPrevented stayed false so OpenTUI's focused <textarea> receives the keys.
    expect(seen).toEqual([]);
    expect(enter.defaultPrevented).toBe(false);
    expect(letter.defaultPrevented).toBe(false);
    expect(tab.defaultPrevented).toBe(false);

    // Escape triggers the text input's onCancel and consumes the key so SettingsModal does not close.
    const esc = makeKey("escape");
    router.dispatch(esc);
    expect(seen).toEqual(["input-cancel"]);
    expect(esc.defaultPrevented).toBe(true);
    expect(esc.propagationStopped).toBe(true);
  });

  it("still runs explicitly allowDuringTextInput layers (e.g. Ctrl+O in SkillsPanel or Ctrl+C in MinSizeGate)", () => {
    const router = createKeyRouter();
    const seen: string[] = [];
    router.addLayer({
      order: nextLayerOrder(),
      priority: 0,
      active: true,
      capture: false,
      allowDuringTextInput: (k) => k.ctrl === true && k.name === "o",
      handler: (k) => {
        k.preventDefault();
        seen.push("skills-ctrl-o");
      },
    });
    router.addTextInput({ order: nextLayerOrder(), active: true, onCancel: () => seen.push("cancel") });

    const ctrlO = makeKey("o", { ctrl: true });
    router.dispatch(ctrlO);
    expect(seen).toEqual(["skills-ctrl-o"]);
    expect(ctrlO.defaultPrevented).toBe(true);
  });
});
