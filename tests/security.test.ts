import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localAdapter, renderDotenvValue } from "../src/adapters/local.js";
import { railwayAdapter } from "../src/adapters/railway.js";
import { supabaseAdapter } from "../src/adapters/supabase.js";
import { childEnv, cliError, parseJsonSafe } from "../src/exec.js";
import { validateManifest } from "../src/manifest.js";
import { digestOf, loadState, saveState, statePath } from "../src/state.js";
import { fakeExec } from "./helpers.js";

describe("values never reach error text", () => {
  it("railway list errors exclude stdout (which carries raw values)", async () => {
    const exec = fakeExec([{ cmd: "railway", result: { code: 1, stdout: '{"OPENAI_API_KEY":"sk-live-123"}', stderr: "" } }]);
    await expect(railwayAdapter.list({ kind: "railway" }, { exec, cwd: "/x" })).rejects.toThrow(/railway variable list failed \(exit 1\)$/);
  });
  it("JSON parse errors never quote input", () => {
    expect(() => parseJsonSafe('{"K":"sk-live-123"', "railway")).toThrow(/^unparseable JSON from railway$/);
  });
  it("cliError redacts and caps", () => {
    const e = cliError("x", { code: 1, stdout: "", stderr: "bad sk-1 " + "y".repeat(1000) }, { redact: ["sk-1"] });
    expect(e.message).toContain("[redacted]");
    expect(e.message).not.toContain("sk-1");
    expect(e.message.length).toBeLessThan(360);
  });
  it("set failures that echo the value are scrubbed", async () => {
    const exec = fakeExec([{ cmd: "railway", result: { code: 1, stderr: "could not set K=sk-new-value" } }]);
    await expect(railwayAdapter.set({ kind: "railway" }, "K", "sk-new-value", { exec, cwd: "/x" })).rejects.toThrow(/\[redacted\]/);
  });
  it("supabase provider digests are re-hashed, never printed raw", async () => {
    const exec = fakeExec([{ cmd: "supabase", result: { stdout: JSON.stringify([{ name: "K", value: "sk-raw" }]) } }]);
    const [e] = await supabaseAdapter.list({ kind: "supabase", project: "p" }, { exec, cwd: "/x" });
    expect(e.digest).toBe(`sb:${digestOf("sk-raw")}`);
    expect(e.digest).not.toContain("sk-raw");
  });
  it("supabase env-file values are dotenv-quoted", () => {
    expect(renderDotenvValue("a b # c")).toBe("'a b # c'");
    expect(renderDotenvValue("plain")).toBe("plain");
  });
});

describe("child environment", () => {
  it("drops KEYMAP_* and keeps the rest", () => {
    const env = childEnv({ PATH: "/usr/bin", KEYMAP_OPENROUTER_MGMT_KEY: "m", KEYMAP_WEBHOOK: "w", HOME: "/h" });
    expect(env.KEYMAP_OPENROUTER_MGMT_KEY).toBeUndefined();
    expect(env.KEYMAP_WEBHOOK).toBeUndefined();
    expect(env.HOME).toBe("/h");
    expect(env.PATH?.startsWith("/usr/bin")).toBe(true);
  });
});

describe("manifest field validation", () => {
  const base = (sink: unknown) => ({ version: 1, project: "p", secrets: { A: { sinks: [sink] } } });
  it("rejects flag-like and odd values, in both syntaxes", () => {
    expect(() => validateManifest(base({ cloudflare: { worker: "--config=/evil.toml" } }))).toThrow(/not a valid identifier/);
    expect(() => validateManifest(base({ kind: "railway", service: "-x" }))).toThrow(/not a valid identifier/);
    expect(() => validateManifest(base({ railway: { service: "api", weird: 5 } }))).toThrow(/must be a string/);
    expect(() => validateManifest(base({ railway: { "Bad Key": "x" } }))).toThrow(/unknown field/);
    expect(validateManifest(base({ vercel: { project: "ff-web", targets: ["production", "preview"] } })).secrets.A.sinks[0]).toEqual({ kind: "vercel", project: "ff-web", targets: ["production", "preview"] });
  });
  it("restricts local files to .env-style paths inside the project", () => {
    expect(() => validateManifest(base({ local: { file: "README.md" } }))).toThrow(/\.env-style/);
    expect(() => validateManifest(base({ local: { file: "../.env" } }))).toThrow(/\.env-style/);
    expect(() => validateManifest(base({ local: { file: "/etc/.env" } }))).toThrow(/\.env-style/);
    expect(() => validateManifest(base({ local: { file: "public/.env.js" } }))).not.toThrow(); // .env.js matches the pattern; git-ignore check still applies at write time
    expect(() => validateManifest(base({ local: { file: "config/.env.production" } }))).not.toThrow();
  });
  it("ignores inherited keys in secrets", () => {
    const m = validateManifest({ version: 1, project: "p", secrets: Object.assign(Object.create({ INHERITED: { sinks: ["local"] } }), { A: { sinks: ["local"] } }) });
    expect(Object.keys(m.secrets)).toEqual(["A"]);
  });
});

describe("local sink safety", () => {
  it("refuses symlinks, tracked files, and writes atomically with mode 600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir, "real.txt"), "A=1\n");
    await symlink(join(dir, "real.txt"), join(dir, ".env"));
    const ok = fakeExec([]);
    await expect(localAdapter.list({ kind: "local" }, { exec: ok, cwd: dir })).rejects.toThrow(/symlink/);

    const dir2 = await mkdtemp(join(tmpdir(), "keymap-"));
    await writeFile(join(dir2, ".env"), "A=1\n", { mode: 0o644 });
    const tracked = fakeExec([{ cmd: "git", result: { code: 1 } }]);
    await expect(localAdapter.set({ kind: "local" }, "A", "2", { exec: tracked, cwd: dir2 })).rejects.toThrow(/not git-ignored/);
    expect(await readFile(join(dir2, ".env"), "utf8")).toBe("A=1\n");

    await localAdapter.set({ kind: "local" }, "A", "2", { exec: ok, cwd: dir2 });
    expect(await readFile(join(dir2, ".env"), "utf8")).toBe("A=2\n");
    expect((await stat(join(dir2, ".env"))).mode & 0o777).toBe(0o600);
    await expect(localAdapter.set({ kind: "local" }, "A", "x\ny", { exec: ok, cwd: dir2 })).rejects.toThrow(/newlines/);
  });
  it("works outside a git repo (exit 128) and without git (exit 127)", async () => {
    for (const code of [128, 127]) {
      const dir = await mkdtemp(join(tmpdir(), "keymap-"));
      const exec = fakeExec([{ cmd: "git", result: { code } }]);
      await localAdapter.set({ kind: "local" }, "A", "v", { exec, cwd: dir });
      expect(await readFile(join(dir, ".env"), "utf8")).toBe("A=v\n");
    }
  });
});

describe("state", () => {
  it("keys by project and location, writes 600, refuses corrupt files", async () => {
    const p1 = statePath("demo", "/a");
    const p2 = statePath("demo", "/b");
    expect(p1).not.toBe(p2);
    expect(p1.startsWith(process.env.KEYMAP_HOME as string)).toBe(true);
    await saveState(p1, { version: 1, secrets: {} });
    expect((await stat(p1)).mode & 0o777).toBe(0o600);
    expect((await stat(process.env.KEYMAP_HOME as string)).mode & 0o777).toBe(0o700);
    await writeFile(p1, "{nope");
    await expect(loadState(p1)).rejects.toThrow(/not valid JSON/);
    expect(await loadState(statePath("none", "/z"))).toEqual({ version: 1, secrets: {} });
  });
  it("digests are salted HMACs, stable within a machine", () => {
    expect(digestOf("x")).toMatch(/^[0-9a-f]{8}$/);
    expect(digestOf("x")).toBe(digestOf("x"));
    expect(digestOf("x")).not.toBe("2d711642"); // plain sha256("x") prefix
  });
});
