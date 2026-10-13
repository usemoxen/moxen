import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { App } from "./app/app.js";
import { mockClient } from "./mockclient.js";
import { registerSyntaxParsers } from "../core/syntax/register.js";
import { SURFACE } from "./theme.js";
import { MinSizeGate } from "./ui/terminalgate.js";

/**
 * The real TUI in a real terminal, on mocks: `bun run tui:mock`.
 *
 * No provider runs and nothing is written (see `mockclient.ts`). Open the
 * new-thread view (`+` in the sidebar, or ctrl+p → New thread) and switch
 * models from the composer footer to see each model's backdrop and the
 * easing between them; the settings page works, in memory.
 */

if (process.stdout.isTTY !== true) {
  console.error("tui:mock needs an interactive terminal.");
  process.exit(2);
}

await registerSyntaxParsers();
const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: SURFACE.base });
const root = createRoot(renderer);
try {
  await new Promise<void>((resolve) => {
    root.render(
      <MinSizeGate onQuit={resolve}>
        <App
          client={mockClient}
          onQuit={resolve}
          cwd={process.cwd()}
          setTerminalTitle={(title) => renderer.setTerminalTitle(title)}
        />
      </MinSizeGate>,
    );
  });
} finally {
  root.unmount();
  renderer.destroy();
}
process.exit(0);
