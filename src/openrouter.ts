/**
 * OpenRouter management API: the one AI issuer where a personal account can mint and delete keys by API.
 * Needs a *management* key (not an inference key) in KEYMAP_OPENROUTER_MGMT_KEY.
 * Docs: https://openrouter.ai/docs/features/provisioning-api-keys
 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OpenRouterKey {
  /** The new inference key. Shown once by OpenRouter; keymap pushes it to sinks and never stores it. */
  key: string;
  hash: string;
  name: string;
}

export interface CreateOptions {
  name: string;
  /** USD credit limit for this key; omit for none. */
  limit?: number;
  limitReset?: "daily" | "weekly" | "monthly";
}

const BASE = "https://openrouter.ai/api/v1/keys";

export function managementKey(env = process.env): string | undefined {
  return env.KEYMAP_OPENROUTER_MGMT_KEY || undefined;
}

export async function createKey(mgmt: string, opts: CreateOptions, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<OpenRouterKey> {
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.limit !== undefined) body.limit = opts.limit;
  if (opts.limitReset) body.limit_reset = opts.limitReset;
  const r = await fetchFn(BASE, { method: "POST", headers: { Authorization: `Bearer ${mgmt}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`OpenRouter create key failed (${r.status}): ${text.slice(0, 200)}`);
  let j: { key?: string; data?: { hash?: string; name?: string } };
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    throw new Error("OpenRouter create key: unparseable response. A key may have been created; check https://openrouter.ai/settings/keys");
  }
  if (!j.key || !j.data?.hash) throw new Error("OpenRouter create key: unexpected response shape. A key may have been created; check https://openrouter.ai/settings/keys");
  return { key: j.key, hash: j.data.hash, name: j.data.name ?? opts.name };
}

export async function listKeys(mgmt: string, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<Array<{ hash: string; name: string; disabled?: boolean }>> {
  const r = await fetchFn(BASE, { method: "GET", headers: { Authorization: `Bearer ${mgmt}` } });
  const text = await r.text();
  if (!r.ok) throw new Error(`OpenRouter list keys failed (${r.status}): ${text.slice(0, 200)}`);
  let j: { data?: Array<{ hash: string; name: string; disabled?: boolean }> };
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    throw new Error("OpenRouter list keys: unparseable response");
  }
  return j.data ?? [];
}

export async function deleteKey(mgmt: string, hash: string, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<void> {
  const r = await fetchFn(`${BASE}/${encodeURIComponent(hash)}`, { method: "DELETE", headers: { Authorization: `Bearer ${mgmt}` } });
  if (!r.ok) throw new Error(`OpenRouter delete key failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
}
