import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { validEmbedding } from "./embedding-cache.js";
import { renameReplacing } from "../infra/atomic.js";
import { compatibleValidation, validateEmbeddings, type EmbeddingValidation } from "./embedding-validation.js";

export interface EmbeddingEncoder {
  encode(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
  close(): void;
}

export interface EmbeddingStatus {
  readonly state: "stopped" | "loading" | "ready" | "failed";
  readonly device: string | null;
  readonly message: string | null;
  readonly file: string | null;
  readonly percent: number | null;
  readonly phase: "idle" | "installing" | "downloading" | "validating" | "indexing";
  readonly validation: EmbeddingValidation | null;
}

/** One native process per server, serialized batches, hard cancellation and idle unloading. */
export class EmbeddingRuntime implements EmbeddingEncoder {
  private child: ChildProcessWithoutNullStreams | null = null;
  private installer: ChildProcess | null = null;
  private pending: { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private keepLoaded = false;
  private preferredDevice: "auto" | "cpu" | "webgpu" = "auto";
  status: EmbeddingStatus = { state: "stopped", device: null, message: null, file: null, percent: null, phase: "idle", validation: null };

  constructor(private readonly storeRoot: string, private readonly processFile?: string) {}

  private get root(): string { return path.join(this.storeRoot, "embedding-runtime", "transformers-4.3.2"); }

  private fail(message: string): void {
    this.stop(false);
    this.status = { ...this.status, state: "failed", message };
  }

  close(): void {
    this.stop(true);
  }

  private stop(cancelQueued: boolean): void {
    if (cancelQueued) this.generation++;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.installer?.kill();
    this.installer = null;
    this.pending?.reject(new Error("Embedding process stopped"));
    this.pending = null;
    this.status = { ...this.status, state: "stopped" };
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.keepLoaded) { this.idle = null; return; }
    this.idle = setTimeout(() => this.close(), 60_000);
    this.idle.unref();
  }

  private receive(timeout: number, signal?: AbortSignal, sent?: () => boolean): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending = null;
        fn();
      };
      // A plain cancel rejects only this caller and never fails the runtime.
      // The child protocol has no cancel verb and no request ids, so when the
      // request already reached the child its late reply would resolve the
      // next caller's receive: restart the child to keep replies matched.
      const abort = () => {
        if (sent?.() ?? true) {
          const child = this.child;
          this.child = null;
          if (this.idle) {
            clearTimeout(this.idle);
            this.idle = null;
          }
          child?.kill();
          this.status = { ...this.status, state: "stopped" };
        }
        finish(() => reject(new Error("Embedding request cancelled")));
      };
      const timer = setTimeout(() => this.fail("Embedding request timed out"), timeout);
      this.pending = { resolve: (value) => finish(() => resolve(value)), reject: (error) => finish(() => reject(error)) };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private async start(download = false, signal?: AbortSignal): Promise<void> {
    if (this.child) return;
    const generation = this.generation;
    if (!download && this.preferredDevice === "auto") {
      const report = await this.readValidation();
      if (report) {
        this.preferredDevice = report.device as "cpu" | "webgpu";
        this.status = { ...this.status, validation: report };
      }
    }
    const asset = this.processFile ?? (await import("./embedding-process.mjs" as string, { with: { type: "file" } })).default as string;
    if (generation !== this.generation || signal?.aborted) throw new Error("Embedding request cancelled");
    const file = path.isAbsolute(asset) ? asset : fileURLToPath(new URL(asset, import.meta.url));
    this.status = { ...this.status, state: "loading", device: null, message: null, file: null, percent: null, phase: download ? "downloading" : this.status.phase === "validating" ? "validating" : "idle" };
    const child = spawn(process.execPath, [file, this.root, path.join(this.root, "cache"), download ? "download" : "offline", this.preferredDevice], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdin.on("error", () => { if (this.child === child) this.fail("Embedding process input failed"); });
    // Do not forward native logs or environment-dependent details to clients.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.child !== child) return;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.progress === "string") this.status = { ...this.status, file: value.progress, percent: typeof value.percent === "number" && Number.isFinite(value.percent) ? Math.min(100, Math.max(0, value.percent)) : null };
        else if (value.error) this.fail("Local memory model unavailable. Retry setup in Settings → Memory.");
        else {
          if (typeof value.device === "string") this.status = { ...this.status, device: value.device };
          this.pending?.resolve(value);
        }
      } catch { this.fail("Invalid response from embedding process"); }
    });
    child.on("error", () => { if (this.child === child) this.fail("Could not start embedding process"); });
    child.on("exit", () => { lines.close(); if (this.child === child) this.fail("Embedding process exited"); });
    await this.receive(download ? 600_000 : 30_000, signal);
    this.status = { ...this.status, state: "ready", message: null };
    this.armIdle();
  }

  private serial<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const generation = this.generation;
    const result = this.tail.then(() => {
      if (generation !== this.generation || signal?.aborted) throw new Error("Embedding request cancelled");
      return operation();
    });
    this.tail = result.catch(() => undefined);
    if (!signal) return result;
    // An interactive search must be able to leave the queue while setup or
    // another request owns the process. It must not wait for that work to end.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error("Embedding request cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      result.then(
        (value) => { signal.removeEventListener("abort", abort); resolve(value); },
        (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
      );
      if (signal.aborted) abort();
    });
  }

  /** Explicit opt-in only. No install or remote model fetch occurs in encode(). */
  setup(): Promise<void> {
    return this.serial(async () => {
      this.close();
      const generation = this.generation;
      this.preferredDevice = "auto";
      this.status = { state: "loading", device: null, message: null, file: null, percent: null, phase: "installing", validation: null };
      await mkdir(this.root, { recursive: true });
      await rm(path.join(this.root, "validation.json"), { force: true });
      await writeFile(path.join(this.root, "package.json"), JSON.stringify({ private: true, dependencies: { "@huggingface/transformers": "4.3.2" }, trustedDependencies: ["onnxruntime-node", "sharp"] }));
      if (generation !== this.generation) throw new Error("Embedding setup cancelled");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["install", "--cwd", this.root], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
        this.installer = child;
        const timer = setTimeout(() => { child.kill(); reject(new Error("Embedding runtime installation timed out")); }, 600_000);
        child.once("error", () => { clearTimeout(timer); this.installer = null; reject(new Error("Could not install embedding runtime")); });
        child.once("exit", (code) => { clearTimeout(timer); this.installer = null; code === 0 ? resolve() : reject(new Error("Could not install embedding runtime")); });
      });
      if (generation !== this.generation) throw new Error("Embedding setup cancelled");
      try { await this.start(true); }
      catch (error) {
        if (generation !== this.generation) throw error;
        this.preferredDevice = "cpu";
        await this.start(true);
      }
    }).catch((error: unknown) => { this.fail(error instanceof Error ? error.message : "Embedding setup failed"); throw error; });
  }

  setKeepLoaded(value: boolean): void {
    this.keepLoaded = value;
    if (this.child) this.armIdle();
  }

  async readValidation(): Promise<EmbeddingValidation | null> {
    const value: unknown = await readFile(path.join(this.root, "validation.json"), "utf8").then((text) => JSON.parse(text) as unknown).catch(() => null);
    return compatibleValidation(value) ? value : null;
  }

  /** Startup never provisions. Only a previously validated local install is warmed. */
  warm(): Promise<void> {
    return this.serial(async () => {
      const generation = this.generation;
      const report = await this.readValidation();
      if (!report || generation !== this.generation) return;
      this.status = { ...this.status, validation: report };
      this.preferredDevice = report.device as "cpu" | "webgpu";
      await this.start();
    });
  }

  async validate(): Promise<EmbeddingValidation> {
    let generation = this.generation;
    this.status = { ...this.status, phase: "validating" };
    let report: EmbeddingValidation;
    try {
      try { report = await validateEmbeddings(this, () => this.status.device); }
      catch (error) {
        if (generation !== this.generation) throw error;
        if (this.preferredDevice === "cpu" || this.status.device === "cpu") throw error;
        this.close();
        generation = this.generation;
        this.preferredDevice = "cpu";
        this.status = { ...this.status, phase: "validating" };
        report = await validateEmbeddings(this, () => this.status.device);
      }
      if (generation !== this.generation) throw new Error("Memory model validation cancelled");
      const file = path.join(this.root, "validation.json");
      const tmp = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(tmp, JSON.stringify(report)); await renameReplacing(tmp, file); }
      finally { await rm(tmp, { force: true }); }
      this.status = { ...this.status, phase: "idle", validation: report };
      return report;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Memory model validation failed");
      throw error;
    }
  }

  encode(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (texts.length < 1 || texts.length > 8 || texts.some((text) => text.length > 10000)) return Promise.reject(new Error("Invalid embedding batch"));
    return this.serial(async () => {
      if (signal?.aborted) throw new Error("Embedding request cancelled");
      if (this.idle) clearTimeout(this.idle);
      await this.start(false, signal);
      if (signal?.aborted) throw new Error("Embedding request cancelled");
      let sent = false;
      const response = this.receive(30_000, signal, () => sent);
      try {
        const child = this.child;
        child?.stdin.write(`${JSON.stringify({ texts })}\n`, (error) => { if (error && this.child === child) this.fail("Embedding process input failed"); });
        sent = true;
        const value = await response;
        if (!Array.isArray(value.vectors) || value.vectors.length !== texts.length || !value.vectors.every(validEmbedding)) {
          this.fail("Invalid embedding vectors");
          throw new Error("Invalid embedding vectors");
        }
        return value.vectors as number[][];
      } finally { if (this.child) this.armIdle(); }
    }, signal);
  }
}
