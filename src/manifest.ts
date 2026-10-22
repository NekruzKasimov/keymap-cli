import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import type { Manifest, SecretSpec, SinkRef } from "./types.js";

export const MANIFEST_FILE = "keymap.yaml";

const ISSUERS = new Set(["openai", "anthropic", "openrouter", "google", "stripe", "supabase", "cloudflare", "custom"]);
const SINKS = new Set(["local", "github", "railway", "vercel", "fly", "cloudflare", "supabase"]);

export class ManifestError extends Error {}

/** Names that are config, not secrets. `init` skips them and `audit` does not report them as unmapped. */
export const NOISE = /^(NODE_ENV|PORT|HOST|HOSTNAME|PATH|HOME|TZ|LANG|LC_|CI|DEBUG|LOG_LEVEL|NEXT_PUBLIC_|VITE_|PUBLIC_|RAILWAY_|VERCEL_)/;

/** True when a name should be ignored: built-in noise, or matched by a manifest `ignore` glob (prefix* or exact). */
export function isIgnored(name: string, ignore: string[] = []): boolean {
  if (NOISE.test(name)) return true;
  return ignore.some((g) => (g.endsWith("*") ? name.startsWith(g.slice(0, -1)) : name === g));
}

/** Compact sink syntax in YAML: `- railway: {service: api}` -> {kind: "railway", service: "api"}. */
function normaliseSink(raw: unknown, path: string): SinkRef {
  if (typeof raw === "string") {
    if (!SINKS.has(raw)) throw new ManifestError(`${path}: unknown sink kind "${raw}"`);
    return { kind: raw as SinkRef["kind"] };
  }
  if (!raw || typeof raw !== "object") throw new ManifestError(`${path}: sink must be a string or mapping`);
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind === "string") {
    if (!SINKS.has(obj.kind)) throw new ManifestError(`${path}: unknown sink kind "${obj.kind}"`);
    return obj as SinkRef;
  }
  const keys = Object.keys(obj);
  if (keys.length !== 1) throw new ManifestError(`${path}: sink mapping must have exactly one key (the sink kind)`);
  const kind = keys[0];
  if (!SINKS.has(kind)) throw new ManifestError(`${path}: unknown sink kind "${kind}"`);
  const inner = obj[kind];
  const fields = inner && typeof inner === "object" ? (inner as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== "string" && !(Array.isArray(v) && v.every((x) => typeof x === "string")))
      throw new ManifestError(`${path}.${k}: must be a string or list of strings`);
  }
  return { kind: kind as SinkRef["kind"], ...(fields as Record<string, string | string[]>) };
}

export function validateManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== "object") throw new ManifestError("manifest must be a mapping");
  const m = raw as Record<string, unknown>;
  if (m.version !== 1) throw new ManifestError(`unsupported manifest version ${String(m.version)}; expected 1`);
  if (typeof m.project !== "string" || !m.project) throw new ManifestError("project: required string");
  const secretsRaw = m.secrets;
  if (!secretsRaw || typeof secretsRaw !== "object") throw new ManifestError("secrets: required mapping");
  let ignore: string[] = [];
  if (m.ignore !== undefined) {
    if (!Array.isArray(m.ignore) || !m.ignore.every((x) => typeof x === "string")) throw new ManifestError("ignore: must be a list of names (suffix * allowed)");
    ignore = m.ignore as string[];
  }
  const secrets: Record<string, SecretSpec> = {};
  for (const [name, specRaw] of Object.entries(secretsRaw as Record<string, unknown>)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new ManifestError(`secrets.${name}: name must be UPPER_SNAKE_CASE`);
    if (!specRaw || typeof specRaw !== "object") throw new ManifestError(`secrets.${name}: must be a mapping`);
    const s = specRaw as Record<string, unknown>;
    const issuer = (s.issuer ?? "custom") as string;
    if (!ISSUERS.has(issuer)) throw new ManifestError(`secrets.${name}.issuer: unknown issuer "${issuer}"`);
    if (s.rotate_every !== undefined && (typeof s.rotate_every !== "string" || !/^\d+[dwm]$/.test(s.rotate_every)))
      throw new ManifestError(`secrets.${name}.rotate_every: expected like "30d", "6w" or "3m"`);
    if (!Array.isArray(s.sinks) || s.sinks.length === 0)
      throw new ManifestError(`secrets.${name}.sinks: required non-empty list`);
    const sinks = s.sinks.map((x, i) => normaliseSink(x, `secrets.${name}.sinks[${i}]`));
    secrets[name] = { issuer: issuer as SecretSpec["issuer"], rotate_every: s.rotate_every as string | undefined, sinks };
  }
  return { version: 1, project: m.project, ...(ignore.length ? { ignore } : {}), secrets };
}

export async function loadManifest(path = MANIFEST_FILE): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ManifestError(`no ${path} found; run \`keymap init\` first`);
  }
  return validateManifest(parse(text));
}

/** Serialise back to the compact YAML form. */
export function manifestToYaml(m: Manifest): string {
  const out = {
    version: m.version,
    project: m.project,
    ...(m.ignore?.length ? { ignore: m.ignore } : {}),
    secrets: Object.fromEntries(
      Object.entries(m.secrets).map(([name, spec]) => [
        name,
        {
          issuer: spec.issuer,
          ...(spec.rotate_every ? { rotate_every: spec.rotate_every } : {}),
          sinks: spec.sinks.map(({ kind, ...rest }) => (Object.keys(rest).length ? { [kind]: rest } : kind)),
        },
      ])
    ),
  };
  return stringify(out, { lineWidth: 0 });
}

export async function saveManifest(m: Manifest, path = MANIFEST_FILE): Promise<void> {
  await writeFile(path, manifestToYaml(m), "utf8");
}

/** Parse "30d" / "6w" / "3m" into milliseconds. */
export function intervalMs(spec: string): number {
  const n = Number(spec.slice(0, -1));
  const unit = spec.slice(-1);
  const day = 86_400_000;
  return unit === "d" ? n * day : unit === "w" ? n * 7 * day : n * 30 * day;
}
