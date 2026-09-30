// Sim time is measured in minutes since the start of day 1.
export type Minutes = number;

export type Sex = "M" | "F";
export type RelKind = "spouse" | "parent" | "child" | "sibling" | "grandparent" | "grandchild" | "friend";

/** `kind` is what the other person is to this person: kind "parent" means `id` is my parent. */
export interface Relationship {
  id: number;
  kind: RelKind;
  closeness: number; // 0..1
}

/** Big Five personality, each 0..1. Fixed for life. */
export interface Traits {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

/** Slow-changing values, 0..1. */
export interface Beliefs {
  religiosity: number;
  patriotism: number;
  trustGov: number;
}

/** The body: 1 = fine, 0 = desperate. Changes with activity and events. Money lives on the family. */
export interface Needs {
  energy: number;
  hunger: number;
  social: number;
  health: number;
}

/** How the person feels, 0..1. Set by Laya every morning and after big events. */
export interface Feelings {
  joy: number;
  sadness: number;
  anger: number;
  fear: number;
}

export type ActivityId =
  | "sleep" | "nap" | "work" | "school" | "eat" | "socialize" | "hobby" | "rest" | "pray"
  | "shop" | "work_extra" | "mourn" | "walk" | "play" | "protest" | "enlist" | "pack"
  | "help" | "shelter" | "doctor" | "toddler" | "news" | "dead";

export type LogKind = "action" | "thought" | "ai" | "event";

export interface LogEntry {
  t: Minutes;
  kind: LogKind;
  text: string;
  meta?: string;
}

export interface Memory {
  t: Minutes;
  text: string;
  weight: number; // how much it matters, 0..1
  about?: number; // the person it's about, e.g. who died
}

export interface Job {
  id: string;
  label: string;
  income: number; // per 8-hour shift
  works: boolean;
}

/** Something that just happened to a person; their next Laya decision reacts to it. */
export interface PendingEvent {
  text: string;
  urgency: number; // 0..1, orders the Laya queue
  attacker: number | null; // country to ask about hating
  lostId?: number; // someone they lost
  byGovernment?: boolean; // their own government did it
}

export interface Person {
  id: number;
  name: string;
  first: string;
  sex: Sex;
  age: number;
  country: number;
  family: number;
  job: Job;
  alive: boolean;
  diedAt?: Minutes;
  deathCause?: string;

  traits: Traits;
  beliefs: Beliefs;
  needs: Needs;
  feelings: Feelings;
  hate: number[]; // 0..1 towards each country (by id)
  likes: string[];
  dislikes: string[];
  wakeHour: number;
  sleepHour: number;

  rels: Relationship[];
  memories: Memory[];
  log: LogEntry[];
  leavingAt?: Minutes;

  activity: ActivityId;
  activityLabel: string;
  activityStart: Minutes;
  withId?: number;
  lastUpdate: Minutes;
  lastWorkDay: number;

  /** When Laya said this person would decide again. Nothing is asked before then. */
  nextDecisionAt: Minutes;
  /** A decision is due and queued (or running) in Laya. */
  waiting: boolean;
  dueAt: Minutes;
  pendingEvent: PendingEvent | null;
  lastFeelingsDay: number;
  aiCount: number;

  x: number;
  y: number;
}

export interface Family {
  id: number;
  country: number;
  surname: string;
  members: number[];
  money: number;
  x: number;
  y: number;
}

export interface NationalEvent {
  t: Minutes;
  text: string;
}

export type DisasterKind = "bomb" | "earthquake" | "flood" | "fire";

/** Something a government has to respond to. */
export interface CountryIssue {
  text: string; // what happened, as the government reads it
  about: number | null; // the other country involved
  victim: number | null; // a country it could help
}

export interface Country {
  id: number;
  name: string;
  government: string;
  temperament: string; // how its leaders tend to act, fed to Laya
  hue: number;
  culture: Beliefs;
  x: number;
  y: number;
  r: number;

  stability: number; // 0..1, falls with protests and war
  relations: number[]; // -1 hostile .. +1 friendly, towards each country (by id)
  atWar: boolean[];
  peaceOffers: number[]; // countries that offered this one a ceasefire
  curfewUntil: Minutes;
  aidUntil: Minutes;
  lastStrikeAt: Minutes;
  lastUnrestAt: Minutes;
  news: NationalEvent[]; // recent national events; citizens hear about them in their next decision
  log: LogEntry[];
  pending: CountryIssue[];
  waiting: boolean; // a government decision is queued in Laya
  turnScheduled: boolean;
  turnAt: Minutes; // when the next meeting is booked
  nextReviewAt: Minutes;
  aiCount: number;
}

export interface Disaster {
  id: number;
  kind: DisasterKind;
  x: number;
  y: number;
  r: number;
  t: Minutes;
  realAt: number; // performance.now() when it hit, for the blast animation
  by: number | null; // the country that dropped it (bombs)
  country: number | null; // where it hit
  deaths: number;
  injured: number;
}

export interface WorldEvent {
  t: Minutes;
  realAt: number; // performance.now() when it happened, for the headlines on the map
  text: string;
  pid?: number;
  cid?: number;
}
