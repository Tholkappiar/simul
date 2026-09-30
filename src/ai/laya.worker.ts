// Runs the Laya model off the main thread. One inference call blocks this worker for about a second,
// so the simulation and the canvas never wait on it.
import { Tokenizer } from "@huggingface/tokenizers";
import {
  Laya, buildSequence, collate, toInternal, renderOptions, tempBucket, clampTemperature, confidenceFromProbs,
  type LayaConfig,
} from "../laya/laya-core.js";
import type { Answer, FromWorker, Item, LoadOptions, ToWorker } from "./protocol";

const QTYPES = { choice: 0, score: 1, noul: 2 } as const;

let ort: any = null;
let laya: Laya | null = null;

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
const progress = (text: string, fraction: number | null = null) => post({ type: "progress", text, fraction });

async function fetchBytes(url: string, onProgress?: (got: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

interface WeightsEntry { name: string; size: number; sha256: string; parts: string[] }

// Weights come as 24 MiB parts; each part is kept in Cache Storage so later visits skip the download.
async function fetchWeights(base: string, entry: WeightsEntry) {
  let cache: Cache | null = null;
  try { cache = await caches.open("laya-" + entry.sha256.slice(0, 16)); } catch { /* private mode: just download */ }
  const out = new Uint8Array(entry.size);
  let off = 0, cached = 0;
  for (const part of entry.parts) {
    const url = base + part;
    let bytes: Uint8Array | null = null;
    try {
      const hit = cache && (await cache.match(url));
      if (hit) { bytes = new Uint8Array(await hit.arrayBuffer()); cached++; }
    } catch { /* cache read failed: download */ }
    if (!bytes) {
      const start = off;
      bytes = await fetchBytes(url, (got) =>
        progress(`Downloading model ${((start + got) / 1048576).toFixed(0)} / ${(entry.size / 1048576).toFixed(0)} MB`, (start + got) / entry.size));
      try { await cache?.put(url, new Response(bytes as BlobPart)); } catch { /* quota: fine */ }
    }
    out.set(bytes, off);
    off += bytes.length;
  }
  if (off !== entry.size) throw new Error(`weights incomplete: ${off} of ${entry.size} bytes`);
  return { data: out, partsFromCache: `${cached}/${entry.parts.length}` };
}

async function load(o: LoadOptions) {
  ort = await import(/* @vite-ignore */ o.ortDir + "ort.min.mjs");
  ort.env.wasm.wasmPaths = o.ortDir;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? o.threads : 1;

  progress("Loading tokenizer…", 0);
  const base = o.modelBase.replace(/\/?$/, "/");
  const json = (f: string) => fetch(base + f).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
  const [manifest, tj, tc, cfg] = await Promise.all(["manifest.json", "tokenizer.json", "tokenizer_config.json", "rl_agent_config.json"].map(json));
  const v = manifest.variants[o.variant];
  if (!v) throw new Error(`build ${o.variant} not in manifest`);
  const tokenizer = new Tokenizer(tj, tc);

  const t0 = performance.now();
  const graph = await fetchBytes(base + v.onnx);
  const w = await fetchWeights(base, v.data);
  const downloadMs = performance.now() - t0;

  progress("Starting model…", null);
  const t1 = performance.now();
  const session = await ort.InferenceSession.create(graph, {
    executionProviders: o.backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
    externalData: [{ path: v.data.name, data: w.data }],
  });
  const sessionMs = performance.now() - t1;
  laya = new Laya(ort, session, tokenizer, cfg as LayaConfig);

  progress("Warming up…", null);
  const t2 = performance.now();
  await run([{ state: "warm up", question: { type: "noul", instructions: "This is a warm-up call" } }]);
  const warmupMs = performance.now() - t2;

  post({ type: "ready", stats: { downloadMs, sessionMs, warmupMs, partsFromCache: w.partsFromCache, threads: ort.env.wasm.numThreads, backend: o.backend } });
}

/** Rows per forward pass. A batch of 8 people can hold 60+ questions; running them in chunks keeps memory in check. */
const CHUNK = 16;

async function run(items: Item[]): Promise<{ answers: Answer[]; modelMs: number }> {
  const answers: Answer[] = [];
  let modelMs = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const r = await runChunk(items.slice(i, i + CHUNK));
    answers.push(...r.answers);
    modelMs += r.modelMs;
  }
  return { answers, modelMs };
}

// Laya.systemOne shares one state across its questions. Here every item has its own state, so each
// (state, question) pair becomes one row, all scored in a single forward pass.
async function runChunk(items: Item[]): Promise<{ answers: Answer[]; modelMs: number }> {
  if (!laya) throw new Error("model not loaded");
  const cfg = laya.cfg;
  const qs = items.map((it) => toInternal(it.question));
  const rows = items.map((it, i) => {
    const s = buildSequence(laya!.tok, laya!.sp, it.state, qs[i], cfg.max_len ?? 512, cfg.head_max_len ?? 192);
    if (s.markers.length !== renderOptions(qs[i]).length) throw new Error(`options too long: ${it.question.instructions}`);
    return { ...s, qtype: QTYPES[qs[i].t] };
  });
  const b = collate(rows, laya.sp.pad);
  const feeds = {
    input_ids: new ort.Tensor("int64", b.ids, [b.n, b.L]),
    attention_mask: new ort.Tensor("int64", b.att, [b.n, b.L]),
    marker_pos: new ort.Tensor("int64", b.mpos, [b.n, b.kmax]),
    marker_mask: new ort.Tensor("bool", b.mmask, [b.n, b.kmax]),
    qtype: new ort.Tensor("int64", b.qtype, [b.n]),
  };
  const t0 = performance.now();
  const out = await laya.session.run(feeds);
  const modelMs = performance.now() - t0;
  const logits = out.logits.data as Float32Array;

  // Same calibration as Laya.systemOne: per-type temperature, softmax, confidence = 1 - normalized entropy.
  const answers = rows.map((row, r): Answer => {
    const q = qs[r], k = row.markers.length;
    const temp = clampTemperature(cfg.temperature_by_options?.[tempBucket(row.qtype, k)] ?? cfg.temperature[row.qtype]);
    const z = Array.from({ length: k }, (_, i) => logits[r * b.kmax + i] / temp);
    const zmax = Math.max(...z);
    const e = z.map((x) => Math.exp(x - zmax));
    const sum = e.reduce((a, x) => a + x, 0);
    const p = e.map((x) => x / sum);
    const confidence = confidenceFromProbs(p, k);
    if (q.t === "choice") {
      const keys = Object.keys(q.crit);
      const top = p.indexOf(Math.max(...p));
      return { type: "choice", choice: keys[top], probabilities: Object.fromEntries(keys.map((key, i) => [key, p[i]])), confidence };
    }
    if (q.t === "score") return { type: "score", score: p.reduce((a, x, i) => a + i * x, 0), probabilities: p, confidence };
    return { type: "noul", p: p[1], confidence: Math.max(p[1], 1 - p[1]) };
  });
  return { answers, modelMs };
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "load") {
    try { await load(msg.options); }
    catch (err) { post({ type: "error", message: (err as Error)?.message ?? String(err) }); }
  } else if (msg.type === "run") {
    const t0 = performance.now();
    try {
      const { answers, modelMs } = await run(msg.items);
      post({ type: "result", id: msg.id, answers, modelMs, totalMs: performance.now() - t0 });
    } catch (err) {
      post({ type: "error", id: msg.id, message: (err as Error)?.message ?? String(err) });
    }
  }
};
