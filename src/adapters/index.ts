import type { SinkAdapter, SinkKind } from "../types.js";
import { githubAdapter } from "./github.js";
import { localAdapter } from "./local.js";
import { railwayAdapter } from "./railway.js";

const registry: Partial<Record<SinkKind, SinkAdapter>> = {
  local: localAdapter,
  github: githubAdapter,
  railway: railwayAdapter,
};

export function adapterFor(kind: SinkKind): SinkAdapter {
  const a = registry[kind];
  if (!a) throw new Error(`sink "${kind}" is not supported yet (coming: vercel, fly, cloudflare, supabase)`);
  return a;
}

export const supportedSinks = Object.keys(registry) as SinkKind[];
