import { useEffect, useRef, useState } from "react";
import type { ClientApi, ExperienceSnapshot } from "../../../server/api.js";
import type { SettingSection } from "../../../core/configschema.js";

/** Persisted completion/read state; onboarding owns its inline controls. */
export function useExperience(client: ClientApi) {
  const [snapshot, setSnapshot] = useState<ExperienceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingSection>("general");
  const busy = useRef(false);
  const offered = useRef(false);
  const notified = useRef(false);
  useEffect(() => {
    let active = true;
    void client.query({ type: "experience.read" }).then(
      (value) => { if (active) { setSnapshot(value); setError(null); } },
      // An older paired server can still run the rest of the app.
      (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { active = false; };
  }, [client]);

  const update = async (value: { completeOnboarding?: boolean; seenRelease?: string }) => {
    if (busy.current) return false;
    busy.current = true;
    setSaving(true);
    try {
      setSnapshot(await client.dispatch({ type: "experience.update", ...value }));
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  return {
    snapshot, error, saving, step, setStep, settingsSection, offered, notified,
    openSettings: (section: SettingSection) => setSettingsSection(section),
    complete: () => update({ completeOnboarding: true }),
    read: (version: string) => update({ seenRelease: version }),
    setMemory: async (choice: "off" | "plain" | "embeddings", write: (key: string, value: string) => Promise<boolean>) => {
      if (busy.current) return;
      busy.current = true;
      setSaving(true);
      try {
        if (choice === "embeddings") {
          if (await write("memory", "true")) await write("memoryEmbeddings", "true");
        } else if (await write("memoryEmbeddings", "false")) await write("memory", String(choice !== "off"));
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
  };
}
