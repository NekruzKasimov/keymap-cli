import type { Exec, ExecResult } from "../src/types.js";

/** Fake exec for tests: match on cmd + args prefix, return canned results. */
export function fakeExec(
  table: Array<{ cmd: string; args?: string[]; result: Partial<ExecResult>; onCall?: (args: string[], stdin?: string) => void }>
): Exec & { calls: Array<{ cmd: string; args: string[]; stdin?: string }> } {
  const calls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
  const fn = (async (cmd, args, opts) => {
    calls.push({ cmd, args, stdin: opts?.stdin });
    // git check-ignore is called by the local adapter before writes; default to "ignored" (exit 0).
    const hit = table.find((t) => t.cmd === cmd && (!t.args || t.args.every((a, i) => args[i] === a)));
    if (!hit) {
      if (cmd === "git") return { code: 0, stdout: "", stderr: "" };
      return { code: 127, stdout: "", stderr: `fakeExec: no match for ${cmd} ${args.join(" ")}` };
    }
    hit.onCall?.(args, opts?.stdin);
    return { code: 0, stdout: "", stderr: "", ...hit.result };
  }) as Exec & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}
