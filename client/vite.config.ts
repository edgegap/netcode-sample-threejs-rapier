import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const shared = (file: string) => fileURLToPath(new URL(`../shared/src/${file}`, import.meta.url));

export default defineConfig({
  // Relative asset paths, so the build works from any folder of any static host (GitHub Pages, S3, a CDN).
  base: "./",
  resolve: {
    // Use the shared TypeScript sources directly, so edits to shared/ hot-reload in the browser.
    alias: [
      { find: /^@sample\/shared\/physics$/, replacement: shared("physics.ts") },
      { find: /^@sample\/shared$/, replacement: shared("index.ts") },
    ],
  },
  server: { port: 5173 },
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 5000 },
});
