// Messages between the main thread (AiClient) and the Laya Web Worker.
import type { Question } from "../laya/laya-core.js";

export type { Question };

export type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: number[]; confidence: number }
  | { type: "noul"; p: number; confidence: number };

export type Backend = "wasm" | "webgpu";

export interface LoadOptions {
  modelBase: string;
  variant: "q8e8" | "q4e8";
  backend: Backend;
  threads: number;
  ortDir: string;
}

export interface LoadStats {
  downloadMs: number;
  sessionMs: number;
  warmupMs: number;
  partsFromCache: string;
  threads: number;
  backend: Backend;
}

/** One (state, question) pair. A batch mixes items from different people into one forward pass. */
export interface Item {
  state: string;
  question: Question;
}

export type ToWorker =
  | { type: "load"; options: LoadOptions }
  | { type: "run"; id: number; items: Item[] };

export type FromWorker =
  | { type: "progress"; text: string; fraction: number | null }
  | { type: "ready"; stats: LoadStats }
  | { type: "result"; id: number; answers: Answer[]; modelMs: number; totalMs: number }
  | { type: "error"; id?: number; message: string };
