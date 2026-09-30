// Adds the COOP/COEP headers that make the page cross-origin isolated, so ONNX Runtime can use
// multithreaded WASM on servers that don't send them (Live Server, GitHub Pages). Same idea as layaForWeb's coi-sw.js.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  // Only our own files need the headers. Requests to other sites (the model, analytics) go straight to the network.
  if (new URL(r.url).origin !== self.location.origin) return;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  e.respondWith(fetch(r).then((res) => {
    if (res.status === 0 || res.type === "opaque") return res;
    const h = new Headers(res.headers);
    h.set("Cross-Origin-Embedder-Policy", "require-corp");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    // Some statuses (204 No Content, 304 Not Modified…) must not carry a body.
    const body = [101, 204, 205, 304].includes(res.status) ? null : res.body;
    return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
