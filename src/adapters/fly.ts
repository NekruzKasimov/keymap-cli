import type { AdapterContext, SinkAdapter, SinkEntry, SinkRef } from "../types.js";

/**
 * Fly.io via `flyctl secrets` (0.4.x). `list --json` returns Fly's own digest per secret (not our sha256
 * prefix, so it is tagged "fly:" and never compared with other sinks). `import --stage` reads NAME=VALUE
 * from stdin and skips the deploy; rotate asks for `flyctl deploy` / `secrets deploy` at the end.
 * ref: { app: string }
 */
function scope(ref: SinkRef): string[] {
  return ref.app ? ["--app", ref.app as string] : [];
}

export const flyAdapter: SinkAdapter = {
  kind: "fly",
  verifiable: false,
  id: (ref) => `fly:${(ref.app as string) ?? "linked"}`,
  async list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]> {
    const r = await ctx.exec("flyctl", ["secrets", "list", "--json", ...scope(ref)], { cwd: ctx.cwd });
    if (r.code !== 0) throw new Error(`flyctl secrets list failed: ${r.stderr.trim() || r.stdout.trim()}`);
    const rows = JSON.parse(r.stdout || "[]") as Array<{ Name?: string; name?: string; Digest?: string; digest?: string }>;
    return rows.map((x) => ({ name: (x.Name ?? x.name) as string, digest: x.Digest ?? x.digest ? `fly:${x.Digest ?? x.digest}` : undefined })).filter((x) => x.name);
  },
  async set(ref, name, value, ctx) {
    if (/[\r\n]/.test(value)) throw new Error(`fly secrets import cannot carry newlines in ${name}`);
    const r = await ctx.exec("flyctl", ["secrets", "import", "--stage", ...scope(ref)], { stdin: `${name}=${value}\n`, cwd: ctx.cwd });
    if (r.code !== 0) throw new Error(`flyctl secrets import ${name} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return { name };
  },
};
