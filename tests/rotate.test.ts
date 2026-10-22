import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRotate, orderSinks, runRotate } from "../src/commands/rotate.js";
import { fakeExec } from "./helpers.js";
import { generateSecret } from "../src/issuers.js";
import { digestOf } from "../src/state.js";
import type { Manifest, State } from "../src/types.js";

const manifest: Manifest = {
  version: 1,
  project: "demo",
  secrets: {
    OPENAI_API_KEY: { issuer: "openai", rotate_every: "30d", sinks: [{ kind: "local" }, { kind: "github", repo: "o/r" }, { kind: "railway", service: "api" }] },
    SESSION_SECRET: { issuer: "custom", sinks: [{ kind: "local" }] },
  },
};

async function ctxWithEnv(text = "OPENAI_API_KEY=old\n") {
  const dir = await mkdtemp(join(tmpdir(), "keymap-"));
  await writeFile(join(dir, ".env"), text);
  return dir;
}

describe("rotate", () => {
  it("orders staged hosts, then immediate hosts, then CI, then local", () => {
    expect(orderSinks(manifest.secrets.OPENAI_API_KEY.sinks).map((s) => s.kind)).toEqual(["railway", "github", "local"]);
    expect(orderSinks([{ kind: "local" }, { kind: "cloudflare" }, { kind: "github" }, { kind: "supabase" }, { kind: "fly" }, { kind: "vercel" }]).map((s) => s.kind)).toEqual(["fly", "vercel", "cloudflare", "supabase", "github", "local"]);
  });

  it("dry run touches nothing", async () => {
    const dir = await ctxWithEnv();
    const exec = fakeExec([]);
    const state: State = { version: 1, secrets: {} };
    const r = await runRotate(manifest, state, { secret: "OPENAI_API_KEY", dryRun: true }, { exec, cwd: dir });
    expect(r.outcomes.map((o) => o.status)).toEqual(["planned", "planned", "planned"]);
    expect(exec.calls).toHaveLength(0);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENAI_API_KEY=old\n");
    expect(state.secrets.OPENAI_API_KEY).toBeUndefined();
    expect(formatRotate(r)).toContain("dry run");
  });

  it("pushes everywhere, records state, prints issuer checklist and redeploy hint", async () => {
    const dir = await ctxWithEnv();
    const exec = fakeExec([
      { cmd: "railway", args: ["variable", "set"], result: { stdout: "{}" } },
      { cmd: "gh", args: ["secret", "set"], result: {} },
    ]);
    const state: State = { version: 1, secrets: {} };
    const r = await runRotate(manifest, state, { secret: "OPENAI_API_KEY", value: "sk-new" }, { exec, cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.outcomes.map((o) => o.id)).toEqual(["railway:api", "github:o/r", "local:.env"]);
    expect(r.outcomes.every((o) => o.status === "pushed")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("sk-new");
    expect(r.redeploy).toEqual(["railway:api"]);
    expect(r.checklist.join(" ")).toMatch(/platform.openai.com/);
    expect(state.secrets.OPENAI_API_KEY.last_rotated).toBeDefined();
    expect(state.secrets.OPENAI_API_KEY.sinks["local:.env"].digest).toBe(digestOf("sk-new"));
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENAI_API_KEY=sk-new\n");
    // value only ever travels on stdin
    for (const c of exec.calls) expect(c.args.join(" ")).not.toContain("sk-new");
    expect(formatRotate(r)).toContain("railway redeploy");
  });

  it("stops at the first failure, skips the rest, keeps local untouched, records nothing", async () => {
    const dir = await ctxWithEnv();
    const exec = fakeExec([
      { cmd: "railway", args: ["variable", "set"], result: { stdout: "{}" } },
      { cmd: "gh", args: ["secret", "set"], result: { code: 1, stderr: "HTTP 403" } },
    ]);
    const state: State = { version: 1, secrets: {} };
    const r = await runRotate(manifest, state, { secret: "OPENAI_API_KEY", value: "sk-new" }, { exec, cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.outcomes.map((o) => o.status)).toEqual(["pushed", "failed", "skipped"]);
    expect(r.stale).toEqual(["github:o/r", "local:.env"]);
    expect(r.checklist).toEqual([]);
    expect(state.secrets.OPENAI_API_KEY).toBeUndefined();
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENAI_API_KEY=old\n");
    const out = formatRotate(r);
    expect(out).toContain("Do NOT revoke");
    expect(out).toContain("github:o/r, local:.env");
  });

  it("generates only for custom issuers", async () => {
    const dir = await ctxWithEnv("SESSION_SECRET=a\n");
    const ctx = { exec: fakeExec([]), cwd: dir };
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENAI_API_KEY", generate: true }, ctx)).rejects.toThrow(/custom/);
    const r = await runRotate(manifest, { version: 1, secrets: {} }, { secret: "SESSION_SECRET", generate: true }, ctx);
    expect(r.ok).toBe(true);
    const env = await readFile(join(dir, ".env"), "utf8");
    expect(env).toMatch(/^SESSION_SECRET=[A-Za-z0-9_-]{43}\n$/);
    expect(generateSecret()).toHaveLength(43);
  });

  it("rejects missing or empty values", async () => {
    const ctx = { exec: fakeExec([]), cwd: "/x" };
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENAI_API_KEY" }, ctx)).rejects.toThrow(/no new value/);
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "constructor", value: "x" }, ctx)).rejects.toThrow(/not in keymap/);
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "OPENAI_API_KEY", value: " " }, ctx)).rejects.toThrow(/empty/);
    await expect(runRotate(manifest, { version: 1, secrets: {} }, { secret: "NOPE", value: "x" }, ctx)).rejects.toThrow(/not in keymap/);
  });
});
