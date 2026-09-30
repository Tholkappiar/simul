import { COUNTRIES, DISLIKES, HOBBIES, JOBS, NO_JOB, START_RELATIONS, type CountryDef } from "./data";
import { between, chance, clamp01, mulberry32, normal01, pick, sample, weighted, type Rng } from "./rng";
import type { Country, Family, Job, Person, RelKind, Sex } from "./types";

/** World units of area per person; sets how spread out the map is. */
const AREA_PER_PERSON = 70;

export interface WorldData {
  seed: number;
  people: Person[];
  families: Family[];
  countries: Country[];
}

export function generateWorld(population: number, seed: number): WorldData {
  const r = mulberry32(seed);
  const people: Person[] = [];
  const families: Family[] = [];

  // Split the population between countries and size each country's disk to its population.
  const counts = COUNTRIES.map((c) => Math.floor(population * c.share));
  counts[0] += population - counts.reduce((a, b) => a + b, 0);
  const radii = counts.map((n) => Math.sqrt((Math.max(n, 1) * AREA_PER_PERSON) / Math.PI));
  const d = Math.max(...radii) + 30;
  const spots = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const countries: Country[] = COUNTRIES.map((c, i) => ({
    id: i, name: c.name, government: c.government, temperament: c.temperament, hue: c.hue, culture: c.culture,
    x: spots[i][0] * d, y: spots[i][1] * d, r: radii[i],
    stability: between(r, 0.6, 0.8),
    relations: [...START_RELATIONS[i]],
    atWar: COUNTRIES.map(() => false),
    peaceOffers: [],
    curfewUntil: -Infinity, aidUntil: -Infinity, lastStrikeAt: -Infinity, lastUnrestAt: -Infinity,
    news: [], log: [], pending: [],
    waiting: false, turnScheduled: false, turnAt: 0, nextReviewAt: 0, aiCount: 0,
  }));

  for (const country of countries) {
    const def = COUNTRIES[country.id];
    const target = counts[country.id];
    const adults: number[] = []; // for linking siblings and parents across households
    let made = 0;
    while (made < target) {
      const left = target - made;
      const fam: Family = { id: families.length, country: country.id, surname: pick(r, def.surnames), members: [], money: 0, x: 0, y: 0 };
      families.push(fam);
      const add = (sex: Sex, age: number, parents: Person[] = []) => {
        if (fam.members.length >= left) return null;
        const p = makePerson(r, people.length, def, country.id, fam, sex, age, parents);
        people.push(p);
        fam.members.push(p.id);
        return p;
      };

      const roll = r();
      if (roll < 0.14) {
        // someone living alone
        const p = add(chance(r, 0.5) ? "M" : "F", Math.round(between(r, 19, 80)))!;
        if (p.age >= 20 && p.age < 70) linkSibling(r, people, adults, p);
        if (p.age >= 20) adults.push(p.id);
      } else if (roll < 0.26) {
        // elderly couple, often the parents of an adult elsewhere
        const a = add("M", Math.round(between(r, 60, 86)))!;
        const b = add("F", Math.max(58, a.age + Math.round(between(r, -5, 3))));
        if (b) link(r, a, b, "spouse", "spouse", 0.5, 1);
        const kidId = adults.find((id) => { const k = people[id]; return k.age + 20 <= a.age && k.age + 38 >= a.age && !k.rels.some((x) => x.kind === "parent"); });
        if (kidId !== undefined) for (const parent of [a, b]) if (parent) adoptAsParent(r, people, parent, people[kidId]);
      } else {
        // a couple with children, sometimes with a grandparent living in
        const a = add("M", Math.round(between(r, 24, 56)))!;
        const b = add("F", Math.max(20, a.age + Math.round(between(r, -6, 3))));
        if (b) link(r, a, b, "spouse", "spouse", 0.5, 1);
        linkSibling(r, people, adults, a);
        adults.push(a.id);
        if (b) adults.push(b.id);
        const kids: Person[] = [];
        const nKids = weighted(r, [0.15, 0.25, 0.3, 0.2, 0.1]);
        const youngest = Math.min(a.age, b?.age ?? a.age);
        for (let i = 0; i < nKids && youngest > 19; i++) {
          const kid = add(chance(r, 0.5) ? "M" : "F", Math.round(between(r, 0, Math.min(24, youngest - 18))), b ? [a, b] : [a]);
          if (!kid) break;
          for (const parent of b ? [a, b] : [a]) link(r, kid, parent, "parent", "child", 0.6, 1);
          for (const sib of kids) link(r, kid, sib, "sibling", "sibling", 0.4, 0.95);
          kids.push(kid);
        }
        if (chance(r, 0.25) && a.age + 22 < 92) {
          const elder = add(chance(r, 0.4) ? "M" : "F", Math.round(between(r, a.age + 22, Math.min(92, a.age + 34))));
          if (elder) {
            link(r, a, elder, "parent", "child", 0.5, 1);
            for (const kid of kids) link(r, kid, elder, "grandparent", "grandchild", 0.5, 0.9);
          }
        }
      }
      made += fam.members.length;
      fam.money = fam.members.length * 8 * between(r, 0.5, 1.4);
    }
  }

  makeFriends(r, people);
  layout(r, families, countries, people);
  return { seed, people, families, countries };
}

function makePerson(r: Rng, id: number, def: CountryDef, country: number, fam: Family, sex: Sex, age: number, parents: Person[]): Person {
  const first = pick(r, sex === "M" ? def.male : def.female);
  const traits = {
    openness: normal01(r, 0.5, 0.17),
    conscientiousness: normal01(r, 0.5, 0.17),
    extraversion: normal01(r, 0.5, 0.17),
    agreeableness: normal01(r, 0.5, 0.17),
    neuroticism: normal01(r, 0.5, 0.17),
  };
  // Children take after their parents; adults after their culture, a little more traditional with age.
  const avg = (k: "religiosity" | "patriotism" | "trustGov") => parents.length ? parents.reduce((a, p) => a + p.beliefs[k], 0) / parents.length : def.culture[k];
  const ageShift = (age - 40) / 200;
  const beliefs = {
    religiosity: normal01(r, avg("religiosity") + (parents.length ? 0 : ageShift), parents.length ? 0.1 : 0.18),
    patriotism: normal01(r, avg("patriotism") + (parents.length ? 0 : ageShift * 0.8), parents.length ? 0.1 : 0.18),
    trustGov: normal01(r, avg("trustGov"), parents.length ? 0.1 : 0.18),
  };
  const likes = sample(r, Object.keys(HOBBIES), 2 + (chance(r, 0.5) ? 1 : 0));
  const dislikes = sample(r, DISLIKES.filter((d) => !likes.includes(d)), 1 + (chance(r, 0.5) ? 1 : 0));
  const child = age < 16;
  // Starting feelings lean on temperament; Laya takes over from the second morning.
  const feelings = {
    joy: normal01(r, 0.6 - (traits.neuroticism - 0.5) * 0.4, 0.12),
    sadness: normal01(r, 0.15 + (traits.neuroticism - 0.5) * 0.2, 0.08),
    anger: normal01(r, 0.12 + (0.5 - traits.agreeableness) * 0.2, 0.08),
    fear: normal01(r, 0.12 + (traits.neuroticism - 0.5) * 0.2, 0.08),
  };
  // Old national rivalries: patriots dislike their country's rivals more.
  const hate = COUNTRIES.map((_, c) => (c === country ? 0 : clamp01(0.05 + Math.max(0, -START_RELATIONS[country][c]) * (0.4 + beliefs.patriotism * 0.6) + (r() - 0.5) * 0.1)));
  return {
    id, first, name: `${first} ${fam.surname}`, sex, age, country, family: fam.id, job: jobFor(r, age, def),
    alive: true,
    traits, beliefs,
    needs: { energy: between(r, 0.6, 1), hunger: between(r, 0.5, 1), social: between(r, 0.4, 1), health: 1 },
    feelings, hate,
    likes, dislikes,
    wakeHour: child ? 7 : 5.5 + (1 - traits.conscientiousness) * 2.5 + r() * 0.5,
    sleepHour: child ? 20 + r() : Math.min(23.75, 21 + traits.extraversion * 1.5 + traits.openness * 0.8 + r() * 0.5),
    rels: [], memories: [], log: [],
    activity: "sleep", activityLabel: "Sleeping", activityStart: 0, lastUpdate: 0, lastWorkDay: -1,
    nextDecisionAt: 0, waiting: false, dueAt: 0, pendingEvent: null, lastFeelingsDay: 0, aiCount: 0,
    x: 0, y: 0,
  };
}

function jobFor(r: Rng, age: number, def: CountryDef): Job {
  if (age < 6) return NO_JOB.child;
  if (age < 18) return NO_JOB.student;
  if (age < 23 && chance(r, 0.5)) return NO_JOB.student;
  if (age >= 65) return NO_JOB.retired;
  if (chance(r, 0.07)) return NO_JOB.unemployed;
  // A military republic employs more soldiers.
  const w = JOBS.map((j) => (j.id === "soldier" && def.government.includes("military") ? 3 : j.id === "doctor" ? 0.4 : 1));
  return JOBS[weighted(r, w)];
}

/** a sees b as `kindForA`, b sees a as `kindForB`. */
function link(r: Rng, a: Person, b: Person, kindForA: RelKind, kindForB: RelKind, lo: number, hi: number) {
  const base = between(r, lo, hi);
  a.rels.push({ id: b.id, kind: kindForA, closeness: clamp01(base + (a.traits.agreeableness - 0.5) * 0.2) });
  b.rels.push({ id: a.id, kind: kindForB, closeness: clamp01(base + (b.traits.agreeableness - 0.5) * 0.2) });
}

function linkSibling(r: Rng, people: Person[], adults: number[], p: Person) {
  if (!chance(r, 0.4) || !adults.length) return;
  const candidates = sample(r, adults, 12).filter((id) => Math.abs(people[id].age - p.age) <= 12 && id !== p.id);
  if (candidates.length) link(r, p, people[candidates[0]], "sibling", "sibling", 0.3, 0.85);
}

/** Make `parent` the parent of `child`, and grandparent of the child's children. */
function adoptAsParent(r: Rng, people: Person[], parent: Person, child: Person) {
  link(r, child, parent, "parent", "child", 0.45, 0.95);
  for (const rel of child.rels) if (rel.kind === "child") link(r, people[rel.id], parent, "grandparent", "grandchild", 0.4, 0.9);
}

function makeFriends(r: Rng, people: Person[]) {
  const byCountry = new Map<number, Person[]>();
  for (const p of people) if (p.age >= 10) (byCountry.get(p.country) ?? byCountry.set(p.country, []).get(p.country)!).push(p);
  const all = people.filter((p) => p.age >= 10);
  const friendCount = (p: Person) => p.rels.reduce((n, x) => n + (x.kind === "friend" ? 1 : 0), 0);
  for (const p of all) {
    const want = 1 + Math.round(p.traits.extraversion * 4);
    for (let tries = 0; tries < 3 && friendCount(p) < want; tries++) {
      const pool = chance(r, 0.08) ? all : byCountry.get(p.country)!;
      let best: Person | null = null, bestScore = -Infinity;
      for (let i = 0; i < 20; i++) {
        const c = pool[Math.floor(r() * pool.length)];
        if (c.id === p.id || c.family === p.family || p.rels.some((x) => x.id === c.id) || friendCount(c) >= 7) continue;
        // People befriend people like them: similar age and temperament.
        const traitGap = Math.abs(c.traits.extraversion - p.traits.extraversion) + Math.abs(c.traits.openness - p.traits.openness) + Math.abs(c.traits.agreeableness - p.traits.agreeableness);
        const shared = c.likes.filter((l) => p.likes.includes(l)).length;
        const score = 1 - Math.abs(c.age - p.age) / 25 - traitGap * 0.5 + shared * 0.3 + r() * 0.3;
        if (score > bestScore) { best = c; bestScore = score; }
      }
      if (best) link(r, p, best, "friend", "friend", 0.25, 0.85);
    }
  }
}

export function placeFamily(r: Rng, fam: Family, country: Country, people: Person[]) {
  const a = r() * Math.PI * 2, d = country.r * 0.92 * Math.sqrt(r());
  fam.x = country.x + Math.cos(a) * d;
  fam.y = country.y + Math.sin(a) * d;
  const members = fam.members.map((id) => people[id]);
  const spread = 1.6 * Math.sqrt(members.length);
  members.forEach((p, i) => {
    const t = (i / Math.max(1, members.length)) * Math.PI * 2 + r() * 0.5;
    const rad = members.length === 1 ? 0 : spread * (0.6 + r() * 0.4);
    p.x = fam.x + Math.cos(t) * rad;
    p.y = fam.y + Math.sin(t) * rad;
  });
}

function layout(r: Rng, families: Family[], countries: Country[], people: Person[]) {
  for (const f of families) placeFamily(r, f, countries[f.country], people);
}
