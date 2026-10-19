import { AsyncLocalStorage } from 'node:async_hooks';
import { apiKeyRevision, credentialExists, getTokenScope, readCredential } from './storage';
import { oauthConnection, resolveOAuthBearer, OAuthError } from './oauth';

export { OAuthError as ConnectionError };
const requestConnection = new AsyncLocalStorage<{userId:string;revision:string;sessionCurrent:()=>boolean}>();
export function withAccountConnection<T>(userId:string,revision:string,work:()=>T,sessionCurrent:()=>boolean):T { return requestConnection.run({userId,revision,sessionCurrent},work); }
export type BearerLease = { userId: string; bearer: string; revision: string; scopes: number | null; kind: 'api_key' | 'oauth' };
type Options = { expectedRevision?: string; requiredScopes?: number; service?: 'site' | 'orchestration' | 'mcp' };

export function connectionStatus(userId: string) {
  const oauth = oauthConnection(userId);
  // Never fall back from OAuth, including an expired or unusable OAuth row.
  if (oauth) return { kind: 'oauth' as const, revision: oauth.revision, grantedScopes: oauth.scope,
    status: credentialExists(userId) ? 'reconnect_required' : oauth.status === 'ready' ? 'connected' : oauth.status === 'refreshing' ? 'refreshing' : 'reconnect_required' };
  const revision = apiKeyRevision(userId);
  return revision ? { kind: 'api_key' as const, revision, grantedScopes: getTokenScope(userId) ?? null, status: readCredential(userId) ? 'connected' : 'reconnect_required' } : null;
}
export function assertConnectionCurrent(lease: BearerLease) {
  const context = requestConnection.getStore();
  if(context && (context.userId !== lease.userId || context.revision !== lease.revision || !context.sessionCurrent())) throw new OAuthError("connection_changed");
  const current = connectionStatus(lease.userId);
  if (!current || current.revision !== lease.revision || current.kind !== lease.kind || current.grantedScopes !== lease.scopes)
    throw new OAuthError('connection_changed');
  if (current.status === 'reconnect_required') throw new OAuthError('reconnect_required');
  const oauth = lease.kind === 'oauth' ? oauthConnection(lease.userId) : null;
  // Another request may be refreshing the same stable connection. Its resolver
  // waits for the refresh; connection identity itself does not change.
  if (oauth && (!['ready', 'refreshing'].includes(oauth.status) || credentialExists(lease.userId))) throw new OAuthError('reconnect_required');
}
export function connectionCurrent(lease: BearerLease) {
  try { assertConnectionCurrent(lease); return true; } catch { return false; }
}
export async function resolveBearer(userId: string, options: Options = {}): Promise<BearerLease> {
  const current = connectionStatus(userId);
  if (!current) throw new OAuthError('reconnect_required');
  const context = requestConnection.getStore();
  if (context && (context.userId !== userId || context.revision !== current.revision || !context.sessionCurrent())) throw new OAuthError('connection_changed');
  const expected = options.expectedRevision ?? context?.revision ?? current.revision;
  if (expected !== current.revision) throw new OAuthError('connection_changed');
  let result: BearerLease;
  if (current.kind === 'oauth') {
    if (credentialExists(userId)) throw new OAuthError('reconnect_required');
    const oauth = await resolveOAuthBearer(userId, options.requiredScopes ?? 0, expected);
    result = { userId, kind: 'oauth', bearer: oauth.bearer, revision: oauth.revision, scopes: oauth.scope };
  } else {
    const bearer = readCredential(userId);
    if (!bearer) throw new OAuthError('reconnect_required');
    result = { userId, kind: 'api_key', bearer, revision: current.revision, scopes: current.grantedScopes };
  }
  assertConnectionCurrent(result);
  if (result.scopes !== null && (result.scopes & (options.requiredScopes ?? 0)) !== (options.requiredScopes ?? 0)) throw new OAuthError('insufficient_scope');
  return result;
}

// The only authenticated provider-dispatch boundary. Fixed origins prevent
// accidental forwarding to media hosts; resolve after all earlier awaits.
export async function providerFetch(lease: BearerLease, url: string, init: RequestInit = {}, requiredScopes = 0,
  beforeDispatch?: () => void): Promise<Response> {
  const parsed = new URL(url);
  const service = parsed.origin === 'https://civitai.com' ? 'site' : parsed.origin === 'https://orchestration.civitai.com' ? 'orchestration'
    : parsed.origin === 'https://mcp.civitai.com' ? 'mcp' : null;
  if (!service || parsed.username || parsed.password) throw new OAuthError('connection_changed');
  const fresh = await resolveBearer(lease.userId, { expectedRevision: lease.revision, requiredScopes, service });
  const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${fresh.bearer}`);
  assertConnectionCurrent(fresh);
  beforeDispatch?.();
  // Update only the in-memory lease bearer for response redaction; identity is stable.
  lease.bearer = fresh.bearer;
  return fetch(url, { ...init, headers, redirect: 'error' });
}
