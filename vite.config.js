import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  esbuild: { legalComments: "eof" },
  resolve: {
    // The package root re-exports its authoring stack; the browser bundle keeps Worker builds bounded.
    alias: { mediabunny: fileURLToPath(new URL("./node_modules/mediabunny/dist/bundles/mediabunny.min.mjs", import.meta.url)) },
  },
  build: {
    target: "es2022",
  },
});
