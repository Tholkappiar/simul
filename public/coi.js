// Registers coi-sw.js and reloads once, if the server didn't already make the page cross-origin isolated.
// Without it everything still works, just on one WASM thread.
(() => {
  if (self.crossOriginIsolated || !("serviceWorker" in navigator) || !window.isSecureContext) return;
  if (sessionStorage.getItem("coi-reloaded") === "1") return;
  navigator.serviceWorker.register(new URL("./coi-sw.js", document.currentScript.src)).then((reg) => {
    const reload = () => { sessionStorage.setItem("coi-reloaded", "1"); location.reload(); };
    if (reg.active && !navigator.serviceWorker.controller) return reload();
    const sw = reg.installing || reg.waiting;
    if (sw) sw.addEventListener("statechange", () => { if (sw.state === "activated") reload(); });
  }).catch((e) => console.warn("cross-origin isolation service worker not available:", e));
})();
