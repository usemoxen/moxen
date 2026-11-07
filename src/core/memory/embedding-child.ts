// The embedding worker's protocol: native dependencies live in the opt-in
// runtime, never in the server's bundle or event loop. Stdout is only the
// RPC protocol. `embedding-child-entry.ts` runs this when spawned directly;
// the standalone executable dispatches to it in-process instead.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

interface TransformersEnv {
  cacheDir: string;
  allowRemoteModels: boolean;
}

interface TransformersConfig {
  vision_config: unknown;
  audio_config: unknown;
}

interface SentenceEmbedding {
  sentence_embedding: { tolist(): readonly number[][] };
}

interface EmbeddingModel {
  (inputs: unknown): Promise<SentenceEmbedding>;
  dispose(): Promise<void>;
}

interface TransformersApi {
  readonly env: TransformersEnv;
  readonly AutoConfig: { from_pretrained(source: string, options: Record<string, unknown>): Promise<TransformersConfig> };
  readonly AutoModel: { from_pretrained(source: string, options: Record<string, unknown>): Promise<EmbeddingModel> };
  readonly AutoTokenizer: { from_pretrained(source: string, options: Record<string, unknown>): Promise<(texts: readonly string[], options: Record<string, unknown>) => Promise<unknown>> };
}

const REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";
const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";

/** Runs the worker protocol over stdio; `argv` is `[runtime, cache, download|offline, device]`. */
export async function runEmbeddingChild(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [runtime, cache, download, deviceOverride] = argv;
  console.log = (...args: unknown[]) => console.error(...args);
  const reply = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  try {
    if (runtime === undefined || cache === undefined || download === undefined) throw new Error("expected <runtime> <cache> <download|offline> [device]");
    const { AutoConfig, AutoModel, AutoTokenizer, env } = (await import(
      pathToFileURL(path.join(runtime, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs")).href
    )) as unknown as TransformersApi;
    env.cacheDir = cache;
    env.allowRemoteModels = download === "download";
    const source = env.allowRemoteModels ? MODEL_ID : path.join(cache, MODEL_ID, REVISION);
    const options: Record<string, unknown> = { revision: REVISION, local_files_only: !env.allowRemoteModels };
    const config = await AutoConfig.from_pretrained(source, options);
    config.vision_config = null;
    config.audio_config = null;
    const progress_callback = (progress: { status: string; file: string; progress: number }): void => {
      if (progress.status === "progress") reply({ progress: progress.file, percent: progress.progress });
      else if (progress.status === "done") reply({ progress: progress.file, percent: 100 });
    };
    const load = (device: string): Promise<EmbeddingModel> =>
      AutoModel.from_pretrained(source, {
        ...options,
        config,
        dtype: "q4",
        device,
        progress_callback,
        session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
      });
    let device = deviceOverride === "cpu" ? "cpu" : process.platform === "darwin" || process.platform === "win32" ? "webgpu" : "cpu";
    let model: EmbeddingModel;
    try {
      model = await load(device);
    } catch (error) {
      if (device === "cpu") throw error;
      device = "cpu";
      model = await load(device);
    }
    const tokenizer = await AutoTokenizer.from_pretrained(source, { ...options, progress_callback });
    // Search must never trigger a download, even after setup used this process.
    env.allowRemoteModels = false;
    reply({ ready: true, device });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const { texts } = JSON.parse(line) as { texts?: unknown };
        if (!Array.isArray(texts) || texts.length < 1 || texts.length > 8 || texts.some((text) => typeof text !== "string" || text.length > 10000)) throw new Error("Invalid embedding batch");
        let inputs: unknown;
        let output: SentenceEmbedding | undefined;
        try {
          inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: 2048 });
          try {
            output = await model(inputs);
          } catch (error) {
            if (device === "cpu") throw error;
            await model.dispose();
            device = "cpu";
            model = await load(device);
            output = await model(inputs);
          }
          reply({ vectors: output.sentence_embedding.tolist(), device });
        } finally {
          for (const tensor of Object.values(output ?? {}) as Array<{ dispose?: () => unknown }>) tensor.dispose?.();
          for (const tensor of Object.values((inputs ?? {}) as Record<string, unknown>) as Array<{ dispose?: () => unknown }>) tensor.dispose?.();
        }
      } catch {
        reply({ error: "Embedding inference failed" });
      }
    }
    await model.dispose();
  } catch {
    reply({ error: "Local memory model unavailable. Retry setup in Settings → Memory." });
    process.exitCode = 1;
  }
}
