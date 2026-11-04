import { describe, expect, it } from "vitest";

import { endsInSearch, isNoMatches } from "../searchexit.js";

describe("endsInSearch", () => {
  it.each([
    "rg foo src",
    "grep -rn 'a;b' .",
    "ls; echo done; rg foo",
    "cat a\nrg foo",
    "FOO=1 /usr/bin/grep foo file 2>&1",
    "rg 'a && b' src;",
    "false; grep x",
  ])("reads %j as ending in a search", (command) => {
    expect(endsInSearch(command)).toBe(true);
  });

  it.each([
    ["grep x; false", "another command is last"],
    ["rg x || true", "another command is last"],
    ["rg x && echo found", "another command is last"],
    ["test -d src && rg x", "the search may never have run: the test is what exited 1"],
    ["false || rg x", "joined by ||, left alone"],
    ["cat f | grep x", "a pipeline's status is not the search's alone"],
    ["rg x &", "backgrounded"],
    ["exit 1; rg x", "exit ends the shell before the search"],
    ["set -e; false; rg x", "set -e ends it at the false"],
    ["if rg x; then echo y; fi", "compound"],
    ["(rg x)", "subshell"],
    ["echo $(rg x)", "substitution"],
    ["rg x <<EOF\nabc\nEOF", "heredoc"],
    ["grep -L x file", "-L inverts what exit 1 means"],
    ["rg --files", "listing, not searching"],
    ["timeout 5 rg x", "wrapped"],
    ["xargs grep x", "wrapped"],
    ["echo 'unterminated", "unparsed"],
    ["", "empty"],
  ])("does not trust %j (%s)", (command) => {
    expect(endsInSearch(command)).toBe(false);
  });
});

describe("isNoMatches", () => {
  it("is true only for exit code exactly 1 from a final search", () => {
    expect(isNoMatches("ls; rg foo", "a\n\n[exit code 1]")).toBe(true);
    expect(isNoMatches("ls; rg foo", "[exit code 1]")).toBe(true);
    expect(isNoMatches("rg foo missing-dir", "rg: missing-dir: No such file\n\n[exit code 2]")).toBe(false);
    expect(isNoMatches("rg foo", "[exit code unknown]")).toBe(false);
    expect(isNoMatches("rg foo", "[exit code 1]\n\n[The command timed out after 120s and was stopped.]")).toBe(false);
    expect(isNoMatches("exit 1", "[exit code 1]")).toBe(false);
  });
});
