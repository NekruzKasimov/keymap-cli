import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubAdapter } from "../src/adapters/github.js";
import { localAdapter, parseDotenv, upsertDotenv } from "../src/adapters/local.js";
import { railwayAdapter } from "../src/adapters/railway.js";
import { fakeExec } from "./helpers.js";
import { digestOf } from "../src/state.js";

describe("local adapter", () => {
  it("parses dotenv forms", () => {
    const t = `# c\nA=1\nexport B="two words"\nC='x#y'\nD=val # trailing\n\nbad line\n`;
    expect(parseDotenv("A=1\nA=2\n")).toEqual([{ name: "A", value: "2" }]);
    expect(parseDotenv(`A='x y'\nB="q\\"z"\n`)).toEqual([{ name: "A", value: "x y" }, { name: "B", value: 'q"z' }]);
    expect(parseDotenv(t)).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "two words" },
      { name: "C", value: "x#y" },
      { name: "D", value: "val" },
    ]);
  });

  it("upserts without touching other lines", () => {
    const t = `# header\nA=1\nexport B=old\n`;
    expect(upsertDotenv(t, "B", "new")).toBe(`# header\nA=1\nexport B=new\n`);
    expect(upsertDotenv(t, "Z", "has space")).toBe(`# header\nA=1\nexport B=old\nZ='has space'\n`);
    expect(upsertDotenv("A=1\nA=2\n", "A", "3")).toBe("A=3\nA=3\n");
    expect(upsertDotenv("", "Q", `it's $x`)).toBe(`Q="it's $x"\n`);
    expect(upsertDotenv("", "A", "x")).toBe(`A=x\n`);
  });

  it("lists digests and sets values on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, ".env"), "OPENAI_API_KEY=sk-old\n");
    const ctx = { exec: fakeExec([]), cwd: dir };
    expect(await localAdapter.list({ kind: "local" }, ctx)).toEqual([{ name: "OPENAI_API_KEY", digest: digestOf("sk-old") }]);
    await localAdapter.set({ kind: "local" }, "OPENAI_API_KEY", "sk-new", ctx);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("OPENAI_API_KEY=sk-new\n");
  });
});

describe("github adapter", () => {
  it("lists names only and sets via stdin", async () => {
    const exec = fakeExec([
      { cmd: "gh", args: ["secret", "list"], result: { stdout: JSON.stringify([{ name: "A" }, { name: "B" }]) } },
      { cmd: "gh", args: ["secret", "set"], result: {} },
    ]);
    const ctx = { exec, cwd: "/x" };
    const ref = { kind: "github" as const, repo: "o/r", env: "prod" };
    expect(await githubAdapter.list(ref, ctx)).toEqual([{ name: "A" }, { name: "B" }]);
    expect(exec.calls[0].args).toEqual(["secret", "list", "--json", "name", "--repo", "o/r", "--env", "prod"]);
    await githubAdapter.set(ref, "A", "v4lue", ctx);
    expect(exec.calls[1].args).toEqual(["secret", "set", "A", "--repo", "o/r", "--env", "prod"]);
    expect(exec.calls[1].stdin).toBe("v4lue");
    expect(exec.calls[1].args.join(" ")).not.toContain("v4lue");
  });

  it("surfaces CLI failures", async () => {
    const exec = fakeExec([{ cmd: "gh", result: { code: 1, stderr: "not logged in" } }]);
    await expect(githubAdapter.list({ kind: "github" }, { exec, cwd: "/x" })).rejects.toThrow(/not logged in/);
  });
});

describe("railway adapter", () => {
  it("hashes values, drops RAILWAY_* and sealed, pushes via stdin with --skip-deploys", async () => {
    const exec = fakeExec([
      { cmd: "railway", args: ["variable", "list"], result: { stdout: JSON.stringify({ OPENAI_API_KEY: "sk-1", SEALED: null, RAILWAY_ENVIRONMENT: "production" }) } },
      { cmd: "railway", args: ["variable", "set"], result: { stdout: "{}" } },
    ]);
    const ctx = { exec, cwd: "/x" };
    const ref = { kind: "railway" as const, service: "api", environment: "production" };
    expect(await railwayAdapter.list(ref, ctx)).toEqual([{ name: "OPENAI_API_KEY", digest: digestOf("sk-1") }, { name: "SEALED" }]);
    expect(exec.calls[0].args).toEqual(["variable", "list", "--json", "--service", "api", "--environment", "production"]);
    const r = await railwayAdapter.set(ref, "OPENAI_API_KEY", "sk-2", ctx);
    expect(r.digest).toBe(digestOf("sk-2"));
    expect(exec.calls[1].args).toEqual(["variable", "set", "OPENAI_API_KEY", "--stdin", "--skip-deploys", "--json", "--service", "api", "--environment", "production"]);
    expect(exec.calls[1].stdin).toBe("sk-2");
  });
});
