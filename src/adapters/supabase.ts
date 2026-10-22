import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, SinkAdapter, SinkEntry, SinkRef } from "../types.js";

/**
 * Supabase Edge Function secrets via `supabase secrets` (2.x). `list -o json` returns name + Supabase's
 * own digest (tagged "sb:", not comparable with other sinks). `set` only takes NAME=VALUE on argv or an
 * --env-file, so the value is written to a mode-600 temp file that is removed right after the call.
 * ref: { project: string }  (the project ref, e.g. abcdefghijklmnop)
 */
function scope(ref: SinkRef): string[] {
  return ref.project ? ["--project-ref", ref.project as string] : [];
}

export const supabaseAdapter: SinkAdapter = {
  kind: "supabase",
  verifiable: false,
  id: (ref) => `supabase:${(ref.project as string) ?? "linked"}`,
  async list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]> {
    const r = await ctx.exec("supabase", ["secrets", "list", "-o", "json", ...scope(ref)], { cwd: ctx.cwd });
    if (r.code !== 0) throw new Error(`supabase secrets list failed: ${r.stderr.trim() || r.stdout.trim()}`);
    const text = r.stdout.slice(Math.max(0, r.stdout.indexOf("[")));
    const rows = JSON.parse(text || "[]") as Array<{ name: string; value?: string; digest?: string }>;
    return rows.map((x) => ({ name: x.name, digest: x.digest ?? x.value ? `sb:${x.digest ?? x.value}` : undefined }));
  },
  async set(ref, name, value, ctx) {
    if (/[\r\n]/.test(value)) throw new Error(`supabase secrets set cannot carry newlines in ${name}`);
    const dir = await mkdtemp(join(tmpdir(), "keymap-sb-"));
    const file = join(dir, "secret.env");
    try {
      await writeFile(file, `${name}=${value}\n`, { mode: 0o600 });
      const r = await ctx.exec("supabase", ["secrets", "set", "--env-file", file, ...scope(ref)], { cwd: ctx.cwd });
      if (r.code !== 0) throw new Error(`supabase secrets set ${name} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return { name };
  },
};
