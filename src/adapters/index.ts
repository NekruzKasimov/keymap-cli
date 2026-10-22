import type { SinkAdapter, SinkKind } from "../types.js";
import { githubAdapter } from "./github.js";
import { localAdapter } from "./local.js";
import { flyAdapter } from "./fly.js";
import { railwayAdapter } from "./railway.js";
import { vercelAdapter } from "./vercel.js";

const registry: Partial<Record<SinkKind, SinkAdapter>> = {
  local: localAdapter,
  github: githubAdapter,
  railway: railwayAdapter,
  vercel: vercelAdapter,
  fly: flyAdapter,
};

export function adapterFor(kind: SinkKind): SinkAdapter {
  const a = registry[kind];
  if (!a) throw new Error(`sink "${kind}" is not supported yet (coming: cloudflare, supabase)`);
  return a;
}

export const supportedSinks = Object.keys(registry) as SinkKind[];
