import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Exec, ExecResult } from "./types.js";

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

/** Child environment: the user's env plus PATH fallbacks, minus keymap's own secrets (management key, webhook). */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("KEYMAP_")) out[k] = v;
  out.PATH = pathWithFallbacks(env);
  return out;
}

export const EXEC_TIMEOUT_MS = 120_000;

/**
 * Runs a CLI without a shell. Secret values only ever travel via argv/stdin, never through a shell string.
 * stdin is always closed so a CLI that waits for input fails fast instead of hanging; a hard timeout
 * covers CLIs that block on an interactive login prompt.
 */
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, env: childEnv(), timeout: EXEC_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        let code = 0;
        let errText = String(stderr);
        if (err) {
          if (err.code === "ENOENT") {
            code = 127;
            errText = errText || `${cmd}: command not found`;
          } else if (err.killed) {
            code = 124;
            errText = `${cmd} timed out after ${EXEC_TIMEOUT_MS / 1000}s (waiting for an interactive prompt?)`;
          } else if (typeof err.code === "number") code = err.code;
          else code = child.exitCode ?? 1;
        }
        resolve({ code, stdout: String(stdout), stderr: errText });
      }
    );
    child.stdin?.end(opts.stdin ?? "");
  });

const MAX_ERR = 300;

/**
 * Build an error message from a failed CLI call without ever echoing secret values.
 * stdout is excluded unless `stdoutSafe` is set (commands whose stdout never carries values), and
 * `redact` strings are blanked wherever they appear.
 */
export function cliError(what: string, r: ExecResult, opts: { stdoutSafe?: boolean; redact?: string[] } = {}): Error {
  let text = r.stderr.trim();
  if (!text && opts.stdoutSafe) text = r.stdout.trim();
  for (const v of opts.redact ?? []) if (v) text = text.split(v).join("[redacted]");
  if (text.length > MAX_ERR) text = text.slice(0, MAX_ERR) + "…";
  return new Error(`${what} failed (exit ${r.code})${text ? `: ${text}` : ""}`);
}

/** JSON.parse whose error never quotes the input (V8 includes a fragment of the text in its message). */
export function parseJsonSafe<T>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`unparseable JSON from ${source}`);
  }
}
