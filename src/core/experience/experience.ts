import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { renameReplacing } from "../infra/atomic.js";
import { CliError } from "../errors.js";
import { APP_VERSION } from "../version.js";

export interface ReleaseText { readonly en: string; readonly es: string }
export interface ReleaseHighlight {
  readonly title: ReleaseText;
  readonly body: ReleaseText;
  readonly action?: "memory" | "mcp" | "onboarding";
}
export interface ReleaseNotes {
  readonly version: string;
  readonly title: ReleaseText;
  readonly highlights: readonly ReleaseHighlight[];
  readonly sections?: readonly { readonly title: ReleaseText; readonly entries: readonly ReleaseText[] }[];
}

/** Shipped with the build: release notes work offline and never advertise an uninstalled release. */
export const RELEASES: readonly ReleaseNotes[] = [{
  version: "0.1.2",
  title: { en: "Make yourself at home", es: "Ponte a gusto" },
  sections: [
    {
      title: { en: "Added", es: "Novedades" },
      entries: [
        { en: "A full-page getting-started guide with appearance controls, inline model selection, memory choices, MCP setup and project selection.", es: "Una guía a pantalla completa con ajustes de aspecto, selección de modelos, opciones de memoria, conexiones MCP y selección de proyecto." },
        { en: "Local semantic memory setup directly in onboarding: download, check retrieval and speed, and index existing memories before activation. A dedicated Memory settings page includes model loading and per-provider participation switches.", es: "Configura la memoria por significado desde la guía: descarga el modelo, comprueba aciertos y velocidad e indexa los recuerdos antes de activarla. La página Memoria reúne sus ajustes; cada proveedor conserva su interruptor." },
        { en: "Offline release history with feature highlights, detailed change lists, and a separate read acknowledgement for each version.", es: "Historial de versiones sin conexión, con funciones destacadas, listas detalladas de cambios y confirmación de lectura por versión." },
      ],
    },
    {
      title: { en: "Improved", es: "Mejoras" },
      entries: [
        { en: "Appearance choices are visible, and memory is a plain three-way choice rather than a settings slider. Onboarding has its own animated thread field and respects Static and Off.", es: "Las opciones de aspecto están a la vista y la memoria es una elección directa entre tres opciones en vez del selector de Ajustes. La guía tiene su propio fondo animado y respeta Estático y Desactivado." },
        { en: "The CLI and release viewer report the same package version.", es: "La CLI y el historial de novedades muestran la misma versión del paquete." },
      ],
    },
  ],
  highlights: [
    {
      title: { en: "A place to start", es: "Por dónde empezar" },
      body: { en: "Walk through appearance, models, memory and tools. Keep your existing setup, change what you need, and return to the guide whenever you like.", es: "Repasa el aspecto, los modelos, la memoria y las herramientas. Conserva tus ajustes, cambia lo que necesites y vuelve a la guía cuando quieras." },
      action: "onboarding",
    },
    {
      title: { en: "Memory, your way", es: "La memoria, a tu manera" },
      body: { en: "Choose memory with embeddings to download and validate a local model right in the guide. Manage setup, keyword fallback and model loading on the Memory settings page.", es: "Elige la memoria con embeddings para descargar y comprobar un modelo local desde la guía. Gestiona la instalación, la búsqueda por palabras clave y la carga del modelo en la página Memoria de Ajustes." },
      action: "memory",
    },
    {
      title: { en: "Bring your tools", es: "Conecta tus herramientas" },
      body: { en: "MCP servers give agents access to tools and services you use. Add one in the guide or Settings, choose which providers get it, and test the connection inline.", es: "Los servidores MCP dan a los agentes acceso a las herramientas y servicios que usas. Añade uno desde la guía o Ajustes, elige qué proveedores lo reciben y prueba la conexión sin salir." },
      action: "mcp",
    },
  ],
}];

export interface ExperienceState {
  readonly onboardingCompleted: boolean;
  readonly seenReleases: readonly string[];
}
export interface ExperienceSnapshot extends ExperienceState {
  readonly version: string;
  readonly releases: readonly ReleaseNotes[];
}

export async function readExperience(storeRoot: string): Promise<ExperienceSnapshot> {
  let state: ExperienceState = { onboardingCompleted: false, seenReleases: [] };
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(storeRoot, "experience.json"), "utf8"));
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const value = raw as Record<string, unknown>;
      state = {
        onboardingCompleted: value.onboardingCompleted === true,
        seenReleases: Array.isArray(value.seenReleases) ? value.seenReleases.filter((v): v is string => typeof v === "string") : [],
      };
    }
  } catch (cause) {
    if (!(cause instanceof SyntaxError) && (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return { ...state, version: APP_VERSION, releases: RELEASES };
}

// Two windows may acknowledge different releases at once. Merge inside one queue per store.
const writes = new Map<string, Promise<unknown>>();
export async function updateExperience(storeRoot: string, update: { readonly completeOnboarding?: boolean; readonly seenRelease?: string }): Promise<ExperienceSnapshot> {
  if (update.seenRelease !== undefined && !RELEASES.some((release) => release.version === update.seenRelease)) {
    throw new CliError("INVALID_RELEASE", "That release is not included in this Moxen build.");
  }
  const key = path.resolve(storeRoot);
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const current = await readExperience(storeRoot);
    const state: ExperienceState = {
      onboardingCompleted: current.onboardingCompleted || update.completeOnboarding === true,
      seenReleases: [...new Set([...current.seenReleases, ...(update.seenRelease ? [update.seenRelease] : [])])],
    };
    await mkdir(storeRoot, { recursive: true });
    const file = path.join(storeRoot, "experience.json");
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await renameReplacing(tmp, file);
    } finally {
      await rm(tmp, { force: true });
    }
    return { ...current, ...state };
  });
  writes.set(key, next);
  try { return await next; }
  finally { if (writes.get(key) === next) writes.delete(key); }
}
