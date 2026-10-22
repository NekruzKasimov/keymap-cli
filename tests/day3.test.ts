import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudflareAdapter } from "../src/adapters/cloudflare.js";
import { supabaseAdapter } from "../src/adapters/supabase.js";
import { formatPlan, formatWalk, planIncident, tierOf, walkIncident } from "../src/commands/incident.js";
import { runRotate } from "../src/commands/rotate.js";
import { fakeExec, pathWithFallbacks } from "../src/exec.js";
import { createKey, deleteKey, type FetchLike } from "../src/openrouter.js";
import { parseSinkArg } from "../src/sinkarg.js";
import type { Manifest, State } from "../src/types.js";

describe("cloudflare adapter", () => {
  it("lists names from json (after banner) and puts via stdin", async () => {
    const exec = fakeExec([
      { cmd: "wrangler", args: ["secret", "list"], result: { stdout: ' ⛅️ wrangler 4.151.3\n[{"name":"OPENAI_API_KEY","type":"secret_text"}]\n' } },
      { cmd: "wrangler", args: ["secret", "put"], result: {} },
    ]);
    const ctx = { exec, cwd: "/x" };
    const ref = { kind: "cloudflare" as const, worker: "ff-edge", env: "production" };
    expect(cloudflareAdapter.id(ref)).toBe("cloudflare:ff-edge/production");
    expect(await cloudflareAdapter.list(ref, ctx)).toEqual([{ name: "OPENAI_API_KEY" }]);
    expect(exec.calls[0].args).toEqual(["secret", "list", "--format", "json", "--name", "ff-edge", "--env", "production"]);
    await cloudflareAdapter.set(ref, "OPENAI_API_KEY", "sk-2", ctx);
    expect(exec.calls[1].args).toEqual(["secret", "put", "OPENAI_API_KEY", "--name", "ff-edge", "--env", "production"]);
    expect(exec.calls[1].stdin).toBe("sk-2");
  });
});

describe("supabase adapter", () => {
  it("lists with sb digests and sets via a temp env file that is removed afterwards", async () => {
    let seenFile = "";
    const exec = fakeExec([
      { cmd: "supabase", args: ["secrets", "list"], result: { stdout: JSON.stringify([{ name: "OPENAI_API_KEY", digest: "d1" }]) } },
      { cmd: "supabase", args: ["secrets", "set"], result: {}, onCall: (args) => { seenFile = args[args.indexOf("--env-file") + 1]; } },
    ]);
    const ctx = { exec, cwd: "/x" };
    const ref = { kind: "supabase" as const, project: "abcdefghijklmnop" };
    expect(await supabaseAdapter.list(ref, ctx)).toEqual([{ name: "OPENAI_API_KEY", digest: "sb:d1" }]);
    expect(exec.calls[0].args).toEqual(["secrets", "list", "-o", "json", "--project-ref", "abcdefghijklmnop"]);
    await supabaseAdapter.set(ref, "OPENAI_API_KEY", "sk-2", ctx);
    expect(exec.calls[1].args).toEqual(["secrets", "set", "--env-file", seenFile, "--project-ref", "abcdefghijklmnop"]);
    expect(exec.calls[1].args.join(" ")).not.toContain("sk-2");
    await expect(readFile(seenFile, "utf8")).rejects.toThrow();
  });
});

describe("sink shorthands and PATH fallback", () => {
  it("parses cloudflare and supabase", () => {
    expect(parseSinkArg("cloudflare:ff-edge/production")).toEqual({ kind: "cloudflare", worker: "ff-edge", env: "production" });
    expect(parseSinkArg("supabase:abcdefghijklmnop")).toEqual({ kind: "supabase", project: "abcdefghijklmnop" });
  });
  it("appends only existing extra bin dirs", () => {
    const p = pathWithFallbacks({ PATH: "/usr/bin" });
    expect(p.startsWith("/usr/bin")).toBe(true);
    expect(p.split(":").every((d) => d.length > 0)).toBe(true);
  });
});

const manifest: Manifest = {
  version: 1,
  project: "demo",
  secrets: {
    DATABASE_URL: { issuer: "custom", sinks: [{ kind: "railway", service: "api" }, { kind: "local" }] },
    OPENAI_API_KEY: { issuer: "openai", sinks: [{ kind: "railway", service: "api" }, { kind: "local" }] },
    NPM_TOKEN: { issuer: "custom", sinks: [{ kind: "railway", service: "worker" }] },
    GH_PAT: { issuer: "custom", sinks: [{ kind: "github" }] },
    STRIPE_SECRET_KEY: { issuer: "stripe", sinks: [{ kind: "railway", service: "api" }, { kind: "vercel", project: "web" }] },
    OPENROUTER_API_KEY: { issuer: "openrouter", sinks: [{ kind: "local" }] },
  },
};

describe("incident", () => {
  it("tiers by blast radius", () => {
    expect(tierOf("OPENAI_API_KEY", "openai")).toBe(0);
    expect(tierOf("GROQ_KEY", "custom")).toBe(0);
    expect(tierOf("STRIPE_SECRET_KEY", "stripe")).toBe(1);
    expect(tierOf("AWS_SECRET_ACCESS_KEY", "custom")).toBe(1);
    expect(tierOf("DATABASE_URL", "custom")).toBe(2);
    expect(tierOf("GH_PAT", "custom")).toBe(3);
    expect(tierOf("NPM_TOKEN", "custom")).toBe(4);
    expect(tierOf("SESSION_SECRET", "custom")).toBe(5);
  });

  it("plans only secrets on the breached host, ordered, with --only filter", () => {
    const all = planIncident(manifest, "railway");
    expect(all.map((i) => i.secret)).toEqual(["OPENAI_API_KEY", "STRIPE_SECRET_KEY", "DATABASE_URL", "NPM_TOKEN"]);
    expect(all[1].exposedAt).toEqual(["railway:api"]);
    expect(all[1].allSinks).toEqual(["railway:api", "vercel:web/production"]);
    const only = planIncident(manifest, "railway", (ref) => ref.service === "worker");
    expect(only.map((i) => i.secret)).toEqual(["NPM_TOKEN"]);
    expect(formatPlan("railway", all)).toContain("[0] AI provider keys");
    expect(formatPlan("fly", planIncident(manifest, "fly"))).toContain("Nothing to rotate");
  });

  it("walks: skip on empty, stop on null, rotates the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, ".env"), "OPENAI_API_KEY=old\nDATABASE_URL=old\n");
    const exec = fakeExec([{ cmd: "railway", args: ["variable", "set"], result: { stdout: "{}" } }, { cmd: "vercel", result: {} }]);
    const state: State = { version: 1, secrets: {} };
    const items = planIncident(manifest, "railway");
    const answers: Record<string, string | undefined | null> = { OPENAI_API_KEY: "sk-new", STRIPE_SECRET_KEY: undefined, DATABASE_URL: "pg-new", NPM_TOKEN: null };
    const seen: string[] = [];
    const w = await walkIncident(manifest, state, items, async (i) => answers[i.secret], { exec, cwd: dir }, (r) => { seen.push(r.secret); });
    expect(w).toEqual({ rotated: ["OPENAI_API_KEY", "DATABASE_URL"], skipped: ["STRIPE_SECRET_KEY"], failed: [], stoppedEarly: true });
    expect(seen).toEqual(["OPENAI_API_KEY", "DATABASE_URL"]);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENAI_API_KEY=sk-new\nDATABASE_URL=pg-new\n");
    expect(formatWalk(w, items)).toContain("Still exposed: STRIPE_SECRET_KEY, NPM_TOKEN");
  });
});

describe("openrouter mint", () => {
  function fakeFetch(log: Array<{ url: string; method: string; body?: string }>): FetchLike {
    return async (url, init) => {
      log.push({ url, method: init.method, body: init.body });
      if (init.method === "POST") return { ok: true, status: 200, text: async () => JSON.stringify({ key: "sk-or-v1-minted", data: { hash: "h-new", name: "demo/OPENROUTER_API_KEY" } }) };
      if (init.method === "DELETE") return { ok: true, status: 200, text: async () => "{}" };
      return { ok: false, status: 500, text: async () => "boom" };
    };
  }

  it("createKey / deleteKey talk to the management API with the bearer key", async () => {
    const log: Array<{ url: string; method: string; body?: string }> = [];
    const k = await createKey("mgmt", { name: "n", limit: 20, limitReset: "monthly" }, fakeFetch(log));
    expect(k).toEqual({ key: "sk-or-v1-minted", hash: "h-new", name: "demo/OPENROUTER_API_KEY" });
    expect(JSON.parse(log[0].body as string)).toEqual({ name: "n", limit: 20, limit_reset: "monthly" });
    await deleteKey("mgmt", "h-old", fakeFetch(log));
    expect(log[1]).toMatchObject({ url: "https://openrouter.ai/api/v1/keys/h-old", method: "DELETE" });
  });

  it("rotate --mint pushes the minted key, records the hash, deletes the previous one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, ".env"), "OPENROUTER_API_KEY=old\n");
    const log: Array<{ url: string; method: string; body?: string }> = [];
    const state: State = { version: 1, secrets: { OPENROUTER_API_KEY: { issuer_ref: "h-old", sinks: {} } } };
    const r = await runRotate(manifest, state, { secret: "OPENROUTER_API_KEY", mint: true, limit: 10, limitReset: "daily", fetchFn: fakeFetch(log), env: { KEYMAP_OPENROUTER_MGMT_KEY: "mgmt" } }, { exec: fakeExec([]), cwd: dir });
    expect(r.ok).toBe(true);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENROUTER_API_KEY=sk-or-v1-minted\n");
    expect(state.secrets.OPENROUTER_API_KEY.issuer_ref).toBe("h-new");
    expect(log.map((l) => l.method)).toEqual(["POST", "DELETE"]);
    expect(r.issuerNotes.join(" ")).toMatch(/minted .* \$10 per day/);
    expect(r.issuerNotes.join(" ")).toMatch(/deleted the previous/);
    expect(r.checklist).toEqual([]);
  });

  it("refuses --mint without a management key or for other issuers", async () => {
    const ctx = { exec: fakeExec([]), cwd: "/x" };
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENROUTER_API_KEY", mint: true, env: {} }, ctx)).rejects.toThrow(/KEYMAP_OPENROUTER_MGMT_KEY/);
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENAI_API_KEY", mint: true, env: { KEYMAP_OPENROUTER_MGMT_KEY: "m" } }, ctx)).rejects.toThrow(/only available for issuer "openrouter"/);
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENROUTER_API_KEY", mint: true, value: "x" }, ctx)).rejects.toThrow(/exactly one/);
  });
});
