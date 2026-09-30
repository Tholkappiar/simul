// The right-hand panel: the selected person, the selected country, or a world overview.
import type { AiClient } from "../ai/client";
import { RELATION_LABEL } from "../sim/data";
import { beliefWords, personalityWords } from "../sim/prompts";
import type { Country, LogEntry, Person } from "../sim/types";
import { KILL_CAUSES, formatDuration, formatTime, type KillCauseId, type World } from "../sim/world";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (n: number) => Math.round(n).toLocaleString();

function bar(label: string, v: number, note = "", tone = "") {
  return `<div class="bar ${tone}"><span class="bl">${esc(label)}</span><span class="track"><span class="fill" style="width:${(Math.max(0, Math.min(1, v)) * 100).toFixed(0)}%"></span></span><span class="bv">${note ? esc(note) : Math.round(v * 100)}</span></div>`;
}

/** -1..1 as a bar that grows left (hostile) or right (friendly) from the middle. */
function relBar(label: string, v: number, war: boolean) {
  const w = Math.min(1, Math.abs(v)) * 50;
  const style = v < 0 ? `left:${50 - w}%;width:${w}%` : `left:50%;width:${w}%`;
  const word = war ? "at war" : v < -0.5 ? "enemy" : v < -0.15 ? "tense" : v > 0.4 ? "friendly" : "neutral";
  return `<div class="bar ${v < 0 ? "warn" : ""}"><span class="bl">${esc(label)}</span><span class="track mid"><span class="fill" style="${style}"></span></span><span class="bv">${word}</span></div>`;
}

/** Only touch the DOM when the markup changed, so buttons aren't replaced mid-click. */
const lastHTML = new WeakMap<HTMLElement, string>();
function setHTML(el: HTMLElement, html: string) {
  if (lastHTML.get(el) !== html) { lastHTML.set(el, html); el.innerHTML = html; }
}

const KIND_LABEL: Record<LogEntry["kind"], string> = { action: "does", thought: "thinks", ai: "Laya", event: "event" };

/** Newest first. Only re-renders when something new was logged, and keeps the scroll position. */
function renderFeed(el: HTMLElement, log: LogEntry[], key: { v: string }) {
  const last = log[log.length - 1];
  const k = `${log.length}:${last?.t}:${last?.text}`;
  if (k === key.v) return;
  key.v = k;
  const scroll = el.scrollTop;
  el.innerHTML = log.length ? [...log].reverse().map((e) => `
    <div class="entry ${e.kind}">
      <span class="time">${formatTime(e.t, false)}</span>
      <span class="kind">${KIND_LABEL[e.kind]}</span>
      <span class="text">${e.kind === "thought" ? "“" + esc(e.text) + "”" : esc(e.text)}${e.meta ? `<span class="meta">${esc(e.meta)}</span>` : ""}</span>
    </div>`).join("") : `<div class="muted pad">Nothing yet.</div>`;
  el.scrollTop = scroll;
}

export class Sidebar {
  onSelectPerson: (pid: number) => void = () => {};
  onSelectCountry: (cid: number) => void = () => {};
  onClose: () => void = () => {};
  onKill: (pid: number, cause: KillCauseId) => void = () => {};
  onRandom: () => void = () => {};

  private feedKey = { v: "" };
  private viewKey = "";

  constructor(private root: HTMLElement) {
    root.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-pid],[data-cid],[data-action]");
      if (!el) return;
      if (el.dataset.pid !== undefined) this.onSelectPerson(Number(el.dataset.pid));
      else if (el.dataset.cid !== undefined) this.onSelectCountry(Number(el.dataset.cid));
      else if (el.dataset.action === "close") this.onClose();
      else if (el.dataset.action === "random") this.onRandom();
      else if (el.dataset.action === "kill") {
        const cause = (root.querySelector("#cause") as HTMLSelectElement).value as KillCauseId;
        this.onKill(Number(el.dataset.target), cause);
      }
    });
  }

  render(world: World, ai: AiClient) {
    const sel = world.selection;
    if (sel !== null && sel.type === "person") this.renderPerson(world, ai, world.people[sel.id]);
    else if (sel !== null && sel.type === "country") this.renderCountry(world, ai, world.countries[sel.id]);
    else this.renderWorld(world, ai);
  }

  /** Rebuilds the panel skeleton when the view changes; returns a lookup for its parts. */
  private frame(key: string, html: string) {
    if (this.viewKey !== key) {
      this.viewKey = key;
      this.feedKey = { v: "" };
      this.root.innerHTML = html;
    }
    return (id: string) => this.root.querySelector<HTMLElement>("#" + id)!;
  }

  // ---------- person ----------

  private renderPerson(w: World, ai: AiClient, p: Person) {
    w.refresh(p);
    const country = w.countries[p.country];
    const $ = this.frame(`p${p.id}:${p.alive}`, `
      <div class="ph">
        <div><h2>${esc(p.name)}</h2><div class="sub" id="psub"></div></div>
        <button class="icon" data-action="close" title="Back to world (Esc)">✕</button>
      </div>
      <div class="now" id="pnow"></div>
      ${p.alive ? `<div class="kill">
        <select id="cause">${Object.entries(KILL_CAUSES).map(([k, c]) => `<option value="${k}">${esc(c.label)}</option>`).join("")}</select>
        <button class="danger" data-action="kill" data-target="${p.id}">Kill</button>
      </div>` : ""}
      <h3>Live feed</h3>
      <div class="feed" id="pfeed"></div>
      <div id="pstats"></div>
      <div id="prels"></div>
      <div id="pmem"></div>`);

    setHTML($("psub"), `${p.age} · ${p.sex === "M" ? "male" : "female"} · ${esc(p.job.label)} · <button class="link" data-cid="${country.id}"><span class="dot" style="background:hsl(${country.hue},58%,50%)"></span>${esc(country.name)}</button>`);

    let now: string;
    if (!p.alive) now = `<span class="pill dead">Dead</span> <span class="muted">${esc(p.deathCause ?? "")} · ${formatTime(p.diedAt!)}</span>`;
    else if (p.waiting) {
      const pos = ai.position(`p${p.id}`);
      now = `<span class="pill thinking">${pos === 0 ? "Laya is deciding…" : `Waiting for Laya${pos ? ` · #${pos} in line` : ""}`}</span> <span class="muted">${esc(p.activityLabel)}</span>`;
    } else if (p.age < 5) now = `<span class="pill">${esc(p.activityLabel)}</span> <span class="muted">too young to decide; follows the family</span>`;
    else now = `<span class="pill">${esc(p.activityLabel)}</span> <span class="muted">next decision in ${formatDuration(p.nextDecisionAt - w.t)}</span>`;
    if (p.pendingEvent && p.alive) now += `<div class="pending">Reacting to: ${esc(p.pendingEvent.text)}</div>`;
    setHTML($("pnow"), now);

    renderFeed($("pfeed"), p.log, this.feedKey);

    const n = p.needs, f = p.feelings, T = p.traits, B = p.beliefs;
    const fam = w.families[p.family];
    const hates = w.countries.filter((c) => c.id !== p.country && p.hate[c.id] > 0.15);
    setHTML($("pstats"), `
      <h3>Feelings <span class="muted small">${p.lastFeelingsDay > 0 ? `from Laya, day ${p.lastFeelingsDay + 1}` : "starting values"}</span></h3>
      ${bar("Joy", f.joy)}
      ${bar("Sadness", f.sadness, "", "warn")}
      ${bar("Anger", f.anger, "", "warn")}
      ${bar("Fear", f.fear, "", "warn")}
      ${hates.map((c) => bar(`Hate: ${c.name}`, p.hate[c.id], "", "warn")).join("")}
      ${p.leavingAt !== undefined ? `<div class="chips"><span class="chip strong">leaving the country ${formatTime(p.leavingAt)}</span></div>` : ""}
      <h3>Body</h3>
      ${bar("Health", n.health, "", n.health < 0.6 ? "warn" : "")}
      ${bar("Energy", n.energy)}
      ${bar("Food", n.hunger)}
      ${bar("Company", n.social)}
      ${bar("Money", w.moneyRatio(p), fam.money.toFixed(0))}
      <h3>Beliefs</h3>
      ${bar("Religion", B.religiosity)}
      ${bar("Patriotism", B.patriotism)}
      ${bar("Trusts gov.", B.trustGov)}
      <h3>Personality</h3>
      ${bar("Openness", T.openness)}
      ${bar("Conscientious", T.conscientiousness)}
      ${bar("Extraversion", T.extraversion)}
      ${bar("Agreeable", T.agreeableness)}
      ${bar("Neuroticism", T.neuroticism)}
      <p class="muted small">${esc([...personalityWords(p), ...beliefWords(p)].join(", ") || "fairly average in most ways")}</p>
      <div class="chips">${p.likes.map((l) => `<span class="chip">♥ ${esc(l)}</span>`).join("")}${p.dislikes.map((d) => `<span class="chip muted">✕ ${esc(d)}</span>`).join("")}</div>`);

    const rels = [...p.rels].sort((a, b) => (a.kind === "friend" ? 1 : 0) - (b.kind === "friend" ? 1 : 0) || b.closeness - a.closeness);
    setHTML($("prels"), `
      <h3>People (${rels.length})</h3>
      <div class="rels">${rels.map((r) => {
        const o = w.people[r.id];
        return `<button class="rel" data-pid="${o.id}">
          <span class="rn">${esc(o.name)}${o.alive ? "" : " †"}</span>
          <span class="rk">${RELATION_LABEL[r.kind]}${o.country !== p.country ? " · " + esc(w.countries[o.country].name) : ""}</span>
          <span class="track"><span class="fill" style="width:${(r.closeness * 100).toFixed(0)}%"></span></span>
        </button>`;
      }).join("") || `<div class="muted">No one.</div>`}</div>`);

    setHTML($("pmem"), `
      ${p.memories.length ? `<h3>Memories</h3>${[...p.memories].reverse().map((m) => `<div class="memory"><span class="time">${formatTime(m.t)}</span> ${esc(m.text)}</div>`).join("")}` : ""}
      <p class="muted small">Laya decisions for ${esc(p.first)}: ${p.aiCount}</p>`);
  }

  // ---------- country ----------

  private renderCountry(w: World, ai: AiClient, c: Country) {
    const $ = this.frame(`c${c.id}`, `
      <div class="ph">
        <div><h2><span class="dot big" style="background:hsl(${c.hue},58%,50%)"></span>${esc(c.name)}</h2><div class="sub">${esc(c.government)} · leaders are ${esc(c.temperament)}</div></div>
        <button class="icon" data-action="close" title="Back to world (Esc)">✕</button>
      </div>
      <div class="now" id="cnow"></div>
      <h3>Government feed</h3>
      <div class="feed" id="cfeed"></div>
      <div id="cstats"></div>`);

    const pos = ai.position(`c${c.id}`);
    const status = c.waiting
      ? `<span class="pill thinking">${pos === 0 ? "Laya is deciding…" : `Government is deliberating${pos ? ` · #${pos} in line` : ""}`}</span>`
      : c.pending.length ? `<span class="pill">${c.pending.length} issue${c.pending.length > 1 ? "s" : ""} on the table</span>`
      : `<span class="pill">Next review ${formatTime(c.nextReviewAt)}</span>`;
    const wars = w.countries.filter((o) => c.atWar[o.id]);
    setHTML($("cnow"), `${status}${wars.length ? ` <span class="chip strong">at war with ${wars.map((o) => esc(o.name)).join(", ")}</span>` : ""}`);

    renderFeed($("cfeed"), c.log, this.feedKey);

    const m = w.mood(c);
    const policies: string[] = [];
    if (c.curfewUntil > w.t) policies.push(`curfew until ${formatTime(c.curfewUntil)}`);
    if (c.aidUntil > w.t) policies.push(`aid until ${formatTime(c.aidUntil)}`);
    setHTML($("cstats"), `
      <h3>State</h3>
      <div class="kv"><span>Alive</span><b>${fmt(m.alive)}</b></div>
      <div class="kv"><span>Dead</span><b>${fmt(m.dead)}</b></div>
      <div class="kv"><span>Protesting now</span><b>${fmt(m.protesters)}</b></div>
      <div class="kv"><span>Soldiers</span><b>${fmt(m.soldiers)}</b></div>
      ${bar("Stability", c.stability, "", c.stability < 0.4 ? "warn" : "")}
      ${policies.length ? `<div class="chips">${policies.map((x) => `<span class="chip strong">${esc(x)}</span>`).join("")}</div>` : ""}
      <h3>Public mood <span class="muted small">average of citizens</span></h3>
      ${bar("Joy", m.joy)}
      ${bar("Anger", m.anger, "", "warn")}
      ${bar("Fear", m.fear, "", "warn")}
      ${bar("Trust in gov.", m.trust)}
      <h3>Relations</h3>
      ${w.countries.filter((o) => o.id !== c.id).map((o) => relBar(o.name, c.relations[o.id], c.atWar[o.id])).join("")}
      <p class="muted small">Laya decisions for ${esc(c.name)}: ${c.aiCount}</p>`);
  }

  // ---------- world ----------

  private renderWorld(w: World, ai: AiClient) {
    const $ = this.frame("world", `
      <div class="ph"><div><h2>World</h2><div class="sub">Click a person or a country to follow it.</div></div></div>
      <div class="how">
        <b>How decisions work</b>
        <ol>
          <li>When someone finishes what they're doing, Laya picks what they do next <i>and for how long</i>. They aren't asked again until that time is up.</li>
          <li>Decisions go to Laya in <b>batches of up to 8</b>. Reactions to events (bombs, deaths, wars) go first — governments, then people — then everyday life.</li>
          <li>Governments meet the moment something happens, and every 6 hours otherwise.</li>
        </ol>
      </div>
      <button class="ghost wide" data-action="random">Follow a random person</button>
      <div id="wstats"></div>
      <div id="wevents"></div>`);
    const pop = w.population();
    const s = w.stats;
    const st = ai.stats();
    setHTML($("wstats"), `
      <h3>Population</h3>
      <div class="kv"><span>Alive</span><b>${fmt(pop.alive)}</b></div>
      <div class="kv"><span>Dead</span><b>${fmt(pop.dead)}</b></div>
      ${w.countries.map((c) => `<div class="kv"><button class="link" data-cid="${c.id}"><span class="dot" style="background:hsl(${c.hue},58%,50%)"></span>${esc(c.name)} <span class="muted">${esc(c.government)}${c.atWar.some(Boolean) ? " · at war" : ""}</span></button><b>${fmt(pop.byCountry[c.id])}</b></div>`).join("")}
      <h3>Laya decisions so far</h3>
      <div class="kv"><span>People's decisions</span><b>${fmt(s.decisions)}</b></div>
      <div class="kv"><span>…with a feelings check</span><b>${fmt(s.feelingChecks)}</b></div>
      <div class="kv"><span>Government decisions</span><b>${fmt(s.countryDecisions)}</b></div>
      <div class="kv"><span>Disasters</span><b>${fmt(s.disasters)}</b></div>
      <div class="kv"><span>Emigrations</span><b>${fmt(s.emigrations)}</b></div>
      <h3>Laya</h3>
      <div class="kv"><span>Status</span><b>${esc(ai.statusText)}</b></div>
      ${ai.loadStats ? `<div class="kv"><span>Load</span><b>${(ai.loadStats.downloadMs / 1000).toFixed(1)} s download · ${(ai.loadStats.sessionMs / 1000).toFixed(1)} s start</b></div>` : ""}
      <div class="kv"><span>Per batch (median)</span><b>${st.p50CallMs !== null ? fmt(st.p50CallMs) + " ms" : "–"}</b></div>
      <div class="kv"><span>Per question</span><b>${st.msPerQuestion !== null ? fmt(st.msPerQuestion) + " ms" : "–"}</b></div>
      <div class="kv"><span>Batches / min</span><b>${fmt(st.callsPerMin)}</b></div>
      <div class="kv"><span>In line for Laya</span><b>${fmt(ai.queueLength)}</b></div>`);
    setHTML($("wevents"), `
      <h3>Recent events</h3>
      ${w.events.length ? [...w.events].reverse().slice(0, 50).map((e) => {
        const attr = e.pid !== undefined ? `data-pid="${e.pid}"` : e.cid !== undefined ? `data-cid="${e.cid}"` : "";
        const body = `<span class="time">${formatTime(e.t)}</span> ${esc(e.text)}`;
        return `<div class="memory">${attr ? `<button class="link" ${attr}>${body}</button>` : body}</div>`;
      }).join("") : `<div class="muted">Quiet so far. Try dropping a bomb or killing someone.</div>`}`);
  }
}
