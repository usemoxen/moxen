import { t } from "../../i18n/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClientApi } from "../../../server/api.js";
import type { useToasts } from "../../hooks/useToasts.js";
import { cardPalette } from "../../model/cardtheme.js";
import { writeClipboardImage } from "../../model/hostClipboard.js";
import type { StatsRange } from "../../model/stats.js";
import { COPY_TOAST_MS } from "../constants.js";
import { uniquePath } from "./useThreadExport.js";

/**
 * The stats screen's "copy card": the server draws the PNG for the range, in the
 * current theme's colours, and this puts the image on the clipboard, ready to paste, through a temp file
 * that is gone straight after. Only where the machine has no image clipboard
 * (a bare SSH session, no `xclip`) does it save the card in the launch folder
 * instead, with a numeric suffix when the name is taken, and copy its path.
 * The client does both, so a card from a paired server lands on this machine.
 */
export function useStatsCard(params: {
  client: Pick<ClientApi, "query">;
  dir: string | undefined;
  clipboard: { copyText: (text: string) => Promise<boolean> };
  toasts: ReturnType<typeof useToasts>;
  /** Puts a PNG file on the clipboard as an image; false when it cannot. */
  copyImage?: (file: string, mimeType: string) => Promise<boolean>;
}): (range: StatsRange) => void {
  const { client, dir, clipboard, toasts, copyImage = writeClipboardImage } = params;
  return (range) => {
    void client
      .query({ type: "usage.card", range, palette: cardPalette() })
      .then(async (card) => {
        const bytes = Buffer.from(card.png, "base64");
        const scratch = await mkdtemp(join(tmpdir(), "moxen-card-"));
        const copied = await writeFile(join(scratch, card.filename), bytes)
          .then(() => copyImage(join(scratch, card.filename), "image/png"))
          .catch(() => false)
          .finally(() => rm(scratch, { recursive: true, force: true }).catch(() => undefined));
        if (copied) {
          toasts.push("stats-card", "info", t("stats.cardCopied"), COPY_TOAST_MS);
          return;
        }
        const path = await uniquePath(dir ?? process.cwd(), card.filename);
        await writeFile(path, bytes);
        toasts.push("stats-card", "info", t("stats.cardSaved", { path }), COPY_TOAST_MS);
        void clipboard.copyText(path).catch(() => false);
      })
      .catch((cause: unknown) => toasts.push("stats-card", "danger", t("stats.cardFailed", { message: String(cause instanceof Error ? cause.message : cause).slice(0, 100) }), COPY_TOAST_MS));
  };
}
