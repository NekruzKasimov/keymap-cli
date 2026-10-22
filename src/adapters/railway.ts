import { cliError, parseJsonSafe } from "../exec.js";
import { digestOf } from "../state.js";
import type { AdapterContext, SinkAdapter, SinkEntry, SinkRef } from "../types.js";


const TOKENS = ["RAILWAY_TOKEN", "RAILWAY_API_TOKEN"];
/**
 * Railway via `railway variable` (CLI 5.x). `list --json` returns raw values, which we hash in-process
 * and discard; sealed variables come back as null and are listed without a digest.
 * ref: { service?: string, environment?: string, project?: string }
 * Pushes use --skip-deploys so a multi-sink rotation does not trigger one redeploy per variable;
 * the rotate command asks for a redeploy at the end.
 */
function scope(ref: SinkRef): string[] {
  const a: string[] = [];
  if (ref.service) a.push("--service", ref.service as string);
  if (ref.environment) a.push("--environment", ref.environment as string);
  if (ref.project) a.push("--project", ref.project as string);
  return a;
}

export const railwayAdapter: SinkAdapter = {
  kind: "railway",
  tokens: TOKENS,
  verifiable: true,
  id: (ref) => `railway:${(ref.service as string) ?? "linked"}${ref.environment ? `/${ref.environment}` : ""}`,
  async list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]> {
    const r = await ctx.exec("railway", ["variable", "list", "--json", ...scope(ref)], { cwd: ctx.cwd, tokens: TOKENS });
    if (r.code !== 0) throw cliError("railway variable list", r);
    const obj = parseJsonSafe<Record<string, string | null>>(r.stdout || "{}", "railway variable list");
    return Object.entries(obj)
      .filter(([name]) => !name.startsWith("RAILWAY_"))
      .map(([name, value]) => (value === null ? { name } : { name, digest: digestOf(value) }));
  },
  async set(ref, name, value, ctx) {
    const r = await ctx.exec("railway", ["variable", "set", name, "--stdin", "--skip-deploys", "--json", ...scope(ref)], {
      stdin: value,
      cwd: ctx.cwd,
      tokens: TOKENS,
    });
    if (r.code !== 0) throw cliError(`railway variable set ${name}`, r, { redact: [value] });
    return { name, digest: digestOf(value) };
  },
};
