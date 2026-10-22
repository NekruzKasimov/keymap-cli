import type { SinkAdapter, SinkKind } from "../types.js";
import { cloudflareAdapter } from "./cloudflare.js";
import { flyAdapter } from "./fly.js";
import { githubAdapter } from "./github.js";
import { localAdapter } from "./local.js";
import { railwayAdapter } from "./railway.js";
import { supabaseAdapter } from "./supabase.js";
import { vercelAdapter } from "./vercel.js";

const registry: Record<SinkKind, SinkAdapter> = {
  local: localAdapter,
  github: githubAdapter,
  railway: railwayAdapter,
  vercel: vercelAdapter,
  fly: flyAdapter,
  cloudflare: cloudflareAdapter,
  supabase: supabaseAdapter,
};

export function adapterFor(kind: SinkKind): SinkAdapter {
  const a = registry[kind];
  if (!a) throw new Error(`unknown sink "${kind}"`);
  return a;
}

export const supportedSinks = Object.keys(registry) as SinkKind[];
