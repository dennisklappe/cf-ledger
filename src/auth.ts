/**
 * Cloudflare Access (Zero Trust) enforcement.
 *
 * Access puts a login wall (email one-time-PIN, Google, GitHub, ...) in front
 * of the Worker at the edge, so unauthenticated users never reach this code.
 *
 * As a fail-closed backstop, when ACCESS_TEAM_DOMAIN + ACCESS_AUD are set we
 * also verify the Access JWT inside the Worker. That stops anyone from using
 * the public *.workers.dev URL to bypass a policy applied only to a custom
 * domain: without a valid Access token the request gets a 403 everywhere.
 *
 * When those vars are NOT set we cannot verify, so instead of silently serving
 * your cost data we report the instance as unprotected and the dashboard shows
 * a loud warning.
 */

export interface AuthEnv {
  /** Your Zero Trust team domain, e.g. "myteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application Audience (AUD) tag. */
  ACCESS_AUD?: string;
}

export interface AuthResult {
  /** false means: block this request (403). */
  ok: boolean;
  /** true means: verified, or it arrived through Access. */
  protected: boolean;
  email?: string;
  reason?: string;
}

const enc = new TextEncoder();

function getToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1]! : null;
}

function b64urlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 ? 4 - (norm.length % 4) : 0;
  const bin = atob(norm + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

interface JwkKey extends JsonWebKey {
  kid: string;
}
let jwksCache: { team: string; keys: JwkKey[]; at: number } | null = null;

async function fetchKeys(team: string, now: number): Promise<JwkKey[]> {
  if (jwksCache && jwksCache.team === team && now - jwksCache.at < 3_600_000) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Could not fetch Cloudflare Access certificates");
  const { keys } = (await res.json()) as { keys: JwkKey[] };
  jwksCache = { team, keys, at: now };
  return keys;
}

interface AccessClaims {
  aud?: string | string[];
  exp?: number;
  email?: string;
}

async function verifyJwt(token: string, team: string, aud: string, now: number): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed Access token");
  const h = parts[0]!, p = parts[1]!, sig = parts[2]!;
  const header = b64urlToJson<{ kid?: string }>(h);
  const claims = b64urlToJson<AccessClaims>(p);

  const jwk = (await fetchKeys(team, now)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown Access signing key");

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), enc.encode(`${h}.${p}`),
  );
  if (!valid) throw new Error("Bad Access token signature");

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new Error("Access token audience mismatch");
  if (claims.exp && now / 1000 > claims.exp) throw new Error("Access token expired");
  return claims;
}

/** Decide whether to serve the request, and whether the instance is protected. */
export async function checkAccess(request: Request, env: AuthEnv): Promise<AuthResult> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  const token = getToken(request);

  if (!team || !aud) {
    // Not configured to verify. Rely on edge Access; infer it from the token.
    return { ok: true, protected: !!token };
  }
  if (!token) return { ok: false, protected: true, reason: "Sign in through Cloudflare Access." };
  try {
    const claims = await verifyJwt(token, team, aud, Date.now());
    return { ok: true, protected: true, email: claims.email };
  } catch (e) {
    return { ok: false, protected: true, reason: (e as Error).message };
  }
}
