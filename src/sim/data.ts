import type { Beliefs, DisasterKind, Job } from "./types";

export interface CountryDef {
  name: string;
  government: string;
  temperament: string;
  hue: number;
  culture: Beliefs;
  share: number; // share of the population
  male: string[];
  female: string[];
  surnames: string[];
}

export const COUNTRIES: CountryDef[] = [
  {
    name: "Northland", government: "an old monarchy", temperament: "proud but cautious", hue: 210, share: 0.3,
    culture: { religiosity: 0.65, patriotism: 0.6, trustGov: 0.6 },
    male: ["Aren", "Brann", "Corin", "Dalen", "Eskil", "Falk", "Gunnar", "Halvar", "Ivar", "Joren", "Kell", "Leif", "Magnus", "Nils"],
    female: ["Astrid", "Brynn", "Solveig", "Dagny", "Eira", "Freya", "Greta", "Hilde", "Ingrid", "Katla", "Liv", "Maren", "Runa", "Sigrid"],
    surnames: ["Ashford", "Brandt", "Holm", "Lund", "Stark", "Vik", "Dahl", "Berg", "Norrell", "Fjell", "Strand", "Hale"],
  },
  {
    name: "Southland", government: "a military republic", temperament: "aggressive and quick to use force", hue: 20, share: 0.25,
    culture: { religiosity: 0.45, patriotism: 0.7, trustGov: 0.35 },
    male: ["Dario", "Esteban", "Fabio", "Iker", "Joaquin", "Luca", "Marco", "Nico", "Oren", "Paolo", "Rafael", "Santi", "Tito", "Vito"],
    female: ["Alba", "Bianca", "Carmen", "Dalia", "Elena", "Flora", "Gia", "Inés", "Lucia", "Mira", "Nora", "Paz", "Rosa", "Vera"],
    surnames: ["Aranda", "Bravo", "Castell", "Duarte", "Ferro", "Galán", "Leone", "Marín", "Novak", "Rocha", "Sierra", "Valdez"],
  },
  {
    name: "Eastmere", government: "a young democracy", temperament: "cautious and diplomatic", hue: 150, share: 0.25,
    culture: { religiosity: 0.3, patriotism: 0.4, trustGov: 0.6 },
    male: ["Aiden", "Callum", "Declan", "Ewan", "Finn", "Gavin", "Hugo", "Jonah", "Kian", "Milo", "Owen", "Rhys", "Theo", "Wyn"],
    female: ["Ada", "Bryony", "Cara", "Delia", "Edie", "Fern", "Isla", "June", "Kira", "Lena", "Maeve", "Nell", "Orla", "Tess"],
    surnames: ["Ainsley", "Barlow", "Carrow", "Dunmore", "Ellery", "Fenwick", "Garrow", "Hollis", "Kestrel", "Marsh", "Penrose", "Wren"],
  },
  {
    name: "Westvale", government: "a trading republic", temperament: "pragmatic and focused on trade", hue: 280, share: 0.2,
    culture: { religiosity: 0.5, patriotism: 0.35, trustGov: 0.5 },
    male: ["Anselm", "Bastien", "Cyril", "Emeric", "Florian", "Gaspard", "Henrik", "Jules", "Lucien", "Matthis", "Oskar", "Remy", "Silas", "Tobin"],
    female: ["Adele", "Blanche", "Colette", "Elodie", "Fleur", "Giselle", "Hanna", "Isolde", "Juliette", "Lise", "Mathilde", "Odile", "Rosalie", "Yvette"],
    surnames: ["Aubert", "Bellamy", "Corvin", "Delacroix", "Everard", "Fontaine", "Guerin", "Lambert", "Moreau", "Roux", "Tessier", "Vidal"],
  },
];

/** Starting relations between countries (-1 hostile .. +1 friendly). Northland and Southland are old rivals. */
export const START_RELATIONS: number[][] = [
  [1, -0.35, 0.3, 0.2],
  [-0.35, 1, -0.1, 0.1],
  [0.3, -0.1, 1, 0.35],
  [0.2, 0.1, 0.35, 1],
];

export const JOBS: Job[] = [
  { id: "farmer", label: "farmer", income: 1.0, works: true },
  { id: "teacher", label: "teacher", income: 1.2, works: true },
  { id: "mechanic", label: "mechanic", income: 1.1, works: true },
  { id: "nurse", label: "nurse", income: 1.3, works: true },
  { id: "merchant", label: "merchant", income: 1.5, works: true },
  { id: "soldier", label: "soldier", income: 1.1, works: true },
  { id: "clerk", label: "clerk", income: 1.2, works: true },
  { id: "fisher", label: "fisher", income: 0.9, works: true },
  { id: "builder", label: "builder", income: 1.0, works: true },
  { id: "doctor", label: "doctor", income: 2.0, works: true },
  { id: "artist", label: "artist", income: 0.7, works: true },
];
export const SOLDIER = JOBS.find((j) => j.id === "soldier")!;
export const NO_JOB: Record<string, Job> = {
  child: { id: "child", label: "child", income: 0, works: false },
  student: { id: "student", label: "student", income: 0, works: false },
  unemployed: { id: "unemployed", label: "unemployed", income: 0, works: false },
  retired: { id: "retired", label: "retired", income: 0, works: false },
};

/** Hobby -> how the activity reads in the feed. */
export const HOBBIES: Record<string, string> = {
  music: "playing music",
  football: "playing football",
  cooking: "cooking something new",
  reading: "reading",
  gardening: "gardening",
  dancing: "dancing",
  fishing: "fishing",
  chess: "playing chess",
  painting: "painting",
  hiking: "hiking",
  gossip: "catching up on gossip",
  politics: "arguing about politics",
  cards: "playing cards",
  woodwork: "woodworking",
};
export const DISLIKES = ["crowds", "early mornings", "politics", "loud music", "gossip", "rain", "long queues", "arguments", "the army", "tax collectors"];

export const RELATION_LABEL: Record<string, string> = {
  spouse: "spouse", parent: "parent", child: "child", sibling: "sibling",
  grandparent: "grandparent", grandchild: "grandchild", friend: "friend",
};

export interface DisasterDef {
  label: string;
  radius: number; // world units (one person per ~70 square units)
  lethality: number; // chance of death at the centre, falling to 0 at the edge
  injury: number; // health lost near the centre
  moneyLoss: number; // share of family savings destroyed near the centre
  natural: boolean;
  color: string; // hsl hue for the crater
}

export const DISASTERS: Record<DisasterKind, DisasterDef> = {
  bomb: { label: "Bomb", radius: 10, lethality: 0.8, injury: 0.6, moneyLoss: 0.3, natural: false, color: "8" },
  earthquake: { label: "Earthquake", radius: 26, lethality: 0.15, injury: 0.45, moneyLoss: 0.4, natural: true, color: "30" },
  flood: { label: "Flood", radius: 22, lethality: 0.05, injury: 0.2, moneyLoss: 0.7, natural: true, color: "205" },
  fire: { label: "Wildfire", radius: 16, lethality: 0.25, injury: 0.45, moneyLoss: 0.5, natural: true, color: "18" },
};
