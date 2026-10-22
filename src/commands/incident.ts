import { adapterFor } from "../adapters/index.js";
import type { AdapterContext, Issuer, Manifest, SinkKind, State } from "../types.js";
import { formatRotate, runRotate, type RotateResult } from "./rotate.js";

/**
 * Blast-radius tiers, in the order Railway's own disclosure told customers to work:
 * AI provider keys, cloud access, database, source control, package registries, then everything else.
 */
export type Tier = 0 | 1 | 2 | 3 | 4 | 5;
const TIER_LABEL: Record<Tier, string> = {
  0: "AI provider keys (a stolen key is a credit card for compute)",
  1: "Cloud, payments and infrastructure tokens",
  2: "Database and storage credentials",
  3: "Source control tokens",
  4: "Package registry credentials",
  5: "Everything else",
};

export function tierOf(name: string, issuer: Issuer): Tier {
  const n = name.toUpperCase();
  if (["openai", "anthropic", "openrouter", "google"].includes(issuer)) return 0;
  if (/(OPENAI|ANTHROPIC|CLAUDE|OPENROUTER|GEMINI|GROQ|MISTRAL|TOGETHER|REPLICATE|ELEVENLABS|HUGGINGFACE|HF_TOKEN)/.test(n)) return 0;
  if (issuer === "stripe" || issuer === "cloudflare" || /(AWS_|GCP|GOOGLE_APPLICATION|AZURE|CLOUDFLARE|CF_|STRIPE|PAYPAL|TWILIO|SENDGRID|RESEND|VERCEL_TOKEN|RAILWAY_TOKEN|FLY_API)/.test(n)) return 1;
  if (issuer === "supabase" || /(DATABASE|POSTGRES|PG_|MYSQL|MONGO|REDIS|SUPABASE|S3_|R2_|BLOB)/.test(n)) return 2;
  if (/(GITHUB|GH_|GITLAB|BITBUCKET)/.test(n)) return 3;
  if (/(NPM_|PYPI|CARGO_|NUGET|DOCKER|GHCR|REGISTRY)/.test(n)) return 4;
  return 5;
}

function elsewhere(it: IncidentItem): string {
  const rest = it.allSinks.filter((s) => !it.exposedAt.includes(s));
  return rest.length ? `also lives at ${rest.join(", ")}` : "lives nowhere else";
}

export interface IncidentItem {
  secret: string;
  issuer: Issuer;
  tier: Tier;
  /** The sinks on the breached host that hold this secret. */
  exposedAt: string[];
  /** Every sink that must receive the new value. */
  allSinks: string[];
}

export function planIncident(manifest: Manifest, host: SinkKind, filter?: (ref: Record<string, unknown>) => boolean): IncidentItem[] {
  const items: IncidentItem[] = [];
  for (const [name, spec] of Object.entries(manifest.secrets)) {
    const exposed = spec.sinks.filter((s) => s.kind === host && (!filter || filter(s)));
    if (!exposed.length) continue;
    items.push({
      secret: name,
      issuer: spec.issuer,
      tier: tierOf(name, spec.issuer),
      exposedAt: exposed.map((s) => adapterFor(s.kind).id(s)),
      allSinks: spec.sinks.map((s) => adapterFor(s.kind).id(s)),
    });
  }
  return items.sort((a, b) => a.tier - b.tier || a.secret.localeCompare(b.secret));
}

export function formatPlan(host: SinkKind, items: IncidentItem[]): string {
  if (!items.length) return `No secret in keymap.yaml has a sink on ${host}. Nothing to rotate for this incident.`;
  const lines = [`INCIDENT ${host}: ${items.length} secret${items.length === 1 ? "" : "s"} to rotate, most dangerous first`, ""];
  let last: Tier | -1 = -1;
  for (const it of items) {
    if (it.tier !== last) {
      lines.push(`[${it.tier}] ${TIER_LABEL[it.tier]}`);
      last = it.tier;
    }
    lines.push(`    ${it.secret.padEnd(28)} ${it.issuer.padEnd(10)} exposed at ${it.exposedAt.join(", ")}; ${elsewhere(it)}`);
  }
  lines.push("", "Run `keymap incident <host> --walk` to rotate each one in turn, or `keymap rotate <SECRET>` individually.");
  return lines.join("\n");
}

/** Asks for the new value; returns undefined to skip, null to stop the walk. */
export type Prompt = (item: IncidentItem) => Promise<string | undefined | null>;

export interface WalkResult {
  rotated: string[];
  skipped: string[];
  failed: string[];
  stoppedEarly: boolean;
}

export async function walkIncident(
  manifest: Manifest,
  state: State,
  items: IncidentItem[],
  prompt: Prompt,
  ctx: AdapterContext,
  persist: (s: State) => Promise<void> = async () => {},
  onResult: (r: RotateResult) => void | Promise<void> = (r) => console.log(formatRotate(r))
): Promise<WalkResult> {
  const out: WalkResult = { rotated: [], skipped: [], failed: [], stoppedEarly: false };
  for (const item of items) {
    const value = await prompt(item);
    if (value === null) {
      out.stoppedEarly = true;
      break;
    }
    if (value === undefined || value.trim() === "") {
      out.skipped.push(item.secret);
      continue;
    }
    const r = await runRotate(manifest, state, { secret: item.secret, value, persist }, ctx);
    await onResult(r);
    (r.ok ? out.rotated : out.failed).push(item.secret);
  }
  return out;
}

export function formatWalk(w: WalkResult, items: IncidentItem[]): string {
  const remaining = items.map((i) => i.secret).filter((s) => !w.rotated.includes(s));
  const lines = ["", `INCIDENT SUMMARY  rotated ${w.rotated.length}  skipped ${w.skipped.length}  failed ${w.failed.length}${w.stoppedEarly ? "  (stopped early)" : ""}`];
  if (remaining.length) lines.push(`Still exposed: ${remaining.join(", ")}`);
  else lines.push("Every secret that lived on the breached host now has a new value. Revoke the old ones at each issuer.");
  return lines.join("\n");
}
