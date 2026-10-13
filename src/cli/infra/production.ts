import { spawn } from "node:child_process";

/**
 * Run the TUI under `NODE_ENV=production`.
 *
 * Bun picks React's development JSX runtime from `NODE_ENV` when the process
 * starts, and that runtime allocates an `Error` (a captured stack) for every
 * element it creates. The TUI re-renders constantly (spinners, the backdrop,
 * every streamed token), and the stacks pile up in native memory that the JS
 * heap never accounts for: MXN-38, 10+ GB after a few hours. In production
 * the same session stays flat. `NODE_ENV` cannot be changed from inside the
 * process (the transpiler has already chosen the dev runtime, and flipping
 * React's own mode afterwards breaks every element), so the command starts
 * itself again with it set.
 *
 * Returns true when it re-ran (the exit code is already set), false when this
 * process is the production one and should carry on.
 */
export async function reexecInProduction(): Promise<boolean> {
  if (process.env.NODE_ENV === "production") return false;
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });
  // The terminal sends Ctrl-C to the whole foreground group, so the child
  // sees it directly; this process only has to outlive it. A kill aimed at
  // this process alone is passed on.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on("SIGINT", () => undefined);
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));
  process.exitCode = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
  return true;
}
