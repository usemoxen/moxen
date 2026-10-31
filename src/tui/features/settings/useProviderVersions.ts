import { useCallback, useEffect, useRef, useState } from "react";

import type { LatestVersions } from "../../../core/catalog/update.js";
import type { ClientApi } from "../../../server/api.js";
import type { ProviderCheckView } from "../../model/settings.js";

type Installs = { readonly codex?: ProviderCheckView; readonly claude: ProviderCheckView; readonly opencode: ProviderCheckView };

/**
 * What the settings page shows of each provider's install: the versions
 * installed (the `doctor` query, local and quick) and the newest the registry
 * offers (`provider.latest`, a network read that can be slow or fail). They are
 * asked separately so the installed versions never wait on the registry, and
 * both again after an update. A failed read leaves what was shown.
 */
export function useProviderVersions(client: ClientApi, open: boolean): {
  versions: Installs | null;
  /** Null until the registry answers (or the check is off: see `enabled`). */
  latest: LatestVersions | null;
  reload: () => void;
} {
  const [versions, setVersions] = useState<Installs | null>(null);
  const [latest, setLatest] = useState<LatestVersions | null>(null);
  const installs = useRef(0);
  const registry = useRef(0);
  const load = useCallback(() => {
    const mine = (installs.current += 1);
    void client
      .query({ type: "doctor" })
      .then((diagnosis) => {
        if (installs.current === mine) setVersions({ ...(diagnosis.providers.codex ? { codex: diagnosis.providers.codex } : {}), claude: diagnosis.providers.claude, opencode: diagnosis.providers.opencode });
      })
      .catch(() => undefined);
    const theirs = (registry.current += 1);
    void client
      .query({ type: "provider.latest" })
      .then((result) => {
        if (registry.current === theirs) setLatest(result);
      })
      .catch(() => undefined);
  }, [client]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  return { versions, latest, reload: load };
}
