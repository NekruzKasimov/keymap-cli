import { execFile } from "node:child_process";
import type { Exec, ExecResult } from "./types.js";

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Common install locations that are often missing from PATH (flyctl's installer, npm global, Homebrew). */
const EXTRA_BIN = [join(homedir(), ".local", "bin"), join(homedir(), ".fly", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

export function pathWithFallbacks(env: NodeJS.ProcessEnv = process.env): string {
  const have = (env.PATH ?? "").split(delimiter);
  const extra = EXTRA_BIN.filter((d) => !have.includes(d) && isDir(d));
  return [...have, ...extra].join(delimiter);
}

function isDir(p: string): boolean {
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs a CLI without a shell. Secret values only ever travel via argv/stdin, never through a shell string. */
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: pathWithFallbacks() } },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        let code = 0;
        let errText = String(stderr);
        if (err) {
          if (err.code === "ENOENT") {
            code = 127;
            errText = errText || `${cmd}: command not found`;
          } else if (typeof err.code === "number") code = err.code;
          else code = child.exitCode ?? 1;
        }
        resolve({ code, stdout: String(stdout), stderr: errText });
      }
    );
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });

/** Build a fake exec for tests: match on cmd + args prefix, return canned results. */
export function fakeExec(
  table: Array<{ cmd: string; args?: string[]; result: Partial<ExecResult>; onCall?: (args: string[], stdin?: string) => void }>
): Exec & { calls: Array<{ cmd: string; args: string[]; stdin?: string }> } {
  const calls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
  const fn = (async (cmd, args, opts) => {
    calls.push({ cmd, args, stdin: opts?.stdin });
    const hit = table.find(
      (t) => t.cmd === cmd && (!t.args || t.args.every((a, i) => args[i] === a))
    );
    if (!hit) return { code: 127, stdout: "", stderr: `fakeExec: no match for ${cmd} ${args.join(" ")}` };
    hit.onCall?.(args, opts?.stdin);
    return { code: 0, stdout: "", stderr: "", ...hit.result };
  }) as Exec & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}
