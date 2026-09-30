import { Tokenizer } from "@huggingface/tokenizers";
import { Laya, buildSequence, collate, toInternal, renderOptions } from "../src/laya/laya-core.js";

// ONNX Runtime is served as a static file from public/vendor/ (it loads its .wasm next to itself).
const ORT_DIR = new URL(`${import.meta.env.BASE_URL}vendor/ort/`, location.href).href;
const ort = await import(/* @vite-ignore */ ORT_DIR + "ort.min.mjs");

// Model files published by the layaForWeb demo. Override with ?modelBase=...
const MODEL_BASES = {
  general: "https://huggingface.co/VishalMysore/layaForWeb/resolve/main/",
  typed: "https://huggingface.co/VishalMysore/layaForWebTrained/resolve/main/",
};

// ---------- test people and situations ----------

const PERSONAS = [
  { name: "Arjun", traits: "anxious, cautious, religious", bio: "Arjun is a 34-year-old farmer from Northland. He is anxious, cautious and deeply religious. He avoids conflict, cares most about keeping his wife and two children safe, and trusts the village elders." },
  { name: "Mira", traits: "hot-tempered, impulsive, anti-government", bio: "Mira is a 27-year-old mechanic from Northland. She is hot-tempered, impulsive and fiercely loyal to her family. She has always distrusted the government and the army, and believes injustice must be answered." },
  { name: "Tomas", traits: "calm, pragmatic, patriotic", bio: "Tomas is a 58-year-old retired civil servant from Northland. He is calm, pragmatic and patriotic. He respects the law and the government, values order and stability, and rarely acts on emotion." },
  { name: "Lena", traits: "sociable, adventurous, apolitical", bio: "Lena is a 22-year-old student from Northland. She is sociable, adventurous and ambitious. She has little interest in politics, dreams of a career abroad, and has friends in several other countries." },
];

const SCENARIOS = [
  {
    id: "loss", title: "Brother killed", feelingLabel: "Anger",
    text: (n) => `Yesterday, ${n}'s younger brother was shot and killed by government soldiers during a raid on their town. The soldiers claimed he was a rebel; the family says he was not.`,
    questions: (n) => ({
      action: { type: "choice", instructions: `What does ${n} most likely do in the next few days?`, criteria: {
        grieve: "Stays home and grieves with the family", revenge: "Seeks revenge against the soldiers", flee: "Leaves the country with close family",
        protest: "Joins a public protest against the government", carry_on: "Goes back to normal work and routine" } },
      feeling: { type: "score", instructions: `How angry is ${n}?`, criteria: ["Calm", "Upset", "Angry", "Furious"] },
      belief: { type: "noul", instructions: `${n} now distrusts the government more than before` },
    }),
  },
  {
    id: "war", title: "War declared", feelingLabel: "Fear",
    text: () => "Northland has just declared war on its neighbour Southland. The government announced that adults under 40 may be called up for military service.",
    questions: (n) => ({
      action: { type: "choice", instructions: `What does ${n} most likely do?`, criteria: {
        enlist: "Volunteers for the army", avoid: "Quietly tries to avoid the call-up", flee: "Leaves the country",
        protest: "Speaks out against the war", wait: "Waits and carries on as normal" } },
      feeling: { type: "score", instructions: `How afraid is ${n}?`, criteria: ["Not afraid", "A little afraid", "Afraid", "Terrified"] },
      belief: { type: "noul", instructions: `${n} supports the war` },
    }),
  },
  {
    id: "evening", title: "Ordinary Friday", feelingLabel: "Wants company",
    text: (n) => `It is Friday evening. ${n} has finished work and is tired. A friend has invited ${n} to a dinner party tonight. Money is a bit tight this month.`,
    questions: (n) => ({
      action: { type: "choice", instructions: `What does ${n} do tonight?`, criteria: {
        party: "Goes to the dinner party", home: "Stays home and rests", family: "Spends the evening with family", work: "Does extra work to earn money" } },
      feeling: { type: "score", instructions: `How much does ${n} want company tonight?`, criteria: ["Wants to be alone", "Neutral", "Wants company"] },
      belief: { type: "noul", instructions: `${n} spends money on something fun this weekend` },
    }),
  },
];

const stateFor = (p, s) => `${p.bio}\n\nSituation: ${s.text(p.name)}`;

// ---------- small helpers ----------

const $ = (id) => document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0)); // let the page repaint between calls
const pct = (x) => (x * 100).toFixed(0) + "%";
const fmt = (n) => Math.round(n).toLocaleString();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
function setStatus(id, msg, warn = false) { $(id).textContent = msg; $(id).className = "status" + (warn ? " warn" : ""); }
function setProgress(f) { $("progress").style.visibility = f == null ? "hidden" : "visible"; if (f != null) $("progressBar").style.width = (f * 100).toFixed(1) + "%"; }

// ---------- theme ----------

const THEMES = ["system", "light", "dark"];
let theme = "system";
try { theme = localStorage.getItem("bench-theme") || "system"; } catch {}
function applyTheme() {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  $("themeBtn").textContent = "Theme: " + theme;
}
$("themeBtn").onclick = () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { localStorage.setItem("bench-theme", theme); } catch {}
  applyTheme();
};
applyTheme();

// ---------- model loading (same steps as layaForWeb's app.js) ----------

let laya = null;
const results = { env: {}, load: null, speed: null, personality: null };

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length; onProgress?.(got);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Weights are split into 24 MiB parts; cache each part in Cache Storage so reloads skip the download.
async function fetchWeights(base, entry) {
  let cache = null;
  try { cache = await caches.open("laya-" + entry.sha256.slice(0, 16)); } catch {}
  const out = new Uint8Array(entry.size); let off = 0, cached = 0;
  for (const part of entry.parts) {
    const url = base + part;
    let bytes = null;
    try { const hit = cache && await cache.match(url); if (hit) { bytes = new Uint8Array(await hit.arrayBuffer()); cached++; } } catch {}
    if (!bytes) {
      bytes = await fetchBytes(url, (got) => {
        setProgress((off + got) / entry.size);
        setStatus("loadStatus", `Downloading weights: ${((off + got) / 1048576).toFixed(0)} / ${(entry.size / 1048576).toFixed(0)} MB`);
      });
      try { await cache?.put(url, new Response(bytes)); } catch {}
    }
    out.set(bytes, off); off += bytes.length; setProgress(off / entry.size);
  }
  if (off !== entry.size) throw new Error(`weights incomplete: ${off} of ${entry.size} bytes`);
  return { data: out, cached, parts: entry.parts.length };
}

async function loadModel() {
  $("loadBtn").disabled = true; $("speedBtn").disabled = true; $("personaBtn").disabled = true;
  laya = null;
  try {
    const baseKey = $("base").value;
    const base = (new URLSearchParams(location.search).get("modelBase") || MODEL_BASES[baseKey]).replace(/\/?$/, "/");
    const [variant, backend] = $("build").value.split("|");
    if (backend === "webgpu" && !(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)))
      throw new Error("WebGPU is not available in this browser. Use Chrome or Edge, or pick a WASM build.");

    const threads = Math.max(1, Number($("threads").value) || 1);
    ort.env.wasm.wasmPaths = ORT_DIR;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? threads : 1;

    setStatus("loadStatus", "Fetching manifest, tokenizer and config…"); setProgress(0);
    const [manifest, tj, tc, cfg] = await Promise.all(
      ["manifest.json", "tokenizer.json", "tokenizer_config.json", "rl_agent_config.json"].map((f) =>
        fetch(base + f).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); })));
    const v = manifest.variants[variant];
    if (!v) throw new Error(`build ${variant} not found in manifest`);
    const tokenizer = new Tokenizer(tj, tc);

    const t0 = performance.now();
    const graph = await fetchBytes(base + v.onnx);
    const w = await fetchWeights(base, v.data);
    const downloadMs = performance.now() - t0;

    setStatus("loadStatus", "Creating inference session…"); setProgress(null); await tick();
    const t1 = performance.now();
    const session = await ort.InferenceSession.create(graph, {
      executionProviders: backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
      graphOptimizationLevel: "all",
      externalData: [{ path: v.data.name, data: w.data }],
    });
    const sessionMs = performance.now() - t1;
    laya = new Laya(ort, session, tokenizer, cfg);

    setStatus("loadStatus", "Warming up…"); await tick();
    const t2 = performance.now();
    await laya.systemOne("warm up", { w: { type: "noul", instructions: "This is a warm-up call" } });
    const warmupMs = performance.now() - t2;

    results.load = { checkpoint: baseKey, variant, backend, threads: ort.env.wasm.numThreads, downloadMs, partsFromCache: `${w.cached}/${w.parts}`, sessionMs, warmupMs };
    results.speed = null; results.personality = null;
    setStatus("loadStatus", `Ready. Download ${(downloadMs / 1000).toFixed(1)} s (${w.cached}/${w.parts} parts from cache) · session ${(sessionMs / 1000).toFixed(1)} s · first call ${fmt(warmupMs)} ms`);
    renderEnv();
    $("speedBtn").disabled = false; $("personaBtn").disabled = false; $("copyBtn").disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("loadStatus", "Could not load: " + (e?.message || e), true);
  } finally {
    setProgress(null); $("loadBtn").disabled = false;
  }
}

function renderEnv() {
  results.env = {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    memoryGB: navigator.deviceMemory ?? null,
    crossOriginIsolated: self.crossOriginIsolated,
  };
  const items = [
    ["Backend", results.load ? (results.load.backend === "webgpu" ? "WebGPU" : "WASM") : "–"],
    ["WASM threads", results.load ? results.load.threads : "–"],
    ["CPU cores", results.env.cores ?? "?"],
    ["Cross-origin isolated", results.env.crossOriginIsolated ? "yes" : "no"],
  ];
  $("env").innerHTML = items.map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("");
}

// ---------- speed test ----------

async function speedTest() {
  if (!laya) return;
  $("speedBtn").disabled = true; $("personaBtn").disabled = true;
  const runs = Math.max(1, Number($("runs").value) || 10);
  const sizes = $("sizes").value.split(",").map((s) => parseInt(s, 10)).filter((n) => n > 0);
  const scenario = SCENARIOS[0];
  const rows = [];
  results.speed = null;
  try {
    for (const size of sizes) {
      // One call answers `size` decisions for `size` different people, batched into a single forward pass.
      const people = Array.from({ length: size }, (_, i) => PERSONAS[i % PERSONAS.length]);
      const times = [], modelTimes = [];
      for (let r = 0; r <= runs; r++) {
        setStatus("speedStatus", `Batch ${size}: run ${Math.min(r + 1, runs)} of ${runs}…`); await tick();
        const t0 = performance.now();
        const ms = await runBatch(people.map((p) => ({ state: stateFor(p, scenario), question: scenario.questions(p.name).action })));
        const total = performance.now() - t0;
        if (r === 0) continue; // first call per batch size warms up that tensor shape
        times.push(total); modelTimes.push(ms);
      }
      const p50 = quantile(times, 0.5);
      rows.push({ batch: size, p50, p95: quantile(times, 0.95), min: Math.min(...times), max: Math.max(...times),
        modelOnlyP50: quantile(modelTimes, 0.5), msPerDecision: p50 / size, runs: times.length });
      results.speed = rows;
      renderSpeed(rows);
    }
    setStatus("speedStatus", `Done: ${runs} timed runs per batch size, plus one warm-up run each.`);
  } catch (e) {
    console.error(e); setStatus("speedStatus", "Speed test failed: " + (e?.message || e), true);
  } finally {
    $("speedBtn").disabled = false; $("personaBtn").disabled = false;
  }
}

// Laya.systemOne shares one state across all its questions. The simulator needs one state per person,
// so build the batch from the same pieces systemOne uses: one sequence per (person, question), one forward pass.
// Returns the inference-only time; the caller measures the total including tokenizing.
async function runBatch(items) {
  const cfg = laya.cfg;
  const seqs = items.map(({ state, question }) => {
    const q = toInternal(question);
    const s = buildSequence(laya.tok, laya.sp, state, q, cfg.max_len ?? 512, cfg.head_max_len ?? 192);
    if (s.markers.length !== renderOptions(q).length) throw new Error("options exceed head_max_len");
    return { ids: s.ids, markers: s.markers, qtype: 0 }; // 0 = choice
  });
  const b = collate(seqs, laya.sp.pad);
  const feeds = {
    input_ids: new ort.Tensor("int64", b.ids, [b.n, b.L]),
    attention_mask: new ort.Tensor("int64", b.att, [b.n, b.L]),
    marker_pos: new ort.Tensor("int64", b.mpos, [b.n, b.kmax]),
    marker_mask: new ort.Tensor("bool", b.mmask, [b.n, b.kmax]),
    qtype: new ort.Tensor("int64", b.qtype, [b.n]),
  };
  const t0 = performance.now();
  await laya.session.run(feeds);
  return performance.now() - t0;
}

function renderSpeed(rows) {
  $("speedTable").hidden = false;
  $("speedTable").querySelector("tbody").innerHTML = rows.map((r) => `<tr>
    <td>${r.batch}</td><td class="num">${fmt(r.p50)}</td><td class="num">${fmt(r.p95)}</td>
    <td class="num">${fmt(r.min)}</td><td class="num">${fmt(r.max)}</td>
    <td class="num"><b>${fmt(r.msPerDecision)}</b></td><td class="num">${fmt(3.6e6 / r.msPerDecision)}</td></tr>`).join("");
  renderProjection();
}

function renderProjection() {
  const all = results.speed || [];
  if (!all.length) return;
  const single = all.find((r) => r.batch === 1) || all[0];
  const best = all.reduce((a, r) => (r.msPerDecision < a.msPerDecision ? r : a));
  const pop = Math.max(1, Number($("population").value) || 5000);
  const line = (r, label) => {
    const perHour = 3.6e6 / r.msPerDecision;
    const minsBetween = (pop / perHour) * 60;
    return `<div>${label}: <b>${fmt(r.msPerDecision)} ms</b> per decision → <b>${fmt(perHour)}</b> AI decisions/hour → each of <b>${fmt(pop)}</b> people gets one every <b>${minsBetween < 1 ? (minsBetween * 60).toFixed(0) + " s" : minsBetween.toFixed(1) + " min"}</b> of real time.</div>`;
  };
  $("projection").hidden = false;
  $("projection").innerHTML = line(single, "One at a time") + (best !== single ? line(best, `Batched ×${best.batch}`) : "");
}

// ---------- personality test ----------

async function personalityTest() {
  if (!laya) return;
  $("speedBtn").disabled = true; $("personaBtn").disabled = true;
  const out = [];
  const reverse = $("reverse").checked;
  try {
    for (const s of SCENARIOS) {
      const row = { scenario: s.id, title: s.title, optionOrder: reverse ? "reversed" : "normal", people: [] };
      for (const p of PERSONAS) {
        setStatus("personaStatus", `${s.title}: asking about ${p.name}…`); await tick();
        const t0 = performance.now();
        const qs = s.questions(p.name);
        if (reverse) qs.action.criteria = Object.fromEntries(Object.entries(qs.action.criteria).reverse());
        const r = await laya.systemOne(stateFor(p, s), qs);
        row.people.push({ name: p.name, ms: performance.now() - t0, answers: r.answers });
      }
      row.spread = spread(row.people.map((x) => x.answers.action.probabilities));
      row.distinctTopChoices = new Set(row.people.map((x) => x.answers.action.choice)).size;
      out.push(row);
      renderPersonality(out);
    }
    results.personality = out;
    setStatus("personaStatus", "Done. Each cell is one call with 3 questions.");
  } catch (e) {
    console.error(e); setStatus("personaStatus", "Personality test failed: " + (e?.message || e), true);
  } finally {
    $("speedBtn").disabled = false; $("personaBtn").disabled = false;
  }
}

// Average pairwise total-variation distance between people's action distributions.
// 0 = everyone gets identical probabilities, 1 = completely different.
function spread(dists) {
  let sum = 0, n = 0;
  for (let i = 0; i < dists.length; i++) for (let j = i + 1; j < dists.length; j++) {
    const keys = Object.keys(dists[i]);
    sum += keys.reduce((a, k) => a + Math.abs(dists[i][k] - dists[j][k]), 0) / 2; n++;
  }
  return n ? sum / n : 0;
}

function miniBars(probs, labels = {}) {
  const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const top = entries[0][0];
  return entries.map(([k, p]) => `<div class="mini${k === top ? " top" : ""}"><span>${esc(labels[k] ?? k)}</span><span class="track"><span class="fill" style="display:block;width:${(p * 100).toFixed(1)}%"></span></span><span class="v">${pct(p)}</span></div>`).join("");
}

function renderPersonality(rows) {
  const head = `<tr><th>Situation</th>${PERSONAS.map((p) => `<th>${esc(p.name)}<br><span class="tag">${esc(p.traits)}</span></th>`).join("")}</tr>`;
  const body = rows.map((row) => {
    const sc = SCENARIOS.find((s) => s.id === row.scenario);
    const qs = sc.questions("them");
    const cells = row.people.map((x) => {
      const a = x.answers;
      return `<td class="cell">
        <div class="top">${esc(a.action.choice)} <span class="p">${pct(a.action.probabilities[a.action.choice])}</span></div>
        ${miniBars(a.action.probabilities)}
        <div class="p" style="margin-top:6px">${esc(sc.feelingLabel)}: <b>${esc(qs.feeling.criteria[Math.round(a.feeling.score)])}</b> (${a.feeling.score.toFixed(2)})</div>
        <div class="p">“${esc(sc.questions(x.name).belief.instructions)}”: <b>${pct(a.belief.noul)}</b></div>
        <div class="p">${fmt(x.ms)} ms</div>
      </td>`;
    }).join("");
    const spreadNote = row.spread < 0.1 ? "almost identical" : row.spread < 0.25 ? "some difference" : "clearly different";
    return `<tr><td><b>${esc(row.title)}</b><div class="spread">spread <b>${row.spread.toFixed(2)}</b> · ${spreadNote}<br>${row.distinctTopChoices} different top choices</div></td>${cells}</tr>`;
  }).join("");
  $("personaOut").innerHTML = `<div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>
    <p class="note">Spread is the average difference between people's action probabilities (0 = identical, 1 = nothing in common). Below ~0.1 means personality barely changes the decision.</p>`;
}

// ---------- wiring ----------

$("threads").value = Math.min(4, navigator.hardwareConcurrency || 2);
$("loadBtn").onclick = loadModel;
$("speedBtn").onclick = speedTest;
$("personaBtn").onclick = personalityTest;
$("population").oninput = renderProjection;
$("copyBtn").onclick = async () => {
  const json = JSON.stringify(results, null, 2);
  try { await navigator.clipboard.writeText(json); $("copyBtn").textContent = "Copied"; }
  catch { console.log(json); $("copyBtn").textContent = "Copy failed, printed to console"; }
  setTimeout(() => ($("copyBtn").textContent = "Copy results as JSON"), 2000);
};
renderEnv();
if (!self.crossOriginIsolated) setStatus("loadStatus", "Warning: page is not cross-origin isolated, so WASM will use 1 thread. Reload once; if it stays, run `npm run dev`.", true);
