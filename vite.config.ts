import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import jsObfuscator from "vite-plugin-javascript-obfuscator";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const secure = process.env.NC_SECURE === "1";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    // Full obfuscation ONLY for hardened prod builds (NC_SECURE=1):
    // slower build + harder prod debugging, so dev stays clean.
    // Heavy vendor chunks (monaco/xterm/shiki) are excluded — our code only.
    ...(secure
      ? [
          jsObfuscator({
            // NOTE: this plugin transforms SOURCE modules, not output chunks —
            // scope to our code so vendor bundles (monaco/xterm/shiki) stay fast.
            include: [/src\/.*\.(ts|tsx|js)$/],
            exclude: [/node_modules/],
            options: {
              compact: true,
              controlFlowFlattening: false,
              deadCodeInjection: false,
              stringArray: true,
              stringArrayRotate: true,
              stringArrayShuffle: true,
              stringArrayThreshold: 0.75,
              splitStrings: true,
              splitStringsChunkLength: 6,
              renameGlobals: false,
              selfDefending: false,
              disableConsoleOutput: false,
              // CRITICAL: never transform module specifiers. The plugin runs
              // on source (pre-Rollup), so mangling import() arguments turns
              // them into runtime fetches that 404 in production
              // (tauri.localhost/... with no hash). Static import/export
              // declarations are left alone by the obfuscator itself.
              reservedStrings: ["^\\.", "^@"],
            },
          }),
        ]
      : []),
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    // Never emit sourcemaps (source recovery protection), even in dev builds.
    sourcemap: false,
    // Desktop app served from localhost: chunk bytes don't matter.
    // The only >500KB chunks are Monaco workers (*.worker.js, loaded lazily
    // on demand and unsplittable) and the Monaco core itself (monolithic
    // upstream). The limit below just keeps the log noise-free.
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      output: {
        // Split the heaviest vendors so no single chunk trips the size warning
        // (desktop app — served locally, extra requests are free).
        manualChunks: {
          monaco: ["monaco-editor", "@monaco-editor/react"],
          xterm: ["@xterm/xterm", "@xterm/addon-fit"],
          shiki: ["shiki"],
          vendor: [
            "react",
            "react-dom",
            "zustand",
            "i18next",
            "react-i18next",
            "framer-motion",
            "lucide-react",
          ],
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
          overlay: false,
        }
      : { overlay: false },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
