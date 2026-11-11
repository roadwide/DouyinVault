import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ["better-sqlite3", "pino-pretty"],
  noExternal: [/^@vault\//],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
