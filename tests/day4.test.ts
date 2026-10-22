import { describe, expect, it } from "vitest";
import type { AuditResult } from "../src/commands/audit.js";
import { formatDoctor, runDoctor } from "../src/commands/doctor.js";
import { buildReminder, postReminder } from "../src/commands/remind.js";
import { fakeExec } from "../src/exec.js";

describe("remind", () => {
  const base: AuditResult = { rows: [], findings: [], failed: false };
  it("says all clear with zero lines", () => {
    expect(buildReminder("demo", base)).toEqual({ text: "keymap demo: all clear", count: 0 });
  });
  it("groups findings into one message without values", () => {
    const r: AuditResult = {
      rows: [],
      failed: true,
      findings: [
        { kind: "overdue", secret: "OPENAI_API_KEY", ageDays: 45, limitDays: 30 },
        { kind: "missing", secret: "DATABASE_URL", sink: "railway:api" },
        { kind: "unknown", sink: "railway:api", names: ["EXTRA"] },
        { kind: "never-rotated", secret: "NPM_TOKEN" },
      ],
    };
    const { text, count } = buildReminder("demo", r);
    expect(count).toBe(4);
    expect(text).toContain("keymap demo: 4 findings");
    expect(text).toContain("OPENAI_API_KEY (45d, limit 30d)");
    expect(text).toContain("DATABASE_URL at railway:api");
  });
  it("posts text+content and surfaces webhook errors", async () => {
    const seen: string[] = [];
    await postReminder("https://hooks.example/x", "hi", async (url, init) => { seen.push(url, init.body as string); return { ok: true, status: 200, text: async () => "" }; });
    expect(JSON.parse(seen[1])).toEqual({ text: "hi", content: "hi" });
    await expect(postReminder("https://hooks.example/x", "hi", async () => ({ ok: false, status: 404, text: async () => "no" }))).rejects.toThrow(/404/);
  });
});

describe("doctor", () => {
  it("reports installed, logged-in, and missing CLIs", async () => {
    const exec = fakeExec([
      { cmd: "gh", args: ["--version"], result: { stdout: "gh version 2.86.0" } },
      { cmd: "gh", args: ["auth", "status"], result: { stdout: "Logged in to github.com" } },
      { cmd: "railway", args: ["--version"], result: { stdout: "railway 5.63.1" } },
      { cmd: "railway", args: ["whoami"], result: { code: 1, stderr: "Unauthorized. Please login with `railway login`" } },
    ]);
    const rows = await runDoctor({ exec, cwd: "/x" }, ["github", "railway", "fly"]);
    expect(rows).toEqual([
      { sink: "github", cmd: "gh", installed: true, version: "2.86.0", loggedIn: true, loginHint: "gh auth login" },
      { sink: "railway", cmd: "railway", installed: true, version: "5.63.1", loggedIn: false, loginHint: "railway login" },
      { sink: "fly", cmd: "flyctl", installed: false, loginHint: "flyctl auth login" },
    ]);
    const out = formatDoctor(rows);
    expect(out).toContain("not logged in -> railway login");
    expect(out).toContain("not installed (flyctl)");
  });
});
