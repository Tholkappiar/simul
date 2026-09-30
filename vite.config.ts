import { defineConfig, type Connect } from "vite";
import { fileURLToPath } from "node:url";

// The built site is served from https://<user>.github.io/simul/, so its files live under /simul/.
// Locally (npm run dev) it stays at /.
const PAGES_BASE = "/simul/";
// Cloudflare Web Analytics (visitor counts). Only added to the built site: Cloudflare rejects reports from localhost.
const CLOUDFLARE_TOKEN = "8bb9fd59ab404365bbd6c190de276af3";

// Cross-origin isolation lets ONNX Runtime use multithreaded WASM. GitHub Pages can't send these
// headers, so public/coi-sw.js adds them there instead.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig(({ command }) => {
  const base = command === "build" ? PAGES_BASE : "/";
  // <base>perf -> <base>perf/ (the benchmark page lives in perf/index.html).
  const perfRedirect: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url === `${base}perf`) { res.statusCode = 301; res.setHeader("Location", `${base}perf/`); res.end(); return; }
    next();
  };
  return {
    base,
    appType: "mpa",
    plugins: [
      {
        name: "perf-redirect",
        configureServer: (server) => { server.middlewares.use(perfRedirect); },
        configurePreviewServer: (server) => { server.middlewares.use(perfRedirect); },
      },
      {
        name: "cloudflare-analytics",
        apply: "build",
        transformIndexHtml: () => [{
          tag: "script",
          attrs: { type: "module", src: "https://static.cloudflareinsights.com/beacon.min.js", "data-cf-beacon": JSON.stringify({ token: CLOUDFLARE_TOKEN }) },
          injectTo: "head",
        }],
      },
    ],
    server: { headers: isolation },
    preview: { headers: isolation },
    worker: { format: "es" },
    build: {
      target: "es2022",
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          perf: fileURLToPath(new URL("./perf/index.html", import.meta.url)),
        },
      },
    },
  };
});
