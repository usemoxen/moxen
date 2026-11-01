import { afterEach, expect, it, vi } from "vitest";
import { EMBEDDING_CHECK, compatibleValidation, validateEmbeddings } from "../embedding-validation.js";
import type { EmbeddingEncoder } from "../embedding-runtime.js";

afterEach(() => vi.restoreAllMocks());
function encoder(wrong = false): EmbeddingEncoder {
  return { close() {}, encode: async (texts) => texts.map((text) => {
    const document = EMBEDDING_CHECK.documents.findIndex(([title]) => text.startsWith(`title: ${title} |`));
    const expected = EMBEDDING_CHECK.queries.find(([query]) => text.endsWith(query))?.[1];
    const axis = document >= 0 ? document : wrong ? 7 : Math.max(0, EMBEDDING_CHECK.documents.findIndex(([title]) => title === expected));
    return Array.from({ length: 768 }, (_, index) => index === axis ? 1 : 0);
  }) };
}

it("rejects failed retrieval, slow queries and incompatible readiness records", async () => {
  const report = await validateEmbeddings(encoder(), () => "webgpu");
  expect(compatibleValidation(report)).toBe(true);
  expect(compatibleValidation({ ...report, version: "old-model" })).toBe(false);
  expect(compatibleValidation({ ...report, correct: 0 })).toBe(false);
  await expect(validateEmbeddings(encoder(true), () => "cpu")).rejects.toThrow("retrieval checks");
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now += 1500);
  await expect(validateEmbeddings(encoder(), () => "cpu")).rejects.toThrow("more than one second");
});
