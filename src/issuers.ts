import { randomBytes } from "node:crypto";
import type { Issuer } from "./types.js";

/** 32 random bytes, base64url: 43 chars, safe in URLs, env files and shells. */
export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Manual steps for issuers whose personal accounts have no key-rotation API.
 * Printed after the new value has been pushed everywhere, so the user revokes last.
 */
export function manualChecklist(issuer: Issuer, name: string): string[] {
  switch (issuer) {
    case "openai":
      return [
        `Open https://platform.openai.com/api-keys and confirm the new ${name} is listed with today's date.`,
        "Open the old key's row, note its last-used time, and if nothing you own used it in the last few minutes, click Revoke.",
        "Set a project spend limit: Settings -> Limits -> Monthly budget (hard limit returns 429 when reached).",
      ];
    case "anthropic":
      return [
        `Open https://console.anthropic.com/settings/keys and confirm the new ${name} is listed.`,
        "Disable the old key (Disable, then Delete once you have verified traffic moved).",
        "Set a workspace spend limit under Settings -> Limits; Anthropic enforces it as a hard stop.",
      ];
    case "google":
      return [
        `In Google AI Studio or Cloud Console, confirm the new ${name} exists and is restricted to the APIs it needs.`,
        "Delete the old key.",
        "Google budgets are alerts only: add a Pub/Sub budget action if you need a hard stop.",
      ];
    case "stripe":
      return [
        "Stripe Dashboard -> Developers -> API keys: the old secret key keeps working for up to 24h after you create a new one.",
        "Once every sink has the new value, click Roll key on the old one and choose expiry now.",
      ];
    case "supabase":
      return [
        "Supabase Dashboard -> Project Settings -> API: regenerate the service role key or JWT secret.",
        "Regenerating the JWT secret logs every user out; schedule it.",
      ];
    case "cloudflare":
      return [
        "Cloudflare Dashboard -> My Profile -> API Tokens: roll or delete the old token after every sink has the new one.",
      ];
    case "openrouter":
      return [
        "Delete the old key at https://openrouter.ai/settings/keys once traffic has moved (or set KEYMAP_OPENROUTER_MGMT_KEY to let keymap do this).",
      ];
    case "resend":
      return [
        `Open https://resend.com/api-keys and confirm the new ${name} is listed.`,
        "Delete the old key once every sink has the new one.",
      ];
    case "telegram":
      return [
        `In Telegram, open @BotFather -> /revoke and pick the bot behind ${name}; the old token stops working at once, so push the new one everywhere first.`,
      ];
    case "github":
      return [
        "GitHub -> Settings -> Developer settings -> tokens: delete the old token after every sink has the new one.",
      ];
    case "custom":
      return [`Tell the service that consumes ${name} about the new value (its own config, or a peer app) and retire the old one.`];
  }
}

/** Issuers for which `--generate` makes sense (we mint the value; a peer service accepts whatever we set). */
export function canGenerate(issuer: Issuer): boolean {
  return issuer === "custom";
}
