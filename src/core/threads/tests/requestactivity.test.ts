import { describe, expect, it } from "vitest";

import {
  permissionActivityRow,
  userInputActivityRow,
  type PermissionRuntimeEvent,
  type UserInputRuntimeEvent,
} from "../requestactivity.js";

function opened(raw: unknown, provider: UserInputRuntimeEvent["provider"] = "claude"): UserInputRuntimeEvent {
  return {
    type: "user-input.request.opened",
    provider,
    threadId: "thread-1",
    requestId: "req-1",
    raw,
  } as UserInputRuntimeEvent;
}

const CLAUDE_QUESTION = {
  toolName: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "How strict should the downward rule be?",
        header: "Rule strictness",
        multiSelect: false,
        options: [
          { label: "Layered", description: "core <- server <- clients" },
          { label: "Strict", description: "clients only touch server" },
        ],
      },
    ],
  },
};

describe("userInputActivityRow", () => {
  it("preserves Codex question IDs so the answer panel can round-trip them", () => {
    const row = userInputActivityRow(opened({ params: { questions: [{ id: "scope", question: "Which scope?", header: "Scope", options: [{ label: "Project" }] }] } }, "codex"));
    expect(row?.payload.questions).toMatchObject([{ id: "scope", question: "Which scope?", options: [{ label: "Project" }] }]);
  });

  it("normalizes a parked Claude AskUserQuestion into a requested row", () => {
    const row = userInputActivityRow(opened(CLAUDE_QUESTION));
    expect(row).toMatchObject({
      kind: "user-input.requested",
      payload: {
        requestId: "req-1",
        questions: [
          {
            id: "How strict should the downward rule be?",
            question: "How strict should the downward rule be?",
            header: "Rule strictness",
            multiSelect: false,
            allowCustomAnswer: true,
            options: [
              { label: "Layered", description: "core <- server <- clients" },
              { label: "Strict", description: "clients only touch server" },
            ],
          },
        ],
      },
    });
  });

  it("keeps an option's preview for the answer panel", () => {
    const row = userInputActivityRow(
      opened({
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Layout?", header: "Layout", options: [{ label: "Sidebar", preview: "## Sidebar" }, { label: "Top" }] }] },
      }),
    );
    expect((row?.payload.questions as Array<{ options: unknown[] }>)[0]?.options).toEqual([{ label: "Sidebar", preview: "## Sidebar" }, { label: "Top" }]);
  });

  it("finds the questions wherever a provider parked them", () => {
    const questions = [{ question: "Which?", header: "Pick", options: [{ label: "A" }] }];
    for (const raw of [
      { questions },
      { method: "_x.ai/ask_user_question", params: { questions } },
      { properties: { questions } },
      { params: { input: { questions } } },
    ]) {
      expect(userInputActivityRow(opened(raw))?.payload.questions).toHaveLength(1);
    }
  });

  it("keeps duplicate question texts apart so one answer cannot serve both", () => {
    const row = userInputActivityRow(
      opened({ questions: [{ question: "Which?", options: [] }, { question: "Which?", options: [] }] }),
    );
    const questions = row?.payload.questions as Array<{ id: string }>;
    expect(questions.map((question) => question.id)).toEqual(["Which?", "Which? (2)"]);
  });

  it("omits an option value rather than defaulting it to the label", () => {
    const row = userInputActivityRow(opened({ questions: [{ question: "Q?", options: [{ label: "A" }] }] }));
    const [question] = row?.payload.questions as Array<{ options: Array<Record<string, unknown>> }>;
    expect(question!.options[0]).toEqual({ label: "A" });
  });

  it("returns null for a shape carrying no question, rather than a row the panel cannot decode", () => {
    expect(userInputActivityRow(opened(null))).toBeNull();
    expect(userInputActivityRow(opened({ toolName: "AskUserQuestion", input: {} }))).toBeNull();
    expect(userInputActivityRow(opened({ questions: [{ options: [] }] }))).toBeNull();
  });

  it("maps a resolution to the row that closes the question", () => {
    expect(
      userInputActivityRow({
        type: "user-input.request.resolved",
        provider: "claude",
        threadId: "thread-1",
        requestId: "req-1",
      } as UserInputRuntimeEvent),
    ).toMatchObject({ kind: "user-input.resolved", payload: { requestId: "req-1" } });
  });
});

describe("permissionActivityRow", () => {
  const event = (type: PermissionRuntimeEvent["type"], raw: unknown): PermissionRuntimeEvent =>
    ({ type, provider: "claude", threadId: "thread-1", requestId: "perm-1", raw }) as PermissionRuntimeEvent;

  it("carries the command and the agent's reason on the opened row", () => {
    const row = permissionActivityRow(
      event("permission.request.opened", {
        toolName: "Bash",
        classification: "command-execution",
        input: { command: "rm -rf build", description: "Clean the build" },
      }),
    );
    expect(row).toMatchObject({
      key: "permission:perm-1:requested",
      kind: "permission.requested",
      summary: "Asked to use Bash",
      payload: { requestId: "perm-1", toolName: "Bash", classification: "command-execution", detail: "rm -rf build", description: "Clean the build" },
    });
  });

  it("names the path for file tools and clips a whole-file input", () => {
    const edit = permissionActivityRow(
      event("permission.request.opened", { toolName: "Write", classification: "file-change", input: { file_path: "/a/b.ts", content: "x".repeat(5000) } }),
    );
    expect(edit.payload.detail).toBe("/a/b.ts");
    const odd = permissionActivityRow(event("permission.request.opened", { toolName: "Custom", input: { blob: "y".repeat(5000) } }));
    expect((odd.payload.detail as string).length).toBeLessThanOrEqual(600);
  });

  it("omits what the input does not say, and records the decision on resolve", () => {
    const bare = permissionActivityRow(event("permission.request.opened", { toolName: "Task", input: {} }));
    expect(bare.payload).toEqual({ requestId: "perm-1", provider: "claude", toolName: "Task" });
    const done = permissionActivityRow(event("permission.request.resolved", { toolName: "Task", behavior: "allow" }));
    expect(done).toMatchObject({ key: "permission:perm-1:resolved", kind: "permission.resolved", payload: { behavior: "allow" } });
  });
});
