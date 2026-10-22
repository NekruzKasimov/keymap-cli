#!/usr/bin/env node
import { Command, Option } from "commander";
import { basename } from "node:path";
import { supportedSinks } from "./adapters/index.js";
import { formatAudit, runAudit } from "./commands/audit.js";
import { runInit } from "./commands/init.js";
import { formatPlan, formatWalk, planIncident, walkIncident, type IncidentItem } from "./commands/incident.js";
import { formatRotate, runRevoke, runRotate } from "./commands/rotate.js";
import { buildReminder, postReminder } from "./commands/remind.js";
import { formatDoctor, runDoctor } from "./commands/doctor.js";
import { readFile } from "node:fs/promises";
import { Prompter, readStdin } from "./prompt.js";
import { getSecret } from "./manifest.js";
import type { SinkKind, State } from "./types.js";
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
    if (r.skipped.length) console.log(`  skipped (not UPPER_SNAKE_CASE): ${r.skipped.join(", ")}`);
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
  .command("rotate <secret>")
  .description("Push a new value to every sink in order; stops on the first failure and tells you which sinks still hold the old value")
  .option("--value-file <path>", "read the new value from a file (or pipe it: `pbpaste | keymap rotate KEY`; on a TTY you are prompted without echo)")
  .option("--generate", "mint a random 32-byte value (custom secrets only)")
  .option("--mint", "create the key at the issuer by API and push it; the old key stays live until `keymap revoke` (openrouter; needs KEYMAP_OPENROUTER_MGMT_KEY)")
  .option("--limit <usd>", "credit limit for a minted key, in USD", (v: string) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit must be a positive number, got "${v}"`); return n; })
  .addOption(new Option("--limit-reset <period>", "reset period for the minted key's limit").choices(["daily", "weekly", "monthly"]))
  .option("--dry-run", "show the push order and do nothing")
  .option("--json", "machine-readable output")
  .action(async (secret: string, o: { valueFile?: string; generate?: boolean; mint?: boolean; limit?: number; limitReset?: "daily" | "weekly" | "monthly"; dryRun?: boolean; json?: boolean }) => {
    const manifest = await loadManifest();
    const path = statePath(manifest.project);
    const state = await loadState(path);
    let value: string | undefined;
    if (!o.generate && !o.mint && !o.dryRun) {
      if (o.valueFile) value = (await readFile(o.valueFile, "utf8")).replace(/\r?\n$/, "");
      else {
        const piped = await readStdin();
        if (piped === "") throw new Error("stdin was empty; no value to rotate to");
        if (piped !== undefined) value = piped;
        else {
          const p = new Prompter();
          try { value = await p.askHidden(`New value for ${secret} (not echoed): `); } finally { p.close(); }
        }
      }
    }
    const persist = (st: State) => saveState(path, st);
    const r = await runRotate(manifest, state, { secret, value, generate: o.generate, mint: o.mint, limit: o.limit, limitReset: o.limitReset, dryRun: o.dryRun, persist }, ctx);
    console.log(o.json ? JSON.stringify(r, null, 2) : formatRotate(r));
    process.exitCode = r.ok ? 0 : 1;
  });

program
  .command("revoke <secret>")
  .description("Delete the previous issuer key left live by `rotate --mint`, once every host has redeployed (openrouter)")
  .option("--hash <hash>", "delete this key hash instead of the recorded previous one")
  .action(async (secret: string, o: { hash?: string }) => {
    const manifest = await loadManifest();
    const path = statePath(manifest.project);
    const state = await loadState(path);
    const r = await runRevoke(manifest, state, { secret, hash: o.hash, persist: (st) => saveState(path, st) });
    if (r.deleted) console.log(`${secret}: deleted previous OpenRouter key ${r.deleted}`);
    else {
      console.log(`${secret}: this issuer has no revoke API. Do it by hand:`);
      r.checklist.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    }
  });

program
  .command("incident <host>")
  .description("A host was breached: list every secret stored there, most dangerous first, and optionally rotate each in turn")
  .option("--only <id>", "restrict to one sink id, e.g. api/production for railway, or a Fly app name")
  .option("--walk", "prompt for a new value per secret and rotate it everywhere (empty = skip, q = stop)")
  .option("--json", "machine-readable plan")
  .action(async (host: string, o: { only?: string; walk?: boolean; json?: boolean }) => {
    if (!supportedSinks.includes(host as SinkKind)) throw new Error(`unknown host "${host}"; one of ${supportedSinks.join(", ")}`);
    const manifest = await loadManifest();
    const filter = o.only ? (ref: Record<string, unknown>) => Object.values(ref).some((v) => (Array.isArray(v) ? v.join("+") : v) === o.only) : undefined;
    const items = planIncident(manifest, host as SinkKind, filter);
    if (o.json) { console.log(JSON.stringify(items, null, 2)); return; }
    console.log(formatPlan(host as SinkKind, items));
    if (!o.walk || !items.length) return;
    const path = statePath(manifest.project);
    const state = await loadState(path);
    const p = new Prompter();
    const prompt = async (item: IncidentItem) => {
      console.log("");
      let a: string;
      try {
        a = await p.askHidden(`New value for ${item.secret} (${item.issuer}; create it at the issuer first; not echoed). Enter = skip, q = stop: `);
      } catch {
        return null; // input ended: stop the walk, report what is still exposed
      }
      if (a.trim().toLowerCase() === "q") return null;
      return a.trim() || undefined;
    };
    try {
      const w = await walkIncident(manifest, state, items, prompt, ctx, (st) => saveState(path, st), async (r) => { console.log(formatRotate(r)); });
      console.log(formatWalk(w, items));
      process.exitCode = w.failed.length || w.stoppedEarly ? 1 : 0;
    } finally {
      p.close();
    }
  });

program
  .command("remind")
  .description("Run the audit and post a one-message summary to the Slack or Discord webhook in KEYMAP_WEBHOOK (names only, never values)")
  .option("--always", "post even when there is nothing to report")
  .action(async (o: { always?: boolean }) => {
    const webhook = process.env.KEYMAP_WEBHOOK; // env only: a URL on argv shows up in `ps` and shell history
    const manifest = await loadManifest();
    const state = await loadState(statePath(manifest.project));
    const r = await runAudit(manifest, state, ctx);
    const { text, count } = buildReminder(manifest.project, r);
    if (!count && !o.always) { console.log(text, "(nothing posted)"); return; }
    if (!webhook) { console.log(text); console.log("\n(KEYMAP_WEBHOOK not set, printed instead)"); process.exitCode = r.failed ? 1 : 0; return; }
    await postReminder(webhook, text);
    console.log(`posted ${count} line${count === 1 ? "" : "s"} to webhook`);
    process.exitCode = r.failed ? 1 : 0;
  });

program
  .command("doctor")
  .description("Check which host CLIs are installed and logged in")
  .action(async () => {
    const rows = await runDoctor(ctx);
    console.log(formatDoctor(rows));
    process.exitCode = rows.some((r) => r.installed && r.loggedIn === false) ? 1 : 0;
  });

program
  .command("mark <secret>")
  .description("Record that a secret was rotated outside keymap (sets last_rotated to now)")
  .option("--at <iso>", "timestamp instead of now")
  .action(async (secret: string, o: { at?: string }) => {
    const manifest = await loadManifest();
    if (!getSecret(manifest, secret)) throw new Error(`${secret} is not in keymap.yaml`);
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
