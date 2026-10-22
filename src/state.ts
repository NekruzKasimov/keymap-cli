import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { State } from "./types.js";

/** Where keymap keeps per-machine state. Override with KEYMAP_HOME (tests use a temp dir). */
export function keymapHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KEYMAP_HOME || join(homedir(), ".keymap");
}

function ensureHome(root: string): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    /* best effort on filesystems without modes */
  }
}

/**
 * Per-machine random salt for digests. Digests are HMAC-SHA256(salt, value) truncated to 8 hex chars:
 * enough to compare sinks for drift, useless for offline guessing without this file.
 */
let saltCache: Buffer | undefined;
export function digestSalt(root = keymapHome()): Buffer {
  if (saltCache) return saltCache;
  ensureHome(root);
  const p = join(root, ".salt");
  try {
    saltCache = Buffer.from(readFileSync(p, "utf8").trim(), "hex");
    if (saltCache.length !== 32) throw new Error("bad salt");
  } catch {
    saltCache = randomBytes(32);
    writeFileSync(p, saltCache.toString("hex") + "\n", { mode: 0o600 });
  }
  return saltCache;
}

/** For tests: forget the cached salt so KEYMAP_HOME changes take effect. */
export function resetSaltCache(): void {
  saltCache = undefined;
}

export function digestOf(value: string): string {
  return createHmac("sha256", digestSalt()).update(value, "utf8").digest("hex").slice(0, 8);
}

/**
 * State lives outside the repo so it never ends up committed. It is keyed by project name AND the
 * repo's absolute path, so two checkouts (or a manifest that copies another project's name) never
 * share issuer handles.
 */
export function statePath(project: string, cwd = process.cwd(), root = keymapHome()): string {
  const safe = project.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60);
  const loc = createHash("sha256").update(cwd).digest("hex").slice(0, 10);
  return join(root, `${safe}-${loc}.state.json`);
}

export class StateError extends Error {}

/** Missing file => empty state. A corrupt file is an error, never silently replaced (it holds issuer handles). */
export async function loadState(path: string): Promise<State> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, secrets: {} };
    throw e;
  }
  let raw: State;
  try {
    raw = JSON.parse(text) as State;
  } catch {
    throw new StateError(`${path} is not valid JSON; fix or move it aside before continuing (it records which issuer keys keymap created)`);
  }
  if (raw.version !== 1 || typeof raw.secrets !== "object") throw new StateError(`${path} has an unknown format`);
  return raw;
}

/** Atomic write: temp file in the same directory, mode 600, then rename over the old file. */
export async function saveState(path: string, state: State): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
