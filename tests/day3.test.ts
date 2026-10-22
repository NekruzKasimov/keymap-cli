import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudflareAdapter } from "../src/adapters/cloudflare.js";
import { supabaseAdapter } from "../src/adapters/supabase.js";
import { formatPlan, formatWalk, planIncident, tierOf, walkIncident } from "../src/commands/incident.js";
import { formatRotate, runRevoke, runRotate } from "../src/commands/rotate.js";
import { pathWithFallbacks } from "../src/exec.js";
import { fakeExec } from "./helpers.js";
import { digestOf } from "../src/state.js";
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
      { cmd: "supabase", args: ["secrets", "set"], result: {}, onCall: (args: string[]) => { seenFile = args[args.indexOf("--env-file") + 1]; } },
    ]);
    const ctx = { exec, cwd: "/x" };
    const ref = { kind: "supabase" as const, project: "abcdefghijklmnop" };
    expect(await supabaseAdapter.list(ref, ctx)).toEqual([{ name: "OPENAI_API_KEY", digest: `sb:${digestOf("d1")}` }]);
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
    const w = await walkIncident(manifest, state, items, async (i) => answers[i.secret], { exec, cwd: dir }, async () => {}, (r) => { seen.push(r.secret); });
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

  it("rotate --mint pushes the minted key, records hashes, and keeps the previous key live for `revoke`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, ".env"), "OPENROUTER_API_KEY=old\n");
    const log: Array<{ url: string; method: string; body?: string }> = [];
    const state: State = { version: 1, secrets: { OPENROUTER_API_KEY: { issuer_ref: "h-old", sinks: {} } } };
    const persisted: string[] = [];
    const r = await runRotate(manifest, state, { secret: "OPENROUTER_API_KEY", mint: true, limit: 10, limitReset: "daily", fetchFn: fakeFetch(log), env: { KEYMAP_OPENROUTER_MGMT_KEY: "mgmt" }, persist: async (s) => { persisted.push(JSON.stringify(s)); } }, { exec: fakeExec([]), cwd: dir });
    expect(r.ok).toBe(true);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENROUTER_API_KEY=sk-or-v1-minted\n");
    expect(state.secrets.OPENROUTER_API_KEY).toMatchObject({ issuer_ref: "h-new", previous_issuer_ref: "h-old" });
    expect(state.secrets.OPENROUTER_API_KEY.pending_issuer_refs).toEqual([]);
    expect(log.map((l) => l.method)).toEqual(["POST"]); // no DELETE: old key stays live until revoke
    expect(persisted[0]).toContain('"pending_issuer_refs":["h-new"]'); // recorded before any push
    expect(r.issuerNotes.join(" ")).toMatch(/\$10 per day/);
    expect(r.issuerNotes.join(" ")).toMatch(/keymap revoke OPENROUTER_API_KEY/);
    expect(JSON.stringify(r)).not.toContain("sk-or-v1-minted");
    expect(persisted.join("")).not.toContain("sk-or-v1-minted");
  });

  it("first mint (no recorded key) lists other live keys and tells the user to delete by hand", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, ".env"), "OPENROUTER_API_KEY=old\n");
    const log: Array<{ url: string; method: string; body?: string }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      log.push({ url, method: init.method });
      if (init.method === "POST") return { ok: true, status: 200, text: async () => JSON.stringify({ key: "sk-or-v1-minted", data: { hash: "h-new", name: "n" } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ hash: "h-new", name: "n" }, { hash: "h-manual", name: "laptop key" }] }) };
    };
    const state: State = { version: 1, secrets: {} };
    const r = await runRotate(manifest, state, { secret: "OPENROUTER_API_KEY", mint: true, fetchFn, env: { KEYMAP_OPENROUTER_MGMT_KEY: "mgmt" } }, { exec: fakeExec([]), cwd: dir });
    expect(r.ok).toBe(true);
    expect(log.map((l) => l.method)).toEqual(["POST", "GET"]);
    expect(r.issuerNotes.join(" ")).toMatch(/not created by keymap/);
    expect(r.issuerNotes.join(" ")).toMatch(/laptop key \(h-manual\)/);
    expect(r.issuerNotes.join(" ")).toMatch(/NO credit limit/);
  });

  it("a push failure after mint keeps the minted key live and pending; the next success deletes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, ".env"), "OPENROUTER_API_KEY=old\n");
    const m2: Manifest = { ...manifest, secrets: { OPENROUTER_API_KEY: { issuer: "openrouter", sinks: [{ kind: "cloudflare", worker: "w" }, { kind: "github", repo: "o/r" }, { kind: "local" }] } } };
    const log: Array<{ url: string; method: string; body?: string }> = [];
    let n = 0;
    const fetchFn: FetchLike = async (url, init) => {
      log.push({ url, method: init.method });
      if (init.method === "POST") { n++; return { ok: true, status: 200, text: async () => JSON.stringify({ key: `sk-or-v1-m${n}`, data: { hash: `h-${n}`, name: "n" } }) }; }
      if (init.method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const exec = fakeExec([{ cmd: "wrangler", result: {} }, { cmd: "gh", result: { code: 1, stderr: "HTTP 403 with sk-or-v1-m1 inside" } }]);
    const state: State = { version: 1, secrets: {} };
    const env = { KEYMAP_OPENROUTER_MGMT_KEY: "mgmt" };
    const r = await runRotate(m2, state, { secret: "OPENROUTER_API_KEY", mint: true, fetchFn, env }, { exec, cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.outcomes.map((o) => `${o.id}:${o.status}`)).toEqual(["cloudflare:w:pushed", "github:o/r:failed", "local:.env:skipped"]);
    expect(log.map((l) => l.method)).toEqual(["POST"]); // no DELETE: cloudflare already serves h-1
    expect(state.secrets.OPENROUTER_API_KEY.pending_issuer_refs).toEqual(["h-1"]);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENROUTER_API_KEY=old\n");
    const text = formatRotate(r);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("sk-or-v1-m1");
    expect(text).toMatch(/h-1 stays live: cloudflare:w already hold it/);

    // second attempt succeeds everywhere: h-1 is now stale and gets deleted
    const exec2 = fakeExec([{ cmd: "wrangler", result: {} }, { cmd: "gh", result: {} }]);
    const r2 = await runRotate(m2, state, { secret: "OPENROUTER_API_KEY", mint: true, fetchFn, env }, { exec: exec2, cwd: dir });
    expect(r2.ok).toBe(true);
    expect(state.secrets.OPENROUTER_API_KEY).toMatchObject({ issuer_ref: "h-2", pending_issuer_refs: [] });
    expect(log.filter((l) => l.method === "DELETE").map((l) => l.url)).toEqual(["https://openrouter.ai/api/v1/keys/h-1"]);
    expect(r2.issuerNotes.join(" ")).toMatch(/deleted stale key h-1/);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENROUTER_API_KEY=sk-or-v1-m2\n");
  });

  it("refuses a second --mint while the previous key is unrevoked", async () => {
    const state: State = { version: 1, secrets: { OPENROUTER_API_KEY: { issuer_ref: "h-2", previous_issuer_ref: "h-1", sinks: {} } } };
    await expect(runRotate(manifest, state, { secret: "OPENROUTER_API_KEY", mint: true, env: { KEYMAP_OPENROUTER_MGMT_KEY: "m" } }, { exec: fakeExec([]), cwd: "/x" })).rejects.toThrow(/has not been revoked yet/);
  });

  it("revoke deletes the previous key only, never the current one", async () => {
    const log: Array<{ url: string; method: string }> = [];
    const fetchFn: FetchLike = async (url, init) => { log.push({ url, method: init.method }); return { ok: true, status: 200, text: async () => "{}" }; };
    const state: State = { version: 1, secrets: { OPENROUTER_API_KEY: { issuer_ref: "h-new", previous_issuer_ref: "h-old", sinks: {} } } };
    const r = await runRevoke(manifest, state, { secret: "OPENROUTER_API_KEY", fetchFn, env: { KEYMAP_OPENROUTER_MGMT_KEY: "mgmt" } });
    expect(r.deleted).toBe("h-old");
    expect(log).toEqual([{ url: "https://openrouter.ai/api/v1/keys/h-old", method: "DELETE" }]);
    expect(state.secrets.OPENROUTER_API_KEY.previous_issuer_ref).toBeUndefined();
    await expect(runRevoke(manifest, state, { secret: "OPENROUTER_API_KEY", hash: "h-new", fetchFn, env: { KEYMAP_OPENROUTER_MGMT_KEY: "mgmt" } })).rejects.toThrow(/CURRENT key/);
    await expect(runRevoke(manifest, state, { secret: "OPENROUTER_API_KEY", fetchFn, env: { KEYMAP_OPENROUTER_MGMT_KEY: "mgmt" } })).rejects.toThrow(/nothing to revoke/);
    const r2 = await runRevoke(manifest, state, { secret: "OPENAI_API_KEY" });
    expect(r2.deleted).toBeUndefined();
    expect(r2.checklist.join(" ")).toMatch(/platform.openai.com/);
  });

  it("refuses --mint without a management key or for other issuers", async () => {
    const ctx = { exec: fakeExec([]), cwd: "/x" };
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENROUTER_API_KEY", mint: true, env: {} }, ctx)).rejects.toThrow(/KEYMAP_OPENROUTER_MGMT_KEY/);
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENAI_API_KEY", mint: true, env: { KEYMAP_OPENROUTER_MGMT_KEY: "m" } }, ctx)).rejects.toThrow(/only available for issuer "openrouter"/);
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENROUTER_API_KEY", mint: true, value: "x" }, ctx)).rejects.toThrow(/exactly one/);
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENAI_API_KEY", value: "x", limit: 5 }, ctx)).rejects.toThrow(/only apply with --mint/);
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENROUTER_API_KEY", mint: true, limit: NaN, env: { KEYMAP_OPENROUTER_MGMT_KEY: "m" } }, ctx)).rejects.toThrow(/positive number/);
  });
});
