import { describe, expect, it } from "vitest";
import { flyAdapter } from "../src/adapters/fly.js";
import { vercelAdapter } from "../src/adapters/vercel.js";
import { parseSinkArg } from "../src/sinkarg.js";
import { fakeExec } from "../src/exec.js";
import { digestOf } from "../src/state.js";

describe("fly adapter", () => {
  it("lists names with fly digests and imports via stdin staged", async () => {
    const exec = fakeExec([
      { cmd: "flyctl", args: ["secrets", "list"], result: { stdout: JSON.stringify([{ Name: "OPENAI_API_KEY", Digest: "abc123" }, { Name: "X", Digest: "" }]) } },
      { cmd: "flyctl", args: ["secrets", "import"], result: {} },
    ]);
    const ctx = { exec, cwd: "/x" };
    const ref = { kind: "fly" as const, app: "ff-worker" };
    expect(await flyAdapter.list(ref, ctx)).toEqual([{ name: "OPENAI_API_KEY", digest: "fly:abc123" }, { name: "X" }]);
    expect(exec.calls[0].args).toEqual(["secrets", "list", "--json", "--app", "ff-worker"]);
    await flyAdapter.set(ref, "OPENAI_API_KEY", "sk-2", ctx);
    expect(exec.calls[1].args).toEqual(["secrets", "import", "--stage", "--app", "ff-worker"]);
    expect(exec.calls[1].stdin).toBe("OPENAI_API_KEY=sk-2\n");
    await expect(flyAdapter.set(ref, "A", "multi\nline", ctx)).rejects.toThrow(/newlines/);
  });
});

describe("vercel adapter", () => {
  it("filters by target, hashes readable values, skips sensitive, adds with --force via stdin", async () => {
    const exec = fakeExec([
      {
        cmd: "vercel",
        args: ["env", "list"],
        result: {
          stdout: JSON.stringify([
            { key: "OPENAI_API_KEY", value: "sk-1", target: ["production", "preview"], type: "encrypted" },
            { key: "SECRET_X", value: "", target: ["production"], type: "sensitive" },
            { key: "DEV_ONLY", value: "d", target: ["development"] },
          ]),
        },
      },
      { cmd: "vercel", args: ["env", "add"], result: {} },
    ]);
    const ctx = { exec, cwd: "/x" };
    const ref = { kind: "vercel" as const, project: "ff-web", targets: ["production", "preview"] };
    expect(vercelAdapter.id(ref)).toBe("vercel:ff-web/production+preview");
    expect(await vercelAdapter.list(ref, ctx)).toEqual([{ name: "OPENAI_API_KEY", digest: digestOf("sk-1") }, { name: "SECRET_X" }]);
    await vercelAdapter.set(ref, "OPENAI_API_KEY", "sk-2", ctx);
    expect(exec.calls[1].args).toEqual(["env", "add", "OPENAI_API_KEY", "--environment", "production,preview", "--force", "--non-interactive", "--project", "ff-web"]);
    expect(exec.calls[1].stdin).toBe("sk-2");
  });
});

describe("sink arg parsing", () => {
  it("parses every supported shorthand", () => {
    expect(parseSinkArg("local:.env.production")).toEqual({ kind: "local", file: ".env.production" });
    expect(parseSinkArg("github:o/r")).toEqual({ kind: "github", repo: "o/r" });
    expect(parseSinkArg("github:o/r/prod")).toEqual({ kind: "github", repo: "o/r", env: "prod" });
    expect(parseSinkArg("railway:api/production")).toEqual({ kind: "railway", service: "api", environment: "production" });
    expect(parseSinkArg("fly:ff-worker")).toEqual({ kind: "fly", app: "ff-worker" });
    expect(parseSinkArg("vercel:ff-web/production+preview")).toEqual({ kind: "vercel", project: "ff-web", targets: ["production", "preview"] });
    expect(() => parseSinkArg("s3:bucket")).toThrow(/unsupported/);
  });
});
