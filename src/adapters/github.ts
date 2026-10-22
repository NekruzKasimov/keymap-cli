import { cliError, parseJsonSafe } from "../exec.js";
import type { AdapterContext, SinkAdapter, SinkEntry, SinkRef } from "../types.js";

/**
 * GitHub Actions secrets via `gh`. Values are write-only on GitHub, so `list` returns names only
 * and `set` reports verified-by-push (the digest we computed locally, which audit treats as unverifiable).
 * ref: { repo?: "owner/name", env?: "production" }
 */
function repoArgs(ref: SinkRef): string[] {
  return ref.repo ? ["--repo", ref.repo as string] : [];
}
function envArgs(ref: SinkRef): string[] {
  return ref.env ? ["--env", ref.env as string] : [];
}

export const githubAdapter: SinkAdapter = {
  kind: "github",
  verifiable: false,
  id: (ref) => `github:${(ref.repo as string) ?? "."}${ref.env ? `/${ref.env}` : ""}`,
  async list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]> {
    const r = await ctx.exec("gh", ["secret", "list", "--json", "name", ...repoArgs(ref), ...envArgs(ref)], { cwd: ctx.cwd });
    if (r.code !== 0) throw cliError("gh secret list", r, { stdoutSafe: true });
    const rows = parseJsonSafe<Array<{ name: string }>>(r.stdout || "[]", "gh secret list");
    return rows.map((x) => ({ name: x.name }));
  },
  async set(ref, name, value, ctx) {
    // Value goes through stdin: never on argv (visible in `ps`), never through a shell.
    const r = await ctx.exec("gh", ["secret", "set", name, ...repoArgs(ref), ...envArgs(ref)], { stdin: value, cwd: ctx.cwd });
    if (r.code !== 0) throw cliError(`gh secret set ${name}`, r, { stdoutSafe: true, redact: [value] });
    return { name };
  },
};
