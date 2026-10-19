import type { ComposerConfig, Preset } from '../shared/composer';
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { studioEncryptionKey as encryptionKey } from './encryption-key';
import { desktopBuild } from './desktop-runtime';

const production = process.env.NODE_ENV === "production";
if (production && !encryptionKey) throw new Error("STUDIO_ENCRYPTION_KEY or STUDIO_ENCRYPTION_KEY_FILE is required in production");
if (production && !desktopBuild && !process.env.PUBLIC_BASE_URL?.startsWith("https://")) {
  throw new Error("PUBLIC_BASE_URL must be HTTPS in production");
}
const dbPath = process.env.STUDIO_DATABASE_PATH ?? "./data/studio.sqlite";
if (!dbPath.trim()) throw new Error("STUDIO_DATABASE_PATH must not be blank");
if (production && dbPath === ":memory:") throw new Error("Production requires a persistent STUDIO_DATABASE_PATH");
export const credentialStorage = {
  mode: encryptionKey ? "encrypted" as const : "memory" as const,
  persistent: Boolean(encryptionKey) && dbPath !== ":memory:",
};
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath, { create: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS studio_users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS civitai_credentials (
    user_id TEXT PRIMARY KEY REFERENCES studio_users(id) ON DELETE CASCADE,
    iv BLOB,
    ciphertext BLOB,
    tag BLOB,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connection_clock (id INTEGER PRIMARY KEY CHECK(id=1), serial INTEGER NOT NULL);
  INSERT OR IGNORE INTO connection_clock VALUES (1,0);
  CREATE TABLE IF NOT EXISTS connection_changes (user_id TEXT PRIMARY KEY, serial INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS credential_revisions (user_id TEXT PRIMARY KEY, revision TEXT NOT NULL, scope INTEGER);
  CREATE TABLE IF NOT EXISTS civitai_access (
    user_id TEXT PRIMARY KEY REFERENCES studio_users(id) ON DELETE CASCADE,
    token_scope INTEGER,
    buzz_limit_json TEXT
  );
  CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS collection_destinations (
    user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,
    collection_id INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY(user_id, collection_id)
  );
  CREATE TABLE IF NOT EXISTS site_collection_saves (
    user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    destination_id INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY(user_id, item_type, item_id, destination_id)
  );
  CREATE TABLE IF NOT EXISTS collection_transfers (
    user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,
    output_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY(user_id, output_id)
  );
  CREATE TABLE IF NOT EXISTS composer_presets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS composer_presets_user ON composer_presets(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS generations_user_created ON generations(user_id, created_at DESC);
`);

export type StudioUser = { id: string; displayName: string; createdAt: string };
const localCredentials = new Map<string, string>();

export function upsertUser(id: string, displayName: string): StudioUser {
  const createdAt = new Date().toISOString();
  db.query(`INSERT INTO studio_users (id, display_name, created_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name`).run(id, displayName, createdAt);
  return getUser(id)!;
}

export function getUser(id: string): StudioUser | null {
  const row = db.query<{ id: string; display_name: string; created_at: string }, [string]>(
    "SELECT id,display_name,created_at FROM studio_users WHERE id = ?",
  ).get(id);
  return row ? { id: row.id, displayName: row.display_name, createdAt: row.created_at } : null;
}

function digest(token: string) { return createHash("sha256").update(token).digest("hex"); }

export function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
  db.query("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)")
    .run(digest(token), userId, expiresAt, Date.now());
  return { token, expiresAt };
}

export function getSessionUser(token: string | undefined): StudioUser | null {
  if (!token) return null;
  const hash = digest(token);
  const row = db.query<{ user_id: string; expires_at: number }, [string]>(
    "SELECT user_id,expires_at FROM sessions WHERE token_hash = ?",
  ).get(hash);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    return null;
  }
  return getUser(row.user_id);
}

export function removeSession(token: string | undefined) {
  if (token) db.query("DELETE FROM sessions WHERE token_hash = ?").run(digest(token));
}

export function storeCredential(userId: string, credential: string, tokenScope?: number, buzzLimit?: unknown) {
  return db.transaction(() => {
  markConnectionChange(userId);
  db.query("INSERT INTO credential_revisions VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,scope=excluded.scope").run(userId,crypto.randomUUID(),tokenScope ?? null);
  db.query(`INSERT INTO civitai_access (user_id,token_scope,buzz_limit_json) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET token_scope=excluded.token_scope,buzz_limit_json=excluded.buzz_limit_json`)
    .run(userId, Number.isInteger(tokenScope) ? tokenScope! : null, buzzLimit === undefined ? null : JSON.stringify(buzzLimit));
  if (!encryptionKey) {
    // Local runs without configured secrets keep API keys in process memory only.
    localCredentials.set(userId, credential);
    db.query("DELETE FROM civitai_credentials WHERE user_id = ?").run(userId);
    return;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(userId));
  const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  db.query(`INSERT INTO civitai_credentials (user_id,iv,ciphertext,tag,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET iv=excluded.iv,ciphertext=excluded.ciphertext,tag=excluded.tag,updated_at=excluded.updated_at`)
    .run(userId, iv, ciphertext, cipher.getAuthTag(), new Date().toISOString());
  localCredentials.delete(userId);
  }).immediate();
}

export function readCredential(userId: string): string | null {
  const local = localCredentials.get(userId);
  if (local) return local;
  if (!encryptionKey) return null;
  const row = db.query<{ iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }, [string]>(
    "SELECT iv,ciphertext,tag FROM civitai_credentials WHERE user_id = ?",
  ).get(userId);
  if (!row?.iv || !row.ciphertext || !row.tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, row.iv);
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // A missing/replaced master key or damaged record requires reconnecting;
    // never expose crypto diagnostics or discard the recoverable sealed record.
    return null;
  }
}

export function removeCredential(userId: string) {
  markConnectionChange(userId);
  db.query("DELETE FROM credential_revisions WHERE user_id=?").run(userId);
  localCredentials.delete(userId);
  db.query("DELETE FROM civitai_credentials WHERE user_id = ?").run(userId);
  db.query("DELETE FROM civitai_access WHERE user_id = ?").run(userId);
}

export function credentialExists(userId: string) {
  return localCredentials.has(userId) || Boolean(db.query("SELECT 1 FROM civitai_credentials WHERE user_id = ?").get(userId));
}

export function getTokenScope(userId: string): number | null | undefined {
  return db.query<{ token_scope: number | null }, [string]>("SELECT token_scope FROM civitai_access WHERE user_id = ?").get(userId)?.token_scope;
}

export type StoredGeneration = Record<string, unknown> & { id: string; createdAt: string; updatedAt: string; status: string };
let generationSaved: ((userId: string, record: StoredGeneration) => void) | null = null;
export function onGenerationSaved(listener: (userId: string, record: StoredGeneration) => void) { generationSaved = listener; }
export function findGeneration(userId: string, id: string): StoredGeneration | null {
  const row = db.query<{ record_json: string }, [string, string]>("SELECT record_json FROM generations WHERE user_id=? AND id=?").get(userId, id);
  return row ? JSON.parse(row.record_json) as StoredGeneration : null;
}

export function findIdempotentGeneration(userId: string, key: string): StoredGeneration | null {
  const row = db.query<{ record_json: string }, [string, string]>("SELECT record_json FROM generations WHERE user_id=? AND idempotency_key=?").get(userId, key);
  return row ? JSON.parse(row.record_json) as StoredGeneration : null;
}

export function findGenerationByWorkflow(userId: string, workflowId: string): StoredGeneration | null {
  const rows = db.query<{ record_json: string }, [string]>("SELECT record_json FROM generations WHERE user_id=?").all(userId);
  for (const row of rows) {
    const record = JSON.parse(row.record_json) as StoredGeneration & { providerWorkflowId?: string };
    if (record.providerWorkflowId === workflowId) return record;
  }
  return null;
}

export function saveGeneration(userId: string, idempotencyKey: string, record: StoredGeneration) {
  db.query(`INSERT INTO generations (id,user_id,idempotency_key,status,record_json,created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json`)
    .run(record.id, userId, idempotencyKey, record.status, JSON.stringify(record), record.createdAt);
  generationSaved?.(userId, record);
}

export function listGenerations(userId: string, limit = 50, before?: { createdAt: string; id: string }) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = before
    ? db.query<{ record_json: string }, [string, string, string, string, number]>("SELECT record_json FROM generations WHERE user_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(userId, before.createdAt, before.createdAt, before.id, safeLimit + 1)
    : db.query<{ record_json: string }, [string, number]>("SELECT record_json FROM generations WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(userId, safeLimit + 1);
  const items = rows.slice(0, safeLimit).map((row) => JSON.parse(row.record_json) as StoredGeneration);
  return { items, hasMore: rows.length > safeLimit };
}

export function listPresets(userId: string): Preset[] {
  return db.query<{ id: string; name: string; config_json: string; updated_at: string }, [string]>("SELECT id,name,config_json,updated_at FROM composer_presets WHERE user_id=? ORDER BY updated_at DESC,id").all(userId)
    .map(row => ({ id: row.id, name: row.name, config: JSON.parse(row.config_json), updatedAt: row.updated_at }));
}
export function writePreset(userId: string, id: string | null, name: string, config: ComposerConfig): Preset | null {
  const updatedAt = new Date().toISOString();
  if (id) {
    const result = db.query("UPDATE composer_presets SET name=?,config_json=?,updated_at=? WHERE user_id=? AND id=?").run(name, JSON.stringify(config), updatedAt, userId, id);
    return result.changes ? { id, name, config, updatedAt } : null;
  }
  const nextId = `preset_${crypto.randomUUID()}`;
  db.query("INSERT INTO composer_presets (id,user_id,name,config_json,updated_at) VALUES (?,?,?,?,?)").run(nextId, userId, name, JSON.stringify(config), updatedAt);
  return { id: nextId, name, config, updatedAt };
}
export function deletePreset(userId: string, id: string) {
  return db.query("DELETE FROM composer_presets WHERE user_id=? AND id=?").run(userId, id).changes > 0;
}

// Lazy migration assigns existing API-key connections a durable, non-secret identity.
export function apiKeyRevision(userId: string): string | null {
  if (!credentialExists(userId)) return null;
  const scope = getTokenScope(userId) ?? null;
  const row = db.query<{revision:string;scope:number|null},[string]>('SELECT revision,scope FROM credential_revisions WHERE user_id=?').get(userId);
  if (row && row.scope === scope) return row.revision;
  if (row) markConnectionChange(userId);
  const revision = crypto.randomUUID();
  db.query('INSERT INTO credential_revisions VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,scope=excluded.scope').run(userId,revision,scope);
  return revision;
}

// A tombstone survives disconnect. An anonymous OAuth flow can reject a target
// account changed after it began, even though its identity was unknown at start.
export function connectionClock(): number {
  return db.query<{serial:number},[]>('SELECT serial FROM connection_clock WHERE id=1').get()!.serial;
}
export function lastConnectionChange(userId: string): number {
  return db.query<{serial:number},[string]>('SELECT serial FROM connection_changes WHERE user_id=?').get(userId)?.serial ?? 0;
}
export function markConnectionChange(userId: string) {
  db.transaction(()=>{
    db.query('UPDATE connection_clock SET serial=serial+1 WHERE id=1').run();
    db.query('INSERT INTO connection_changes VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET serial=excluded.serial').run(userId,connectionClock());
  }).immediate();
}
