import { digestOf } from "../state.js";
import type { AdapterContext, SinkAdapter, SinkEntry, SinkRef } from "../types.js";

/**
 * Vercel via `vercel env` (CLI 65.x). `env list --json` returns values for plain variables and a redacted
 * placeholder for sensitive ones, so a digest is given only when the value is readable. `env add --force`
 * with the value on stdin creates or overwrites one variable in the given environments.
 * ref: { project?: string, targets?: ["production","preview","development"] (default production) }
 */
function targets(ref: SinkRef): string[] {
  const t = ref.targets;
  return Array.isArray(t) && t.length ? t : ["production"];
}
function projectArgs(ref: SinkRef): string[] {
  return ref.project ? ["--project", ref.project as string] : [];
}

interface VercelEnvRow {
  key: string;
  value?: string;
  target?: string[] | string;
  type?: string;
}

export const vercelAdapter: SinkAdapter = {
  kind: "vercel",
  verifiable: true,
  id: (ref) => `vercel:${(ref.project as string) ?? "linked"}/${targets(ref).join("+")}`,
  async list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]> {
    const want = new Set(targets(ref));
    const r = await ctx.exec("vercel", ["env", "list", "--json", "--non-interactive", ...projectArgs(ref)], { cwd: ctx.cwd });
    if (r.code !== 0) throw new Error(`vercel env list failed: ${r.stderr.trim() || r.stdout.trim()}`);
    const parsed = JSON.parse(r.stdout || "[]") as VercelEnvRow[] | { envs?: VercelEnvRow[] };
    const rows = Array.isArray(parsed) ? parsed : (parsed.envs ?? []);
    const out = new Map<string, SinkEntry>();
    for (const row of rows) {
      const t = Array.isArray(row.target) ? row.target : row.target ? [row.target] : [];
      if (!t.some((x) => want.has(x))) continue;
      const readable = row.type !== "sensitive" && typeof row.value === "string" && !/^\*+$|redacted|encrypted/i.test(row.value);
      out.set(row.key, readable ? { name: row.key, digest: digestOf(row.value as string) } : { name: row.key });
    }
    return [...out.values()];
  },
  async set(ref, name, value, ctx) {
    const r = await ctx.exec(
      "vercel",
      ["env", "add", name, "--environment", targets(ref).join(","), "--force", "--non-interactive", ...projectArgs(ref)],
      { stdin: value, cwd: ctx.cwd }
    );
    if (r.code !== 0) throw new Error(`vercel env add ${name} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return { name, digest: digestOf(value) };
  },
};
