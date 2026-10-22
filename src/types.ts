export type Issuer =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "google"
  | "stripe"
  | "supabase"
  | "cloudflare"
  | "custom";

export type SinkKind =
  | "local"
  | "github"
  | "railway"
  | "vercel"
  | "fly"
  | "cloudflare"
  | "supabase";

/** One place a secret lives. Shape depends on `kind`; extra fields are adapter-specific. */
export interface SinkRef {
  kind: SinkKind;
  [key: string]: string | string[] | undefined;
}

export interface SecretSpec {
  issuer: Issuer;
  /** e.g. "30d", "12w", "6m". Optional: no rotation deadline. */
  rotate_every?: string;
  sinks: SinkRef[];
}

export interface Manifest {
  version: 1;
  project: string;
  /** Names to leave out of "unmapped" reports; a trailing * matches a prefix. */
  ignore?: string[];
  secrets: Record<string, SecretSpec>;
}

/** What an adapter can tell us about one secret at one sink, without ever returning the value. */
export interface SinkEntry {
  name: string;
  /** Provider-supplied digest or our own sha256 prefix, when the sink lets us compute one. */
  digest?: string;
}

export interface SinkState {
  last_pushed?: string;
  digest?: string;
}

export interface SecretState {
  last_rotated?: string;
  last_verified?: string;
  sinks: Record<string, SinkState>;
}

export interface State {
  version: 1;
  secrets: Record<string, SecretState>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { stdin?: string; cwd?: string }
) => Promise<ExecResult>;

export interface AdapterContext {
  exec: Exec;
  cwd: string;
}

export interface SinkAdapter {
  kind: SinkKind;
  /** Human-readable id for this sink ref, e.g. "railway:api/production". */
  id(ref: SinkRef): string;
  /** Names (and digests when available) of every secret at this sink. Values never leave the adapter. */
  list(ref: SinkRef, ctx: AdapterContext): Promise<SinkEntry[]>;
  /** Push a new value. Returns a digest when the sink lets us verify. */
  set(ref: SinkRef, name: string, value: string, ctx: AdapterContext): Promise<SinkEntry>;
  /** Whether `list` returns a digest that can be compared across sinks. */
  verifiable: boolean;
}
