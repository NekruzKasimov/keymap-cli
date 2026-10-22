#!/usr/bin/env node
import { Command } from "commander";
import { basename } from "node:path";
import { supportedSinks } from "./adapters/index.js";
import { formatAudit, runAudit } from "./commands/audit.js";
import { runInit } from "./commands/init.js";
import { realExec } from "./exec.js";
import { loadManifest } from "./manifest.js";
import { loadState, saveState, statePath } from "./state.js";
import type { AdapterContext, SinkKind, SinkRef } from "./types.js";

const ctx: AdapterContext = { exec: realExec, cwd: process.cwd() };

/** "railway:api/production" | "github:owner/repo" | "local:.env" -> SinkRef */
export function parseSinkArg(arg: string): SinkRef {
  const [kind, rest = ""] = arg.split(":", 2) as [SinkKind, string?];
  if (!supportedSinks.includes(kind)) throw new Error(`unsupported sink "${kind}"; supported: ${supportedSinks.join(", ")}`);
  switch (kind) {
    case "local": return { kind, file: rest || ".env" };
    case "github": { const [repo, env] = rest.split("/").length > 2 ? [rest.split("/").slice(0, 2).join("/"), rest.split("/")[2]] : [rest, undefined]; return { kind, ...(repo ? { repo } : {}), ...(env ? { env } : {}) }; }
    case "railway": { const [service, environment] = rest.split("/"); return { kind, ...(service ? { service } : {}), ...(environment ? { environment } : {}) }; }
    default: return { kind };
  }
}

const program = new Command()
  .name("keymap")
  .description("Values-free map of every secret you run, where it lives, and one command to rotate it everywhere.")
  .version("0.0.1");

program
  .command("init")
  .description("Discover secret names across sinks and write keymap.yaml (values are hashed in memory, never stored)")
  .option("-p, --project <name>", "project name", basename(process.cwd()))
  .option("-s, --sink <sink...>", `sinks to scan, e.g. local:.env github:owner/repo railway:api/production (supported: ${supportedSinks.join(", ")})`, ["local:.env"])
  .option("--all", "include config-looking names like PORT and NEXT_PUBLIC_*")
  .option("--force", "overwrite an existing keymap.yaml")
  .action(async (o: { project: string; sink: string[]; all?: boolean; force?: boolean }) => {
    const sinks = o.sink.map(parseSinkArg);
    const r = await runInit({ project: o.project, sinks, all: o.all, force: o.force }, ctx);
    for (const s of r.perSink) console.log(s.error ? `  ${s.id}: ERROR ${s.error}` : `  ${s.id}: ${s.count} secrets`);
    console.log(`wrote keymap.yaml with ${Object.keys(r.manifest.secrets).length} secrets. Edit issuers and rotate_every, then run \`keymap audit\`.`);
  });

program
  .command("audit")
  .description("Check every mapped secret: present at each sink, consistent across sinks, within its rotation window")
  .option("--json", "machine-readable output")
  .action(async (o: { json?: boolean }) => {
    const manifest = await loadManifest();
    const state = await loadState(statePath(manifest.project));
    const r = await runAudit(manifest, state, ctx);
    console.log(o.json ? JSON.stringify(r, null, 2) : formatAudit(r));
    process.exitCode = r.failed ? 1 : 0;
  });

program
  .command("mark <secret>")
  .description("Record that a secret was rotated outside keymap (sets last_rotated to now)")
  .option("--at <iso>", "timestamp instead of now")
  .action(async (secret: string, o: { at?: string }) => {
    const manifest = await loadManifest();
    if (!manifest.secrets[secret]) throw new Error(`${secret} is not in keymap.yaml`);
    const path = statePath(manifest.project);
    const state = await loadState(path);
    const when = o.at ? new Date(o.at).toISOString() : new Date().toISOString();
    state.secrets[secret] = { ...(state.secrets[secret] ?? { sinks: {} }), last_rotated: when };
    await saveState(path, state);
    console.log(`${secret}: last_rotated = ${when}`);
  });

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(`keymap: ${e.message}`);
  process.exit(2);
});
