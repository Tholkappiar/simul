// Main-thread side of the Laya worker: a priority queue of decision jobs, batched into single
// forward passes, plus live timing stats.
import { URGENT, type AiJob, type AiPort } from "../sim/world";
import type { Answer, Backend, FromWorker, Item, LoadOptions, LoadStats } from "./protocol";

export const MODEL_BASES = {
  general: "https://huggingface.co/VishalMysore/layaForWeb/resolve/main/",
  typed: "https://huggingface.co/VishalMysore/layaForWebTrained/resolve/main/",
};
export type ModelBase = keyof typeof MODEL_BASES;

/** One batch = up to this many decisions (people or governments), sent to Laya together. */
export const BATCH_SIZE = 8;
/** How long a part-full batch waits for more decisions before it's sent anyway (ms). */
const GATHER_MS = 400;

interface Queued extends AiJob { queuedAt: number }
interface CallRecord { at: number; ms: number; items: number }

/** What the UI shows about batches. */
export interface BatchInfo {
  id: number;
  jobs: { key: string; label: string }[];
  items: number; // questions in the batch
  startedAt: number;
  ms?: number; // set when finished
}

export type AiStatus = "off" | "loading" | "ready" | "error";

const byPriority = (a: Queued, b: Queued) => b.priority - a.priority || a.queuedAt - b.queuedAt;

export class AiClient implements AiPort {
  status: AiStatus = "off";
  statusText = "Not loaded";
  progress: number | null = null;
  loadStats: LoadStats | null = null;

  /** The batch Laya is working on, and the one before it. */
  current: BatchInfo | null = null;
  lastBatch: BatchInfo | null = null;

  private worker: Worker | null = null;
  private queue: Queued[] = [];
  private inFlight: { id: number; jobs: Queued[]; items: number } | null = null;
  private nextId = 1;
  private calls: CallRecord[] = [];

  get ready() { return this.status === "ready"; }

  load(opts: { base: ModelBase; variant: LoadOptions["variant"]; backend: Backend; threads: number }) {
    if (this.status === "loading" || this.status === "ready") return;
    this.worker?.terminate(); // after an error, start clean
    this.status = "loading";
    this.statusText = "Starting…";
    this.worker = new Worker(new URL("./laya.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => { this.status = "error"; this.statusText = e.message || "The model worker failed to start"; };
    const ortDir = new URL(`${import.meta.env.BASE_URL}vendor/ort/`, location.href).href;
    this.worker.postMessage({
      type: "load",
      options: { modelBase: MODEL_BASES[opts.base], variant: opts.variant, backend: opts.backend, threads: opts.threads, ortDir },
    });
  }

  enqueue(job: AiJob) {
    this.queue.push({ ...job, queuedAt: performance.now() });
    this.pump();
  }

  remove(key: string): boolean {
    const i = this.queue.findIndex((j) => j.key === key);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  get queueLength() { return this.queue.length; }

  /** Keys ("p12", "c3") of everything in the running batch. */
  decidingKeys(): Set<string> {
    return new Set(this.inFlight?.jobs.map((j) => j.key) ?? []);
  }

  /** Where a job stands: 0 = Laya is working on it now, n = n-th in line, null = not queued. */
  position(key: string): number | null {
    if (this.inFlight?.jobs.some((j) => j.key === key)) return 0;
    const i = [...this.queue].sort(byPriority).findIndex((j) => j.key === key);
    return i < 0 ? null : i + 1;
  }

  /** Forget all work (when the world is regenerated). A running call finishes and is ignored. */
  clear() {
    this.queue = [];
    if (this.inFlight) this.inFlight.jobs = [];
    this.current = null;
    this.lastBatch = null;
  }

  /** Called every frame: starts the next call when the worker is free. */
  tick() { this.pump(); }

  private pump() {
    if (!this.ready || this.inFlight || !this.worker || !this.queue.length) return;
    // Give an everyday batch a moment to fill up; anything urgent goes right away.
    const urgent = this.queue.some((j) => j.priority >= URGENT);
    const oldest = Math.min(...this.queue.map((j) => j.queuedAt));
    if (!urgent && this.queue.length < BATCH_SIZE && performance.now() - oldest < GATHER_MS) return;
    // Highest priority first (oldest first within a priority), up to BATCH_SIZE decisions.
    this.queue.sort(byPriority);
    const jobs = this.queue.splice(0, BATCH_SIZE);
    const flat: Item[] = jobs.flatMap((j) => Object.values(j.questions).map((question) => ({ state: j.state, question })));
    const id = this.nextId++;
    this.inFlight = { id, jobs, items: flat.length };
    this.current = { id, jobs: jobs.map((j) => ({ key: j.key, label: j.label })), items: flat.length, startedAt: performance.now() };
    this.worker.postMessage({ type: "run", id, items: flat });
  }

  private onMessage(m: FromWorker) {
    if (m.type === "progress") { this.statusText = m.text; this.progress = m.fraction; return; }
    if (m.type === "ready") {
      this.status = "ready";
      this.loadStats = m.stats;
      this.progress = null;
      this.statusText = `Ready · ${m.stats.backend === "webgpu" ? "WebGPU" : `WASM ${m.stats.threads} threads`}`;
      this.pump();
      return;
    }
    if (m.type === "error" && m.id === undefined) {
      this.status = "error";
      this.statusText = m.message;
      this.progress = null;
      return;
    }
    const flight = this.inFlight;
    if (!flight || flight.id !== m.id) return;
    this.inFlight = null;
    if (this.current?.id === flight.id) {
      this.lastBatch = { ...this.current, ms: performance.now() - this.current.startedAt };
      this.current = null;
    }
    if (m.type === "error") {
      console.error("Laya call failed:", m.message);
      for (const j of flight.jobs) j.onDrop();
    } else if (m.type === "result") {
      const now = performance.now();
      this.calls.push({ at: now, ms: m.totalMs, items: flight.items });
      if (this.calls.length > 200) this.calls.shift();
      let i = 0;
      for (const job of flight.jobs) {
        const answers: Record<string, Answer> = {};
        for (const key of Object.keys(job.questions)) answers[key] = m.answers[i++];
        job.onResult(answers, { batchId: flight.id, callMs: m.totalMs, waitedMs: now - job.queuedAt, batchSize: flight.jobs.length });
      }
    }
    this.pump();
  }

  /** Live numbers for the UI. */
  stats() {
    const now = performance.now();
    const recent = this.calls.slice(-30);
    const sorted = recent.map((c) => c.ms).sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const lastMin = this.calls.filter((c) => now - c.at < 60_000);
    const qs = recent.reduce((a, c) => a + c.items, 0);
    const ms = recent.reduce((a, c) => a + c.ms, 0);
    return {
      p50CallMs: p50,
      msPerQuestion: qs ? ms / qs : null,
      questionsPerMin: lastMin.reduce((a, c) => a + c.items, 0),
      callsPerMin: lastMin.length,
      queue: this.queue.length,
    };
  }
}
