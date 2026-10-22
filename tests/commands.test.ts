import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatAudit, runAudit } from "../src/commands/audit.js";
import { buildManifest, guessIssuer } from "../src/commands/init.js";
import { fakeExec } from "./helpers.js";
import { digestOf } from "../src/state.js";
import type { Manifest, State } from "../src/types.js";

const DAY = 86_400_000;

describe("init", () => {
  it("guesses issuers", () => {
    expect(guessIssuer("OPENAI_API_KEY")).toBe("openai");
    expect(guessIssuer("OPENROUTER_KEY")).toBe("openrouter");
    expect(guessIssuer("ANTHROPIC_API_KEY")).toBe("anthropic");
    expect(guessIssuer("CF_API_TOKEN")).toBe("cloudflare");
    expect(guessIssuer("DATABASE_URL")).toBe("custom");
  });

  it("merges names across sinks and skips noise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, ".env"), "OPENAI_API_KEY=a\nPORT=3000\nNEXT_PUBLIC_X=1\nDATABASE_URL=p\n");
    const exec = fakeExec([
      { cmd: "railway", args: ["variable", "list"], result: { stdout: JSON.stringify({ OPENAI_API_KEY: "a", STRIPE_KEY: "s", RAILWAY_X: "y" }) } },
      { cmd: "gh", args: ["secret", "list"], result: { code: 1, stderr: "gh: not logged in" } },
    ]);
    const r = await buildManifest(
      { project: "demo", sinks: [{ kind: "local" }, { kind: "railway", service: "api" }, { kind: "github" }] },
      { exec, cwd: dir }
    );
    expect(Object.keys(r.manifest.secrets)).toEqual(["DATABASE_URL", "OPENAI_API_KEY", "STRIPE_KEY"]);
    expect(r.manifest.secrets.OPENAI_API_KEY.sinks).toEqual([{ kind: "local" }, { kind: "railway", service: "api" }]);
    expect(r.manifest.secrets.STRIPE_KEY.issuer).toBe("stripe");
    expect(r.perSink[2].error).toMatch(/not logged in/);
  });
});

describe("audit", () => {
  const manifest: Manifest = {
    version: 1,
    project: "demo",
    ignore: ["FEATURE_FLAG_*"],
    secrets: {
      OPENAI_API_KEY: { issuer: "openai", rotate_every: "30d", sinks: [{ kind: "local" }, { kind: "railway", service: "api" }, { kind: "github" }] },
      DATABASE_URL: { issuer: "custom", sinks: [{ kind: "railway", service: "api" }] },
    },
  };

  async function setup(envText: string, railwayVars: Record<string, string | null>) {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, ".env"), envText);
    const exec = fakeExec([
      { cmd: "railway", args: ["variable", "list"], result: { stdout: JSON.stringify(railwayVars) } },
      { cmd: "gh", args: ["secret", "list"], result: { stdout: JSON.stringify([{ name: "OPENAI_API_KEY" }]) } },
    ]);
    return { exec, cwd: dir };
  }

  it("passes a clean setup, flags unknown age only", async () => {
    const ctx = await setup("OPENAI_API_KEY=k\n", { OPENAI_API_KEY: "k", DATABASE_URL: "pg" });
    const state: State = { version: 1, secrets: {} };
    const r = await runAudit(manifest, state, ctx);
    expect(r.findings).toEqual([{ kind: "never-rotated", secret: "OPENAI_API_KEY" }]);
    expect(r.failed).toBe(false);
    expect(formatAudit(r)).toContain("UNKNOWN AGE OPENAI_API_KEY");
  });

  it("detects drift, missing, overdue and unmapped", async () => {
    const ctx = await setup("OPENAI_API_KEY=local-value\nPORT=1\n", { OPENAI_API_KEY: "railway-value", EXTRA: "e", FEATURE_FLAG_X: "1" });
    const now = Date.now();
    const state: State = { version: 1, secrets: { OPENAI_API_KEY: { last_rotated: new Date(now - 45 * DAY).toISOString(), sinks: {} } } };
    const r = await runAudit(manifest, state, ctx, now);
    const kinds = r.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(["drift", "missing", "overdue", "unknown"]);
    expect(r.findings).toContainEqual({ kind: "missing", secret: "DATABASE_URL", sink: "railway:api" });
    expect(r.findings).toContainEqual({ kind: "overdue", secret: "OPENAI_API_KEY", ageDays: 45, limitDays: 30 });
    expect(r.findings).toContainEqual({ kind: "unknown", sink: "railway:api", names: ["EXTRA"] });
    expect(r.failed).toBe(true);
    const row = r.rows.find((x) => x.secret === "OPENAI_API_KEY")!;
    expect(row.sinks.find((s) => s.id === "local:.env")!.comparable).toBe(true);
    expect(row.sinks.find((s) => s.id === "local:.env")!.drift).toBe(true);
    expect(JSON.stringify(r)).not.toContain(digestOf("local-value"));
    expect(row.sinks.find((s) => s.id === "github:.")!.verifiable).toBe(false);
  });

  it("reports a sink error without aborting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, ".env"), "OPENAI_API_KEY=k\n");
    const exec = fakeExec([
      { cmd: "railway", result: { code: 1, stderr: "Unauthorized. Please login with `railway login`" } },
      { cmd: "gh", args: ["secret", "list"], result: { stdout: "[]" } },
    ]);
    const r = await runAudit(manifest, { version: 1, secrets: {} }, { exec, cwd: dir });
    expect(r.findings).toContainEqual(expect.objectContaining({ kind: "sink-error", sink: "railway:api" }));
    expect(r.findings).toContainEqual({ kind: "missing", secret: "OPENAI_API_KEY", sink: "github:." });
    expect(r.failed).toBe(true);
  });
});
