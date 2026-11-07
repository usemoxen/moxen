/**
 * The format-version contract both the config file and the thread store are
 * read and written through (MXN-311): a value that names no version reads as
 * version 1, migrations run one version at a time in order, and data newer
 * than the build knows is refused rather than guessed at.
 */
import { describe, expect, it } from "vitest";

import { FIRST_FORMAT_VERSION, formatVersionOf, migrateFormat } from "../format.js";

describe("format versions", () => {
  it("reads a missing version as version 1", () => {
    expect(formatVersionOf(undefined)).toBe(FIRST_FORMAT_VERSION);
    expect(formatVersionOf({})).toBe(FIRST_FORMAT_VERSION);
    expect(formatVersionOf({ formatVersion: 1 })).toBe(1);
    expect(formatVersionOf({ formatVersion: 3 })).toBe(3);
  });

  it.each([["a string", "2"], ["a float", 1.5], ["zero", 0], ["a negative", -1], ["null", null], ["a list", [1]]])(
    "refuses %s as a version instead of guessing",
    (_label, version) => {
      const data = Array.isArray(version) || version === null ? version : { formatVersion: version };
      expect(() => formatVersionOf(data)).toThrow(expect.objectContaining({ code: "INVALID_FORMAT_VERSION" }));
    },
  );

  it("runs migrations one version at a time, in order", () => {
    const seen: string[] = [];
    const next = migrateFormat({ formatVersion: 1, keys: ["a"] }, {
      what: "the test data",
      from: 1,
      current: 3,
      migrations: [
        { from: 1, to: 2, migrate: (data) => { seen.push("1->2"); return { ...(data as Record<string, unknown>), formatVersion: 2 }; } },
        { from: 2, to: 3, migrate: (data) => { seen.push("2->3"); return { ...(data as Record<string, unknown>), formatVersion: 3 }; } },
      ],
    });
    expect(seen).toEqual(["1->2", "2->3"]);
    expect(next).toMatchObject({ formatVersion: 3, keys: ["a"] });
  });

  it("passes data already at the current version through untouched", () => {
    const data = { formatVersion: 1, keys: ["a"] };
    expect(migrateFormat(data, { what: "the test data", from: 1, current: 1, migrations: [] })).toBe(data);
  });

  it("refuses data newer than the build knows, before running any migration", () => {
    const seen: string[] = [];
    expect(() => migrateFormat({ formatVersion: 2 }, {
      what: "the test data",
      from: 2,
      current: 1,
      migrations: [{ from: 1, to: 2, migrate: (data) => { seen.push("ran"); return data; } }],
    })).toThrow(expect.objectContaining({ code: "FORMAT_TOO_NEW" }));
    expect(seen).toEqual([]);
  });

  it("names what is newer and what the build reads", () => {
    expect(() => migrateFormat({}, { what: "the test data", from: 2, current: 1, migrations: [] })).toThrow(
      expect.objectContaining({ code: "FORMAT_TOO_NEW", message: expect.stringContaining("version 2") }),
    );
  });

  it("fails when no migration covers the gap instead of skipping a version", () => {
    expect(() => migrateFormat({ formatVersion: 1 }, {
      what: "the test data",
      from: 1,
      current: 3,
      migrations: [{ from: 2, to: 3, migrate: (data) => data }],
    })).toThrow(expect.objectContaining({ code: "FORMAT_MIGRATION_MISSING" }));
  });
});
