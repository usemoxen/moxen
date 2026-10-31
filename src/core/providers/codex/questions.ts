/** Codex's asynchronous question items and its native answered-question envelope. */
import { asRecord, asString } from "./protocol.js";
import { CliError } from "../../errors.js";

export function codexAsyncQuestions(item: Record<string, unknown>): Record<string, unknown>[] {
  const id = asString(item.id);
  if (item.delivery !== "async" || !id || !Array.isArray(item.questions)) return [];
  return item.questions.flatMap((raw, index) => {
    const question = asRecord(raw);
    const title = asString(question?.title);
    if (!title?.trim()) return [];
    return [{
      id: JSON.stringify(["request_user_input_async", id, index]),
      question: title,
      header: "Question",
      options: (Array.isArray(question?.options) ? question.options : []).flatMap((option) => typeof option === "string" && option.trim() ? [{ label: option }] : []),
    }];
  });
}

export function codexAsyncReply(questions: readonly unknown[], answers: Readonly<Record<string, string | readonly string[]>>): { prompt: string; display: string } {
  const replies = questions.map((raw) => {
    const question = asRecord(raw);
    const id = asString(question?.id);
    const title = asString(question?.question);
    const value = id ? answers[id] : undefined;
    const answer = typeof value === "string" ? value : value?.join(", ");
    if (!id || !title || !answer?.trim()) throw new CliError("INVALID_ANSWER", "Answer every question before submitting.");
    return { questionItemId: id, question: title, answer };
  });
  return {
    prompt: `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`,
    display: replies.map((reply) => `> ${reply.question}\n\n${reply.answer}`).join("\n\n"),
  };
}
