// Confidential browser OAuth plus account-scoped encrypted token lifecycle.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db, removeCredential, apiKeyRevision, connectionClock, markConnectionChange } from './storage';
import { studioEncryptionKey } from './encryption-key';

const AUTH = 'https://auth.civitai.com/api/auth/oauth';
export const OAUTH_CALLBACK = '/api/studio/v1/civitai/oauth/callback';
export const OAUTH_SCOPES = {
  UserRead: 1, ModelsRead: 4, MediaRead: 32, MediaWrite: 64,
  AIServicesRead: 16384, AIServicesWrite: 32768, BuzzRead: 65536,
  CollectionsWrite: 262144,
} as const;
export const OAUTH_REQUESTED_SCOPE = Object.values(OAUTH_SCOPES).reduce((mask, bit) => mask | bit, 0);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');

function configuration() {
  const clientId = process.env.CIVITAI_CLIENT_ID?.trim();
  const clientSecret = process.env.CIVITAI_CLIENT_SECRET;
  const base = process.env.PUBLIC_BASE_URL;
  if (!clientId || !clientSecret || !base || !studioEncryptionKey) return null;
  try {
    const url = new URL(base);
    const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) return null;
    const key = studioEncryptionKey;
    const callback = `${url.origin}${OAUTH_CALLBACK}`;
    if (process.env.CIVITAI_REDIRECT_URI !== callback) return null;
    return { clientId, clientSecret, key, callback };
  } catch { return null; }
}

export function oauthAvailability() {
  const configured = !!configuration();
  return { configured, enabled: configured, status: configured ? 'available' : 'not_configured', requestedScopes: OAUTH_REQUESTED_SCOPE,
    message: configured ? 'Authorize Civitai with credentials held only on the Studio server.' : 'OAuth is not configured on this Studio server.' };
}
export function oauthCallbackMatches(url: URL) { return configuration()?.callback === `${url.origin}${url.pathname}`; }

export class OAuthError extends Error {
  constructor(public readonly code: 'configuration' | 'flow_invalid' | 'reconnect_required' | 'rate_limited' | 'connection_changed' | 'insufficient_scope') {
    super({ configuration: 'OAuth is not configured.', flow_invalid: 'This connection attempt expired or changed. Start again.',
      reconnect_required: 'Reconnect Civitai before continuing. The token operation will not be repeated automatically.',
      rate_limited: 'Civitai rate-limited the connection attempt. Wait before reconnecting.',
      connection_changed: 'Your connection changed. Review the action again.',
      insufficient_scope: 'The connection does not grant the permissions required for this action.' }[code]);
  }
}
function config() { const result = configuration(); if (!result) throw new OAuthError('configuration'); return result; }

db.exec(`
 CREATE TABLE IF NOT EXISTS oauth_browsers (binding_hash TEXT PRIMARY KEY, epoch TEXT NOT NULL, expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS oauth_pending (
   state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, session_hash TEXT NOT NULL,
   account_id TEXT, expires_at INTEGER NOT NULL, sealed TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS oauth_connections (
   user_id TEXT PRIMARY KEY REFERENCES studio_users(id) ON DELETE CASCADE,
   revision TEXT NOT NULL, scope INTEGER NOT NULL, expires_at INTEGER NOT NULL,
   status TEXT NOT NULL, sealed TEXT NOT NULL
 );
`);

function seal(value: unknown, aad: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', config().key, iv);
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: bytes.toString('base64') });
}
function unseal<T>(sealed: string, aad: string): T {
  try {
    const row = JSON.parse(sealed), decipher = createDecipheriv('aes-256-gcm', config().key, Buffer.from(row.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw new OAuthError('reconnect_required'); }
}

export function ensureOAuthBrowser(existing?: string) {
  const now=Date.now();
  db.query('DELETE FROM oauth_browsers WHERE expires_at<=?').run(now);
  if(existing && /^[A-Za-z0-9_-]{43}$/.test(existing) && oauthBrowserCurrent(existing)) return {token:existing,created:false};
  if(db.query<{n:number},[]>('SELECT count(*) n FROM oauth_browsers').get()!.n>=10000)throw new OAuthError('rate_limited');
  const token=random();
  db.query('INSERT INTO oauth_browsers VALUES (?,?,?)').run(digest(token),random(),now+8*60*60*1000);
  return {token,created:true};
}
export function oauthBrowserCurrent(token: string, epoch?: string) {
  const row=db.query<{epoch:string;expires_at:number},[string]>('SELECT epoch,expires_at FROM oauth_browsers WHERE binding_hash=?').get(digest(token));
  return !!row && row.expires_at>Date.now() && (epoch===undefined || epoch===row.epoch);
}
export function invalidateOAuthBrowser(token: string | undefined) {
  if(token) db.query('DELETE FROM oauth_browsers WHERE binding_hash=?').run(digest(token));
}
// Origin and CSRF are validated by the route before starting a flow.
export function beginOAuth(sessionBinding: string, accountId: string | null, browserToken: string, expectedRevision: string | null) {
  if (sessionBinding.length < 32) throw new OAuthError('flow_invalid');
  const cfg = config(), state = random(), cookieNonce = random(), verifier = random();
  const stateHash = digest(state), sessionHash = digest(sessionBinding), expiresAt = Date.now() + 300_000, browserEpoch=random();
  db.transaction(() => {
    if(!oauthBrowserCurrent(browserToken))throw new OAuthError('flow_invalid');
    db.query('UPDATE oauth_browsers SET epoch=? WHERE binding_hash=?').run(browserEpoch,digest(browserToken));
    db.query('DELETE FROM oauth_pending WHERE expires_at <= ? OR session_hash = ?').run(Date.now(), sessionHash);
    const count = db.query<{ total: number }, []>('SELECT count(*) AS total FROM oauth_pending').get()!.total;
    if (count >= 1000) throw new OAuthError('rate_limited');
    db.query('INSERT INTO oauth_pending VALUES (?,?,?,?,?,?)').run(stateHash, digest(cookieNonce), sessionHash, accountId, expiresAt,
      seal({ verifier, expectedRevision, browserEpoch, startClock:connectionClock(), expiresAt }, `flow:${stateHash}`));
  }).immediate();
  const url = new URL(`${AUTH}/authorize`);
  url.search = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.callback,
    scope: String(OAUTH_REQUESTED_SCOPE), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  // Civitai documents OAuth code/state, not an ID-token nonce. cookieNonce is a
  // separate local browser binding; we do not invent an OIDC nonce response claim.
  return { authorizeUrl: url.toString(), cookieNonce, expiresAt };
}

export function consumeOAuth(state: string, cookieNonce: string, sessionBinding: string, accountId: string | null) {
  if (![state, cookieNonce].every(value => /^[A-Za-z0-9_-]{43}$/.test(value)) || sessionBinding.length < 32) throw new OAuthError('flow_invalid');
  const stateHash = digest(state);
  return db.transaction(() => {
    const row = db.query<{ binding_hash: string; session_hash: string; account_id: string | null; expires_at: number; sealed: string }, [string]>(
      'SELECT * FROM oauth_pending WHERE state_hash = ?').get(stateHash);
    if (!row || row.expires_at <= Date.now() || row.binding_hash !== digest(cookieNonce) ||
      row.session_hash !== digest(sessionBinding) || row.account_id !== accountId) throw new OAuthError('flow_invalid');
    const payload = unseal<{ verifier: string; expectedRevision:string|null; browserEpoch:string; startClock:number; expiresAt:number }>(row.sealed, `flow:${stateHash}`);
    db.query('DELETE FROM oauth_pending WHERE state_hash = ?').run(stateHash);
    return payload;
  }).immediate();
}

async function boundedJson(response: Response): Promise<any> {
  const reader = response.body?.getReader(); if (!reader) throw new OAuthError('reconnect_required');
  let length = 0; const chunks: Uint8Array[] = [];
  for (;;) { const part = await reader.read(); if (part.done) break;
    length += part.value.length; if (length > 32768) { await reader.cancel(); throw new OAuthError('reconnect_required'); }
    chunks.push(part.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new OAuthError('reconnect_required'); }
}
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; scope: number };
async function tokenRequest(fields: Record<string, string>): Promise<Tokens> {
  const cfg = config();
  try {
    const response = await fetch(`${AUTH}/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...fields, client_id: cfg.clientId, client_secret: cfg.clientSecret }) });
    if (!response.ok) { await response.body?.cancel(); throw new OAuthError(response.status === 429 ? 'rate_limited' : 'reconnect_required'); }
    const body = await boundedJson(response);
    if (body.token_type?.toLowerCase() !== 'bearer' || ![body.access_token, body.refresh_token].every(value =>
      typeof value === 'string' && value.length >= 8 && value.length <= 16384 && !/[\s\x00-\x1f]/.test(value)) ||
      !Number.isInteger(body.expires_in) || body.expires_in <= 60 || body.expires_in > 86400 ||
      typeof body.scope !== 'string' || !/^\d{1,8}$/.test(body.scope)) throw new OAuthError('reconnect_required');
    const scope = Number(body.scope);
    if (scope > 33554431 || !(scope & OAUTH_SCOPES.UserRead)) throw new OAuthError('reconnect_required');
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000, scope };
  } catch (error) { if (error instanceof OAuthError) throw error; throw new OAuthError('reconnect_required'); }
}

export async function exchangeOAuth(code: string, verifier: string, expectedAccount: string | null) {
  if (!code || code.length > 4096 || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw new OAuthError('flow_invalid');
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config().callback });
  try {
    const response = await fetch(`${AUTH}/userinfo`, { redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); throw new OAuthError('reconnect_required'); }
    const profile = await boundedJson(response);
    if (typeof profile.sub !== 'string' || !/^[1-9]\d{0,19}$/.test(profile.sub) || String(profile.id) !== profile.sub ||
      (expectedAccount !== null && expectedAccount !== profile.sub)) throw new OAuthError('flow_invalid');
    return { tokens, accountId: profile.sub, displayName: String(profile.preferred_username ?? profile.username ?? 'Civitai user').slice(0, 120) };
  } catch (error) { await revokeToken(tokens.refreshToken); if (error instanceof OAuthError) throw error; throw new OAuthError('reconnect_required'); }
}

type Connection = { user_id: string; revision: string; scope: number; expires_at: number; status: string; sealed: string };
export function oauthConnection(userId: string) {
  return db.query<Connection, [string]>('SELECT * FROM oauth_connections WHERE user_id = ?').get(userId);
}
// Callback adapter checks its session/browser/tombstone inside an outer transaction.
export function installOAuth(userId: string, tokens: Tokens, expectedRevision: string | null) {
  return db.transaction(() => {
    if ((oauthConnection(userId)?.revision ?? apiKeyRevision(userId)) !== expectedRevision) throw new OAuthError('connection_changed');
    const revision = random();
    removeCredential(userId);
    db.query(`INSERT INTO oauth_connections VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
      revision=excluded.revision,scope=excluded.scope,expires_at=excluded.expires_at,status=excluded.status,sealed=excluded.sealed`)
      .run(userId, revision, tokens.scope, tokens.expiresAt, 'ready', seal(tokens, `connection:${userId}:${revision}`));
    return revision;
  }).immediate();
}

const refreshing = new Map<string, Promise<void>>();
async function refresh(userId: string, row: Connection) {
  // Persist the claim before dispatch. A crash leaves 'refreshing' unusable;
  // never retry the rotating refresh token after an ambiguous result.
  const claimed = db.query("UPDATE oauth_connections SET status='refreshing' WHERE user_id=? AND revision=? AND status='ready' AND sealed=?")
    .run(userId, row.revision, row.sealed).changes;
  if (claimed !== 1) throw new OAuthError('reconnect_required');
  try {
    const old = unseal<Tokens>(row.sealed, `connection:${userId}:${row.revision}`);
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: old.refreshToken });
    const revision = tokens.scope === row.scope ? row.revision : random();
    const changed = db.transaction(()=>{
      const updated = db.query(`UPDATE oauth_connections SET revision=?,scope=?,expires_at=?,status='ready',sealed=?
      WHERE user_id=? AND revision=? AND status='refreshing' AND sealed=?`).run(revision, tokens.scope, tokens.expiresAt,
        seal(tokens, `connection:${userId}:${revision}`), userId, row.revision, row.sealed).changes;
      if(updated===1 && revision!==row.revision)markConnectionChange(userId);
      return updated;
    }).immediate();
    if (changed !== 1) { await revokeToken(tokens.refreshToken); throw new OAuthError('connection_changed'); }
  } catch (error) {
    db.query("UPDATE oauth_connections SET status='reconnect_required' WHERE user_id=? AND revision=? AND status='refreshing' AND sealed=?")
      .run(userId, row.revision, row.sealed);
    throw error;
  }
}

// Site/Orchestration adapters resolve immediately before each call. A
// caller must compare revision again after awaits and before paid/write dispatch.
export async function resolveOAuthBearer(userId: string, requiredScope: number, expectedRevision?: string) {
  let row = oauthConnection(userId);
  if (!row) throw new OAuthError('reconnect_required');
  const pending = refreshing.get(userId);
  if (pending) await pending;
  else if (row.status === 'ready' && row.expires_at <= Date.now() + 60000) {
    const promise = refresh(userId, row); refreshing.set(userId, promise);
    try { await promise; } finally { if (refreshing.get(userId) === promise) refreshing.delete(userId); }
  }
  row = oauthConnection(userId);
  if (!row || row.status !== 'ready' || row.expires_at <= Date.now()) throw new OAuthError('reconnect_required');
  if (expectedRevision && row.revision !== expectedRevision) throw new OAuthError('connection_changed');
  if ((row.scope & requiredScope) !== requiredScope) throw new OAuthError('insufficient_scope');
  return { bearer: unseal<Tokens>(row.sealed, `connection:${userId}:${row.revision}`).accessToken, revision: row.revision, scope: row.scope };
}

export async function revokeToken(token: string): Promise<void> {
  try {
    const cfg = config();
    const response = await fetch(`${AUTH}/revoke`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token,
        token_type_hint: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret }) });
    await response.body?.cancel();
  } catch { /* Local deletion never depends on remote revocation. No token logs. */ }
}
export async function disconnectOAuth(userId: string) {
  const row = oauthConnection(userId);
  let token: string | undefined;
  try { if (row) token = unseal<Tokens>(row.sealed, `connection:${userId}:${row.revision}`).refreshToken; } catch { /* delete even if undecryptable */ }
  db.transaction(() => {
    removeCredential(userId);
    db.query('DELETE FROM oauth_connections WHERE user_id=?').run(userId);
    db.query('DELETE FROM oauth_pending WHERE account_id=?').run(userId);
    db.query('DELETE FROM sessions WHERE user_id=?').run(userId);
  }).immediate();
  if (token) await revokeToken(token);
}
