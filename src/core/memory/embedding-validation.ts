import { EMBEDDING_VERSION, validEmbedding } from "./embedding-cache.js";
import type { EmbeddingEncoder } from "./embedding-runtime.js";

/** A small readiness check, not a claim of general retrieval accuracy. */
export const EMBEDDING_CHECK = {
  documents: [
    ["secrets", "Authentication keys belong in the OS keychain. Provider CLIs manage their own login. Never print tokens."],
    ["paths", "Construct filesystem paths with node:path so directory separators work on Windows and macOS."],
    ["language", "The interface translation uses natural Spanish from Spain, with tú, never Latin American vocabulary."],
    ["ci", "CI must pass on every job before a pushed change is ready. Use bun run check locally."],
    ["tests", "Reduce suite latency by using isolated fixtures and avoiding unnecessary subprocesses."],
    ["model-cache", "Model weights are downloaded only during explicit setup. Reuse the pinned local directory offline."],
    ["memory-scopes", "Project memories describe the codebase; global memories describe user preferences. Read before updating."],
    ["ssh", "SSH remote access uses an encrypted tunnel to the server. Pair devices explicitly."],
  ],
  queries: [
    ["Where should an API credential be kept?", "secrets"],
    ["How do we avoid platform-specific directory separators?", "paths"],
    ["¿Qué variante del castellano usamos para traducir la interfaz?", "language"],
    ["Which jobs must pass before a pushed change is ready?", "ci"],
    ["How can we reduce the time spent running our checks?", "tests"],
    ["Can the model work without an internet connection?", "model-cache"],
  ],
} as const;

export interface EmbeddingValidation {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly device: string;
  readonly correct: number;
  readonly total: number;
  readonly queryP95Ms: number;
  readonly documentMs: number;
  readonly checkedAt: string;
}

export function compatibleValidation(value: unknown): value is EmbeddingValidation {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<EmbeddingValidation>;
  return report.version === EMBEDDING_VERSION && report.platform === process.platform && report.arch === process.arch &&
    (report.device === "cpu" || report.device === "webgpu") && report.total === EMBEDDING_CHECK.queries.length && report.correct === report.total &&
    typeof report.queryP95Ms === "number" && Number.isFinite(report.queryP95Ms) && report.queryP95Ms >= 0 && report.queryP95Ms <= 1000 &&
    typeof report.documentMs === "number" && Number.isFinite(report.documentMs) && report.documentMs >= 0 && typeof report.checkedAt === "string";
}

export async function validateEmbeddings(encoder: EmbeddingEncoder, device: () => string | null): Promise<EmbeddingValidation> {
  const signal = AbortSignal.timeout(45_000);
  const documentStart = performance.now();
  const documents = await encoder.encode(EMBEDDING_CHECK.documents.map(([title, text]) => `title: ${title} | text: ${text}`), signal);
  if (documents.length !== EMBEDDING_CHECK.documents.length || !documents.every(validEmbedding)) throw new Error("The memory model returned invalid document vectors.");
  const documentMs = performance.now() - documentStart;
  // Warm up separately: the latency check measures steady-state query cost.
  await encoder.encode(["task: search result | query: memory readiness check"], signal);
  const timings: number[] = [];
  let correct = 0;
  for (const [query, expected] of EMBEDDING_CHECK.queries) {
    const started = performance.now();
    const vector = (await encoder.encode([`task: search result | query: ${query}`], signal))[0];
    timings.push(performance.now() - started);
    if (!validEmbedding(vector)) throw new Error("The memory model returned an invalid query vector.");
    const scores = documents.map((document, index) => ({ index, score: document.reduce((sum, value, axis) => sum + value * vector[axis]!, 0) }));
    scores.sort((a, b) => b.score - a.score || a.index - b.index);
    if (EMBEDDING_CHECK.documents[scores[0]!.index]![0] === expected) correct++;
  }
  timings.sort((a, b) => a - b);
  const report: EmbeddingValidation = {
    version: EMBEDDING_VERSION, platform: process.platform, arch: process.arch, device: device() ?? "unknown",
    correct, total: EMBEDDING_CHECK.queries.length, queryP95Ms: timings[Math.ceil(timings.length * 0.95) - 1]!, documentMs, checkedAt: new Date().toISOString(),
  };
  if (correct !== report.total) throw new Error(`The memory model passed ${correct} of ${report.total} retrieval checks. Semantic search was not enabled.`);
  if (report.queryP95Ms > 1000) throw new Error("The memory model took more than one second per query in the readiness check. Semantic search was not enabled.");
  return report;
}
