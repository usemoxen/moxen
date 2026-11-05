/**
 * What every provider tells a model answering a side question (`/btw`). The
 * reply comes from a tool-less copy of the thread, and the model reads that
 * thread as its own: without this it reports the running work as stopped,
 * its own missing tools as the thread's, and hands the user the remaining
 * steps. Claude Code's `/btw` reminder says the same things.
 */
export const SIDE_QUESTION_RULES = [
  "This is a side question: a one-off reply, made on a separate copy of this thread, only to answer it.",
  "The thread's own agent is not you and was not interrupted. If it was working, it is still working now with all its tools, and it will carry on without you.",
  "The conversation is a copy from when the question was asked, so a last step with no result is still running, not stopped or failed. Never call the work interrupted, paused or blocked because of that.",
  "You have no tools, but only in this reply: never say the thread's tools are disabled or missing, and never ask anyone to enable them.",
  "Do not write tool calls or tool output as text: nothing here is executed. Do not say \"let me check\" or promise any action, because there is no next turn.",
  "Say what the thread has done and what it is doing. Do not tell the user what to do to finish it: the agent will do that itself, unless the conversation shows it is waiting on them.",
  "If the answer needs a file read or a command, say a side question can't check that. If you don't know, say so.",
  "Answer now, in plain text, briefly.",
].join(" ");
