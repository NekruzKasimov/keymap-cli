import { access } from "node:fs/promises";
import { adapterFor } from "../adapters/index.js";
import { MANIFEST_FILE, isIgnored, saveManifest } from "../manifest.js";
import type { AdapterContext, Issuer, Manifest, SinkRef } from "../types.js";

/** Guess the issuer from the variable name. Only a hint; the user edits keymap.yaml afterwards. */
export function guessIssuer(name: string): Issuer {
  const n = name.toUpperCase();
  if (n.includes("OPENROUTER")) return "openrouter";
  if (n.includes("OPENAI")) return "openai";
  if (n.includes("ANTHROPIC") || n.includes("CLAUDE")) return "anthropic";
  if (n.includes("GEMINI") || n.includes("GOOGLE")) return "google";
  if (n.includes("STRIPE")) return "stripe";
  if (n.includes("SUPABASE")) return "supabase";
  if (n.includes("CLOUDFLARE") || n.startsWith("CF_")) return "cloudflare";
  return "custom";
}

export interface InitOptions {
  project: string;
  sinks: SinkRef[];
  all?: boolean;
  force?: boolean;
}

export interface InitResult {
  manifest: Manifest;
  perSink: Array<{ id: string; count: number; error?: string }>;
  /** Names that are not UPPER_SNAKE_CASE and therefore cannot be mapped. */
  skipped: string[];
}

export async function buildManifest(opts: InitOptions, ctx: AdapterContext): Promise<InitResult> {
  const secrets: Manifest["secrets"] = {};
  const perSink: InitResult["perSink"] = [];
  const skipped: string[] = [];
  for (const ref of opts.sinks) {
    const adapter = adapterFor(ref.kind);
    const id = adapter.id(ref);
    try {
      const entries = await adapter.list(ref, ctx);
      let count = 0;
      for (const { name } of entries) {
        if (!opts.all && isIgnored(name)) continue;
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) { skipped.push(`${id}: ${name}`); continue; }
        count++;
        const spec = (secrets[name] ??= { issuer: guessIssuer(name), rotate_every: "90d", sinks: [] });
        if (!spec.sinks.some((s) => adapter.id(s) === id)) spec.sinks.push(ref);
      }
      perSink.push({ id, count });
    } catch (e) {
      perSink.push({ id, count: 0, error: (e as Error).message });
    }
  }
  const ordered = Object.fromEntries(Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b)));
  return { manifest: { version: 1, project: opts.project, secrets: ordered }, perSink, skipped };
}

export async function runInit(opts: InitOptions, ctx: AdapterContext): Promise<InitResult> {
  if (!opts.force) {
    try {
      await access(MANIFEST_FILE);
      throw new Error(`${MANIFEST_FILE} already exists; use --force to overwrite`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const result = await buildManifest(opts, ctx);
  await saveManifest(result.manifest);
  return result;
}
