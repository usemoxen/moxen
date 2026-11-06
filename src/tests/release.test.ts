import { describe, expect, it } from "vitest";
import { archiveFileName, checksumFileName, packCommand, releaseBaseName, releaseInstallNotes, releaseNotesBody, releaseTarget, tagForVersion, tagMismatch, unpackCommand } from "../../scripts/release-lib.js";

describe("release archives", () => {
  it("names one archive per platform, the way the updater will look for it", () => {
    expect(archiveFileName("0.1.2", releaseTarget("darwin", "arm64"))).toBe("moxen-0.1.2-macos-arm64.tar.gz");
    expect(archiveFileName("0.1.2", releaseTarget("win32", "x64"))).toBe("moxen-0.1.2-windows-x64.zip");
    expect(releaseBaseName("0.1.2", releaseTarget("win32", "x64"))).toBe("moxen-0.1.2-windows-x64");
  });

  it("ships each platform's own native OpenTUI package", () => {
    expect(releaseTarget("darwin", "arm64").nativePackage).toBe("@opentui/core-darwin-arm64");
    expect(releaseTarget("win32", "x64").nativePackage).toBe("@opentui/core-win32-x64");
  });

  it("refuses a platform it does not release for", () => {
    expect(() => releaseTarget("linux", "x64")).toThrow();
    expect(() => releaseTarget("darwin", "ia32")).toThrow();
  });

  it("accepts only the tag v<version>", () => {
    expect(tagForVersion("0.1.2")).toBe("v0.1.2");
    expect(tagMismatch("v0.1.2", "0.1.2")).toBeNull();
    for (const tag of ["0.1.2", "v0.1.3", "v0.1.2-rc.1", "v0.1.20"]) expect(tagMismatch(tag, "0.1.2")).toContain(tag);
  });

  it("makes zips on Windows with the system tar, since Git Bash's tar cannot", () => {
    const env = { SystemRoot: "C:\\Windows" };
    const windows = releaseTarget("win32", "x64");
    expect(packCommand(windows, "out.zip", "stage", "moxen", env)).toEqual({ command: "C:\\Windows\\System32\\tar.exe", args: ["-a", "-c", "-f", "out.zip", "-C", "stage", "moxen"] });
    expect(unpackCommand(windows, "out.zip", "dest", env).command).toBe("C:\\Windows\\System32\\tar.exe");
    expect(packCommand(releaseTarget("darwin", "arm64"), "out.tar.gz", "stage", "moxen").command).toBe("tar");
  });
});

describe("release notes", () => {
  it("names both archives, their checksums and the one-line installers for the version", () => {
    const notes = releaseInstallNotes("0.1.2");
    expect(notes).toContain("moxen-0.1.2-macos-arm64.tar.gz");
    expect(notes).toContain(checksumFileName("0.1.2", releaseTarget("darwin", "arm64")));
    expect(notes).toContain("moxen-0.1.2-windows-x64.zip");
    expect(notes).toContain(checksumFileName("0.1.2", releaseTarget("win32", "x64")));
    expect(notes).toContain("releases/download/v0.1.2/install.sh");
    expect(notes).toContain("releases/download/v0.1.2/install.ps1");
  });

  it("says what an install needs and what happens next", () => {
    const notes = releaseInstallNotes("0.1.2");
    expect(notes).toContain("Bun");
    expect(notes).toContain("self-update --install");
    expect(notes).toContain("PATH");
  });

  it("puts the install steps above the changelog and keeps the changelog as it is", () => {
    const changelog = "## What's changed\n* something by @someone in #1\n";
    const body = releaseNotesBody("0.1.2", changelog);
    expect(body.indexOf("## Install")).toBeLessThan(body.indexOf("## What's changed"));
    expect(body).toContain(changelog);
  });

  it("is just the install steps when there is no changelog", () => {
    expect(releaseNotesBody("0.1.2", "\n")).toBe(`${releaseInstallNotes("0.1.2")}\n`);
  });
});
