// Adds the COOP/COEP headers that make the page cross-origin isolated, so ONNX Runtime can use
// multithreaded WASM on servers that don't send them (Live Server, GitHub Pages). Same idea as layaForWeb's coi-sw.js.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  e.respondWith(fetch(r).then((res) => {
    if (res.status === 0 || res.type === "opaque") return res;
    const h = new Headers(res.headers);
    h.set("Cross-Origin-Embedder-Policy", "require-corp");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
