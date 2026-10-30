import { EDITOR_GALLERY } from "./editors.js";
import { FEATURE_GALLERY } from "./features.js";
import { PANEL_GALLERY } from "./panels.js";
import { SCENE_GALLERY } from "./scenes.js";
import { SETTINGS_GALLERY } from "./settings.js";
import { SIDEPANEL_GALLERY } from "./sidepanel.js";
import type { GalleryEntry } from "./registry.js";
import { UI_GALLERY } from "./ui.js";

/** Every component the visual harness can show on its own. */
export const GALLERY: readonly GalleryEntry[] = [...UI_GALLERY, ...FEATURE_GALLERY, ...SCENE_GALLERY, ...SETTINGS_GALLERY, ...SIDEPANEL_GALLERY, ...EDITOR_GALLERY, ...PANEL_GALLERY];
