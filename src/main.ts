import "./style.css";
import { AiClient, type ModelBase } from "./ai/client";
import type { Backend, LoadOptions } from "./ai/protocol";
import { COUNTRIES, DISASTERS } from "./sim/data";
import { generateWorld } from "./sim/generate";
import type { DisasterKind } from "./sim/types";
import { KILL_CAUSES, World, formatTime } from "./sim/world";
import { MapView } from "./ui/map";
import { Sidebar } from "./ui/sidebar";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Rough cost: ~7 one-question decisions plus a 2–4 question morning check per person per sim day. */
const QUESTIONS_PER_PERSON_DAY = 9;
const DEFAULT_MS_PER_QUESTION = 1300;

const ai = new AiClient();
const map = new MapView($<HTMLCanvasElement>("map"));
const sidebar = new Sidebar($("side"));
let world: World | null = null;
let running = true;

// ---------- start screen: nothing runs until the model is loaded ----------

function estimate(n: number, msPerQuestion = DEFAULT_MS_PER_QUESTION) {
  const minutes = (n * QUESTIONS_PER_PERSON_DAY * msPerQuestion) / 60000;
  return minutes < 60 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`;
}
function renderEstimate() {
  const n = Number($<HTMLInputElement>("startPop").value) || 50;
  $("startEstimate").textContent = `With ${n.toLocaleString()} people, one sim day takes about ${estimate(n)} of real time. Fewer people make the days go faster.`;
}
$<HTMLInputElement>("startPop").oninput = renderEstimate;
renderEstimate();

$("startBtn").onclick = () => {
  const [variant, backend] = $<HTMLSelectElement>("startBuild").value.split("|") as [LoadOptions["variant"], Backend];
  ai.load({ base: $<HTMLSelectElement>("startBase").value as ModelBase, variant, backend, threads: Math.min(4, navigator.hardwareConcurrency || 2) });
  for (const id of ["startBtn", "startPop", "startBase", "startBuild"]) $<HTMLInputElement>(id).disabled = true;
};

function updateStart() {
  if (ai.status !== "off") $("startStatus").textContent = ai.statusText;
  $<HTMLElement>("startBar").style.width = `${(ai.progress ?? (ai.status === "loading" ? 1 : 0)) * 100}%`;
  if (ai.status === "error") {
    $("startStatus").textContent = `Could not load the model: ${ai.statusText}`;
    for (const id of ["startBtn", "startPop", "startBase", "startBuild"]) $<HTMLInputElement>(id).disabled = false;
  }
  if (ai.ready) {
    $("start").hidden = true;
    $<HTMLButtonElement>("generate").disabled = false;
    $<HTMLInputElement>("population").value = $<HTMLInputElement>("startPop").value;
    generate();
  }
}

// ---------- world ----------

function generate() {
  const n = Math.max(10, Math.min(2000, Number($<HTMLInputElement>("population").value) || 50));
  $<HTMLInputElement>("population").value = String(n);
  ai.clear();
  world = new World(generateWorld(n, (Math.random() * 2 ** 31) | 0), ai);
  map.setWorld(world);
  renderLegend();
}

$("generate").onclick = generate;
$<HTMLInputElement>("population").onkeydown = (e) => { if (e.key === "Enter" && ai.ready) generate(); };

map.onClick = (x, y, pid) => {
  if (!world) return;
  const tool = $<HTMLSelectElement>("tool").value as DisasterKind | "";
  if (tool) {
    const by = $<HTMLSelectElement>("by").value;
    world.dropDisaster(tool, x, y, tool === "bomb" && by !== "" ? Number(by) : null);
    return;
  }
  if (pid !== null) world.selection = { type: "person", id: pid };
  else {
    const c = world.countryAt(x, y);
    world.selection = c ? { type: "country", id: c.id } : null;
  }
};
sidebar.onSelectPerson = (id) => { if (world) world.selection = { type: "person", id }; };
sidebar.onSelectCountry = (id) => { if (world) world.selection = { type: "country", id }; };
sidebar.onClose = () => { if (world) world.selection = null; };
sidebar.onRandom = () => {
  if (!world) return;
  const alive = world.people.filter((p) => p.alive && p.age >= 16);
  if (alive.length) world.selection = { type: "person", id: alive[Math.floor(Math.random() * alive.length)].id };
};
sidebar.onKill = (pid, cause) => world?.kill(pid, KILL_CAUSES[cause].cause);

function renderLegend() {
  if (!world) return;
  $("legend").innerHTML =
    world.countries.map((c) => `<span><i class="dot" style="background:${map.countryColor(c.hue)}"></i>${c.name}</span>`).join("") +
    `<span><i class="dot" style="background:var(--grief)"></i>sad</span>` +
    `<span><i class="dot ring danger"></i>injured</span>` +
    `<span><i class="dot ring bold"></i>Laya deciding now</span>` +
    `<span><i class="dot ring faint"></i>in line for Laya</span>` +
    `<span><i class="dot hollow"></i>dead</span>`;
}

// ---------- disaster tool ----------

$<HTMLSelectElement>("by").innerHTML = `<option value="">by: unknown</option>` + COUNTRIES.map((c, i) => `<option value="${i}">by: ${c.name}</option>`).join("");
function setTool(kind: DisasterKind | "") {
  $<HTMLSelectElement>("tool").value = kind;
  $("by").hidden = kind !== "bomb";
  $("toolHint").hidden = kind === "";
  $("toolCancel").hidden = kind === "";
  map.toolRadius = kind ? DISASTERS[kind].radius : null;
}
$<HTMLSelectElement>("tool").onchange = (e) => setTool((e.target as HTMLSelectElement).value as DisasterKind | "");
$("toolCancel").onclick = () => setTool("");

// ---------- controls ----------

const setRunning = (on: boolean) => { running = on; $("play").textContent = on ? "Pause" : "Play"; };
$("play").onclick = () => setRunning(!running);
document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.code === "Space" && !typing) { e.preventDefault(); setRunning(!running); }
  if (e.key === "Escape") {
    if ($<HTMLSelectElement>("tool").value) setTool("");
    else if (world) world.selection = null;
  }
});

// theme: system -> light -> dark
const THEMES = ["system", "light", "dark"] as const;
let theme: (typeof THEMES)[number] = "system";
try { theme = (localStorage.getItem("theme") as typeof theme) || "system"; } catch { /* storage blocked */ }
function applyTheme() {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  $("theme").textContent = theme === "system" ? "Theme: auto" : theme === "light" ? "Theme: light" : "Theme: dark";
  map.refreshTheme();
  renderLegend();
}
$("theme").onclick = () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { localStorage.setItem("theme", theme); } catch { /* storage blocked */ }
  applyTheme();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

// ---------- loop ----------

let last = performance.now();
let fps = 60, simMs = 0, lastPanel = 0;

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps = fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;

  if (world && running) {
    const t0 = performance.now();
    world.step(dt * Number($<HTMLSelectElement>("speed").value));
    simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
    ai.tick();
  }
  map.deciding = ai.decidingKeys();
  map.draw(now);

  if (now - lastPanel > 250) {
    lastPanel = now;
    if (world) {
      sidebar.render(world, ai);
      updateTopBar(world);
      renderLaya(world);
      renderHeadlines(world, now);
    } else updateStart();
  }
  requestAnimationFrame(frame);
}

function updateTopBar(w: World) {
  $("clock").textContent = formatTime(w.t);
  const s = ai.stats();
  const hold = w.aiHolding && running ? `<br><span class="lag">clock paused until Laya catches up</span>` : "";
  $("perf").innerHTML =
    `1 sim day ≈ <b>${estimate(w.population().alive, s.msPerQuestion ?? DEFAULT_MS_PER_QUESTION)}</b> real time` +
    `<br>fps <b>${Math.round(fps)}</b> · sim <b>${simMs.toFixed(1)} ms</b> · draw <b>${map.drawMs.toFixed(1)} ms</b>${hold}`;
}

// ---------- Laya panel: what is being decided right now ----------

$("laya").innerHTML = `
  <div class="lhead"><b>Laya</b> <span id="lstate" class="muted"></span></div>
  <div class="lchips" id="lchips"></div>
  <div class="lfoot muted" id="lfoot"></div>`;
let shownBatch = -1;

function renderLaya(w: World) {
  const cur = ai.current, last = ai.lastBatch;
  $("lstate").textContent = cur
    ? `batch #${cur.id} · deciding for ${cur.jobs.length} · ${((performance.now() - cur.startedAt) / 1000).toFixed(1)} s`
    : ai.queueLength ? "starting the next batch…" : "idle · everyone knows what they're doing";
  // Names only change when a new batch starts, so the buttons stay clickable.
  const id = cur?.id ?? 0;
  if (id !== shownBatch) {
    shownBatch = id;
    $("lchips").innerHTML = cur ? cur.jobs.map((j) => `<button class="chip-btn${j.key[0] === "c" ? " gov" : ""}" data-key="${j.key}">${escapeHtml(j.label)}</button>`).join("") : "";
  }
  const parts: string[] = [];
  if (last?.ms) parts.push(`last batch: ${last.jobs.length} decisions in ${(last.ms / 1000).toFixed(1)} s (${(last.ms / 1000 / Math.max(1, last.jobs.length)).toFixed(1)} s each)`);
  parts.push(`${ai.queueLength} in line`);
  if (w.aiHolding && running) parts.push("clock waiting");
  $("lfoot").textContent = parts.join(" · ");
}

$("lchips").addEventListener("click", (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key;
  if (!key || !world) return;
  const id = Number(key.slice(1));
  world.selection = key[0] === "c" ? { type: "country", id } : { type: "person", id };
});

// ---------- headlines: what governments and disasters just did ----------

let shownHeadlines = "";
function renderHeadlines(w: World, now: number) {
  const recent = w.events.filter((e) => e.cid !== undefined && now - e.realAt < 12000).slice(-3);
  const key = recent.map((e) => `${e.realAt}`).join("|");
  if (key === shownHeadlines) return;
  shownHeadlines = key;
  $("headlines").innerHTML = recent.map((e) => `<button class="headline" data-cid="${e.cid}">${escapeHtml(e.text)}</button>`).join("");
}
$("headlines").addEventListener("click", (e) => {
  const cid = (e.target as HTMLElement).closest<HTMLElement>("[data-cid]")?.dataset.cid;
  if (cid !== undefined && world) world.selection = { type: "country", id: Number(cid) };
});

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

applyTheme();
requestAnimationFrame(frame);

// Handy in the dev console: __sim.world.people[0], __sim.ai.stats()
if (import.meta.env.DEV) Object.assign(window, { __sim: { get world() { return world; }, ai } });
