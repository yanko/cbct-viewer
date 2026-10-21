/// <reference types="vitest/config" />
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

// dental-cbct-viewer decodes DICOM in workers that use SharedArrayBuffer,
// which requires a cross-origin isolated page.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// dental-cbct-viewer spawns its DICOM decode worker from the absolute URL
// `/assets/decodeImageFrameWorker-*.js` (marked @vite-ignore), so Vite neither
// serves nor bundles it. Serve the package's worker assets in dev and copy them
// into the build output so they resolve under `/assets/` in both cases.
// (In dev, Vite's worker transform rewrites the URL to `/public/assets/...`.)
function dentalCbctWorkerAssets(): Plugin {
  const assetsDir = fileURLToPath(
    new URL("node_modules/dental-cbct-viewer/dist/assets", import.meta.url),
  );
  const workerFiles = new Set(fs.readdirSync(assetsDir).filter((file) => file.endsWith(".js")));
  const read = (file: string) => fs.readFileSync(path.join(assetsDir, file));

  return {
    name: "dental-cbct-worker-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = req.url?.match(/^(?:\/public)?\/assets\/([^/?#]+\.js)(?:[?#].*)?$/)?.[1];
        if (!file || !workerFiles.has(file)) return next();
        res.setHeader("Content-Type", "text/javascript");
        // Workers of a cross-origin isolated page must carry COEP themselves.
        for (const [name, value] of Object.entries(crossOriginIsolation)) {
          res.setHeader(name, value);
        }
        res.end(read(file));
      });
    },
    generateBundle() {
      for (const file of workerFiles) {
        this.emitFile({ type: "asset", fileName: `assets/${file}`, source: read(file) });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), dentalCbctWorkerAssets()],

  // Tauri-specific options (https://v2.tauri.app/start/frontend/vite/):
  // keep Rust errors visible, use the fixed port Tauri expects, and don't
  // watch the Rust sources.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    headers: crossOriginIsolation,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  preview: {
    headers: crossOriginIsolation,
  },
  // Env variables starting with TAURI_ENV_* are exposed to the frontend.
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WebView2 (Windows) is Chromium; WebKitGTK / WKWebView are Safari-class.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // The viewer bundles Cornerstone3D, vtk.js and WASM codecs; large chunks are expected.
    chunkSizeWarningLimit: 4096,
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
