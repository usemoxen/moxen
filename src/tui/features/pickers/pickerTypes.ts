/** Centered picker modal: model/effort lists, the diff-turn list, the
    command palette, the rename or custom-answer prompt, message actions,
    the new-thread project list, the background-tasks browser, or the
    settings page, or the usage stats. */
export type PickerName =
  | "model"
  | "effort"
  | "permission"
  | "diff-turn"
  | "command"
  | "rename"
  | "message"
  | "answer-custom"
  | "project"
  | "project-new"
  | "background-tasks"
  | "settings"
  | "stats"
  | "schedule"
  | "search"
  | "remote-servers"
  | "remote-devices"
  | "remote-pair-address"
  | "remote-pair-code"
  | "remote-code"
  | null;
