import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { intervalMs, manifestToYaml, validateManifest } from "../src/manifest.js";

const sample = `
version: 1
project: demo
secrets:
  OPENAI_API_KEY:
    issuer: openai
    rotate_every: 30d
    sinks:
      - railway: {service: api, environment: production}
      - github: {repo: nek/demo}
      - local
  DATABASE_URL:
    issuer: supabase
    sinks:
      - railway: {service: api}
`;

describe("manifest", () => {
  it("parses compact sink syntax", () => {
    const m = validateManifest(parse(sample));
    expect(m.secrets.OPENAI_API_KEY.sinks).toEqual([
      { kind: "railway", service: "api", environment: "production" },
      { kind: "github", repo: "nek/demo" },
      { kind: "local" },
    ]);
    expect(m.secrets.DATABASE_URL.rotate_every).toBeUndefined();
  });

  it("round-trips through yaml", () => {
    const m = validateManifest(parse(sample));
    const again = validateManifest(parse(manifestToYaml(m)));
    expect(again).toEqual(m);
    expect(manifestToYaml(m)).not.toMatch(/kind:/);
  });

  it("rejects bad input", () => {
    expect(() => validateManifest({ version: 2 })).toThrow(/version/);
    expect(() => validateManifest({ version: 1, project: "x", secrets: { lower: { sinks: ["local"] } } })).toThrow(/UPPER_SNAKE/);
    expect(() => validateManifest({ version: 1, project: "x", secrets: { A: { sinks: [] } } })).toThrow(/non-empty/);
    expect(() => validateManifest({ version: 1, project: "x", secrets: { A: { sinks: ["s3"] } } })).toThrow(/unknown sink/);
    expect(() => validateManifest({ version: 1, project: "x", secrets: { A: { rotate_every: "30", sinks: ["local"] } } })).toThrow(/rotate_every/);
    expect(() => validateManifest({ version: 1, project: "x", secrets: { A: { issuer: "aws", sinks: ["local"] } } })).toThrow(/issuer/);
  });

  it("parses intervals", () => {
    expect(intervalMs("30d")).toBe(30 * 86_400_000);
    expect(intervalMs("2w")).toBe(14 * 86_400_000);
    expect(intervalMs("3m")).toBe(90 * 86_400_000);
  });
});
