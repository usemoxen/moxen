import { StyledText, fg } from "@opentui/core";

import { splitInlineCode } from "../model/inlinecode.js";
import { COLOR } from "../theme.js";

/** A schema description with inline code highlighted: `code` keeps its own colour. */
export function prose(text: string, base: string): StyledText {
  return new StyledText(splitInlineCode(text).map((segment) => fg(segment.code ? COLOR.command : base)(segment.text)));
}
