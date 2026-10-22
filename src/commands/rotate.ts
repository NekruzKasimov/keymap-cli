import { adapterFor } from "../adapters/index.js";
import { canGenerate, generateSecret, manualChecklist } from "../issuers.js";
import { digestOf } from "../state.js";
import type { AdapterContext, Manifest, SecretSpec, SinkRef, State } from "../types.js";

export interface RotateOptions {
  secret: string;
  /** New value. Exactly one of value / generate must be given unless dryRun. */
  value?: string;
  generate?: boolean;
  dryRun?: boolean;
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
  if (!opts.dryRun) {
    if (opts.value !== undefined && opts.generate) throw new Error("give either --value/stdin or --generate, not both");
    if (opts.value === undefined && !opts.generate) throw new Error("no new value: pass it on stdin, with --value, or use --generate for custom secrets");
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
  }

  return {
    secret: opts.secret,
    issuer: spec.issuer,
    dryRun: !!opts.dryRun,
    digest: value !== undefined ? digestOf(value) : undefined,
    outcomes,
    stale,
    checklist: ok ? manualChecklist(spec.issuer, opts.secret) : [],
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
  if (r.checklist.length) {
    lines.push("", "Now, at the issuer:");
    r.checklist.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  lines.push("", "Recorded last_rotated = now.");
  return lines.join("\n");
}
