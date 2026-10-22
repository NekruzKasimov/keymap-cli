import { execFile } from "node:child_process";
import type { Exec, ExecResult } from "./types.js";

/** Runs a CLI without a shell. Secret values only ever travel via argv/stdin, never through a shell string. */
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === "number"
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : error
              ? (child.exitCode ?? 1)
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
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
