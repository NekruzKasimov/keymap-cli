import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { digestOf } from "../state.js";
import type { AdapterContext, SinkAdapter, SinkEntry, SinkRef } from "../types.js";

/** Minimal dotenv parser: KEY=value, optional quotes, # comments. Later duplicates win, like dotenv. */
export function parseDotenv(text: string): Array<{ name: string; value: string }> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    map.set(m[1], value);
  }
  return [...map].map(([name, value]) => ({ name, value }));
}

/**
 * Render a value so every common dotenv reader (dotenv, godotenv, python-dotenv) gets it back byte-for-byte.
 * Single quotes are literal everywhere, so they are used whenever the value has no single quote. A value with a
 * single quote must go in double quotes, where readers disagree about backslashes, `$` and `"`; such values are
 * refused rather than stored wrong.
 */
export function renderDotenvValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("values with newlines cannot be stored in dotenv format");
  if (value !== "" && !/[\s#"'$\\`]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (/["$\\`]/.test(value)) throw new Error("value mixes a single quote with \" $ \\ or `, which dotenv readers parse differently; choose a value without that mix");
  return `"${value}"`;
}

/** Replace every line that sets `name`, keeping all other lines byte-for-byte; append when absent. */
export function upsertDotenv(text: string, name: string, value: string): string {
  const rendered = renderDotenvValue(value);
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^(export\\s+)?${name}\\s*=`);
  let replaced = false;
  const out = lines.map((l) => {
    if (re.test(l.trim())) {
      replaced = true;
      const prefix = /^\s*export\s+/.test(l) ? "export " : "";
      return `${prefix}${name}=${rendered}`;
    }
    return l;
  });
  if (!replaced) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.splice(out.length - 1, 0, `${name}=${rendered}`);
  }
  return out.join("\n");
}

/**
 * Resolve the sink's file and refuse anything outside cwd, any symlink, and (when inside a git repo)
 * any file git would commit. The manifest is shared, so a sink path must never be able to point a
 * rotated value at a tracked or served file.
 */
export async function resolveLocalFile(ref: SinkRef, ctx: AdapterContext, forWrite: boolean): Promise<string> {
  const rel = (ref.file as string) ?? ".env";
  const file = resolve(ctx.cwd, rel);
  const inside = relative(ctx.cwd, file);
  if (inside.startsWith("..") || inside.includes(`..${sep}`) || resolve(ctx.cwd, inside) !== file) throw new Error(`local sink ${rel} is outside the project directory`);
  // Resolve symlinks in every parent component: a committed `config -> ../elsewhere` must not redirect the write.
  const realRoot = await realpath(ctx.cwd);
  const realDir = await realpath(dirname(file)).catch(() => undefined);
  if (realDir === undefined) throw new Error(`local sink ${rel}: directory does not exist`);
  const dirInside = relative(realRoot, realDir);
  if (dirInside.startsWith("..") || resolve(realRoot, dirInside) !== realDir) throw new Error(`local sink ${rel} resolves outside the project directory (symlinked parent)`);
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink()) throw new Error(`local sink ${rel} is a symlink; refusing`);
    if (!st.isFile()) throw new Error(`local sink ${rel} is not a regular file`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (forWrite && !process.env.KEYMAP_ALLOW_TRACKED_ENV) {
    const g = await ctx.exec("git", ["check-ignore", "-q", "--", inside], { cwd: ctx.cwd });
    // 0 = ignored (good). 1 = would be committed. 127 = no git. 128 = not a repo, OR git refused the path.
    if (g.code === 1) throw new Error(`${rel} is not git-ignored; a rotated secret written there could be committed. Add it to .gitignore (or set KEYMAP_ALLOW_TRACKED_ENV=1 to override)`);
    if (g.code === 128) {
      const inRepo = await ctx.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd });
      if (inRepo.code === 0) throw new Error(`git refused to check ${rel} (${g.stderr.trim().slice(0, 120) || "exit 128"}); refusing to write`);
    }
  }
  return file;
}

export const localAdapter: SinkAdapter = {
  kind: "local",
  tokens: [],
  verifiable: true,
  id: (ref) => `local:${(ref.file as string) ?? ".env"}`,
  async list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]> {
    const file = await resolveLocalFile(ref, ctx, false);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    return parseDotenv(text).map(({ name, value }) => ({ name, digest: digestOf(value) }));
  },
  async set(ref, name, value, ctx) {
    renderDotenvValue(value); // validate before touching anything
    const file = await resolveLocalFile(ref, ctx, true);
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch {
      /* new file */
    }
    // Atomic replace: temp file beside the target, mode 600, rename over. A crash mid-write cannot lose other keys.
    const dir = await mkdtemp(resolve(dirname(file), ".keymap-"));
    const tmp = resolve(dir, "env");
    try {
      await writeFile(tmp, upsertDotenv(text, name, value), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return { name, digest: digestOf(value) };
  },
};
