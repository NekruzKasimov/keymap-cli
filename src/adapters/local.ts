import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digestOf } from "../state.js";
import type { AdapterContext, SinkAdapter, SinkEntry, SinkRef } from "../types.js";

/** Minimal dotenv parser: KEY=value, optional quotes, # comments. Returns entries in file order. */
export function parseDotenv(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out.push({ name: m[1], value });
  }
  return out;
}

/** Replace or append one key, keeping every other line byte-for-byte. */
export function upsertDotenv(text: string, name: string, value: string): string {
  const needsQuote = /[\s#"'$]/.test(value) || value === "";
  const rendered = needsQuote ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^(export\\s+)?${name}\\s*=`);
  let replaced = false;
  const out = lines.map((l) => {
    if (!replaced && re.test(l.trim())) {
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

export const localAdapter: SinkAdapter = {
  kind: "local",
  verifiable: true,
  id: (ref) => `local:${(ref.file as string) ?? ".env"}`,
  async list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]> {
    const file = resolve(ctx.cwd, (ref.file as string) ?? ".env");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    return parseDotenv(text).map(({ name, value }) => ({ name, digest: digestOf(value) }));
  },
  async set(ref, name, value, ctx) {
    const file = resolve(ctx.cwd, (ref.file as string) ?? ".env");
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch {
      /* new file */
    }
    await writeFile(file, upsertDotenv(text, name, value), { mode: 0o600 });
    return { name, digest: digestOf(value) };
  },
};
