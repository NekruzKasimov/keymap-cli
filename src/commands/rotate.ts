import { adapterFor } from "../adapters/index.js";
import { canGenerate, generateSecret, manualChecklist } from "../issuers.js";
import { createKey, deleteKey, managementKey, type FetchLike } from "../openrouter.js";
import { digestOf } from "../state.js";
import type { AdapterContext, Manifest, SecretSpec, SinkRef, State } from "../types.js";

export interface RotateOptions {
  secret: string;
  /** New value. Exactly one of value / generate must be given unless dryRun. */
  value?: string;
  generate?: boolean;
  /** Create the new key at the issuer by API (OpenRouter only), push it, then delete the previous one. */
  mint?: boolean;
  limit?: number;
  limitReset?: "daily" | "weekly" | "monthly";
  dryRun?: boolean;
  fetchFn?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export type SinkOutcome =
  | { id: string; status: "planned" }
  | { id: string; status: "pushed"; digest?: string }
  | { id: string; status: "failed"; error: string }
  | { id: string; status: "skipped" };

export interface RotateResult {
  secret: string;
  issuer: SecretSpec["issuer"];
  dryRun: boolean;
  digest?: string;
  outcomes: SinkOutcome[];
  /** Sinks that still hold the OLD value because a push failed before reaching them. */
  stale: string[];
  checklist: string[];
  /** Notes from the issuer step (minted key name, old key deleted or not). */
  issuerNotes: string[];
  /** Hosts that need a redeploy for the new value to take effect. */
  redeploy: string[];
  ok: boolean;
}

/**
 * Push order: hosts that run code first (so a redeploy picks up the new value), CI second,
 * local file last (a half-done rotation should never leave the laptop ahead of production).
 */
const ORDER: Record<SinkRef["kind"], number> = { railway: 0, fly: 0, vercel: 0, cloudflare: 0, supabase: 0, github: 1, local: 2 };

export function orderSinks(sinks: SinkRef[]): SinkRef[] {
  return [...sinks].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

const NEEDS_REDEPLOY = new Set<SinkRef["kind"]>(["railway", "fly", "vercel"]);
const REDEPLOY_HINT: Partial<Record<SinkRef["kind"], string>> = {
  railway: "railway redeploy --service <name>",
  fly: "flyctl secrets deploy --app <name>",
  vercel: "vercel --prod (or redeploy from the dashboard)",
};

export async function runRotate(manifest: Manifest, state: State, opts: RotateOptions, ctx: AdapterContext): Promise<RotateResult> {
  const spec = manifest.secrets[opts.secret];
  if (!spec) throw new Error(`${opts.secret} is not in keymap.yaml`);
  const issuerNotes: string[] = [];
  let mintedHash: string | undefined;
  if (!opts.dryRun) {
    const sources = [opts.value !== undefined, !!opts.generate, !!opts.mint].filter(Boolean).length;
    if (sources > 1) throw new Error("give exactly one of --value/stdin, --generate, --mint");
    if (sources === 0) throw new Error("no new value: pass it on stdin, with --value, --generate (custom secrets) or --mint (openrouter)");
    if (opts.mint) {
      if (spec.issuer !== "openrouter") throw new Error(`--mint is only available for issuer "openrouter" (${opts.secret} is ${spec.issuer})`);
      const mgmt = managementKey(opts.env);
      if (!mgmt) throw new Error("--mint needs KEYMAP_OPENROUTER_MGMT_KEY (an OpenRouter management key, not an inference key)");
      const created = await createKey(mgmt, { name: `${manifest.project}/${opts.secret} ${new Date().toISOString().slice(0, 10)}`, limit: opts.limit, limitReset: opts.limitReset }, opts.fetchFn);
      opts = { ...opts, value: created.key };
      mintedHash = created.hash;
      issuerNotes.push(`minted OpenRouter key "${created.name}"${opts.limit !== undefined ? ` with limit $${opts.limit}${opts.limitReset ? ` per ${{ daily: "day", weekly: "week", monthly: "month" }[opts.limitReset]}` : ""}` : " with no credit limit"}`);
    }
    if (opts.generate && !canGenerate(spec.issuer)) throw new Error(`--generate only makes sense for issuer "custom"; ${spec.issuer} keys must be created at the issuer first`);
    if (opts.value !== undefined && opts.value.trim() === "") throw new Error("new value is empty");
  }
  const value = opts.generate ? generateSecret() : opts.value;
  const sinks = orderSinks(spec.sinks);
  const outcomes: SinkOutcome[] = [];
  const redeploy = new Set<string>();
  let failed = false;

  for (const ref of sinks) {
    const adapter = adapterFor(ref.kind);
    const id = adapter.id(ref);
    if (opts.dryRun) {
      outcomes.push({ id, status: "planned" });
      continue;
    }
    if (failed) {
      outcomes.push({ id, status: "skipped" });
      continue;
    }
    try {
      const r = await adapter.set(ref, opts.secret, value as string, ctx);
      outcomes.push({ id, status: "pushed", digest: r.digest });
      if (NEEDS_REDEPLOY.has(ref.kind)) redeploy.add(id);
    } catch (e) {
      failed = true;
      outcomes.push({ id, status: "failed", error: (e as Error).message });
    }
  }

  const stale = outcomes.filter((o) => o.status === "failed" || o.status === "skipped").map((o) => o.id);
  const ok = !failed;

  if (!opts.dryRun && ok) {
    const now = new Date().toISOString();
    const st = (state.secrets[opts.secret] ??= { sinks: {} });
    st.last_rotated = now;
    st.last_verified = now;
    for (const o of outcomes) if (o.status === "pushed") st.sinks[o.id] = { last_pushed: now, digest: o.digest };
    if (mintedHash) {
      const old = st.issuer_ref;
      st.issuer_ref = mintedHash;
      if (old && old !== mintedHash) {
        try {
          await deleteKey(managementKey(opts.env) as string, old, opts.fetchFn);
          issuerNotes.push("deleted the previous OpenRouter key");
        } catch (e) {
          issuerNotes.push(`could not delete the previous OpenRouter key (${(e as Error).message}); delete it at https://openrouter.ai/settings/keys`);
        }
      }
    }
  }

  return {
    secret: opts.secret,
    issuer: spec.issuer,
    dryRun: !!opts.dryRun,
    digest: value !== undefined ? digestOf(value) : undefined,
    outcomes,
    stale,
    checklist: ok && !mintedHash ? manualChecklist(spec.issuer, opts.secret) : [],
    issuerNotes,
    redeploy: [...redeploy],
    ok,
  };
}

export function formatRotate(r: RotateResult): string {
  const lines: string[] = [];
  lines.push(`${r.dryRun ? "PLAN" : "ROTATE"}  ${r.secret}  (${r.issuer})${r.digest ? `  new@${r.digest}` : ""}`);
  for (const o of r.outcomes) {
    const mark = o.status === "pushed" ? "✓" : o.status === "failed" ? "✗" : o.status === "skipped" ? "-" : "·";
    const extra = o.status === "failed" ? `  ${o.error}` : o.status === "skipped" ? "  (skipped, still has OLD value)" : "";
    lines.push(`  ${mark} ${o.id}${extra}`);
  }
  if (r.dryRun) {
    lines.push("", "dry run: nothing was changed. Re-run with the new value on stdin, --value, or --generate.");
    return lines.join("\n");
  }
  if (!r.ok) {
    lines.push("", `STOPPED. Do NOT revoke the old key yet: ${r.stale.join(", ")} still use it.`, "Fix the failing sink and run the same rotate again with the same new value.");
    return lines.join("\n");
  }
  if (r.redeploy.length) {
    lines.push("", "Redeploy so the new value takes effect:");
    for (const id of r.redeploy) lines.push(`  ${id}: ${REDEPLOY_HINT[id.split(":")[0] as SinkRef["kind"]] ?? "redeploy"}`);
  }
  if (r.issuerNotes.length) lines.push("", ...r.issuerNotes.map((n) => `Issuer: ${n}`));
  if (r.checklist.length) {
    lines.push("", "Now, at the issuer:");
    r.checklist.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  lines.push("", "Recorded last_rotated = now.");
  return lines.join("\n");
}
