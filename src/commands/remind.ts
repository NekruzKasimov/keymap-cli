import type { AuditResult, Finding } from "./audit.js";
import type { FetchLike } from "../openrouter.js";

/**
 * Turns audit findings into one short message and posts it to a Slack or Discord incoming webhook.
 * Both accept {"text": ...}/{"content": ...}; we send both fields so one payload works for either.
 * No secret values are ever in a finding, so the message is safe to post to a shared channel.
 */
export function buildReminder(project: string, r: AuditResult): { text: string; count: number } {
  const lines: string[] = [];
  const by = (k: Finding["kind"]) => r.findings.filter((f) => f.kind === k);
  const overdue = by("overdue") as Extract<Finding, { kind: "overdue" }>[];
  const missing = by("missing") as Extract<Finding, { kind: "missing" }>[];
  const drift = by("drift") as Extract<Finding, { kind: "drift" }>[];
  const unknown = by("unknown") as Extract<Finding, { kind: "unknown" }>[];
  const errors = by("sink-error") as Extract<Finding, { kind: "sink-error" }>[];
  const never = by("never-rotated") as Extract<Finding, { kind: "never-rotated" }>[];

  if (overdue.length) lines.push(`Overdue rotation: ${overdue.map((f) => `${f.secret} (${f.ageDays}d, limit ${f.limitDays}d)`).join(", ")}`);
  if (missing.length) lines.push(`Missing: ${missing.map((f) => `${f.secret} at ${f.sink}`).join(", ")}`);
  if (drift.length) lines.push(`Drift: ${drift.map((f) => f.secret).join(", ")}`);
  if (unknown.length) lines.push(`Unmapped: ${unknown.map((f) => `${f.sink}: ${f.names.join(", ")}`).join("; ")}`);
  if (errors.length) lines.push(`Host errors: ${errors.map((f) => f.sink).join(", ")}`);
  if (never.length) lines.push(`Never rotated via keymap: ${never.map((f) => f.secret).join(", ")}`);
  const count = lines.length;
  const head = count ? `keymap ${project}: ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}` : `keymap ${project}: all clear`;
  return { text: [head, ...lines].join("\n"), count };
}

export async function postReminder(webhook: string, text: string, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<void> {
  const r = await fetchFn(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) });
  if (!r.ok) throw new Error(`webhook returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
