// Copies the browser build of ONNX Runtime Web into public/vendor/. ORT loads its .wasm and glue
// files at runtime from `ort.env.wasm.wasmPaths`, so they must be served as plain static files.
// Runs automatically after `npm install`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  ["node_modules/onnxruntime-web/dist/ort.min.mjs", "public/vendor/ort/ort.min.mjs"],
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs", "public/vendor/ort/ort-wasm-simd-threaded.jsep.mjs"],
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm", "public/vendor/ort/ort-wasm-simd-threaded.jsep.wasm"],
];
for (const [from, to] of FILES) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(root, to));
}
console.log(`copied ${FILES.length} files into public/vendor/`);
