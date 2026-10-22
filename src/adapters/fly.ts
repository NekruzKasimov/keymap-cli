import { cliError, parseJsonSafe } from "../exec.js";
import type { AdapterContext, SinkAdapter, SinkEntry, SinkRef } from "../types.js";


const TOKENS = ["FLY_API_TOKEN", "FLY_ACCESS_TOKEN"];
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
  tokens: TOKENS,
  verifiable: false,
  id: (ref) => `fly:${(ref.app as string) ?? "linked"}`,
  async list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]> {
    const r = await ctx.exec("flyctl", ["secrets", "list", "--json", ...scope(ref)], { cwd: ctx.cwd, tokens: TOKENS });
    if (r.code !== 0) throw cliError("flyctl secrets list", r, { stdoutSafe: true });
    const rows = parseJsonSafe<Array<{ Name?: string; name?: string; Digest?: string; digest?: string }>>(r.stdout || "[]", "flyctl secrets list") as Array<{ Name?: string; name?: string; Digest?: string; digest?: string }>;
    return rows.map((x) => ({ name: (x.Name ?? x.name) as string, digest: x.Digest ?? x.digest ? `fly:${x.Digest ?? x.digest}` : undefined })).filter((x) => x.name);
  },
  async set(ref, name, value, ctx) {
    // flyctl splits NAME=VALUE at the first "=" and takes the rest verbatim: no quoting layer, so only newlines are impossible.
    if (/[\r\n]/.test(value)) throw new Error(`fly secrets import cannot carry newlines in ${name}`);
    if (value !== value.trim()) throw new Error(`${name}: leading or trailing whitespace would be lost by flyctl secrets import`);
    const r = await ctx.exec("flyctl", ["secrets", "import", "--stage", ...scope(ref)], { stdin: `${name}=${value}\n`, cwd: ctx.cwd, tokens: TOKENS });
    if (r.code !== 0) throw cliError(`flyctl secrets import ${name}`, r, { stdoutSafe: true, redact: [value] });
    return { name };
  },
};
