import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './beingPaths';

/**
 * Optional admin login for this NEXUS instance.
 *
 * WHY THIS EXISTS, stated plainly: NEXUS has no access control of its own. The
 * dev server binds 0.0.0.0, and `curl http://<host>:3000/api/logs` was measured
 * returning the full conversation index with no credential of any kind. Every
 * being's logs, souls, letters and keys are one unauthenticated request away
 * from anyone who can reach the port. On a LAN or a VPN that is a small known
 * set of people; the moment a second instance runs on the same machine for
 * someone else, "reachable" and "allowed" stop being the same set.
 *
 * SHAPE: the file's existence IS the switch. `local_data/login.json` present =>
 * the gate is up; absent => anyone who reaches the port is in. That is the
 * operator's own rule and it is the one that cannot lie: there is no state
 * where the file sits there holding credentials while the door stands open.
 * Deleting the file is the documented way out if the password is lost.
 *
 * WHAT IS STORED, and what deliberately is not: the password is NOT kept. Only
 * a scrypt hash, its salt and parameters, plus a random session-signing secret.
 * `keys.json` next door holds API keys in clear text and that is a considered
 * choice — a leaked API key can be revoked, and it is used nowhere else. A
 * password is different in a way that matters: humans reuse them. Storing it in
 * clear would extend a local file read into every other service that shares it,
 * and verification never needs the plaintext. There is no benefit to weigh
 * against that, so nothing to trade off.
 *
 * TRANSPORT IS NOT COVERED HERE. Over plain HTTP the password crosses the
 * network readable by anything on the path. Inside a VPN that is the same trust
 * boundary the VPN already draws. On a public site it is not acceptable, and
 * this module cannot fix it — only TLS can. The cookie takes `Secure`
 * automatically when the request arrives over HTTPS, so a future reverse proxy
 * strengthens it with no edit here.
 */

export const LOGIN_FILE = path.join(DATA_DIR, 'login.json');

export type LoginRecord = {
  version: 1;
  username: string;
  algo: 'scrypt';
  params: { N: number; r: number; p: number; keylen: number };
  salt: string;
  hash: string;
  /** Random key that signs session cookies. Rotating it invalidates every session. */
  secret: string;
  createdAt: number;
};

/**
 * OWASP's current scrypt recommendation (N=2^17, r=8, p=1). Measured on this
 * machine: 179 ms and ~128 MB per hash. 128 MB exceeds Node's default
 * `maxmem` (32 MB), so every call must pass it explicitly or scrypt throws.
 * The cost is paid once per sign-in, never per request — requests verify an
 * HMAC instead, which is microseconds.
 */
export const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, keylen: 32 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** NIST SP 800-63B's floor for a user-chosen secret. */
export const MIN_PASSWORD_LENGTH = 8;

export const SESSION_COOKIE = 'nx_admin';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const b64u = (b: Buffer) => b.toString('base64url');

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function createLoginRecord(username: string, password: string): LoginRecord {
  const salt = randomBytes(16);
  return {
    version: 1,
    username: username.trim(),
    algo: 'scrypt',
    params: { ...SCRYPT_PARAMS },
    salt: b64u(salt),
    hash: b64u(hashPassword(password, salt)),
    // Fresh secret on every (re)configuration, which is what makes a password
    // change hang up all existing sessions instead of leaving old cookies live.
    secret: b64u(randomBytes(32)),
    createdAt: Date.now(),
  };
}

/**
 * Re-derives with the parameters stored IN THE RECORD, not the current
 * constants, so raising SCRYPT_PARAMS later does not lock out an existing
 * password. Compared with `timingSafeEqual`.
 */
export function verifyPassword(rec: LoginRecord, password: string): boolean {
  try {
    const salt = Buffer.from(rec.salt, 'base64url');
    const expected = Buffer.from(rec.hash, 'base64url');
    const actual = scryptSync(password, salt, rec.params.keylen, {
      N: rec.params.N,
      r: rec.params.r,
      p: rec.params.p,
      maxmem: SCRYPT_MAXMEM,
    });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Stateless session token: `v1.<expiry-ms>.<hmac>`. No server-side session
 * list, so nothing to write per sign-in, nothing to garbage-collect, and a
 * dev-server restart does not log the operator out.
 *
 * The username is inside the signed payload, so renaming the admin also
 * invalidates old cookies.
 */
export function issueToken(rec: LoginRecord, now = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  return `v1.${exp}.${signPayload(rec, exp)}`;
}

function signPayload(rec: LoginRecord, exp: number): string {
  return createHmac('sha256', Buffer.from(rec.secret, 'base64url'))
    .update(`v1.${rec.username}.${exp}`)
    .digest('base64url');
}

export function verifyToken(rec: LoginRecord, token: string | undefined | null, now = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= now) return false;
  try {
    const expected = Buffer.from(signPayload(rec, exp), 'base64url');
    const actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Cached read. The middleware runs on every request that is not a bundle, so
 * this must not re-parse JSON each time; it must also not go stale, because a
 * stale "no login configured" reading is an open door. `statSync` (~0.05 ms)
 * decides: same mtime and size => reuse, anything else => re-read. Absence is
 * cached the same way, keyed on a sentinel, so the common "no login file"
 * install pays one stat per request and nothing else.
 */
let cache: { key: string; rec: LoginRecord | null } | null = null;

function statKey(): string {
  try {
    const st = fsSync.statSync(LOGIN_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

export function readLoginSync(): LoginRecord | null {
  const key = statKey();
  if (cache && cache.key === key) return cache.rec;
  let rec: LoginRecord | null = null;
  if (key !== 'absent') {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(LOGIN_FILE, 'utf-8'));
      // A truncated or hand-edited file must not read as "no login required" —
      // that would turn a typo into an open door. Only a record with every
      // field needed to verify counts as configured; anything else is treated
      // as a configured-but-unusable gate below.
      if (parsed && parsed.username && parsed.salt && parsed.hash && parsed.secret && parsed.params) {
        rec = parsed as LoginRecord;
      } else {
        rec = BROKEN;
      }
    } catch {
      rec = BROKEN;
    }
  }
  cache = { key, rec };
  return rec;
}

/**
 * Sentinel for "the file is there but unusable". It must never verify anything,
 * so it carries a random secret generated at module load and a hash no password
 * can reach. The door stays shut and the operator's way out is the documented
 * one: delete login.json.
 */
const BROKEN: LoginRecord = {
  version: 1,
  username: '\u0000broken',
  algo: 'scrypt',
  params: { ...SCRYPT_PARAMS },
  salt: b64u(randomBytes(16)),
  hash: b64u(randomBytes(32)),
  secret: b64u(randomBytes(32)),
  createdAt: 0,
};

export function isBroken(rec: LoginRecord | null): boolean {
  return rec === BROKEN;
}

/** The file's existence is the switch — see the header comment. */
export function loginRequiredSync(): boolean {
  return readLoginSync() !== null;
}

export async function writeLogin(rec: LoginRecord): Promise<void> {
  await fs.mkdir(path.dirname(LOGIN_FILE), { recursive: true });
  const tmp = `${LOGIN_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2));
    await fs.rename(tmp, LOGIN_FILE);
  } catch (e) {
    try { await fs.unlink(tmp); } catch {}
    throw e;
  }
  cache = null;
}

export async function deleteLogin(): Promise<boolean> {
  try {
    await fs.unlink(LOGIN_FILE);
    cache = null;
    return true;
  } catch {
    cache = null;
    return false;
  }
}

export function validatePasswordPair(password: string, confirm: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return 'tooShort';
  if (password !== confirm) return 'mismatch';
  return null;
}

/**
 * Failed-attempt backoff, in memory only, keyed per client address.
 *
 * scrypt already rate-limits by costing 179 ms, which caps a guesser at a few
 * tries per second before any of this. The backoff exists for the case where
 * that is not enough, and it deliberately delays rather than locks: a lockout
 * is a denial-of-service that the legitimate operator — who is the ONLY account
 * here — would wear, with no second admin to lift it.
 *
 * On globalThis so dev hot-reload does not hand an attacker a counter reset.
 */
const _g = globalThis as unknown as { __nx_login_fails?: Map<string, { n: number; at: number }> };
if (!_g.__nx_login_fails) _g.__nx_login_fails = new Map();
const fails = _g.__nx_login_fails;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

export function failureDelayMs(client: string): number {
  const e = fails.get(client);
  if (!e) return 0;
  if (Date.now() - e.at > FAIL_WINDOW_MS) { fails.delete(client); return 0; }
  return Math.min(5000, Math.max(0, e.n - 2) * 500);
}

export function recordFailure(client: string): void {
  const e = fails.get(client);
  const now = Date.now();
  if (!e || now - e.at > FAIL_WINDOW_MS) fails.set(client, { n: 1, at: now });
  else fails.set(client, { n: e.n + 1, at: now });
}

export function clearFailures(client: string): void {
  fails.delete(client);
}

export function buildSessionCookie(token: string, secure: boolean): string {
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: Strict drops the cookie on a cross-site top-level
    // navigation, so following a link or a bookmark into NEXUS would bounce to
    // the login page even while signed in. Lax still withholds it from
    // cross-site POSTs, which is the case that matters here.
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
