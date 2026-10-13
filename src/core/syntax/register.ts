import { addDefaultParsers } from "@opentui/core";

import { getBuiltParsers } from "./builtParsers.js";
import { getParsers } from "./parsers.js";

let registered: Promise<void> | null = null;

/**
 * Registers the vendored tree-sitter parsers (`parsers-config.json` and
 * `parsers-build.json` -> `src/core/syntax/*`) on OpenTUI's global client. Must run before the first
 * render: `addDefaultParsers` only affects clients initialized afterwards.
 * Best-effort — a failure leaves the bundled js/ts/markdown/zig grammars.
 */
export function registerSyntaxParsers(): Promise<void> {
  registered ??= (async () => {
    try {
      addDefaultParsers([...(await getParsers()), ...(await getBuiltParsers())]);
    } catch (error) {
      process.stderr.write(`moxen: extra syntax parsers unavailable (${String(error).slice(0, 120)})\n`);
    }
  })();
  return registered;
}
