import esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: true,
  target: "chrome120",
  logLevel: "info",
};

// Each entry point is bundled independently so Chrome can load them in
// their respective execution contexts (service worker, offscreen, content, popup, options).
const entryPoints = [
  { in: "src/debug.js", out: "extension/debug" },
  { in: "src/background.js", out: "extension/background" },
  { in: "src/offscreen.js", out: "extension/offscreen" },
  { in: "src/content.js", out: "extension/content" },
  { in: "src/popup.js", out: "extension/popup" },
  { in: "src/options.js", out: "extension/options" },
];

async function build() {
  for (const { in: entry, out } of entryPoints) {
    const opts = {
      ...shared,
      entryPoints: [entry],
      outfile: `${out}.js`,
      format: "iife",
    };

    // @xenova/transformers is loaded at runtime from the bundled node_modules
    // in the offscreen document; for content/popup/options it's not needed.
    // For the offscreen entry, we bundle it inline.
    if (entry.includes("offscreen")) {
      opts.define = {
        "process.env.NODE_ENV": '"production"',
      };
    }

    if (watch) {
      const ctx = await esbuild.context(opts);
      await ctx.watch();
      console.log(`Watching ${entry}...`);
    } else {
      await esbuild.build(opts);
    }
  }

  if (!watch) {
    // Copy ONNX Runtime WASM files needed by the offscreen document
    const wasmDir = "extension/wasm";
    if (!existsSync(wasmDir)) mkdirSync(wasmDir, { recursive: true });
    const wasmFiles = [
      "ort-wasm-simd-threaded.jsep.wasm",
      "ort-wasm-simd-threaded.wasm",
      "ort-wasm-simd-threaded.jsep.mjs",
      "ort-wasm-simd-threaded.mjs",
    ];
    const ortDist = join("node_modules", "onnxruntime-web", "dist");
    for (const f of wasmFiles) {
      const src = join(ortDist, f);
      const dst = join(wasmDir, f);
      if (existsSync(src)) {
        copyFileSync(src, dst);
      } else {
        console.warn(`Warning: WASM file not found: ${src}`);
      }
    }
    console.log("Build complete.");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
