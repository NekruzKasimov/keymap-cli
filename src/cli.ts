#!/usr/bin/env node
import { Command } from "commander";
import { basename } from "node:path";
import { supportedSinks } from "./adapters/index.js";
import { formatAudit, runAudit } from "./commands/audit.js";
import { runInit } from "./commands/init.js";
import { formatRotate, runRotate } from "./commands/rotate.js";
import { realExec } from "./exec.js";
import { loadManifest } from "./manifest.js";
import { loadState, saveState, statePath } from "./state.js";
import { parseSinkArg } from "./sinkarg.js";
import type { AdapterContext } from "./types.js";

const ctx: AdapterContext = { exec: realExec, cwd: process.cwd() };

const program = new Command()
  .name("keymap")
  .description("Values-free map of every secret you run, where it lives, and one command to rotate it everywhere.")
  .version("0.0.1");

program
  .command("init")
  .description("Discover secret names across sinks and write keymap.yaml (values are hashed in memory, never stored)")
  .option("-p, --project <name>", "project name", basename(process.cwd()))
  .option("-s, --sink <sink...>", `sinks to scan, e.g. local:.env github:owner/repo railway:api/production fly:myapp vercel:myproj/production+preview (supported: ${supportedSinks.join(", ")})`, ["local:.env"])
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

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  return s.length ? s.replace(/\r?\n$/, "") : undefined;
}

program
  .command("rotate <secret>")
  .description("Push a new value to every sink in order; stops on the first failure and tells you which sinks still hold the old value")
  .option("--value <value>", "new value (prefer stdin: `pbpaste | keymap rotate KEY`, so it stays out of shell history)")
  .option("--generate", "mint a random 32-byte value (custom secrets only)")
  .option("--dry-run", "show the push order and do nothing")
  .option("--json", "machine-readable output")
  .action(async (secret: string, o: { value?: string; generate?: boolean; dryRun?: boolean; json?: boolean }) => {
    const manifest = await loadManifest();
    const path = statePath(manifest.project);
    const state = await loadState(path);
    const value = o.value ?? (o.generate || o.dryRun ? undefined : await readStdin());
    const r = await runRotate(manifest, state, { secret, value, generate: o.generate, dryRun: o.dryRun }, ctx);
    if (!r.dryRun && r.ok) await saveState(path, state);
    console.log(o.json ? JSON.stringify(r, null, 2) : formatRotate(r));
    process.exitCode = r.ok ? 0 : 1;
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
