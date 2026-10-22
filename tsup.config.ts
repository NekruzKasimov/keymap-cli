import { defineConfig } from "tsup";
// Bundle both runtime dependencies so the published package has no floating transitive dependencies.
// commander is CommonJS, so the ESM bundle needs a `require` for its node built-ins.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  noExternal: ["commander", "yaml"],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
