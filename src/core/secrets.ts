/**
 * Keys and tokens live in the operating system's keychain, never in a file:
 * macOS Keychain, Windows Credential Manager, or libsecret on Linux, through
 * `Bun.secrets`. The config holds only a reference (`keychain:<name>`), so the
 * config file, a backup of it, or a pasted `moxen config list` carries nothing
 * a thief can use.
 *
 * Reading is asynchronous and the keychain can be slow or locked, so callers
 * that need a key in a synchronous place prime it first (`primeSecret`) and
 * read it from the cache (`cachedSecret`). A machine without a keychain (a
 * headless Linux box) reports that plainly; the environment-variable settings
 * still work there.
 */

const SERVICE = "moxen";
const PREFIX = "keychain:";

interface BunSecrets {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

function store(): BunSecrets {
  const secrets = (globalThis as { Bun?: { secrets?: BunSecrets } }).Bun?.secrets;
  if (!secrets) throw new Error("This runtime has no OS keychain. Name an environment variable that holds the key instead.");
  return secrets;
}

export function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX) && value.length > PREFIX.length;
}

export const secretRef = (name: string): string => `${PREFIX}${name}`;
export const refName = (ref: string): string => ref.slice(PREFIX.length);

const cache = new Map<string, string>();

/** Save a secret. An empty value removes it. */
export async function writeSecret(name: string, value: string): Promise<void> {
  const secrets = store();
  if (value === "") {
    await secrets.delete({ service: SERVICE, name });
    cache.delete(name);
    return;
  }
  await secrets.set({ service: SERVICE, name, value });
  cache.set(name, value);
}

export async function readSecret(name: string): Promise<string | null> {
  try {
    const value = await store().get({ service: SERVICE, name });
    if (value === null || value === "") {
      cache.delete(name);
      return null;
    }
    cache.set(name, value);
    return value;
  } catch {
    return null;
  }
}

/**
 * `readSecret` for a value whose absence has consequences: null only when the
 * keychain answered that there is none, and a throw when it could not answer
 * (locked, unavailable, no keychain at all). The remote listener's key is
 * one such value: treating a locked keychain as "no key" would replace the
 * key and unpair every device.
 */
export async function readSecretStrict(name: string): Promise<string | null> {
  const value = await store().get({ service: SERVICE, name });
  if (value === null || value === "") {
    cache.delete(name);
    return null;
  }
  cache.set(name, value);
  return value;
}

/** Load a referenced secret into the cache so `cachedSecret` can answer. Never throws. */
export async function primeSecret(ref: string | undefined): Promise<void> {
  if (!isSecretRef(ref)) return;
  await readSecret(refName(ref));
}

/** The secret a reference names, if it has been primed (or was just written). */
export function cachedSecret(ref: string | undefined): string | undefined {
  return isSecretRef(ref) ? cache.get(refName(ref)) : undefined;
}

/** Whether the keychain holds a value for the reference (the settings page shows "saved" or not). */
export async function hasSecret(ref: string | undefined): Promise<boolean> {
  return isSecretRef(ref) && (await readSecret(refName(ref))) !== null;
}

/** Forget what was cached (tests, and a key changed elsewhere). */
export function clearSecretCache(): void {
  cache.clear();
}
