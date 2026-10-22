import { adapterFor } from "../adapters/index.js";
import type { AdapterContext, SinkKind } from "../types.js";

/** One probe per host CLI: is it installed, and is it logged in? Read-only commands only. */
interface Probe {
  sink: SinkKind;
  cmd: string;
  versionArgs: string[];
  authArgs: string[];
  /** Returns true when stdout+stderr of the auth probe indicate a valid login. */
  loggedIn: (out: string, code: number) => boolean;
  loginHint: string;
}

const PROBES: Probe[] = [
  { sink: "github", cmd: "gh", versionArgs: ["--version"], authArgs: ["auth", "status"], loggedIn: (o, c) => c === 0 && /Logged in/.test(o), loginHint: "gh auth login" },
  { sink: "railway", cmd: "railway", versionArgs: ["--version"], authArgs: ["whoami"], loggedIn: (o, c) => c === 0 && !/Unauthorized|login/i.test(o), loginHint: "railway login" },
  { sink: "vercel", cmd: "vercel", versionArgs: ["--version"], authArgs: ["whoami", "--non-interactive"], loggedIn: (o, c) => c === 0 && !/Logged out|not logged in/i.test(o), loginHint: "vercel login" },
  { sink: "fly", cmd: "flyctl", versionArgs: ["version"], authArgs: ["auth", "whoami"], loggedIn: (o, c) => c === 0 && /@/.test(o), loginHint: "flyctl auth login" },
  { sink: "cloudflare", cmd: "wrangler", versionArgs: ["--version"], authArgs: ["whoami"], loggedIn: (o, c) => c === 0 && /logged in|Account Name|account/i.test(o) && !/not authenticated|You are not/i.test(o), loginHint: "wrangler login" },
  { sink: "supabase", cmd: "supabase", versionArgs: ["--version"], authArgs: ["projects", "list", "-o", "json"], loggedIn: (o, c) => c === 0 && !/not logged in|Access token/i.test(o), loginHint: "supabase login" },
];

export interface DoctorRow {
  sink: SinkKind;
  cmd: string;
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  loginHint: string;
}

export async function runDoctor(ctx: AdapterContext, only?: SinkKind[]): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  for (const p of PROBES) {
    if (only && !only.includes(p.sink)) continue;
    const tokens = adapterFor(p.sink).tokens;
    const v = await ctx.exec(p.cmd, p.versionArgs, { cwd: ctx.cwd, tokens });
    if (v.code === 127) {
      rows.push({ sink: p.sink, cmd: p.cmd, installed: false, loginHint: p.loginHint });
      continue;
    }
    const version = (v.stdout + v.stderr).match(/\d+\.\d+\.\d+/)?.[0];
    const a = await ctx.exec(p.cmd, p.authArgs, { cwd: ctx.cwd, tokens });
    rows.push({ sink: p.sink, cmd: p.cmd, installed: true, version, loggedIn: p.loggedIn(a.stdout + a.stderr, a.code), loginHint: p.loginHint });
  }
  return rows;
}

export function formatDoctor(rows: DoctorRow[]): string {
  const lines = ["SINK        CLI        STATUS"];
  for (const r of rows) {
    const status = !r.installed ? `not installed (${r.cmd})` : r.loggedIn ? `ok ${r.version ?? ""}`.trim() : `installed ${r.version ?? ""}, not logged in -> ${r.loginHint}`;
    lines.push(`${r.sink.padEnd(11)} ${r.cmd.padEnd(10)} ${status}`);
  }
  lines.push("local       (none)     ok");
  return lines.join("\n");
}
