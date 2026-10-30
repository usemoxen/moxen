import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { tempDir } from "../../../core/testing/tmp.js";
import { attachmentsFromPaths, parsePickerOutput, pickerCommand } from "../filepicker.js";
import { addPaths, pathLabel, promptWithPaths, quotePath } from "../pathattachments.js";

describe("paths in the prompt", () => {
  it("quotes a path with a space or a quote and leaves a plain one alone", () => {
    expect(quotePath("/Users/me/notes.txt")).toBe("/Users/me/notes.txt");
    expect(quotePath("/Users/me/My Docs/a.txt")).toBe('"/Users/me/My Docs/a.txt"');
    expect(quotePath('/tmp/say "hi".txt')).toBe('"/tmp/say \\"hi\\".txt"');
    expect(quotePath("C:\\Users\\me\\My Docs")).toBe('"C:\\Users\\me\\My Docs"');
  });

  it("lists the attached paths after the prompt, kind first, and changes nothing without any", () => {
    expect(promptWithPaths("look", [])).toBe("look");
    expect(
      promptWithPaths("look", [
        { path: "/a/b c.txt", kind: "file" },
        { path: "/a/src", kind: "folder" },
      ]),
    ).toBe('look\n\nAttached paths:\n- file: "/a/b c.txt"\n- folder: /a/src');
  });

  it("does not attach a path twice", () => {
    const first = [{ path: "/a", kind: "folder" as const }];
    expect(addPaths(first, [{ path: "/a", kind: "folder" }, { path: "/b", kind: "file" }, { path: "/b", kind: "file" }])).toEqual([
      { path: "/a", kind: "folder" },
      { path: "/b", kind: "file" },
    ]);
  });

  it("names a chip by the last segment, and a root by itself", () => {
    expect(pathLabel({ path: path.join("x", "y", "report.pdf"), kind: "file" })).toBe("report.pdf");
    expect(pathLabel({ path: path.parse(process.cwd()).root, kind: "folder" })).toBe(path.parse(process.cwd()).root);
  });
});

describe("the OS file dialog", () => {
  it("is opened with argv on every platform, the prompt as an argument and never inside a shell string", () => {
    const mac = pickerCommand("file", "darwin", "Pick; rm -rf /")!;
    expect(mac.command).toBe("osascript");
    expect(mac.args.at(-1)).toBe("Pick; rm -rf /");
    expect(mac.args.join("\n")).toContain("choose file");
    expect(pickerCommand("folder", "darwin", "x")!.args.join("\n")).toContain("choose folder");

    const windows = pickerCommand("file", "win32", "x")!;
    expect(windows.command).toBe("powershell.exe");
    expect(windows.args.join("\n")).toContain("OpenFileDialog");
    expect(windows.args.join("\n")).toContain("Multiselect = $true");
    expect(pickerCommand("folder", "win32", "x")!.args.join("\n")).toContain("FolderBrowserDialog");

    const linux = pickerCommand("folder", "linux", "x")!;
    expect(linux.command).toBe("zenity");
    expect(linux.args).toContain("--directory");
  });

  it("reads one path per line, without blank lines or the trailing separator a folder comes with", () => {
    expect(parsePickerOutput("/Users/me/a.txt\n/Users/me/My Docs/\n\n")).toEqual(["/Users/me/a.txt", "/Users/me/My Docs"]);
    expect(parsePickerOutput("C:\\Users\\me\\a.txt\r\nD:\\\r\n")).toEqual(["C:\\Users\\me\\a.txt", "D:\\"]);
    expect(parsePickerOutput("/")).toEqual(["/"]);
  });

  it("attaches what exists, telling a folder from a file by the disk, and drops what is gone", async () => {
    const dir = realpathSync.native(tempDir("moxen-pick-"));
    const file = path.join(dir, "my notes.txt");
    const folder = path.join(dir, "src");
    writeFileSync(file, "x");
    mkdirSync(folder);
    expect(await attachmentsFromPaths([file, folder, path.join(dir, "gone.txt")])).toEqual([
      { path: file, kind: "file" },
      { path: folder, kind: "folder" },
    ]);
  });
});
