// Types for the parts of laya-core.js (ported from layaForWeb) that the app uses.

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> | string[] }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

export interface InternalQuestion {
  t: "choice" | "score" | "noul";
  ins: string;
  crit: any;
}

export interface Sequence {
  ids: number[];
  markers: number[];
}

export interface Batch {
  n: number;
  L: number;
  kmax: number;
  ids: BigInt64Array;
  att: BigInt64Array;
  mpos: BigInt64Array;
  mmask: Uint8Array;
  qtype: BigInt64Array;
}

export interface SpecialIds {
  cls: number;
  sep: number;
  mask: number;
  pad: number;
}

export interface LayaConfig {
  max_len?: number;
  head_max_len?: number;
  temperature: number[];
  temperature_by_options?: Record<string, number>;
}

export function toInternal(q: Question): InternalQuestion;
export function renderOptions(q: InternalQuestion): string[];
export function specialIds(tok: unknown): SpecialIds;
export function buildSequence(tok: unknown, sp: SpecialIds, state: unknown, q: InternalQuestion, maxLen?: number, headMaxLen?: number): Sequence;
export function tempBucket(qt: number, k: number): string;
export function clampTemperature(t: unknown): number;
export function confidenceFromProbs(p: number[], k: number): number;
export function collate(items: (Sequence & { qtype: number })[], padId: number): Batch;

export class Laya {
  constructor(ort: unknown, session: unknown, tokenizer: unknown, cfg: LayaConfig);
  ort: any;
  session: any;
  tok: unknown;
  cfg: LayaConfig;
  sp: SpecialIds;
  systemOne(state: unknown, questions: Record<string, Question>): Promise<unknown>;
}
