import { adapterFor } from "../adapters/index.js";
import { canGenerate, generateSecret, manualChecklist } from "../issuers.js";
import { getSecret } from "../manifest.js";
import { createKey, deleteKey, listKeys, managementKey, type FetchLike } from "../openrouter.js";
import { digestOf } from "../state.js";
import type { AdapterContext, Manifest, SecretSpec, SinkRef, State } from "../types.js";

export interface RotateOptions {
  secret: string;
  /** New value. Exactly one of value / generate / mint must be given unless dryRun. */
  value?: string;
  generate?: boolean;
  /** Create the new key at the issuer by API (OpenRouter only) and push it. The old key is NOT deleted; see `revoke`. */
  mint?: boolean;
  limit?: number;
  limitReset?: "daily" | "weekly" | "monthly";
  dryRun?: boolean;
  /** Called whenever state changes in a way that must survive a crash (minted key hash, pushes). */
  persist?: (state: State) => Promise<void>;
  fetchFn?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export type SinkOutcome =
  | { id: string; status: "planned" }
  | { id: string; status: "pushed" }
  | { id: string; status: "failed"; error: string }
  | { id: string; status: "skipped" };

export interface RotateResult {
  secret: string;
  issuer: SecretSpec["issuer"];
  dryRun: boolean;
  source: "stdin" | "generate" | "mint" | "none";
  outcomes: SinkOutcome[];
  /** Sinks that still hold the OLD value because a push failed before reaching them. */
  stale: string[];
  checklist: string[];
  /** Notes from the issuer step (minted key, what to revoke, other keys on the account). */
  issuerNotes: string[];
  /** Hosts that need a redeploy for the new value to take effect. */
  redeploy: string[];
  ok: boolean;
}

/**
 * Push order: hosts that STAGE the value (nothing changes until a redeploy) go first, so an early failure
 * leaves nothing live on the new value. Hosts where a push takes effect immediately come next, then CI,
 * then the local file last (a half-done rotation should never leave the laptop ahead of production).
 */
const ORDER: Record<SinkRef["kind"], number> = { railway: 0, fly: 0, vercel: 0, cloudflare: 1, supabase: 1, github: 2, local: 3 };

export function orderSinks(sinks: SinkRef[]): SinkRef[] {
  return [...sinks].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

const NEEDS_REDEPLOY = new Set<SinkRef["kind"]>(["railway", "fly", "vercel"]);
const REDEPLOY_HINT: Partial<Record<SinkRef["kind"], string>> = {
  railway: "railway redeploy --service <name>",
  fly: "flyctl secrets deploy --app <name>",
  vercel: "vercel --prod (or redeploy from the dashboard)",
};

function redact(msg: string, value: string | undefined): string {
  return value ? msg.split(value).join("[redacted]") : msg;
}

export async function runRotate(manifest: Manifest, state: State, opts: RotateOptions, ctx: AdapterContext): Promise<RotateResult> {
  const spec = getSecret(manifest, opts.secret);
  if (!spec) throw new Error(`${opts.secret} is not in keymap.yaml`);
  const persist = opts.persist ?? (async () => {});
  const issuerNotes: string[] = [];
  let value: string | undefined;
  let source: RotateResult["source"] = "none";
  let mintedHash: string | undefined;
  let mgmt: string | undefined;

  if (!opts.dryRun) {
    const sources = [opts.value !== undefined, !!opts.generate, !!opts.mint].filter(Boolean).length;
    if (sources > 1) throw new Error("give exactly one of stdin/--value-file, --generate, --mint");
    if (sources === 0) throw new Error("no new value: pipe it on stdin, use --value-file, --generate (custom secrets) or --mint (openrouter)");
    if ((opts.limit !== undefined || opts.limitReset) && !opts.mint) throw new Error("--limit / --limit-reset only apply with --mint");
    if (opts.limit !== undefined && !(Number.isFinite(opts.limit) && opts.limit > 0)) throw new Error("--limit must be a positive number of USD");
    if (opts.generate && !canGenerate(spec.issuer)) throw new Error(`--generate only makes sense for issuer "custom"; ${spec.issuer} keys must be created at the issuer first`);
    if (opts.value !== undefined && opts.value.trim() === "") throw new Error("new value is empty");

    if (opts.mint) {
      if (spec.issuer !== "openrouter") throw new Error(`--mint is only available for issuer "openrouter" (${opts.secret} is ${spec.issuer})`);
      mgmt = managementKey(opts.env);
      if (!mgmt) throw new Error("--mint needs KEYMAP_OPENROUTER_MGMT_KEY (an OpenRouter management key, not an inference key)");
      const pre = state.secrets[opts.secret];
      if (pre?.previous_issuer_ref) throw new Error(`${opts.secret}: the key from the last --mint (${pre.previous_issuer_ref}) has not been revoked yet. Run \`keymap revoke ${opts.secret}\` first, or \`--hash\` it if it is already gone`);
      const created = await createKey(mgmt, { name: `${manifest.project}/${opts.secret} ${new Date().toISOString().slice(0, 10)}`, limit: opts.limit, limitReset: opts.limitReset }, opts.fetchFn);
      value = created.key;
      mintedHash = created.hash;
      source = "mint";
      // Record the live key's handle BEFORE any push, so a crash cannot orphan it.
      const st = (state.secrets[opts.secret] ??= { sinks: {} });
      st.pending_issuer_refs = [...(st.pending_issuer_refs ?? []), mintedHash];
      await persist(state);
      issuerNotes.push(`minted OpenRouter key "${created.name}" (${created.hash})${opts.limit !== undefined ? ` with limit $${opts.limit}${opts.limitReset ? ` per ${{ daily: "day", weekly: "week", monthly: "month" }[opts.limitReset]}` : ""}` : " with NO credit limit"}`);
    } else if (opts.generate) {
      value = generateSecret();
      source = "generate";
    } else {
      value = opts.value;
      source = "stdin";
    }
  }

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
      await adapter.set(ref, opts.secret, value as string, ctx);
      outcomes.push({ id, status: "pushed" });
      if (NEEDS_REDEPLOY.has(ref.kind)) redeploy.add(id);
    } catch (e) {
      failed = true;
      outcomes.push({ id, status: "failed", error: redact((e as Error).message, value) });
    }
  }

  const stale = outcomes.filter((o) => o.status === "failed" || o.status === "skipped").map((o) => o.id);
  const ok = !failed;

  if (!opts.dryRun && (ok || mintedHash)) {
    const st = (state.secrets[opts.secret] ??= { sinks: {} });
    if (ok) {
      const now = new Date().toISOString();
      st.last_rotated = now;
      st.last_verified = now;
      for (const o of outcomes) if (o.status === "pushed") st.sinks[o.id] = { last_pushed: now, digest: digestOf(value as string) };
      if (mintedHash) {
        // Promote: the minted key is now current; the previous one stays live until `keymap revoke`.
        if (st.issuer_ref && st.issuer_ref !== mintedHash) st.previous_issuer_ref = st.issuer_ref;
        st.issuer_ref = mintedHash;
        // Keys minted by earlier unfinished rotations may already be running on hosts that redeployed in between,
        // so they are NOT deleted here. They join the revoke-after-redeploy set, exactly like the previous key.
        const stale = (st.pending_issuer_refs ?? []).filter((h) => h !== mintedHash && h !== st.issuer_ref && h !== st.previous_issuer_ref);
        st.pending_issuer_refs = [];
        if (stale.length) {
          st.stale_issuer_refs = [...new Set([...(st.stale_issuer_refs ?? []), ...stale])];
          issuerNotes.push(`keys from earlier unfinished rotations (${stale.join(", ")}) stay live until \`keymap revoke ${opts.secret}\``);
        }
        if (st.previous_issuer_ref) {
          issuerNotes.push(`previous key ${st.previous_issuer_ref} is still live on purpose. After every host has redeployed, run: keymap revoke ${opts.secret}`);
        } else {
          issuerNotes.push("the key you are replacing was not created by keymap, so it cannot be revoked automatically. After every host has redeployed, delete it at https://openrouter.ai/settings/keys");
          try {
            const others = (await listKeys(mgmt as string, opts.fetchFn)).filter((k) => k.hash !== mintedHash && !k.disabled);
            if (others.length) issuerNotes.push(`other live keys on the account: ${others.map((k) => `${k.name} (${k.hash})`).join(", ")}`);
          } catch {
            /* informational only */
          }
        }
      }
      await persist(state);
    } else if (mintedHash) {
      // Pushes failed part-way. Sinks that were pushed hold ONLY the minted key (keymap never had the old value),
      // so the minted key must stay live. It is recorded as pending and deleted by the next successful --mint,
      // once every sink has been overwritten.
      const pushed = outcomes.filter((o) => o.status === "pushed").map((o) => o.id);
      issuerNotes.push(
        pushed.length
          ? `minted key ${mintedHash} stays live: ${pushed.join(", ")} already hold it. Re-run with --mint; revoke it later with \`keymap revoke ${opts.secret}\`.`
          : `minted key ${mintedHash} was pushed nowhere; it stays live until \`keymap revoke ${opts.secret}\` (or delete it at https://openrouter.ai/settings/keys).`
      );
      await persist(state);
    }
  }

  return {
    secret: opts.secret,
    issuer: spec.issuer,
    dryRun: !!opts.dryRun,
    source,
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
  lines.push(`${r.dryRun ? "PLAN" : "ROTATE"}  ${r.secret}  (${r.issuer})`);
  for (const o of r.outcomes) {
    const mark = o.status === "pushed" ? "✓" : o.status === "failed" ? "✗" : o.status === "skipped" ? "-" : "·";
    const extra = o.status === "failed" ? `  ${o.error}` : o.status === "skipped" ? "  (skipped, still has OLD value)" : "";
    lines.push(`  ${mark} ${o.id}${extra}`);
  }
  if (r.dryRun) {
    lines.push("", "dry run: nothing was changed. Re-run with the new value on stdin, --value-file, --generate or --mint.");
    return lines.join("\n");
  }
  if (!r.ok) {
    lines.push("", `STOPPED. Do NOT revoke the old key yet: ${r.stale.join(", ")} still use it.`);
    lines.push(
      r.source === "stdin"
        ? "Fix the failing sink and run the same rotate again with the same new value."
        : `Fix the failing sink and re-run with --${r.source}; the partially pushed value will be overwritten everywhere.`
    );
    if (r.issuerNotes.length) lines.push("", ...r.issuerNotes.map((n) => `Issuer: ${n}`));
    return lines.join("\n");
  }
  if (r.redeploy.length) {
    lines.push("", "Redeploy so the new value takes effect:");
    for (const id of r.redeploy) lines.push(`  ${id}: ${REDEPLOY_HINT[id.split(":")[0] as SinkRef["kind"]] ?? "redeploy"}`);
  }
  if (r.issuerNotes.length) lines.push("", ...r.issuerNotes.map((n) => `Issuer: ${n}`));
  if (r.checklist.length) {
    lines.push("", "Now, at the issuer (after the redeploy above, if any):");
    r.checklist.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  lines.push("", "Recorded last_rotated = now.");
  return lines.join("\n");
}

export interface RevokeResult {
  secret: string;
  deleted: string[];
  checklist: string[];
}

/** Delete the previous issuer key recorded by a successful --mint (or a hash given explicitly). */
export async function runRevoke(manifest: Manifest, state: State, opts: { secret: string; hash?: string; env?: NodeJS.ProcessEnv; fetchFn?: FetchLike; persist?: (s: State) => Promise<void> }): Promise<RevokeResult> {
  const spec = getSecret(manifest, opts.secret);
  if (!spec) throw new Error(`${opts.secret} is not in keymap.yaml`);
  if (spec.issuer !== "openrouter") return { secret: opts.secret, deleted: [], checklist: manualChecklist(spec.issuer, opts.secret) };
  const st = (state.secrets[opts.secret] ??= { sinks: {} });
  const targets = opts.hash ? [opts.hash] : [...(st.previous_issuer_ref ? [st.previous_issuer_ref] : []), ...(st.stale_issuer_refs ?? [])];
  if (!targets.length) throw new Error(`nothing to revoke for ${opts.secret}: no superseded key recorded. Pass --hash <hash> (see https://openrouter.ai/settings/keys)`);
  if (targets.includes(st.issuer_ref as string)) throw new Error(`${st.issuer_ref} is the CURRENT key for ${opts.secret}; refusing to delete it`);
  if (opts.hash && (st.pending_issuer_refs ?? []).includes(opts.hash)) throw new Error(`${opts.hash} belongs to an unfinished rotation; finish it with --mint first`);
  const mgmt = managementKey(opts.env);
  if (!mgmt) throw new Error("revoke needs KEYMAP_OPENROUTER_MGMT_KEY");
  const deleted: string[] = [];
  const persist = opts.persist ?? (async () => {});
  for (const hash of targets) {
    await deleteKey(mgmt, hash, opts.fetchFn);
    deleted.push(hash);
    if (st.previous_issuer_ref === hash) delete st.previous_issuer_ref;
    st.stale_issuer_refs = (st.stale_issuer_refs ?? []).filter((h) => h !== hash);
    await persist(state); // record each deletion as it happens
  }
  if (!st.stale_issuer_refs?.length) delete st.stale_issuer_refs;
  return { secret: opts.secret, deleted, checklist: [] };
}
