/**
 * The OS's own file and folder dialog, driven through the tool each platform
 * ships (argv only, never a shell string): `osascript` on macOS, PowerShell
 * and Windows Forms on Windows, `zenity` on Linux when it is installed. The
 * dialog belongs to this machine, so what it picks are this machine's paths.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { runProcess } from "../../core/infra/process.js";
import type { PathAttachment, PathKind } from "./pathattachments.js";

export interface PickerCommand {
  command: string;
  args: string[];
}

/** Long enough for a person to browse; the dialog is theirs to close. */
const PICKER_TIMEOUT_MS = 30 * 60_000;

const WINDOWS_SCRIPT = (kind: PathKind) =>
  [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    // An invisible topmost owner, so the dialog opens in front of the terminal and not behind it.
    "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }",
    "$owner.Show()",
    kind === "file"
      ? "$dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Multiselect = $true"
      : "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {",
    kind === "file" ? "  $dialog.FileNames | ForEach-Object { Write-Output $_ }" : "  Write-Output $dialog.SelectedPath",
    "}",
    "$owner.Close()",
  ].join("\n");

/** The command that opens the dialog on `platform`, or null where there is no tool to open one with. */
export function pickerCommand(kind: PathKind, platform: NodeJS.Platform, prompt: string): PickerCommand | null {
  if (platform === "darwin") {
    // `choose file` and `choose folder` both take several picks; the paths come back one per line.
    const choose = kind === "file" ? "choose file" : "choose folder";
    return {
      command: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        `set picked to ${choose} with prompt (item 1 of argv) with multiple selections allowed`,
        "-e",
        'set out to ""',
        "-e",
        "repeat with entry in picked",
        "-e",
        "set out to out & POSIX path of entry & linefeed",
        "-e",
        "end repeat",
        "-e",
        "return out",
        "-e",
        "end run",
        prompt,
      ],
    };
  }
  if (platform === "win32") {
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SCRIPT(kind)] };
  }
  return { command: "zenity", args: ["--file-selection", "--title", prompt, ...(kind === "file" ? ["--multiple"] : ["--directory", "--multiple"]), "--separator", "\n"] };
}

/** The dialog's output as paths: one per line, blank lines and the folder's trailing separator dropped. */
export function parsePickerOutput(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.length > 1 ? line.replace(/[\\/]+$/u, "") : line))
    // `D:` alone means the current folder on drive D, not its root.
    .map((line) => (/^[A-Za-z]:$/u.test(line) ? `${line}\\` : line));
}

/**
 * What a dialog's output points at that still exists, as attachments: each
 * path made absolute, its kind read from the disk (a picked file that is
 * gone is dropped, not attached).
 */
export async function attachmentsFromPaths(paths: readonly string[]): Promise<PathAttachment[]> {
  const found: PathAttachment[] = [];
  for (const picked of paths) {
    const absolute = path.resolve(picked);
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat === null) continue;
    found.push({ path: absolute, kind: stat.isDirectory() ? "folder" : "file" });
  }
  return found;
}

export type PickResult = { status: "picked"; items: PathAttachment[] } | { status: "cancelled" } | { status: "unavailable"; reason: string };

/** Opens the dialog and waits for it. Closing it without a pick is `cancelled`, not an error. */
export async function pickPaths(kind: PathKind, prompt: string, platform: NodeJS.Platform = process.platform): Promise<PickResult> {
  const command = pickerCommand(kind, platform, prompt);
  if (command === null) return { status: "unavailable", reason: platform };
  let result;
  try {
    result = await runProcess(command.command, command.args, { allowFailure: true, timeoutMs: PICKER_TIMEOUT_MS });
  } catch (cause) {
    return { status: "unavailable", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  // osascript exits 1 on cancel (error -128), zenity too; anything printed is a pick.
  const items = await attachmentsFromPaths(parsePickerOutput(result.stdout));
  if (items.length > 0) return { status: "picked", items };
  if (result.exitCode !== 0 && result.stderr.trim().length > 0 && !/-128|User canceled/iu.test(result.stderr)) {
    return { status: "unavailable", reason: result.stderr.trim().split(/\r?\n/u)[0] ?? "" };
  }
  return { status: "cancelled" };
}
