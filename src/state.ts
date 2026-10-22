import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { State } from "./types.js";

/** State lives outside the repo so it never ends up committed, keyed by project name. */
export function statePath(project: string, root = join(homedir(), ".keymap")): string {
  const safe = project.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(root, `${safe}.state.json`);
}

export async function loadState(path: string): Promise<State> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as State;
    if (raw.version !== 1) return { version: 1, secrets: {} };
    return raw;
  } catch {
    return { version: 1, secrets: {} };
  }
}

export async function saveState(path: string, state: State): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** 8-hex-char prefix of sha256. Enough to detect drift between sinks; useless for recovering the value. */
export function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}
