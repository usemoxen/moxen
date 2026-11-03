/**
 * How a compacted Harness conversation is framed for the model that reads it
 * next. What the summary asks for, and how a reply is checked, is shared with
 * every provider whose compaction Moxen runs (`core/compaction/summaryprompt.ts`).
 */
export { SUMMARY_NUDGE, parseSummary, summaryInstruction } from "../../compaction/summaryprompt.js";

/** Standing at the top of the message that replaces the history. */
export const SUMMARY_FRAMING =
  "The conversation so far was compacted to free up room. Below is your own summary of the earlier work, then the user's messages in their own words. Continue from it as if you remembered it: do not redo finished work, and do not mention the compaction unless the user asks. Files you read earlier are no longer in front of you, so read a file again before you edit it.";

export const TRIMMED_FRAMING =
  "The conversation so far was cut down to free up room, and no summary of the earlier work could be made. Below are the user's messages in their own words; what you did in between is not recorded here. Check the state of the project (files, git status) before you rely on any memory of it, and carry on from the user's latest message.";

/** Added after a `length` stop that compaction made room for. */
export const CONTINUE_AFTER_COMPACTION =
  "Your last reply was cut off because the conversation had grown too long, and it has since been compacted. Carry on from where you were; repeat only what is needed to finish your answer.";
