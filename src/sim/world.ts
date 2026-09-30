// The simulation engine.
//
// Every choice a person or a government makes comes from Laya. Each option carries its own length
// ("~2 hours", "until morning"), so when Laya picks one, the person isn't asked again until it's done.
// Decisions are queued and sent in batches; if Laya falls behind, the clock waits (at most MAX_LAG).
//
// The code here only handles the physical world: hunger and tiredness, injuries, money, where a bomb
// lands and who it hits, and how fast news travels.
import type { Answer, Question } from "../ai/protocol";
import { DISASTERS, HOBBIES, RELATION_LABEL, SOLDIER } from "./data";
import { placeFamily, type WorldData } from "./generate";
import { Heap } from "./heap";
import { countryMood, decisionQuestions, describeCountry, describePerson, policyQuestions, type ChoiceOption, type PromptContext } from "./prompts";
import { between, chance, clamp01, mulberry32, pick, weighted, type Rng } from "./rng";
import type { ActivityId, Country, Disaster, DisasterKind, Family, LogEntry, LogKind, Minutes, PendingEvent, Person, WorldEvent } from "./types";

export const DAY = 1440;
const HOUR = 60;
const START: Minutes = 6 * HOUR; // day 1 (a Monday), 06:00
const LOG_LIMIT = 150;
/** The clock never runs further than this past the oldest decision still waiting for Laya. */
const MAX_LAG = 45;
/** Younger children follow the family routine instead of deciding for themselves. */
const TODDLER_AGE = 5;
/** Laya reads about this many options well; urgent ones always make the cut. */
const MAX_OPTIONS = 10;
/** Governments meet this often when nothing happens (sim minutes), twice as often at war. */
const REVIEW_EVERY = 6 * HOUR;

/**
 * Order of the Laya queue: reactions to events come first, governments before people.
 * Anything at or above URGENT skips waiting for a full batch.
 */
export const PRIORITY = { governmentEvent: 300, personEvent: 200, governmentReview: 100, everyday: 0 };
export const URGENT = PRIORITY.governmentReview;

export interface Cause {
  phrase: string; // "was killed by government soldiers"
  attacker: number | null;
  byGovernment: boolean;
}

export type KillCauseId = "accident" | "illness" | "soldiers";
export const KILL_CAUSES: Record<KillCauseId, { label: string; cause: Cause }> = {
  accident: { label: "Accident", cause: { phrase: "died in an accident", attacker: null, byGovernment: false } },
  illness: { label: "Sudden illness", cause: { phrase: "died of a sudden illness", attacker: null, byGovernment: false } },
  soldiers: { label: "Killed by soldiers", cause: { phrase: "was killed by government soldiers", attacker: null, byGovernment: true } },
};

type SimEvent =
  | { at: Minutes; kind: "due"; pid: number }
  | { at: Minutes; kind: "news"; pid: number; deadId: number; cause: Cause; shock: number }
  | { at: Minutes; kind: "emigrate"; pid: number }
  | { at: Minutes; kind: "country"; cid: number }
  | { at: Minutes; kind: "strike"; by: number; target: number };

/** What the world hands to the AI layer. */
export interface AiJob {
  key: string; // one job per person/country at a time: "p12", "c3"
  label: string; // who it's for, shown in the UI
  priority: number;
  state: string;
  questions: Record<string, Question>;
  onResult: (answers: Record<string, Answer>, info: AiInfo) => void;
  onDrop: () => void;
}
export interface AiInfo { batchId: number; callMs: number; waitedMs: number; batchSize: number }
export interface AiPort {
  enqueue(job: AiJob): void;
  /** Take a job out of the queue. False if it isn't queued (e.g. already running). */
  remove(key: string): boolean;
}

export type Selection = { type: "person"; id: number } | { type: "country"; id: number } | null;

interface ActOption extends ChoiceOption {
  id: ActivityId;
  label: string; // how it reads in the feed
  min: number; // duration range in minutes; sleep lasts until wake time instead
  max: number;
  withId?: number;
}

interface PolicyOption extends ChoiceOption {
  apply: () => string; // carries it out and says what happened
}

type ScoreAnswer = Extract<Answer, { type: "score" }>;
type NoulAnswer = Extract<Answer, { type: "noul" }>;
type ChoiceAnswer = Extract<Answer, { type: "choice" }>;

export const hourOf = (t: Minutes) => (t / HOUR) % 24;
export const dayOf = (t: Minutes) => Math.floor(t / DAY);
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export function formatTime(t: Minutes, withDay = true): string {
  const d = dayOf(t), h = Math.floor(hourOf(t)), m = Math.floor(t % HOUR);
  const hm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return withDay ? `Day ${d + 1} · ${WEEKDAYS[d % 7].slice(0, 3)} ${hm}` : hm;
}
export function formatDuration(mins: number): string {
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  if (mins < DAY) return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
  return `${Math.floor(mins / DAY)}d ${Math.floor((mins % DAY) / 60)}h`;
}
const an = (word: string) => (/^[aeiou]/i.test(word) ? "an " : "a ") + word;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** "~30 min", "~1 hour", "~3 hours": how long an option lasts, as Laya reads it. */
const about = (mins: number) => (mins < 45 ? `~${Math.round(mins / 10) * 10} min` : mins < 90 ? "~1 hour" : `~${Math.round(mins / 60)} hours`);
const clampRel = (x: number) => Math.max(-1, Math.min(1, x));

export class World implements PromptContext {
  readonly seed: number;
  readonly people: Person[];
  readonly families: Family[];
  readonly countries: Country[];
  disasters: Disaster[] = [];
  /** Government-ordered bombings on their way (drawn as arrows on the map). */
  strikes: { by: number; target: number; at: Minutes }[] = [];
  t: Minutes = START;
  events: WorldEvent[] = [];
  selection: Selection = null;
  layoutVersion = 0; // bumps when people move, so the renderer rebuilds its hit-test grid
  stats = { decisions: 0, feelingChecks: 0, countryDecisions: 0, deaths: 0, emigrations: 0, disasters: 0 };
  /** True while the clock is held back so Laya can catch up. */
  aiHolding = false;

  private ai: AiPort;
  private heap = new Heap<SimEvent>();
  private rng: Rng;
  private waitingIds = new Set<number>();
  /** Whether each government's queued decision is a response to an event or a routine meeting. */
  private countryJobs = new Map<number, { fromEvent: boolean }>();

  constructor(data: WorldData, ai: AiPort) {
    this.seed = data.seed;
    this.people = data.people;
    this.families = data.families;
    this.countries = data.countries;
    this.ai = ai;
    this.rng = mulberry32(data.seed ^ 0x9e3779b9);
    for (const p of this.people) {
      // Everyone starts asleep and wakes at their own hour.
      p.lastUpdate = this.t;
      p.activityStart = this.t;
      const wake = dayOf(this.t) * DAY + p.wakeHour * HOUR + between(this.rng, 0, 40);
      p.nextDecisionAt = Math.max(this.t + between(this.rng, 1, 30), wake);
      this.heap.push({ at: p.nextDecisionAt, kind: "due", pid: p.id });
    }
    for (const c of this.countries) {
      c.nextReviewAt = this.t + between(this.rng, 1, 3) * HOUR;
      this.scheduleCountry(c, c.nextReviewAt - this.t);
    }
  }

  // ---------- clock ----------

  /** Advance the clock by up to `dt` sim minutes, spending at most `budgetMs` of real time. */
  step(dt: Minutes, budgetMs = 6) {
    const from = this.t;
    let target = this.t + dt;
    const oldest = this.oldestWaiting();
    this.aiHolding = oldest !== null && target > oldest + MAX_LAG;
    if (oldest !== null && this.aiHolding) target = Math.max(this.t, oldest + MAX_LAG);

    const t0 = performance.now();
    let n = 0, done = true;
    while (this.heap.size && this.heap.peek()!.at <= target) {
      const ev = this.heap.pop()!;
      this.t = Math.max(this.t, ev.at);
      this.handle(ev);
      if ((++n & 63) === 0 && performance.now() - t0 > budgetMs) { done = false; break; }
    }
    if (done) this.t = target;
    this.updateCountries((this.t - from) / HOUR);
  }

  private oldestWaiting(): Minutes | null {
    let min: Minutes | null = null;
    for (const id of this.waitingIds) {
      const d = this.people[id].dueAt;
      if (min === null || d < min) min = d;
    }
    return min;
  }

  private handle(ev: SimEvent) {
    switch (ev.kind) {
      case "due": {
        const p = this.people[ev.pid];
        // Only the latest scheduled decision counts; older ones were superseded by events.
        if (p.alive && !p.waiting && ev.at === p.nextDecisionAt) this.decideNow(p);
        break;
      }
      case "news": {
        const p = this.people[ev.pid];
        if (p.alive) this.onNews(p, ev.deadId, ev.cause, ev.shock);
        break;
      }
      case "emigrate": {
        const p = this.people[ev.pid];
        if (p.alive) this.emigrate(p);
        break;
      }
      case "country": {
        const c = this.countries[ev.cid];
        if (ev.at === c.turnAt) this.countryTurn(c); // older bookings were replaced by an earlier one
        break;
      }
      case "strike": this.strike(ev.by, ev.target); break;
    }
  }

  // ---------- bookkeeping ----------

  log(p: Person, kind: LogKind, text: string, meta?: string) {
    pushLog(p.log, { t: this.t, kind, text, meta });
  }

  private worldEvent(text: string, pid?: number, cid?: number) {
    this.events.push({ t: this.t, realAt: performance.now(), text, pid, cid });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  private addNews(c: Country, text: string) {
    c.news.push({ t: this.t, text });
    if (c.news.length > 20) c.news.shift();
    pushLog(c.log, { t: this.t, kind: "event", text });
  }

  moneyRatio(p: Person): number {
    const f = this.families[p.family];
    const alive = f.members.reduce((n, id) => n + (this.people[id].alive ? 1 : 0), 0);
    return clamp01(f.money / (Math.max(1, alive) * 8));
  }

  /** Bring someone's body and money up to date (the UI calls this before showing them). */
  refresh(p: Person) { if (p.alive) this.catchUp(p); }

  /** Physics: needs, health and money change with what the person has been doing. */
  private catchUp(p: Person) {
    const hours = (this.t - p.lastUpdate) / HOUR;
    p.lastUpdate = this.t;
    if (hours <= 0) return;
    const n = p.needs, a = p.activity;
    let energy = -0.045, hunger = -0.06, social = -0.02 * (0.5 + p.traits.extraversion), health = 0.003;
    switch (a) {
      case "sleep": case "nap": energy = 0.14; hunger = -0.02; social = -0.005; health = 0.01; break;
      case "rest": energy = 0.03; health = 0.01; break;
      case "socialize": social = 0.3; energy = -0.05; break;
      case "work": case "school": social = 0.04; energy = -0.07; break;
      case "work_extra": energy = -0.08; break;
      case "play": case "toddler": social = 0.15; energy = -0.05; break;
      case "eat": hunger = 1.2; break;
      case "pray": social = 0.02; break;
      case "protest": case "help": social = 0.08; energy = -0.07; break;
      case "shelter": social = 0.05; energy = -0.02; break;
      case "doctor": health = 0.08; break;
    }
    if (this.countries[p.country].aidUntil > this.t) health += 0.01;
    if (n.hunger < 0.05) health -= 0.01; // starving hurts
    n.energy = clamp01(n.energy + energy * hours);
    n.hunger = clamp01(n.hunger + hunger * hours);
    n.social = clamp01(n.social + social * hours);
    n.health = clamp01(n.health + health * hours);

    const fam = this.families[p.family];
    if (a === "work") fam.money += p.job.income * (hours / 8);
    if (a === "work_extra") fam.money += Math.max(p.job.income, 0.6) * 0.8 * (hours / 8);
    if (a === "shop") fam.money -= 0.3 * hours;
    fam.money = Math.max(0, fam.money - (p.age < 16 ? 0.25 : 0.35) * (hours / 24));
  }

  // ---------- people: decisions ----------

  private decideNow(p: Person) {
    this.catchUp(p);
    if (p.needs.health <= 0.02) { this.kill(p.id, { phrase: "died of injuries", attacker: null, byGovernment: false }); return; }
    if (p.age < TODDLER_AGE) { this.toddlerRoutine(p); return; }
    p.waiting = true;
    p.dueAt = this.t;
    this.waitingIds.add(p.id);
    this.enqueueDecision(p);
  }

  private enqueueDecision(p: Person) {
    const c = this.countries[p.country];
    const options = this.actOptions(p);
    const ev = p.pendingEvent;
    // Most decisions are one question (what next). Mornings and big events add a short feelings check,
    // with only the feelings that matter right now.
    const mood = ev !== null || p.lastFeelingsDay !== dayOf(this.t);
    const recentLoss = p.memories.some((m) => m.about !== undefined && this.t - m.t < 14 * DAY);
    const violent = ev !== null && (ev.attacker !== null || !!ev.byGovernment);
    const hateTarget = ev && ev.attacker !== null && ev.attacker !== p.country ? this.countries[ev.attacker] : null;
    const questions = decisionQuestions(p, options, {
      mood,
      sadness: mood && (ev?.lostId !== undefined || recentLoss || p.feelings.sadness > 0.3),
      anger: mood && (violent || p.feelings.anger > 0.3),
      hateTarget,
      faith: ev?.lostId !== undefined && p.beliefs.religiosity > 0.3,
      blameGov: !!ev?.byGovernment,
    }, c.name);
    this.ai.enqueue({
      key: `p${p.id}`,
      label: p.first,
      priority: (ev ? PRIORITY.personEvent + ev.urgency * 10 : PRIORITY.everyday) + this.focusBoost(p),
      state: describePerson(p, this, ev ? ev.text : this.situationFor(p)),
      questions,
      onResult: (a, info) => this.applyDecision(p, options, hateTarget, ev, a, info),
      onDrop: () => this.retry(p),
    });
  }

  private situationFor(p: Person): string {
    const when = `It is ${WEEKDAYS[dayOf(this.t) % 7]}, ${formatTime(this.t, false)}.`;
    return p.activity === "sleep" ? `${when} ${p.first} has just woken up.` : `${when} ${p.first} has been ${lowerFirst(p.activityLabel)}.`;
  }

  /** Watched people (and their families) jump the queue. */
  private focusBoost(p: Person): number {
    const s = this.selection;
    if (!s) return 0;
    if (s.type === "country") return p.country === s.id ? 0.5 : 0;
    if (p.id === s.id) return 3;
    return p.rels.some((r) => r.id === s.id && r.kind !== "friend") ? 1 : 0;
  }

  /** What's physically possible right now. Laya picks from these. */
  private actOptions(p: Person): ActOption[] {
    const t = this.t, h = hourOf(t), day = dayOf(t), weekday = day % 7 < 5, r = this.rng;
    const c = this.countries[p.country];
    const curfew = c.curfewUntil > t;
    const atWar = c.atWar.some(Boolean);
    const night = !(h >= p.wakeHour && h < p.sleepHour);
    const awake = !night || p.pendingEvent !== null; // bad news wakes people up
    const until = (hour: number) => ((hour - h + 24) % 24) * HOUR;
    const must: ActOption[] = [], may: ActOption[] = [];
    // Each option tells Laya how long it lasts, so choosing it also sets the next decision time.
    const add = (list: ActOption[], key: string, id: ActivityId, desc: string, label: string, min: number, max: number, extra: { withId?: number; when?: string } = {}) =>
      list.push({ key, id, desc: `${desc} (${extra.when ?? about((min + max) / 2)})`, label, min, max, withId: extra.withId });
    const disasterHere = (days: number) => this.disasters.some((d) => d.country === p.country && t - d.t < days * DAY);
    const bombedHere = atWar || this.disasters.some((d) => d.country === p.country && d.kind === "bomb" && t - d.t < 2 * DAY);

    const morning = { when: "until morning" };
    if (!awake) {
      add(must, "sleep", "sleep", "Go to sleep", "Sleeping", 0, 0, morning);
      add(may, "rest", "rest", "Stay up and rest", "Resting at home", 30, 120);
    } else {
      if (night) add(must, "sleep", "sleep", "Go back to sleep", "Sleeping", 0, 0, morning);
      else if (p.needs.energy < 0.3) add(must, "nap", "nap", "Take a nap", "Napping", 30, 120);
      add(must, "eat", "eat", "Eat something", "Eating", 20, 60);
      if (p.job.works && weekday && p.lastWorkDay !== day && h >= 7 && h < 15)
        add(must, "work", "work", "Go to work", `Working as ${an(p.job.label)}`, until(16), until(18.5), { when: "until evening" });
      if (p.job.id === "student" && weekday && p.lastWorkDay !== day && h >= 7.5 && h < 14)
        add(must, "school", "school", p.age < 18 ? "Go to school" : "Go to college", p.age < 18 ? "At school" : "At college", until(14.5), until(16), { when: "until afternoon" });
      const loss = p.memories.filter((m) => m.about !== undefined && t - m.t < 30 * DAY).sort((a, b) => b.weight - a.weight)[0];
      if (loss) { const who = this.people[loss.about!].first; add(must, "mourn", "mourn", `Mourn ${who}`, `Mourning ${who}`, 60, 240); }
      if (p.needs.health < 0.75) add(must, "doctor", "doctor", "Get injuries treated", "Getting injuries treated", 60, 180);
      if (bombedHere) add(must, "shelter", "shelter", "Hide in a shelter", "Hiding in a shelter", 120, 480);
      if (disasterHere(3) && p.age >= 14 && p.needs.health > 0.5) add(must, "help", "help", "Help the victims", "Helping the victims", 90, 240);
      if (p.age >= 18 && p.leavingAt === undefined && (disasterHere(5) || atWar || p.feelings.joy < 0.3 || p.feelings.fear > 0.5))
        add(must, "leave", "pack", "Leave the country for good", "Getting ready to leave the country", 120, 300);
      if (p.age >= 16 && !curfew && (c.news.some((n) => t - n.t < 5 * DAY) || c.stability < 0.5 || p.beliefs.trustGov < 0.3))
        add(must, "protest", "protest", "Protest against the government", "Protesting against the government", 90, 240);
      if (atWar && p.age >= 18 && p.age <= 45 && p.job.id !== "soldier") add(must, "enlist", "enlist", "Join the army", "Joining the army", 60, 120);

      if (p.age < 13) add(may, "play", "play", "Play with other kids", "Playing", 60, 150);
      if (!curfew && h >= 8 && h < 22) {
        this.visitCandidates(p).forEach((rel, i) => {
          const o = this.people[rel.id], kind = RELATION_LABEL[rel.kind];
          add(may, `see${i + 1}`, "socialize", `Visit ${kind} ${o.first}`, `Spending time with ${o.first} (${kind})`, 60, 180, { withId: o.id });
        });
      }
      const hobby = pick(r, p.likes);
      add(may, "hobby", "hobby", cap(HOBBIES[hobby] ?? hobby), cap(HOBBIES[hobby] ?? hobby), 45, 150);
      add(may, "rest", "rest", "Rest at home", "Resting at home", 30, 120);
      if (p.age >= 6) add(may, "pray", "pray", weekday ? "Pray" : "Go to a religious service", weekday ? "Praying" : "At a religious service", 20, 90);
      if (!curfew && p.age >= 16 && h >= 9 && h < 19) add(may, "shop", "shop", "Go shopping", "Shopping at the market", 30, 90);
      if (p.age >= 16 && p.job.id !== "retired" && p.job.id !== "student")
        add(may, "extra", "work_extra", p.job.works ? "Work extra hours" : "Look for odd jobs", p.job.works ? "Working extra hours" : "Looking for odd jobs", 90, 240);
      if (!curfew) add(may, "walk", "walk", "Take a walk", "Taking a walk", 20, 60);
    }
    // Keep every urgent option; fill the rest with a random mix of everyday ones.
    for (let i = may.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [may[i], may[j]] = [may[j], may[i]]; }
    return [...must, ...may.slice(0, Math.max(0, MAX_OPTIONS - must.length))];
  }

  /** Up to two people worth visiting, leaning towards the closest. */
  private visitCandidates(p: Person) {
    return p.rels
      .filter((r) => this.people[r.id].alive && this.people[r.id].family !== p.family)
      .map((r) => ({ r, score: r.closeness * (0.5 + this.rng()) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((x) => x.r);
  }

  private applyDecision(p: Person, options: ActOption[], hateTarget: Country | null, included: PendingEvent | null, a: Record<string, Answer>, info: AiInfo) {
    this.waitingIds.delete(p.id);
    p.waiting = false;
    if (!p.alive) return;
    this.catchUp(p);
    const score = (k: string) => (a[k] as ScoreAnswer | undefined)?.score;
    const yes = (k: string) => (a[k] as NoulAnswer | undefined)?.p;
    const notes: string[] = [];

    // Only the feelings Laya was asked about change; the rest keep their last answer.
    const felt: string[] = [];
    for (const k of ["joy", "sadness", "anger", "fear"] as const) {
      const v = score(k);
      if (v === undefined) continue;
      p.feelings[k] = v / 3;
      felt.push(`${k} ${v.toFixed(1)}/3`);
    }
    if (felt.length) {
      p.lastFeelingsDay = dayOf(this.t);
      this.stats.feelingChecks++;
      notes.push(`Feels: ${felt.join(" · ")}.`);
    }
    const hate = score("hate");
    if (hate !== undefined && hateTarget) {
      p.hate[hateTarget.id] = hate / 3;
      notes.push(`Hate for ${hateTarget.name}: ${hate.toFixed(1)}/3.`);
    }
    const faith = yes("faith");
    if (faith !== undefined && chance(this.rng, faith)) {
      p.beliefs.religiosity = clamp01(p.beliefs.religiosity + 0.15 * (1 - p.beliefs.religiosity));
      notes.push("Turned to faith.");
    }
    const blame = yes("blame");
    if (blame !== undefined) {
      p.beliefs.trustGov = clamp01(p.beliefs.trustGov - 0.3 * blame);
      if (blame > 0.5) notes.push("Blames the government.");
    }

    // Sample from Laya's probabilities rather than always taking the top pick, so people differ.
    const probs = options.map((o) => (a.act as ChoiceAnswer).probabilities[o.key] ?? 0);
    const chosen = options[weighted(this.rng, probs)];
    this.startActivity(p, chosen);

    this.stats.decisions++;
    p.aiCount++;
    this.log(p, "ai", `${chosen.label} for ~${formatDuration(p.nextDecisionAt - this.t)}.${notes.length ? " " + notes.join(" ") : ""}`,
      `weighed ${weighed(options, probs)}\n${batchNote(info)}`);
    const thought = this.thoughtFor(p, chosen);
    if (thought) this.log(p, "thought", thought);

    if (included && p.pendingEvent === included) p.pendingEvent = null;
    // Something new happened while Laya was thinking: decide again straight away.
    if (p.pendingEvent) this.decideNow(p);
  }

  /** Starts the chosen option. Its length was part of what Laya chose; a little jitter keeps people out of step. */
  private startActivity(p: Person, o: ActOption) {
    const t = this.t;
    const dur = o.id === "sleep" ? this.untilWake(p) + between(this.rng, -30, 30) : between(this.rng, o.min, o.max);
    p.activity = o.id;
    p.activityLabel = o.label;
    p.activityStart = t;
    p.withId = o.withId;
    p.nextDecisionAt = t + Math.max(10, dur);
    this.heap.push({ at: p.nextDecisionAt, kind: "due", pid: p.id });

    switch (o.id) {
      case "work": case "school": p.lastWorkDay = dayOf(t); break;
      case "socialize": {
        const other = this.people[o.withId!];
        other.needs.social = clamp01(other.needs.social + 0.1);
        for (const [x, y] of [[p, other], [other, p]] as const) {
          const rel = x.rels.find((r) => r.id === y.id);
          if (rel) rel.closeness = clamp01(rel.closeness + 0.01);
        }
        this.log(other, "action", `${p.first} came by`);
        break;
      }
      case "enlist":
        p.job = SOLDIER;
        this.log(p, "event", `Joined the ${this.countries[p.country].name} army.`);
        break;
      case "pack":
        p.leavingAt = t + between(this.rng, 1, 3) * DAY;
        this.heap.push({ at: p.leavingAt, kind: "emigrate", pid: p.id });
        this.worldEvent(`${p.name} decided to leave ${this.countries[p.country].name}.`, p.id);
        break;
      case "help": {
        const hurt = this.people.filter((o) => o.alive && o.country === p.country && o.id !== p.id && o.needs.health < 0.75);
        for (let i = 0; i < 3 && hurt.length; i++) {
          const o = hurt.splice(Math.floor(this.rng() * hurt.length), 1)[0];
          o.needs.health = clamp01(o.needs.health + 0.1);
          this.log(o, "action", `${p.first} helped with the injuries`);
        }
        break;
      }
    }
  }

  private untilWake(p: Person) {
    const m = ((p.wakeHour - hourOf(this.t) + 24) % 24) * HOUR;
    return m < 60 ? m + DAY : m;
  }

  private toddlerRoutine(p: Person) {
    const h = hourOf(this.t);
    const awake = h >= p.wakeHour && h < p.sleepHour;
    p.activity = awake ? "toddler" : "sleep";
    p.activityLabel = awake ? "With the family" : "Sleeping";
    p.activityStart = this.t;
    const next = ((awake ? p.sleepHour : p.wakeHour) - h + 24) % 24;
    p.nextDecisionAt = this.t + Math.max(30, next * HOUR);
    this.heap.push({ at: p.nextDecisionAt, kind: "due", pid: p.id });
  }

  private retry(p: Person) {
    this.waitingIds.delete(p.id);
    p.waiting = false;
    if (!p.alive) return;
    p.nextDecisionAt = this.t + 15;
    this.heap.push({ at: p.nextDecisionAt, kind: "due", pid: p.id });
  }

  private thoughtFor(p: Person, o: ActOption): string | null {
    const f = p.feelings;
    const strong = f.sadness > 0.5 || f.fear > 0.5 || f.anger > 0.5;
    if (!strong && !chance(this.rng, 0.35)) return null;
    const country = this.countries[p.country].name;
    switch (o.id) {
      case "sleep": return f.sadness > 0.5 ? "Maybe tomorrow will hurt less." : "Time to sleep.";
      case "eat": return p.needs.hunger < 0.3 ? "I'm starving." : "Time to eat.";
      case "work": return f.sadness > 0.5 ? "Work keeps my mind off things." : "Off to work.";
      case "socialize": return p.needs.social < 0.35 ? `I need to see ${this.people[o.withId!].first}.` : `${this.people[o.withId!].first} always cheers me up.`;
      case "mourn": return "I keep expecting them to walk in.";
      case "shelter": return "We need to hide. Now.";
      case "help": return "People need help. I can't just watch.";
      case "pack": return `There's nothing left for me in ${country}.`;
      case "protest": return f.anger > 0.5 ? "Enough is enough." : "Someone has to speak up.";
      case "enlist": return `${country} needs me.`;
      case "pray": return f.sadness > 0.5 || f.fear > 0.5 ? "Please, give me strength." : "A quiet moment of prayer.";
      default: return f.anger > 0.6 ? "I'm so angry I can't think straight." : f.fear > 0.6 ? "I can't shake this fear." : null;
    }
  }

  // ---------- people: events ----------

  /** Something happened to this person: their next Laya decision (asked right away) reacts to it. */
  private raiseEvent(p: Person, ev: PendingEvent) {
    if (!p.alive || p.age < TODDLER_AGE) return;
    const cur = p.pendingEvent;
    p.pendingEvent = cur
      ? {
        text: cur.text.length > 300 ? ev.text : `${cur.text} ${ev.text}`,
        urgency: Math.max(cur.urgency, ev.urgency),
        attacker: ev.attacker ?? cur.attacker,
        lostId: ev.lostId ?? cur.lostId,
        byGovernment: ev.byGovernment || cur.byGovernment,
      }
      : ev;
    if (p.activity !== "news") {
      this.catchUp(p);
      p.activity = "news";
      p.activityLabel = "Taking in the news";
      p.activityStart = this.t;
    }
    if (!p.waiting) this.decideNow(p);
    // Still queued: rebuild the question with the news. Already running: the answer triggers a fresh decision.
    else if (this.ai.remove(`p${p.id}`)) this.enqueueDecision(p);
  }

  kill(pid: number, cause: Cause, quiet = false) {
    const p = this.people[pid];
    if (!p.alive) return;
    this.catchUp(p);
    p.alive = false;
    p.diedAt = this.t;
    p.deathCause = cause.phrase;
    p.activity = "dead";
    p.activityLabel = "Dead";
    p.pendingEvent = null;
    if (p.waiting) { this.ai.remove(`p${p.id}`); this.waitingIds.delete(p.id); p.waiting = false; }
    this.stats.deaths++;
    this.log(p, "event", `${p.first} ${cause.phrase}.`);
    if (!quiet) this.worldEvent(`${p.name} ${cause.phrase}.`, p.id);

    // The news travels: people at home know at once, others hear over the next day or two.
    const SHOCK: Record<string, number> = { spouse: 1, parent: 0.95, child: 0.95, sibling: 0.75, grandparent: 0.6, grandchild: 0.6, friend: 0.45 };
    for (const rel of p.rels) {
      const o = this.people[rel.id];
      const back = o.rels.find((x) => x.id === p.id);
      if (!o.alive || !back) continue;
      const shock = clamp01(SHOCK[back.kind] * (0.5 + 0.5 * back.closeness));
      const delay = o.family === p.family ? between(this.rng, 1, 20) : between(this.rng, 30, 36 * HOUR) * (1.2 - back.closeness);
      this.heap.push({ at: this.t + delay, kind: "news", pid: o.id, deadId: p.id, cause, shock });
    }
  }

  private onNews(p: Person, deadId: number, cause: Cause, shock: number) {
    const dead = this.people[deadId];
    const rel = RELATION_LABEL[p.rels.find((x) => x.id === deadId)?.kind ?? "friend"];
    p.memories.push({ t: this.t, text: `${dead.first}, my ${rel}, ${cause.phrase}.`, weight: shock, about: deadId });
    this.log(p, "event", `Heard that ${dead.name} (${rel}) ${cause.phrase}.`);
    this.raiseEvent(p, {
      text: `${p.first} has just learned that ${dead.first}, ${p.first}'s ${rel}, ${cause.phrase}.`,
      urgency: shock, attacker: cause.attacker, lostId: deadId, byGovernment: cause.byGovernment,
    });
  }

  private emigrate(p: Person) {
    if (p.leavingAt === undefined) return;
    const fam = this.families[p.family];
    const from = this.countries[fam.country];
    // Go somewhere they don't hate and that isn't at war with home.
    const choices = this.countries.filter((c) => c.id !== from.id && !from.atWar[c.id]);
    if (!choices.length) { p.leavingAt = undefined; return; }
    const to = choices.reduce((a, c) => (p.hate[c.id] < p.hate[a.id] ? c : a));
    fam.country = to.id;
    placeFamily(this.rng, fam, to, this.people);
    for (const id of fam.members) {
      const m = this.people[id];
      m.leavingAt = undefined;
      if (!m.alive) continue;
      m.country = to.id;
      this.log(m, "event", m === p ? `Left ${from.name} for a new life in ${to.name}.` : `Moved to ${to.name} with ${p.first}.`);
      m.memories.push({ t: this.t, text: `We left ${from.name} for ${to.name}.`, weight: 0.6 });
    }
    this.stats.emigrations++;
    this.worldEvent(`${p.name}'s household moved from ${from.name} to ${to.name}.`, p.id);
    this.layoutVersion++;
  }

  // ---------- disasters ----------

  countryAt(x: number, y: number): Country | null {
    return this.countries.find((c) => Math.hypot(x - c.x, y - c.y) <= c.r + 6) ?? null;
  }

  dropDisaster(kind: DisasterKind, x: number, y: number, by: number | null) {
    const def = DISASTERS[kind];
    const where = this.countryAt(x, y);
    const attacker = kind === "bomb" && by !== null ? this.countries[by] : null;
    const d: Disaster = {
      id: this.disasters.length, kind, x, y, r: def.radius, t: this.t, realAt: performance.now(),
      by: attacker?.id ?? null, country: where?.id ?? null, deaths: 0, injured: 0,
    };
    this.disasters.push(d);
    const place = where?.name ?? "open land";
    const what = kind === "bomb"
      ? attacker ? `${attacker.name} dropped a bomb on ${place}` : `A bomb exploded in ${place}`
      : `${cap(an(def.label.toLowerCase()))} struck ${place}`;
    const cause: Cause = {
      phrase: kind === "bomb" ? (attacker ? `was killed when ${attacker.name} bombed ${place}` : "was killed in a bombing") : `died in ${an(def.label.toLowerCase())}`,
      attacker: d.by, byGovernment: false,
    };

    // Physics first: distance decides who dies, who is hurt and whose home is ruined.
    const reach = def.radius * 1.4;
    const survivors: { p: Person; dist: number; hurt: number }[] = [];
    for (const p of this.people) {
      if (!p.alive) continue;
      const dist = Math.hypot(p.x - x, p.y - y);
      if (dist > reach) continue;
      if (chance(this.rng, def.lethality * clamp01(1 - (dist / def.radius) ** 2))) {
        this.kill(p.id, cause, true);
        d.deaths++;
        continue;
      }
      this.catchUp(p);
      const hurt = def.injury * clamp01(1 - dist / reach) * between(this.rng, 0.4, 1);
      p.needs.health = clamp01(p.needs.health - hurt);
      if (hurt > 0.1) d.injured++;
      this.families[p.family].money *= 1 - def.moneyLoss * clamp01(1 - dist / reach);
      survivors.push({ p, dist, hurt });
    }
    // Then everyone caught in it reacts, through Laya.
    for (const { p, dist, hurt } of survivors) {
      p.memories.push({ t: this.t, text: `${what}.${hurt > 0.2 ? " I was hurt." : ""}`, weight: 0.7 });
      this.log(p, "event", `${what}${hurt > 0.2 ? " — injured" : dist < def.radius ? " — caught in it" : " nearby"}.`);
      this.raiseEvent(p, {
        text: `${what} just now, ${dist < def.radius ? `right where ${p.first} was` : `close to ${p.first}`}.${hurt > 0.2 ? ` ${p.first} is injured.` : ""}`,
        urgency: 0.6 + 0.4 * clamp01(1 - dist / def.radius), attacker: d.by,
      });
    }

    const summary = `${what}: ${d.deaths} dead, ${d.injured} injured.`;
    this.worldEvent(summary, undefined, where?.id);
    this.stats.disasters++;
    if (!where) return;
    this.addNews(where, summary);
    where.stability = clamp01(where.stability - 0.05 - 0.02 * d.deaths);
    // The government that was hit meets; if another country did it, everyone else hears about it too.
    if (attacker && attacker.id !== where.id) {
      this.addIssue(where, `${attacker.name} has just bombed ${where.name}: ${d.deaths} dead, ${d.injured} injured.`, attacker.id);
      this.addNews(attacker, `${attacker.name} bombed ${where.name}, killing ${d.deaths}.`);
      this.tellOthers(`${attacker.name} bombed ${where.name}, killing ${d.deaths}.`, attacker.id, where.id);
    } else if (kind === "bomb") {
      const suspect = this.rival(where);
      this.addIssue(where, `${summary} Nobody has claimed it. Some suspect ${suspect.name}.`, suspect.id);
    } else this.addIssue(where, summary);
  }

  /** A government-ordered bombing lands somewhere populated in the target country. */
  private strike(by: number, target: number) {
    this.strikes = this.strikes.filter((s) => !(s.by === by && s.target === target && s.at <= this.t));
    const alive = this.people.filter((p) => p.alive && p.country === target);
    if (!alive.length) return;
    const aim = pick(this.rng, alive);
    this.dropDisaster("bomb", aim.x + between(this.rng, -4, 4), aim.y + between(this.rng, -4, 4), by);
  }

  // ---------- countries ----------
  //
  // A government meets when something happens (it's attacked, hit by a disaster, or another country
  // makes a move) and every few hours otherwise. Each time, Laya picks one action from a menu built
  // from the situation. Recent world events are part of what it reads, so it reacts to history.

  /** Something for a government to respond to. `about` is the other country involved; `victim` one it could help. */
  private addIssue(c: Country, text: string, about: number | null = null, victim: number | null = null) {
    if (c.pending.length >= 3) c.pending.shift(); // keep the agenda short; the newest matters most
    c.pending.push({ text, about, victim });
    // If a routine meeting is still waiting in the Laya queue, cancel it so the event is dealt with first.
    const queued = this.countryJobs.get(c.id);
    if (c.waiting && queued && !queued.fromEvent && this.ai.remove(`c${c.id}`)) c.waiting = false;
    this.scheduleCountry(c, 1); // the government meets at once
  }

  /** Let every country not involved react to a move between `actor` and `victim`. */
  private tellOthers(text: string, actor: number, victim: number | null) {
    for (const o of this.countries) if (o.id !== actor && o.id !== victim) this.addIssue(o, text, actor, victim);
  }

  /** Book the government's next meeting; an earlier booking replaces a later one. */
  private scheduleCountry(c: Country, delay: number) {
    const at = this.t + Math.max(1, delay);
    if (c.waiting || (c.turnScheduled && c.turnAt <= at)) return;
    c.turnScheduled = true;
    c.turnAt = at;
    this.heap.push({ at, kind: "country", cid: c.id });
  }

  private rival(c: Country): Country {
    return this.countries.filter((o) => o.id !== c.id).reduce((a, o) => (c.relations[o.id] < c.relations[a.id] ? o : a));
  }

  private countryTurn(c: Country) {
    c.turnScheduled = false;
    if (c.waiting || !this.people.some((p) => p.alive && p.country === c.id)) return;
    let issue = c.pending.shift();
    const fromEvent = issue !== undefined;
    if (!issue) {
      if (this.t < c.nextReviewAt) { this.scheduleCountry(c, c.nextReviewAt - this.t); return; }
      const enemy = this.countries.find((o) => c.atWar[o.id]);
      issue = enemy
        ? { text: `${c.name} is at war with ${enemy.name}. The government reviews the war.`, about: enemy.id, victim: null }
        : { text: `A regular meeting of the ${c.name} government.`, about: this.rival(c).id, victim: null };
    }
    const turn = issue;
    const other = turn.about !== null && turn.about !== c.id ? this.countries[turn.about] : null;
    const victim = turn.victim !== null && turn.victim !== c.id ? this.countries[turn.victim] : null;
    const options = this.policyMenu(c, other, victim);
    c.waiting = true;
    this.countryJobs.set(c.id, { fromEvent });
    this.ai.enqueue({
      key: `c${c.id}`,
      label: `${c.name} gov.`,
      priority: fromEvent ? PRIORITY.governmentEvent : PRIORITY.governmentReview,
      state: describeCountry(c, this, turn.text),
      questions: policyQuestions(c, options, other),
      onResult: (a, info) => this.applyPolicy(c, options, other, a, info),
      onDrop: () => { c.waiting = false; c.pending.unshift(turn); this.scheduleCountry(c, 60); },
    });
  }

  /** Everything this government could do right now: one menu for every situation, filtered by what makes sense. */
  private policyMenu(c: Country, other: Country | null, victim: Country | null): PolicyOption[] {
    const t = this.t;
    const menu: PolicyOption[] = [];
    const add = (key: string, desc: string, apply: () => string) => menu.push({ key, desc, apply });
    const hitAtHome = this.disasters.some((d) => d.country === c.id && t - d.t < DAY);

    if (hitAtHome && c.aidUntil < t) add("aid", "Help our victims and rebuild", () => this.sendAid(c));
    if (hitAtHome && c.curfewUntil < t) add("curfew", "Declare an emergency and a curfew", () => this.curfew(c));
    if (hitAtHome) add("ask", "Ask other countries for help", () => this.askForHelp(c));
    if (c.stability < 0.45) {
      add("crackdown", "Crack down on protesters", () => this.govNews(c, 0.15, "The government cracked down on protesters."));
      add("reform", "Promise reforms", () => this.govNews(c, 0.1, "The government promised reforms."));
    }
    if (other) {
      const x = other, war = c.atWar[x.id], hostile = c.relations[x.id] < -0.3;
      if ((war || hostile) && t - c.lastStrikeAt > DAY) add("bomb", `Bomb ${x.name}`, () => this.orderStrike(c, x));
      if (!war && hostile) add("war", `Declare war on ${x.name}`, () => this.declareWar(c, x));
      if (war && c.peaceOffers.includes(x.id)) add("accept", `Accept ${x.name}'s peace offer`, () => this.makePeace(c, x));
      else if (war) add("peace", `Offer ${x.name} a ceasefire`, () => this.offerPeace(c, x));
      add("condemn", `Condemn ${x.name}`, () => this.shiftRelations(c, x, -0.2, `${c.name} condemned ${x.name}.`));
      if (!war) add("ties", `Strengthen ties with ${x.name}`, () => this.shiftRelations(c, x, 0.15, `${c.name} strengthened ties with ${x.name}.`));
    }
    if (victim) add("help", `Send help to ${victim.name}`, () => this.sendHelp(c, victim));
    add("nothing", "Do nothing for now", () => "Did nothing for now.");
    return menu;
  }

  private applyPolicy(c: Country, options: PolicyOption[], other: Country | null, a: Record<string, Answer>, info: AiInfo) {
    c.waiting = false;
    const probs = options.map((o) => (a.policy as ChoiceAnswer).probabilities[o.key] ?? 0);
    const chosen = options[weighted(this.rng, probs)];
    const trust = (a.trust as ScoreAnswer | undefined)?.score;
    if (other && trust !== undefined) c.relations[other.id] = 0.5 * c.relations[other.id] + 0.5 * ((trust / 3) * 2 - 1);
    const result = chosen.apply();
    for (const o of this.countries) { o.stability = clamp01(o.stability); o.relations = o.relations.map(clampRel); }

    c.aiCount++;
    this.stats.countryDecisions++;
    pushLog(c.log, {
      t: this.t, kind: "ai",
      text: result + (other && trust !== undefined ? ` Trust in ${other.name}: ${trust.toFixed(1)}/3.` : ""),
      meta: `weighed ${weighed(options, probs)}\n${batchNote(info)}`,
    });
    if (chosen.key !== "nothing") this.worldEvent(`${c.name}: ${result}`, undefined, c.id);
    c.nextReviewAt = this.t + (c.atWar.some(Boolean) ? REVIEW_EVERY / 2 : REVIEW_EVERY);
    this.scheduleCountry(c, c.pending.length ? 10 : c.nextReviewAt - this.t);
  }

  // What each government action does.

  private orderStrike(c: Country, x: Country): string {
    c.lastStrikeAt = this.t;
    const at = this.t + between(this.rng, 30, 90);
    this.strikes.push({ by: c.id, target: x.id, at });
    this.heap.push({ at, kind: "strike", by: c.id, target: x.id });
    this.addNews(c, `The government ordered a bombing of ${x.name}.`);
    return `Ordered a bombing of ${x.name}.`;
  }

  private declareWar(c: Country, x: Country): string {
    c.atWar[x.id] = x.atWar[c.id] = true;
    c.relations[x.id] = Math.min(c.relations[x.id], -0.8);
    x.relations[c.id] = Math.min(x.relations[c.id], -0.8);
    const text = `${c.name} declared war on ${x.name}.`;
    this.addNews(c, text);
    this.addNews(x, text);
    this.addIssue(x, `${c.name} has declared war on ${x.name}.`, c.id);
    this.tellOthers(text, c.id, x.id);
    return `Declared war on ${x.name}.`;
  }

  private offerPeace(c: Country, x: Country): string {
    if (!x.peaceOffers.includes(c.id)) x.peaceOffers.push(c.id);
    this.addNews(c, `The government offered ${x.name} a ceasefire.`);
    this.addIssue(x, `${c.name} offers ${x.name} a ceasefire.`, c.id);
    return `Offered ${x.name} a ceasefire.`;
  }

  private makePeace(c: Country, x: Country): string {
    c.atWar[x.id] = x.atWar[c.id] = false;
    c.peaceOffers = c.peaceOffers.filter((id) => id !== x.id);
    x.peaceOffers = x.peaceOffers.filter((id) => id !== c.id);
    c.relations[x.id] = Math.max(c.relations[x.id], -0.4);
    x.relations[c.id] = Math.max(x.relations[c.id], -0.4);
    const text = `${c.name} and ${x.name} agreed to a ceasefire.`;
    this.addNews(c, text);
    this.addNews(x, text);
    return `Made peace with ${x.name}.`;
  }

  private shiftRelations(c: Country, x: Country, delta: number, text: string): string {
    c.relations[x.id] += delta;
    x.relations[c.id] += delta * 0.7;
    this.addNews(c, text);
    this.addNews(x, text);
    return text.replace(`${c.name} `, "").replace(/^./, (s) => s.toUpperCase());
  }

  private sendAid(c: Country): string {
    c.aidUntil = this.t + 3 * DAY;
    for (const d of this.disasters) {
      if (d.country !== c.id || this.t - d.t > DAY) continue;
      for (const f of this.families) if (Math.hypot(f.x - d.x, f.y - d.y) < d.r * 1.4) f.money += 4;
    }
    return this.govNews(c, 0.05, "The government is sending aid to the victims.");
  }

  private curfew(c: Country): string {
    c.curfewUntil = this.t + 2 * DAY;
    return this.govNews(c, 0.05, "The government declared a state of emergency and a curfew.");
  }

  private askForHelp(c: Country): string {
    for (const o of this.countries) if (o.id !== c.id) this.addIssue(o, `${c.name} asks for help after a disaster.`, null, c.id);
    return this.govNews(c, 0, "The government asked other countries for help.");
  }

  private sendHelp(c: Country, x: Country): string {
    x.aidUntil = this.t + 3 * DAY;
    for (const f of this.families) if (f.country === x.id && f.money < 8) f.money += 2;
    c.relations[x.id] += 0.2;
    x.relations[c.id] += 0.3;
    this.addNews(x, `${c.name} sent help to ${x.name}.`);
    this.addNews(c, `${c.name} sent help to ${x.name}.`);
    return `Sent help to ${x.name}.`;
  }

  private govNews(c: Country, stability: number, text: string): string {
    c.stability += stability;
    this.addNews(c, text);
    return text;
  }

  /** Physics for countries: protests and war wear stability down; calm lets it recover. */
  private updateCountries(hours: number) {
    if (hours <= 0) return;
    const alive = this.countries.map(() => 0), protest = this.countries.map(() => 0);
    for (const p of this.people) {
      if (!p.alive) continue;
      alive[p.country]++;
      if (p.activity === "protest") protest[p.country]++;
    }
    for (const c of this.countries) {
      if (!alive[c.id]) continue;
      const share = protest[c.id] / alive[c.id];
      if (share > 0.02) c.stability -= share * 0.05 * hours;
      else c.stability += (0.7 - c.stability) * 0.01 * hours;
      if (c.atWar.some(Boolean)) c.stability -= 0.002 * hours;
      c.stability = clamp01(c.stability);
      if (c.stability < 0.3 && this.t - c.lastUnrestAt > DAY) {
        c.lastUnrestAt = this.t;
        this.addIssue(c, `Protests and unrest are spreading across ${c.name}.`);
      }
    }
  }

  // ---------- queries for the UI ----------

  selectedPerson(): Person | null {
    const sel = this.selection;
    return sel !== null && sel.type === "person" ? this.people[sel.id] : null;
  }

  population() {
    let alive = 0;
    const byCountry = this.countries.map(() => 0);
    for (const p of this.people) if (p.alive) { alive++; byCountry[p.country]++; }
    return { alive, dead: this.people.length - alive, byCountry };
  }

  mood(c: Country) { return countryMood(c, this.people); }
}

/** "eat 41% · walk 22% · rest 15%": the top options Laya weighed. */
function weighed(options: ChoiceOption[], probs: number[]): string {
  return options.map((o, i) => ({ o, pr: probs[i] })).sort((x, y) => y.pr - x.pr).slice(0, 3)
    .map((x) => `${x.o.key} ${Math.round(x.pr * 100)}%`).join(" · ");
}

function batchNote(info: AiInfo): string {
  return `batch #${info.batchId} (${info.batchSize} decisions) · ${(info.callMs / 1000).toFixed(1)} s · waited ${(info.waitedMs / 1000).toFixed(1)} s`;
}

function pushLog(log: LogEntry[], e: LogEntry) {
  log.push(e);
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
}
