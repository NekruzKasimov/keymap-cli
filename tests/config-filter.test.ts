import { describe, expect, it } from "vitest";
import { isIgnored, looksLikeConfig } from "../src/manifest.js";
import { guessIssuer } from "../src/commands/init.js";

describe("looksLikeConfig", () => {
  it("treats addresses, ids, paths and amounts as config", () => {
    for (const n of ["NEXTAUTH_URL", "PROD_APP_URL", "UPLOAD_DIR", "CLICK_MERCHANT_ID", "APPOINTMENT_PRICE", "RESEND_FROM", "ESKIZ_EMAIL", "SUPER_ADMIN_TELEGRAM_CHAT_ID", "APP_URL_PROD"]) {
      expect(looksLikeConfig(n), n).toBe(true);
      expect(isIgnored(n), n).toBe(true);
    }
  });
  it("keeps anything that names a credential", () => {
    for (const n of ["DATABASE_URL", "DIRECT_URL", "DATABASE_URL_PROD", "REDIS_URL", "MONGO_URI", "NEXTAUTH_SECRET", "RESEND_API_KEY", "TELEGRAM_BOT_TOKEN", "CRON_SECRET", "ESKIZ_PASSWORD", "WEBHOOK_ID", "STRIPE_SIGNING_ID"]) {
      expect(looksLikeConfig(n), n).toBe(false);
      expect(isIgnored(n), n).toBe(false);
    }
  });
  it("leaves plain names mapped", () => {
    expect(isIgnored("SOME_VALUE")).toBe(false);
  });
});

describe("guessIssuer additions", () => {
  it("recognises resend, telegram and github tokens", () => {
    expect(guessIssuer("RESEND_API_KEY")).toBe("resend");
    expect(guessIssuer("TELEGRAM_BOT_TOKEN")).toBe("telegram");
    expect(guessIssuer("GH_TOKEN")).toBe("github");
    expect(guessIssuer("ESKIZ_PASSWORD")).toBe("custom");
  });
});

import { validateManifest } from "../src/manifest.js";
import { parse as parseYaml } from "yaml";
describe("manifest accepts every issuer init can guess", () => {
  it("loads github, resend and telegram issuers", () => {
    for (const issuer of ["github", "resend", "telegram"]) {
      const m = validateManifest(parseYaml(`version: 1\nproject: p\nsecrets:\n  X_TOKEN:\n    issuer: ${issuer}\n    rotate_every: 30d\n    sinks:\n      - local: {file: .env}\n`));
      expect(m.secrets.X_TOKEN.issuer).toBe(issuer);
    }
  });
});
