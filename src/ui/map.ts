// Draws everyone as a dot on a canvas. Canvas (not DOM elements) is what keeps thousands of nodes fast.
import { DISASTERS } from "../sim/data";
import type { Person } from "../sim/types";
import { DAY, type World } from "../sim/world";

const NODE_R = 1.6; // node radius in world units
const CELL = 12; // hit-test grid cell size in world units
const CRATER_DAYS = 3; // how long disaster marks stay on the map (sim time)
const BLAST_MS = 1400; // blast animation (real time)

interface Palette { bg: string; ink: string; ink2: string; line: string; accent: string; grief: string; danger: string; dark: boolean }

export class MapView {
  /** A click that wasn't a drag: world coordinates and the person under the cursor, if any. */
  onClick: (x: number, y: number, pid: number | null) => void = () => {};
  /** When set, the cursor shows a target of this radius (world units) for dropping a disaster. */
  toolRadius: number | null = null;
  /** Keys ("p12", "c3") in the batch Laya is running right now. */
  deciding = new Set<string>();
  drawMs = 0;

  private ctx: CanvasRenderingContext2D;
  private world: World | null = null;
  private cam = { x: 0, y: 0, scale: 1 };
  private grid = new Map<number, number[]>();
  private gridVersion = -1;
  private hovered: number | null = null;
  private mouse: { x: number; y: number } | null = null;
  private pal!: Palette;
  private w = 0;
  private h = 0;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.refreshTheme();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.bindInput();
  }

  setWorld(world: World) {
    this.world = world;
    this.gridVersion = -1;
    this.hovered = null;
    this.fit();
  }

  /** Re-read the CSS colour tokens (call after a theme change). */
  refreshTheme() {
    const s = getComputedStyle(document.documentElement);
    const v = (k: string) => s.getPropertyValue(k).trim();
    this.pal = { bg: v("--bg"), ink: v("--ink"), ink2: v("--ink2"), line: v("--line"), accent: v("--accent"), grief: v("--grief"), danger: v("--danger"), dark: v("--scheme") === "dark" };
  }

  countryColor(hue: number, alpha = 1) {
    return this.pal.dark ? `hsla(${hue}, 60%, 62%, ${alpha})` : `hsla(${hue}, 58%, 45%, ${alpha})`;
  }

  fit() {
    if (!this.world) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of this.world.countries) {
      minX = Math.min(minX, c.x - c.r); maxX = Math.max(maxX, c.x + c.r);
      minY = Math.min(minY, c.y - c.r - 14); maxY = Math.max(maxY, c.y + c.r);
    }
    const top = 90; // room for the Laya panel above the map
    this.cam.scale = Math.min(this.w / (maxX - minX), (this.h - top) / (maxY - minY)) * 0.9;
    this.cam.x = (minX + maxX) / 2;
    this.cam.y = (minY + maxY) / 2 - top / 2 / this.cam.scale;
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const firstSize = this.w === 0;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    if (firstSize) this.fit();
  }

  private toScreen(x: number, y: number): [number, number] {
    return [(x - this.cam.x) * this.cam.scale + this.w / 2, (y - this.cam.y) * this.cam.scale + this.h / 2];
  }
  private toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.w / 2) / this.cam.scale + this.cam.x, (sy - this.h / 2) / this.cam.scale + this.cam.y];
  }

  // ---------- hit testing ----------

  private rebuildGrid() {
    const w = this.world!;
    this.grid.clear();
    for (const p of w.people) {
      const key = this.cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
      (this.grid.get(key) ?? this.grid.set(key, []).get(key)!).push(p.id);
    }
    this.gridVersion = w.layoutVersion;
  }
  private cellKey(cx: number, cy: number) { return (cx + 50000) * 100000 + (cy + 50000); }

  private personAt(sx: number, sy: number): number | null {
    const w = this.world;
    if (!w) return null;
    if (this.gridVersion !== w.layoutVersion) this.rebuildGrid();
    const [x, y] = this.toWorld(sx, sy);
    const maxD = Math.max(NODE_R * 1.8, 7 / this.cam.scale);
    let best: number | null = null, bestD = maxD * maxD;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), reach = Math.ceil(maxD / CELL);
    for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
      for (const id of this.grid.get(this.cellKey(cx + i, cy + j)) ?? []) {
        const p = w.people[id], d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bestD) { bestD = d; best = id; }
      }
    }
    return best;
  }

  private bindInput() {
    const c = this.canvas;
    let down: { x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;
    const local = (e: PointerEvent | WheelEvent) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY, camX: this.cam.x, camY: this.cam.y, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      this.mouse = local(e);
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) down.moved = true;
        if (down.moved) {
          this.cam.x = down.camX - dx / this.cam.scale;
          this.cam.y = down.camY - dy / this.cam.scale;
          c.style.cursor = "grabbing";
        }
      } else {
        this.hovered = this.toolRadius === null ? this.personAt(this.mouse.x, this.mouse.y) : null;
        c.style.cursor = this.toolRadius !== null ? "crosshair" : this.hovered !== null ? "pointer" : "default";
      }
    });
    c.addEventListener("pointerup", (e) => {
      if (down && !down.moved) {
        const m = local(e);
        const [x, y] = this.toWorld(m.x, m.y);
        this.onClick(x, y, this.toolRadius === null ? this.personAt(m.x, m.y) : null);
      }
      down = null;
      c.style.cursor = this.toolRadius !== null ? "crosshair" : "default";
    });
    c.addEventListener("pointerleave", () => { this.hovered = null; this.mouse = null; });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const m = local(e);
      const [wx, wy] = this.toWorld(m.x, m.y);
      this.cam.scale = Math.min(40, Math.max(0.05, this.cam.scale * Math.exp(-e.deltaY * 0.0015)));
      // keep the point under the cursor still
      const [nx, ny] = this.toWorld(m.x, m.y);
      this.cam.x += wx - nx;
      this.cam.y += wy - ny;
    }, { passive: false });
  }

  // ---------- drawing ----------

  draw(now: number) {
    const t0 = performance.now();
    const ctx = this.ctx, w = this.world, pal = this.pal;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    if (!w) return;
    const s = this.cam.scale;
    const r = Math.max(1.1, NODE_R * s);
    const pop = w.population();
    const sel = w.selection;

    // Countries: a faint disk and a label; the selected one gets an outline.
    ctx.textAlign = "center";
    for (const c of w.countries) {
      const [x, y] = this.toScreen(c.x, c.y);
      ctx.beginPath();
      ctx.arc(x, y, c.r * s + r * 2, 0, Math.PI * 2);
      ctx.fillStyle = this.countryColor(c.hue, pal.dark ? 0.06 : 0.07);
      ctx.fill();
      if (sel?.type === "country" && sel.id === c.id) {
        ctx.strokeStyle = this.countryColor(c.hue, 0.9);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const tags = [
        c.atWar.some(Boolean) ? "at war" : "",
        c.curfewUntil > w.t ? "curfew" : "",
        c.aidUntil > w.t ? "aid" : "",
        this.deciding.has(`c${c.id}`) ? "government deciding…" : c.waiting ? "government in line" : "",
      ].filter(Boolean);
      ctx.fillStyle = this.deciding.has(`c${c.id}`) ? pal.accent : pal.ink2;
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillText([`${c.name} · ${pop.byCountry[c.id].toLocaleString()}`, ...tags].join(" · "), x, y - c.r * s - r * 2 - 8);
    }

    // Wars as red lines between countries; ordered strikes as arrows until they land.
    ctx.lineWidth = 2;
    for (const a of w.countries) for (const b of w.countries) {
      if (a.id >= b.id || !a.atWar[b.id]) continue;
      const [ax, ay] = this.toScreen(a.x, a.y), [bx, by] = this.toScreen(b.x, b.y);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = pal.danger;
      ctx.globalAlpha = 0.35;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    for (const st of w.strikes) this.arrow(w.countries[st.by], w.countries[st.target], pal.danger);

    // Disasters: a fading crater for a few sim days, plus an expanding blast when it lands.
    for (const d of w.disasters) {
      const age = (w.t - d.t) / (CRATER_DAYS * DAY);
      const blast = (now - d.realAt) / BLAST_MS;
      if (age > 1 && blast > 1) continue;
      const [x, y] = this.toScreen(d.x, d.y);
      const hue = DISASTERS[d.kind].color;
      if (age <= 1) {
        ctx.beginPath();
        ctx.arc(x, y, d.r * s, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 75%, 50%, ${0.18 * (1 - age)})`;
        ctx.fill();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = `hsla(${hue}, 75%, 50%, ${0.6 * (1 - age)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (blast >= 0 && blast < 1) {
        ctx.beginPath();
        ctx.arc(x, y, d.r * s * 1.4 * (0.2 + blast * 0.8), 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${hue}, 85%, 55%, ${1 - blast})`;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    const selPerson = w.selectedPerson();
    const inView = (p: Person) => {
      const [x, y] = this.toScreen(p.x, p.y);
      return x > -10 && y > -10 && x < this.w + 10 && y < this.h + 10;
    };

    // Lines from the selected person to their family and friends.
    if (selPerson) {
      const [sx, sy] = this.toScreen(selPerson.x, selPerson.y);
      for (const rel of selPerson.rels) {
        const o = w.people[rel.id];
        const [ox, oy] = this.toScreen(o.x, o.y);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ox, oy);
        ctx.setLineDash(rel.kind === "friend" ? [3, 3] : []);
        ctx.strokeStyle = pal.ink2;
        ctx.globalAlpha = rel.kind === "friend" ? 0.45 : 0.8;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Living people, one path per colour: sad people turn grey, everyone else wears their country's colour.
    const buckets = new Map<string, Person[]>();
    const dead: Person[] = [], hurt: Person[] = [], queued: Person[] = [], deciding: Person[] = [];
    for (const p of w.people) {
      if (!inView(p)) continue;
      if (!p.alive) { dead.push(p); continue; }
      const key = p.feelings.sadness > 0.5 ? pal.grief : this.countryColor(w.countries[p.country].hue);
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(p);
      if (p.needs.health < 0.6) hurt.push(p);
      if (p.waiting) (this.deciding.has(`p${p.id}`) ? deciding : queued).push(p);
    }
    for (const [color, list] of buckets) {
      ctx.beginPath();
      for (const p of list) this.dot(p, r);
      ctx.fillStyle = color;
      ctx.fill();
    }
    const ring = (list: Person[], radius: number, color: string, width: number) => {
      if (!list.length) return;
      ctx.beginPath();
      for (const p of list) this.dot(p, radius);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    ring(dead, r, pal.ink2, 1);
    ring(hurt, r + 1.5, pal.danger, 1.5);
    // Faint ring: waiting in line for Laya. Bold pulsing ring: in the batch Laya is running now.
    ctx.globalAlpha = 0.35;
    ring(queued, r + 2.5, pal.accent, 1);
    ctx.globalAlpha = 1;
    ring(deciding, r * (1.9 + Math.sin(now / 150) * 0.5) + 2, pal.accent, 2);

    if (selPerson) {
      const [x, y] = this.toScreen(selPerson.x, selPerson.y);
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
      this.label(`${selPerson.name}${selPerson.alive ? "" : " †"}`, x, y - r - 8);
    }
    if (this.hovered !== null && this.hovered !== selPerson?.id) {
      const p = w.people[this.hovered];
      const [x, y] = this.toScreen(p.x, p.y);
      this.label(`${p.name}${p.alive ? "" : " †"}`, x, y - r - 8);
    }

    // Disaster tool: show the blast radius under the cursor.
    if (this.toolRadius !== null && this.mouse) {
      ctx.beginPath();
      ctx.arc(this.mouse.x, this.mouse.y, this.toolRadius * s, 0, Math.PI * 2);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = pal.danger;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.drawMs = performance.now() - t0;
  }

  private arrow(from: { x: number; y: number; r: number }, to: { x: number; y: number; r: number }, color: string) {
    const ctx = this.ctx, s = this.cam.scale;
    const [fx, fy] = this.toScreen(from.x, from.y), [tx, ty] = this.toScreen(to.x, to.y);
    const a = Math.atan2(ty - fy, tx - fx);
    // start and end at the edges of the two country disks
    const x1 = fx + Math.cos(a) * from.r * s, y1 = fy + Math.sin(a) * from.r * s;
    const x2 = tx - Math.cos(a) * to.r * s * 0.6, y2 = ty - Math.sin(a) * to.r * s * 0.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(a - 0.4) * 12, y2 - Math.sin(a - 0.4) * 12);
    ctx.lineTo(x2 - Math.cos(a + 0.4) * 12, y2 - Math.sin(a + 0.4) * 12);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  private dot(p: Person, radius: number) {
    const [x, y] = this.toScreen(p.x, p.y);
    this.ctx.moveTo(x + radius, y);
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
  }

  private label(text: string, x: number, y: number) {
    const ctx = this.ctx;
    ctx.font = "600 12px system-ui, sans-serif";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = this.pal.ink;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.roundRect(x - tw / 2 - 6, y - 15, tw + 12, 20, 5);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.pal.bg;
    ctx.textAlign = "center";
    ctx.fillText(text, x, y);
  }
}
