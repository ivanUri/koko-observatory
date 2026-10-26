import { build } from "vite";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const output = resolve(root, "public/generated");
await mkdir(output, { recursive: true });
await rm(resolve(output, "koko-observatory-probe.js"), { force: true });
await build({
  configFile: false,
  root,
  build: {
    lib: {
      entry: resolve(root, "src/probe-entry.ts"),
      name: "KokoObservatoryProbe",
      formats: ["iife"],
      fileName: () => "koko-observatory-probe.js",
    },
    outDir: output,
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
  },
});
