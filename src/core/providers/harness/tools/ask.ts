/**
 * Lets the model put a question to the user and wait for the answer. The
 * shape of a question is the one the clients' answer panel renders (header,
 * options with descriptions, multi-select, free text on top), keyed by the
 * question's own text because that is how the panel keys its answers.
 */
import type { HarnessTool, ToolResult } from "./types.js";

export interface AskOption {
  readonly label: string;
  readonly description?: string;
}

export interface AskQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly AskOption[];
  readonly multiSelect: boolean;
}

export type AskReply =
  | { readonly kind: "answered"; readonly answers: Readonly<Record<string, string | readonly string[]>> }
  | { readonly kind: "dismissed" };

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_HEADER = 14;

interface AskArgs {
  questions: unknown[];
}

const fail = (content: string): ToolResult => ({ content, isError: true });
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function parseQuestions(raw: unknown[]): { ok: true; questions: AskQuestion[] } | { ok: false; error: string } {
  if (raw.length === 0 || raw.length > MAX_QUESTIONS) return { ok: false, error: `Ask between 1 and ${MAX_QUESTIONS} questions at a time.` };
  const questions: AskQuestion[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const record = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const question = text(record?.question);
    if (question === "") return { ok: false, error: `Question ${index + 1} has no "question" text.` };
    // The answer comes back under the question's text, so two identical ones could not be told apart.
    if (seen.has(question)) return { ok: false, error: `Two questions read "${question}". Each question must be different.` };
    seen.add(question);
    const rawOptions = Array.isArray(record?.options) ? record.options : [];
    if (rawOptions.length > MAX_OPTIONS) return { ok: false, error: `Question ${index + 1} has more than ${MAX_OPTIONS} options. Offer the few that matter; the user can always type another answer.` };
    const options: AskOption[] = [];
    for (const option of rawOptions) {
      const asRecord = typeof option === "object" && option !== null ? (option as Record<string, unknown>) : null;
      const label = typeof option === "string" ? option.trim() : text(asRecord?.label);
      if (label === "") return { ok: false, error: `An option of question ${index + 1} has no "label".` };
      const description = text(asRecord?.description);
      options.push(description === "" ? { label } : { label, description });
    }
    const header = text(record?.header).slice(0, MAX_HEADER) || "Question";
    questions.push({ question, header, options, multiSelect: record?.multiSelect === true });
  }
  return { ok: true, questions };
}

function describeAnswer(value: string | readonly string[]): string {
  return typeof value === "string" ? value : value.join(", ");
}

/** `ask` parks the call until the user answers; the driver owns the waiting. */
export function askTool(ask: (questions: readonly AskQuestion[], signal: AbortSignal) => Promise<AskReply>): HarnessTool<AskArgs> {
  return {
    readOnly: false,
    definition: {
      name: "ask",
      description: [
        "Asks the user one to four questions and waits for the answers. Use it when you cannot go on without a decision only they can make: a requirement that is unclear, a choice between approaches with real trade-offs, a preference that changes what you build.",
        "",
        "- Do not ask what you can find out by reading the project, or what you can reasonably decide yourself. Do not ask for permission to continue; just continue.",
        "- Give a short \"header\" (a word or two) and, when there are clear alternatives, the options with a line each on what choosing it means. Put the one you recommend first. The user can always answer in their own words, so do not add an \"other\" option.",
        "- Set multiSelect when more than one option may apply.",
        "- If the user dismisses the question, carry on with your best judgement and say what you assumed.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "The questions, at most four.",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The complete question, ending with a question mark." },
                header: { type: "string", description: "A one or two word label." },
                options: {
                  type: "array",
                  items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
                },
                multiSelect: { type: "boolean" },
              },
              required: ["question"],
            },
          },
        },
        required: ["questions"],
      },
    },
    intent: () => ({ action: "read", paths: [] }),
    async run(args, context) {
      const parsed = parseQuestions(args.questions);
      if (!parsed.ok) return fail(parsed.error);
      const reply = await ask(parsed.questions, context.signal);
      if (reply.kind === "dismissed") return { content: "The user dismissed the question without answering. Continue with your best judgement and say what you assumed." };
      const lines = parsed.questions.map((question) => {
        const answer = reply.answers[question.question];
        return `"${question.question}" = "${answer === undefined ? "(no answer)" : describeAnswer(answer)}"`;
      });
      return { content: `The user answered:\n${lines.join("\n")}` };
    },
  };
}
