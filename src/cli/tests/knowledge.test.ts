import { expect, it } from "vitest";
import generated from "../../core/knowledge/generated.json" with { type: "json" };
import { commandReference, program } from "../program.js";

it("ships every command's current arguments and flags without running CLI actions", () => {
  expect(generated.pages.filter((page) => page.id.startsWith("cli-"))).toEqual(commandReference());
  expect(program.args).toEqual([]);
  const profile = generated.pages.find((page) => page.id === "cli-moxen-harness-profile-add")!;
  expect(profile.sections[0]!.text).toContain("--base-url <url> (required)");
  expect(profile.sections[0]!.text).toContain("--api-key-env <NAME>");
});
