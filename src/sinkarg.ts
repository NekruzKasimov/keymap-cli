import { supportedSinks } from "./adapters/index.js";
import type { SinkKind, SinkRef } from "./types.js";

/** "railway:api/production" | "github:owner/repo" | "local:.env" -> SinkRef */
export function parseSinkArg(arg: string): SinkRef {
  const [kind, rest = ""] = arg.split(":", 2) as [SinkKind, string?];
  if (!supportedSinks.includes(kind)) throw new Error(`unsupported sink "${kind}"; supported: ${supportedSinks.join(", ")}`);
  switch (kind) {
    case "local": return { kind, file: rest || ".env" };
    case "github": { const [repo, env] = rest.split("/").length > 2 ? [rest.split("/").slice(0, 2).join("/"), rest.split("/")[2]] : [rest, undefined]; return { kind, ...(repo ? { repo } : {}), ...(env ? { env } : {}) }; }
    case "railway": { const [service, environment] = rest.split("/"); return { kind, ...(service ? { service } : {}), ...(environment ? { environment } : {}) }; }
    case "fly": return { kind, ...(rest ? { app: rest } : {}) };
    case "vercel": { const [project, t] = rest.split("/"); return { kind, ...(project ? { project } : {}), ...(t ? { targets: t.split("+") } : {}) }; }
    default: return { kind };
  }
}

