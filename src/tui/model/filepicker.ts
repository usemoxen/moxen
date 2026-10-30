/**
 * The OS's own file and folder dialog, driven through the tool each platform
 * ships (argv only, never a shell string): `osascript` on macOS, PowerShell
 * and Windows Forms on Windows, `zenity` on Linux when it is installed. The
 * dialog belongs to this machine, so what it picks are this machine's paths.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { runProcess } from "../../core/infra/process.js";
import type { PathAttachment } from "./pathattachments.js";

/** What the dialog picked, before it is labelled for the draft. */
export type PickedPath = Omit<PathAttachment, "label">;

export interface PickerCommand {
  command: string;
  args: string[];
}

/** Long enough for a person to browse; the dialog is theirs to close. */
const PICKER_TIMEOUT_MS = 30 * 60_000;

/** The placeholder name the Windows dialog offers: pressing Open with it, inside a folder, picks that folder. */
export const WINDOWS_FOLDER_PLACEHOLDER = "Select this folder";

const WINDOWS_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  // An invisible topmost owner, so the dialog opens in front of the terminal and not behind it.
  "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }",
  "$owner.Show()",
  // Windows has no dialog for files and folders together. This one picks files; with no file chosen,
  // Open on the placeholder name picks the folder the dialog is in (it need not exist, so the check is off).
  `$dialog = New-Object System.Windows.Forms.OpenFileDialog -Property @{ Multiselect = $true; CheckFileExists = $false; ValidateNames = $false; FileName = '${WINDOWS_FOLDER_PLACEHOLDER}' }`,
  "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {",
  "  $dialog.FileNames | ForEach-Object { Write-Output $_ }",
  "}",
  "$owner.Close()",
].join("\n");

/**
 * macOS: an NSOpenPanel that takes files and folders at once, which
 * AppleScript's `choose file` / `choose folder` cannot. The prompt arrives as
 * the script's first argument.
 */
const MAC_SCRIPT = [
  "ObjC.import('AppKit');",
  "function run(argv) {",
  "  const app = $.NSApplication.sharedApplication;",
  "  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);",
  "  app.activateIgnoringOtherApps(true);",
  "  const panel = $.NSOpenPanel.openPanel;",
  "  panel.canChooseFiles = true;",
  "  panel.canChooseDirectories = true;",
  "  panel.allowsMultipleSelection = true;",
  "  panel.message = argv[0];",
  "  if (panel.runModal !== $.NSModalResponseOK) return '';",
  "  const out = [];",
  "  for (let index = 0; index < panel.URLs.count; index += 1) out.push(ObjC.unwrap(panel.URLs.objectAtIndex(index).path));",
  "  return out.join('\\n');",
  "}",
].join("\n");

/** The command that opens the dialog on `platform`, or null where there is no tool to open one with. */
export function pickerCommand(platform: NodeJS.Platform, prompt: string): PickerCommand | null {
  if (platform === "darwin") return { command: "osascript", args: ["-l", "JavaScript", "-e", MAC_SCRIPT, prompt] };
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SCRIPT] };
  // zenity cannot pick files and folders together: files.
  return { command: "zenity", args: ["--file-selection", "--multiple", "--title", prompt, "--separator", "\n"] };
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
export async function attachmentsFromPaths(paths: readonly string[]): Promise<PickedPath[]> {
  const found: PickedPath[] = [];
  for (const picked of paths) {
    // Open on the placeholder name picked the folder it was in.
    const absolute = path.basename(picked) === WINDOWS_FOLDER_PLACEHOLDER ? path.resolve(path.dirname(picked)) : path.resolve(picked);
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat === null) continue;
    found.push({ path: absolute, kind: stat.isDirectory() ? "folder" : "file" });
  }
  return found;
}

export type PickResult = { status: "picked"; items: PickedPath[] } | { status: "cancelled" } | { status: "unavailable"; reason: string };

/** Opens the dialog and waits for it. Closing it without a pick is `cancelled`, not an error. */
export async function pickPaths(prompt: string, platform: NodeJS.Platform = process.platform): Promise<PickResult> {
  const command = pickerCommand(platform, prompt);
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
