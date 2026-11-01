// Shipped as a file asset: native dependencies live in the opt-in runtime,
// never in the server's bundle or event loop. Stdout is only the RPC protocol.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const [runtime, cache, download, deviceOverride] = process.argv.slice(2);
console.log = (...args) => console.error(...args);
const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const revision = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";
const id = "onnx-community/embeddinggemma-2-ONNX";
try {
  const { AutoConfig, AutoModel, AutoTokenizer, env } = await import(pathToFileURL(path.join(runtime, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs")).href);
  env.cacheDir = cache;
  env.allowRemoteModels = download === "download";
  const source = env.allowRemoteModels ? id : path.join(cache, id, revision);
  const options = { revision, local_files_only: !env.allowRemoteModels };
  const config = await AutoConfig.from_pretrained(source, options);
  config.vision_config = null;
  config.audio_config = null;
  const progress_callback = (progress) => {
    if (progress.status === "progress") reply({ progress: progress.file, percent: progress.progress });
    else if (progress.status === "done") reply({ progress: progress.file, percent: 100 });
  };
  const load = (device) => AutoModel.from_pretrained(source, {
    ...options, config, dtype: "q4", device, progress_callback,
    session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
  });
  let device = deviceOverride === "cpu" ? "cpu" : process.platform === "darwin" || process.platform === "win32" ? "webgpu" : "cpu";
  let model;
  try { model = await load(device); }
  catch (error) {
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
      const { texts } = JSON.parse(line);
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > 8 || texts.some((text) => typeof text !== "string" || text.length > 10000)) throw new Error("Invalid embedding batch");
      let inputs, output;
      try {
        inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: 2048 });
        try { output = await model(inputs); }
        catch (error) {
          if (device === "cpu") throw error;
          await model.dispose();
          device = "cpu";
          model = await load(device);
          output = await model(inputs);
        }
        reply({ vectors: output.sentence_embedding.tolist(), device });
      } finally {
        for (const tensor of Object.values(output ?? {})) tensor.dispose?.();
        for (const tensor of Object.values(inputs ?? {})) tensor.dispose?.();
      }
    } catch { reply({ error: "Embedding inference failed" }); }
  }
  await model.dispose();
} catch {
  reply({ error: "Local memory model unavailable. Retry setup in Settings → Memory." });
  process.exitCode = 1;
}
