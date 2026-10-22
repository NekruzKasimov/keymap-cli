import { adapterFor } from "../adapters/index.js";
import { intervalMs, isIgnored } from "../manifest.js";
import type { AdapterContext, Manifest, SinkEntry, SinkRef, State } from "../types.js";

export type Finding =
  | { kind: "missing"; secret: string; sink: string }
  | { kind: "drift"; secret: string; sinks: string[] }
  | { kind: "overdue"; secret: string; ageDays: number; limitDays: number }
  | { kind: "never-rotated"; secret: string }
  | { kind: "unknown"; sink: string; names: string[] }
  | { kind: "sink-error"; sink: string; error: string };

export interface AuditRow {
  secret: string;
  issuer: string;
  ageDays?: number;
  rotateEvery?: string;
  sinks: Array<{ id: string; present: boolean; comparable: boolean; verifiable: boolean; drift?: boolean }>;
}

export interface AuditResult {
  rows: AuditRow[];
  findings: Finding[];
  /** true when any finding would fail CI (missing, drift, overdue, unknown, sink-error). */
  failed: boolean;
}

function sinkKey(ref: SinkRef): string {
  return adapterFor(ref.kind).id(ref);
}

export async function runAudit(manifest: Manifest, state: State, ctx: AdapterContext, now = Date.now()): Promise<AuditResult> {
  // Collect the unique sinks referenced anywhere, list each once.
  const sinkRefs = new Map<string, SinkRef>();
  for (const spec of Object.values(manifest.secrets)) for (const ref of spec.sinks) sinkRefs.set(sinkKey(ref), ref);

  const listings = new Map<string, Map<string, SinkEntry>>();
  const findings: Finding[] = [];
  for (const [id, ref] of sinkRefs) {
    try {
      const entries = await adapterFor(ref.kind).list(ref, ctx);
      listings.set(id, new Map(entries.map((e) => [e.name, e])));
    } catch (e) {
      findings.push({ kind: "sink-error", sink: id, error: (e as Error).message });
    }
  }

  const rows: AuditRow[] = [];
  const claimed = new Map<string, Set<string>>(); // sink id -> names the manifest knows about
  for (const [name, spec] of Object.entries(manifest.secrets)) {
    const st = state.secrets[name];
    const ageDays = st?.last_rotated ? Math.floor((now - Date.parse(st.last_rotated)) / 86_400_000) : undefined;
    const row: AuditRow = { secret: name, issuer: spec.issuer, ageDays, rotateEvery: spec.rotate_every, sinks: [] };

    const digests = new Map<string, string>();
    for (const ref of spec.sinks) {
      const adapter = adapterFor(ref.kind);
      const id = adapter.id(ref);
      (claimed.get(id) ?? claimed.set(id, new Set()).get(id)!).add(name);
      const listing = listings.get(id);
      if (!listing) {
        row.sinks.push({ id, present: false, comparable: false, verifiable: adapter.verifiable });
        continue;
      }
      const entry = listing.get(name);
      const comparable = !!entry?.digest && /^[0-9a-f]{8}$/.test(entry.digest); // provider-native digests (fly:…, sb:…) are not comparable
      row.sinks.push({ id, present: !!entry, comparable, verifiable: adapter.verifiable });
      if (!entry) findings.push({ kind: "missing", secret: name, sink: id });
      else if (comparable) digests.set(id, entry.digest as string);
    }
    const distinct = new Set(digests.values());
    if (distinct.size > 1) {
      findings.push({ kind: "drift", secret: name, sinks: [...digests.keys()] });
      for (const s of row.sinks) if (digests.has(s.id)) s.drift = true;
    }

    if (spec.rotate_every) {
      const limitDays = Math.round(intervalMs(spec.rotate_every) / 86_400_000);
      if (ageDays === undefined) findings.push({ kind: "never-rotated", secret: name });
      else if (ageDays > limitDays) findings.push({ kind: "overdue", secret: name, ageDays, limitDays });
    }
    rows.push(row);
  }

  for (const [id, listing] of listings) {
    const known = claimed.get(id) ?? new Set();
    const unknown = [...listing.keys()].filter((n) => !known.has(n) && !isIgnored(n, manifest.ignore));
    if (unknown.length) findings.push({ kind: "unknown", sink: id, names: unknown.sort() });
  }

  const failed = findings.some((f) => f.kind !== "never-rotated");
  return { rows, findings, failed };
}

export function formatAudit(r: AuditResult): string {
  const lines: string[] = [];
  const w = Math.max(6, ...r.rows.map((x) => x.secret.length));
  lines.push(`${"SECRET".padEnd(w)}  ${"ISSUER".padEnd(10)}  ${"AGE".padStart(6)}  ${"EVERY".padStart(6)}  SINKS`);
  for (const row of r.rows) {
    const age = row.ageDays === undefined ? "?" : `${row.ageDays}d`;
    const sinks = row.sinks
      .map((s) => `${s.present ? (s.drift ? "≠" : "✓") : "✗"}${s.id}${s.verifiable ? "" : "(wo)"}`)
      .join("  ");
    lines.push(`${row.secret.padEnd(w)}  ${row.issuer.padEnd(10)}  ${age.padStart(6)}  ${(row.rotateEvery ?? "-").padStart(6)}  ${sinks}`);
  }
  if (r.findings.length) {
    lines.push("");
    for (const f of r.findings) {
      switch (f.kind) {
        case "missing": lines.push(`MISSING   ${f.secret} is not set at ${f.sink}`); break;
        case "drift": lines.push(`DRIFT     ${f.secret} differs across ${f.sinks.join(", ")}`); break;
        case "overdue": lines.push(`OVERDUE   ${f.secret} is ${f.ageDays}d old, limit ${f.limitDays}d`); break;
        case "never-rotated": lines.push(`UNKNOWN AGE ${f.secret} has never been rotated via keymap (run \`keymap rotate ${f.secret}\` or \`keymap mark ${f.secret}\`)`); break;
        case "unknown": lines.push(`UNMAPPED  ${f.sink} has secrets not in keymap.yaml: ${f.names.join(", ")}`); break;
        case "sink-error": lines.push(`ERROR     ${f.sink}: ${f.error}`); break;
      }
    }
  } else {
    lines.push("", "OK  every mapped secret is present, consistent and within its rotation window");
  }
  return lines.join("\n");
}
