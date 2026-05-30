/**
 * Credential resolution for the UI "Connect" flow.
 *
 * Order of precedence:
 *   1. credentials stored in D1 `config` (entered via the dashboard), then
 *   2. wrangler secrets (CF_API_TOKEN / CF_ACCOUNT_ID).
 *
 * The stored token is read-only, but it can read your account, so the Worker
 * must sit behind Cloudflare Access. We never return the raw token to clients,
 * only a masked tail via connectionStatus().
 */

import type { Creds } from "./collect";

interface Env {
  DB?: D1Database;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

const K_TOKEN = "cf_api_token";
const K_ACCOUNT = "cf_account_id";

async function readConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/** Resolve usable credentials, or null if neither source is configured. */
export async function getCreds(env: Env): Promise<(Creds & { source: "ui" | "secret" }) | null> {
  const token = env.DB ? await readConfig(env.DB, K_TOKEN) : null;
  const accountId = env.DB ? await readConfig(env.DB, K_ACCOUNT) : null;
  if (token && accountId) return { token, accountId, source: "ui" };
  if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID) {
    return { token: env.CF_API_TOKEN, accountId: env.CF_ACCOUNT_ID, source: "secret" };
  }
  return null;
}

export interface ConnectionStatus {
  connected: boolean;
  source: "ui" | "secret" | null;
  accountId: string | null; // masked, e.g. "****ab12"
}

export async function connectionStatus(env: Env): Promise<ConnectionStatus> {
  const creds = await getCreds(env);
  if (!creds) return { connected: false, source: null, accountId: null };
  return { connected: true, source: creds.source, accountId: mask(creds.accountId) };
}

/**
 * Validate a token + account against Cloudflare, then persist them.
 * Throws with a human message if the credentials do not work.
 */
/**
 * Validate a token + account against Cloudflare. Throws a human message if they
 * do not work. Used by both the stored Connect flow and the stateless live mode.
 */
export async function verifyCreds(token: string, accountId: string): Promise<void> {
  token = token.trim();
  accountId = accountId.trim();
  if (!token || !accountId) throw new Error("Both an API token and an account id are required.");

  const verify = await cf(`/user/tokens/verify`, token);
  if (!verify.ok) throw new Error("That API token is invalid or inactive.");

  const probe = await cf(`/accounts/${accountId}/workers/scripts`, token);
  if (!probe.ok) {
    throw new Error(
      "Token is valid but cannot read this account. Check the account id and that the token has Workers Scripts: Read.",
    );
  }
}

export async function connect(env: Env, token: string, accountId: string): Promise<void> {
  token = token.trim();
  accountId = accountId.trim();
  await verifyCreds(token, accountId);
  if (!env.DB) throw new Error("No database binding.");
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(K_TOKEN, token),
    env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(K_ACCOUNT, accountId),
  ]);
}

/** Remove UI-stored credentials (falls back to secrets, if any). */
export async function disconnect(env: Env): Promise<void> {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM config WHERE key = ?").bind(K_TOKEN),
    env.DB.prepare("DELETE FROM config WHERE key = ?").bind(K_ACCOUNT),
  ]);
}

function mask(id: string): string {
  return id.length <= 4 ? "****" : "****" + id.slice(-4);
}

async function cf(path: string, token: string): Promise<{ ok: boolean }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false };
  const body = (await res.json()) as { success?: boolean };
  return { ok: body.success === true };
}
