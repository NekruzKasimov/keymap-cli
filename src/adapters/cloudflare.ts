import { cliError, parseJsonSafe } from "../exec.js";
import type { AdapterContext, SinkAdapter, SinkEntry, SinkRef } from "../types.js";

/**
 * Cloudflare Workers via `wrangler secret` (4.x). Secrets are write-only, so `list` returns names and
 * `set` pipes the value to `wrangler secret put <KEY>` on stdin. Runs against the Worker named in
 * ref.worker (falls back to the wrangler config in cwd) and optional ref.env.
 * ref: { worker?: string, env?: string }
 */
function scope(ref: SinkRef): string[] {
  const a: string[] = [];
  if (ref.worker) a.push("--name", ref.worker as string);
  if (ref.env) a.push("--env", ref.env as string);
  return a;
}

export const cloudflareAdapter: SinkAdapter = {
  kind: "cloudflare",
  verifiable: false,
  id: (ref) => `cloudflare:${(ref.worker as string) ?? "linked"}${ref.env ? `/${ref.env}` : ""}`,
  async list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]> {
    const r = await ctx.exec("wrangler", ["secret", "list", "--format", "json", ...scope(ref)], { cwd: ctx.cwd });
    if (r.code !== 0) throw cliError("wrangler secret list", r, { stdoutSafe: true });
    // wrangler may print banner lines before the JSON; take from the first '['.
    const text = r.stdout.slice(r.stdout.indexOf("["));
    const rows = parseJsonSafe<Array<{ name: string }>>(text || "[]", "wrangler secret list");
    return rows.map((x) => ({ name: x.name }));
  },
  async set(ref, name, value, ctx) {
    const r = await ctx.exec("wrangler", ["secret", "put", name, ...scope(ref)], { stdin: value, cwd: ctx.cwd });
    if (r.code !== 0) throw cliError(`wrangler secret put ${name}`, r, { stdoutSafe: true, redact: [value] });
    return { name };
  },
};
