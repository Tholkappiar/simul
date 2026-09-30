// Turns people and countries into the short English text Laya reads, and builds the questions.
// Laya's time grows with text length, so descriptions are kept compact and the most important
// facts come first (Laya truncates the end).
import type { Question } from "../ai/protocol";
import type { Country, Family, Minutes, Person, WorldEvent } from "./types";

/** What prompts need from the world (kept small to avoid a circular import). */
export interface PromptContext {
  people: Person[];
  countries: Country[];
  families: Family[];
  events: WorldEvent[];
  t: Minutes;
  moneyRatio(p: Person): number;
}

const DAY = 1440;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ago = (mins: number) => (mins < 60 ? "just now" : mins < DAY ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / DAY)}d ago`);

// ---------- people ----------

const TRAIT_WORDS: Record<string, [string, string]> = {
  openness: ["curious and imaginative", "traditional and set in their ways"],
  conscientiousness: ["disciplined and hard-working", "careless and spontaneous"],
  extraversion: ["outgoing and sociable", "quiet and reserved"],
  agreeableness: ["kind and trusting", "stubborn and suspicious of others"],
  neuroticism: ["anxious and easily upset", "calm and emotionally steady"],
};
/** One word per trait, for Laya (shorter text = faster answers). */
const SHORT_TRAITS: Record<string, [string, string]> = {
  openness: ["curious", "traditional"],
  conscientiousness: ["disciplined", "careless"],
  extraversion: ["outgoing", "reserved"],
  agreeableness: ["kind", "stubborn"],
  neuroticism: ["anxious", "calm"],
};

/** Longer phrases, for the sidebar. */
export function personalityWords(p: Person): string[] {
  const out: string[] = [];
  for (const [k, [hi, lo]] of Object.entries(TRAIT_WORDS)) {
    const v = p.traits[k as keyof Person["traits"]];
    if (Math.abs(v - 0.5) < 0.12) continue;
    out.push((Math.abs(v - 0.5) > 0.25 ? "very " : "") + (v > 0.5 ? hi : lo));
  }
  return out;
}

export function beliefWords(p: Person): string[] {
  const b = p.beliefs, out: string[] = [];
  if (b.religiosity > 0.65) out.push("deeply religious"); else if (b.religiosity < 0.3) out.push("not religious");
  if (b.patriotism > 0.65) out.push("patriotic"); else if (b.patriotism < 0.3) out.push("not patriotic");
  if (b.trustGov > 0.65) out.push("trusts the government"); else if (b.trustGov < 0.35) out.push("distrusts the government");
  return out;
}

function shortTraits(p: Person): string[] {
  const out: string[] = [];
  for (const [k, [hi, lo]] of Object.entries(SHORT_TRAITS)) {
    const v = p.traits[k as keyof Person["traits"]];
    if (Math.abs(v - 0.5) >= 0.15) out.push(v > 0.5 ? hi : lo);
  }
  return [...out, ...beliefWords(p).map((w) => w.replace("deeply ", ""))];
}

function stateWords(p: Person, ctx: PromptContext): string[] {
  const n = p.needs, f = p.feelings, out: string[] = [];
  if (n.hunger < 0.15) out.push("starving"); else if (n.hunger < 0.35) out.push("hungry");
  if (n.energy < 0.15) out.push("exhausted"); else if (n.energy < 0.35) out.push("tired");
  if (n.social < 0.3) out.push("lonely");
  if (n.health < 0.4) out.push("badly injured"); else if (n.health < 0.75) out.push("injured");
  const money = ctx.moneyRatio(p);
  if (money < 0.2) out.push("almost broke"); else if (money < 0.4) out.push("short of money");
  if (f.joy > 0.7) out.push("happy"); else if (f.joy < 0.3) out.push("unhappy");
  if (f.sadness > 0.6) out.push("heartbroken"); else if (f.sadness > 0.4) out.push("sad");
  if (f.anger > 0.6) out.push("furious"); else if (f.anger > 0.4) out.push("angry");
  if (f.fear > 0.6) out.push("terrified"); else if (f.fear > 0.4) out.push("afraid");
  for (const c of ctx.countries) if (p.hate[c.id] > 0.5) out.push(`hates ${c.name}`);
  return out;
}

/** About 60–120 tokens: who they are, what's happening, how they are, and what's going on around them. */
export function describePerson(p: Person, ctx: PromptContext, situation: string): string {
  const c = ctx.countries[p.country];
  const role = p.job.works ? p.job.label : p.job.id === "child" ? "child" : p.job.id === "student" && p.age < 18 ? "schoolchild" : p.job.id;
  const lines = [`${p.name}, ${p.age}, ${p.sex === "M" ? "male" : "female"} ${role} in ${c.name}.`];
  const traits = shortTraits(p);
  if (traits.length) lines.push(`${cap(traits.join(", "))}.`);
  lines.push(situation);

  const state = stateWords(p, ctx);
  if (state.length) lines.push(`${p.first} is ${list(state)}.`);

  const fam: string[] = [];
  const kin = p.rels.filter((r) => r.kind !== "friend");
  const spouse = kin.find((r) => r.kind === "spouse");
  if (spouse && ctx.people[spouse.id].alive) fam.push("married");
  const kids = kin.filter((r) => r.kind === "child" && ctx.people[r.id].alive).length;
  if (kids) fam.push(`${kids} ${kids > 1 ? "children" : "child"}`);
  const lost = kin.filter((r) => !ctx.people[r.id].alive).map((r) => `${r.kind} ${ctx.people[r.id].first}`);
  if (lost.length) fam.push(`lost ${list(lost)}`);
  if (fam.length) lines.push(`${cap(fam.join(", "))}.`);

  if (c.atWar.some(Boolean)) lines.push(`${c.name} is at war with ${list(ctx.countries.filter((o) => c.atWar[o.id]).map((o) => o.name))}.`);
  if (c.curfewUntil > ctx.t) lines.push("There is a curfew.");
  const news = c.news.filter((n) => ctx.t - n.t < 3 * DAY).at(-1);
  if (news) lines.push(`News (${ago(ctx.t - news.t)}): ${news.text}`);

  const mem = [...p.memories].sort((a, b) => b.weight - a.weight)[0];
  if (mem) lines.push(`Remembers: ${mem.text}`);
  lines.push(`Likes ${list(p.likes)}.`);
  return lines.join(" ");
}

export interface ChoiceOption {
  key: string;
  desc: string; // what Laya reads, kept to a few words
}

/** Which extra questions come with this decision. Most decisions are just the choice. */
export interface DecisionAsk {
  mood: boolean; // morning check or a big event: joy and fear
  sadness: boolean; // after a loss
  anger: boolean; // after violence
  hateTarget: Country | null; // a country that attacked them
  faith: boolean; // lost someone and has some faith
  blameGov: boolean; // their own government did it
}

/**
 * What the person does next. The options carry their own length ("~2 hours", "until morning"),
 * so picking one also decides when they're asked again.
 */
export function decisionQuestions(p: Person, options: ChoiceOption[], ask: DecisionAsk, countryName: string): Record<string, Question> {
  const n = p.first;
  const q: Record<string, Question> = {
    act: { type: "choice", instructions: `What does ${n} do next?`, criteria: Object.fromEntries(options.map((o) => [o.key, o.desc])) },
  };
  if (ask.mood) {
    q.joy = { type: "score", instructions: `How happy is ${n}?`, criteria: ["Miserable", "Unhappy", "Okay", "Happy"] };
    q.fear = { type: "score", instructions: `How afraid is ${n}?`, criteria: ["Safe", "Uneasy", "Afraid", "Terrified"] };
  }
  if (ask.sadness) q.sadness = { type: "score", instructions: `How sad is ${n}?`, criteria: ["Not sad", "A little", "Very sad", "Heartbroken"] };
  if (ask.anger) q.anger = { type: "score", instructions: `How angry is ${n}?`, criteria: ["Calm", "Irritated", "Angry", "Furious"] };
  if (ask.hateTarget) q.hate = { type: "score", instructions: `How much does ${n} hate ${ask.hateTarget.name}?`, criteria: ["Not at all", "A little", "A lot", "Deeply"] };
  if (ask.faith) q.faith = { type: "noul", instructions: `${n} turns to religion for comfort` };
  if (ask.blameGov) q.blame = { type: "noul", instructions: `${n} blames the government of ${countryName}` };
  return q;
}

// ---------- countries ----------

export interface Mood { joy: number; anger: number; fear: number; trust: number; protesters: number; soldiers: number; alive: number; dead: number }

export function countryMood(c: Country, people: Person[]): Mood {
  const m: Mood = { joy: 0, anger: 0, fear: 0, trust: 0, protesters: 0, soldiers: 0, alive: 0, dead: 0 };
  for (const p of people) {
    if (p.country !== c.id) continue;
    if (!p.alive) { m.dead++; continue; }
    m.alive++;
    m.joy += p.feelings.joy;
    m.anger += p.feelings.anger;
    m.fear += p.feelings.fear;
    m.trust += p.beliefs.trustGov;
    if (p.activity === "protest") m.protesters++;
    if (p.job.id === "soldier") m.soldiers++;
  }
  const n = Math.max(1, m.alive);
  m.joy /= n; m.anger /= n; m.fear /= n; m.trust /= n;
  return m;
}

export function describeCountry(c: Country, ctx: PromptContext, situation: string): string {
  const m = countryMood(c, ctx.people);
  const lines = [`${c.name} is ${c.government} of ${m.alive} people. Its leaders are ${c.temperament}.`, situation];
  const mood: string[] = [];
  if (m.anger > 0.45) mood.push("angry");
  if (m.fear > 0.45) mood.push("afraid");
  if (m.joy < 0.35) mood.push("unhappy"); else if (m.joy > 0.65) mood.push("content");
  lines.push(`The public is ${mood.length ? list(mood) : "calm"}, and ${m.trust < 0.4 ? "most distrust" : m.trust > 0.6 ? "most trust" : "many doubt"} the government.`);
  if (m.protesters) lines.push(`${m.protesters} people are protesting in the streets.`);
  lines.push(c.stability < 0.3 ? "The country is close to collapse." : c.stability < 0.5 ? "Unrest is growing." : "The country is stable.");
  const rel: string[] = [];
  for (const o of ctx.countries) {
    if (o.id === c.id) continue;
    const v = c.relations[o.id];
    rel.push(c.atWar[o.id] ? `at war with ${o.name}` : v < -0.5 ? `enemies with ${o.name}` : v < -0.15 ? `tense with ${o.name}` : v > 0.4 ? `friendly with ${o.name}` : `neutral towards ${o.name}`);
  }
  lines.push(`${c.name} is ${list(rel)}.`);
  // Its history: what happened at home, and what governments did around the world lately.
  for (const n of c.news.filter((n) => ctx.t - n.t < 3 * DAY).slice(-2)) lines.push(`At home (${ago(ctx.t - n.t)}): ${n.text}`);
  for (const e of ctx.events.filter((e) => e.cid !== undefined && e.cid !== c.id && ctx.t - e.t < 3 * DAY).slice(-3)) lines.push(`Abroad (${ago(ctx.t - e.t)}): ${e.text}`);
  return lines.join(" ");
}

export function policyQuestions(c: Country, options: ChoiceOption[], counterpart: Country | null): Record<string, Question> {
  const q: Record<string, Question> = {
    policy: { type: "choice", instructions: `What does the government of ${c.name} decide?`, criteria: Object.fromEntries(options.map((o) => [o.key, o.desc])) },
  };
  if (counterpart) q.trust = { type: "score", instructions: `How much does ${c.name} trust ${counterpart.name} now?`, criteria: ["Not at all", "A little", "Somewhat", "Completely"] };
  return q;
}
