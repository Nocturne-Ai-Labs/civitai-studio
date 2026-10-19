import { validOutputCategory, type OutputCategory } from '../shared/output-folders';
import { constants, accessSync, lstatSync, realpathSync, mkdirSync, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync } from 'node:fs';
import { resolve, parse, join, sep, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { db } from './storage';
import type { LocalSaveJob, LocalStorageSettings } from '../shared/local-storage';
import { desktopRuntime } from './desktop-runtime';

const limit = 500 * 1024 * 1024;
const project = realpathSync(desktopRuntime()?.dataDir ?? resolve(import.meta.dir, '..'));
const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (path: string, root: string) => same(path, root) || (process.platform === 'win32' ? path.toLowerCase().startsWith(root.toLowerCase() + sep) : path.startsWith(root + sep));
const fail = () => new Error('Choose an existing local directory outside the project, without links or special path components.');
export type Destination = { base_path: string; effective_path: string; identity: string };
export type ManifestItem = { category: OutputCategory; maxBytes?: number; outputId: string; filename: string | null; dateFolder: string | null; metadata?: Record<string, unknown> };
const jobs = new Map<string, { job: LocalSaveJob; updated: number }>();
const busy = new Set<string>();

db.exec(`CREATE TABLE IF NOT EXISTS studio_local_destinations (user_id TEXT PRIMARY KEY, base_path TEXT NOT NULL, effective_path TEXT NOT NULL, identity TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_local_exports (user_id TEXT NOT NULL, destination TEXT NOT NULL, output_id TEXT NOT NULL, generation_id TEXT NOT NULL, date_folder TEXT NOT NULL, filename TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, sidecar_sha256 TEXT NOT NULL, PRIMARY KEY(user_id,destination,output_id,generation_id));`);

db.exec(`CREATE TABLE IF NOT EXISTS studio_local_exports_v2 (user_id TEXT NOT NULL, destination TEXT NOT NULL, output_id TEXT NOT NULL, generation_id TEXT NOT NULL, category TEXT NOT NULL, date_folder TEXT NOT NULL, filename TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, sidecar_sha256 TEXT NOT NULL, PRIMARY KEY(user_id,destination,output_id,generation_id,category));`);
export const localSaveBusy = (userId: string) => busy.has(userId) || busy.size >= 2;

// All ancestors must be ordinary directories; never normalize away hostile segments.
function directory(path: string): string {
  if (!isAbsolute(path) || path.length > 2048 || /[\x00-\x1f]/.test(path) || path.split(/[\\/]/).some(p => p === '.' || p === '..')) throw fail();
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(path) || /[:*?"<>|]/.test(path.slice(2)) || path.split(/[\\/]/).some(p => /[. ]$/.test(p)))) throw fail();
  const normalized = resolve(path), root = parse(normalized).root;
  let current = root;
  for (const part of normalized.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail();
    if (!same(realpathSync(current), current)) throw fail();
  }
  const canonical = realpathSync(normalized);
  if (same(canonical, root) || within(canonical, project)) throw fail();
  return canonical;
}
function identity(path: string) { const s = lstatSync(path); return `${s.dev}:${s.ino}`; }
export function destination(userId: string) { return db.query('SELECT * FROM studio_local_destinations WHERE user_id=?').get(userId) as Destination | null; }
function checkedDestination(value: Destination) {
  if (!same(directory(value.base_path), value.base_path) || !same(directory(value.effective_path), value.effective_path) || identity(value.effective_path) !== value.identity) throw fail();
  return value.effective_path;
}
export function localSettings(userId: string): LocalStorageSettings {
  const value = destination(userId);
  return { enabled: true, basePath: value?.base_path ?? null, effectivePath: value?.effective_path ?? null, busy: busy.has(userId), job: jobs.get(userId)?.job ?? null };
}
export function configureLocalDestination(userId: string, input: unknown) {
  if (busy.has(userId)) throw new Error('Wait for the current folder save to finish before changing its destination.');
  if (typeof input !== 'string' || input.split(/[\\/]/).some(p => /^studio-account-/i.test(p))) throw fail();
  try {
    const base = directory(input);
    const effective = join(base, `studio-account-${createHash('sha256').update(userId).digest('hex').slice(0, 24)}`);
    try { mkdirSync(effective, { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    directory(effective);
    accessSync(effective, constants.W_OK);
    db.query('INSERT INTO studio_local_destinations VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET base_path=excluded.base_path,effective_path=excluded.effective_path,identity=excluded.identity').run(userId, base, effective, identity(effective));
    return localSettings(userId);
  } catch { throw fail(); }
}
function childDirectory(value: Destination, category: OutputCategory, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail();
  if (!validOutputCategory(category)) throw fail();
  const root = checkedDestination(value), categoryPath = join(root, category);
  try { mkdirSync(categoryPath, { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  directory(categoryPath);
  const path = join(categoryPath, date);
  try { mkdirSync(path, { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  directory(path);
  return path;
}
function digestFile(path: string, max: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw fail();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) throw fail();
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let total = 0, size: number;
    while ((size = readSync(fd, buffer, 0, buffer.length, null))) { total += size; if (total > max) throw fail(); hash.update(buffer.subarray(0, size)); }
    return { bytes: total, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}
function safeName(value: string | null) {
  const name = (value ?? 'output.bin').replace(/[^a-z0-9._-]/gi, '_').slice(-120).replace(/^\.+/, '');
  return `${randomUUID()}-${name || 'output.bin'}`;
}
function writeAll(fd: number, data: Uint8Array) { let offset = 0; while (offset < data.length) { const n = writeSync(fd, data, offset, data.length - offset); if (!n) throw fail(); offset += n; } }

export function startLocalSave(userId: string, items: ManifestItem[], content: (item: ManifestItem) => Promise<Response>, assertCurrent: () => void, options: { automatic?: boolean; destination?: Destination; finished?: (job: LocalSaveJob) => void } = {}): LocalSaveJob {
  if (busy.has(userId) || busy.size >= 2) throw new Error('A folder save is already running. Try again when it finishes.');
  const value = options.destination ?? destination(userId);
  if (!value) throw new Error('Configure a destination in Settings first.');
  try { checkedDestination(value); } catch { throw fail(); }
  // Bound retained progress; SQLite retains only completed deduplication records.
  for (const [owner, old] of jobs) if (!busy.has(owner) && Date.now() - old.updated > 30 * 60_000) jobs.delete(owner);
  if (jobs.size >= 100 && !jobs.has(userId)) { const owner = [...jobs.keys()].find(id => !busy.has(id)); if (owner) jobs.delete(owner); }
  const job: LocalSaveJob = { automatic: options.automatic, id: randomUUID(), status: 'saving', items: items.map(item => ({ outputId: item.outputId, category: item.category, status: 'pending', bytes: 0, filename: null, dateFolder: item.dateFolder, error: null })) };
  jobs.set(userId, { job, updated: Date.now() }); busy.add(userId);
  // Invoked inside the authenticated request's AsyncLocalStorage context. Every
  // network transfer, chunk write and completion checks the original session/lease.
  void (async () => {
    let total = 0;
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!, row = job.items[index]!;
        let fd: number | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          assertCurrent(); row.status = 'saving';
          const date = item.dateFolder!, category = item.category, fileLimit = Math.min(item.maxBytes ?? limit, 1024 * 1024 * 1024), folder = childDirectory(value, category, date);
          const generationId = String(item.metadata?.generationId ?? '');
          const prior = db.query('SELECT * FROM studio_local_exports_v2 WHERE user_id=? AND destination=? AND output_id=? AND generation_id=? AND category=?').get(userId, value.effective_path, item.outputId, generationId, category) as any;
          if (prior && /^[a-z0-9._-]+$/i.test(prior.filename) && /^\d{4}-\d{2}-\d{2}$/.test(prior.date_folder)) {
            try {
              const oldFolder = directory(join(checkedDestination(value), category, prior.date_folder));
              const media = digestFile(join(oldFolder, prior.filename), fileLimit), sidecar = digestFile(join(oldFolder, prior.filename + '.studio.json'), 4 * 1024 * 1024);
              if (media.bytes === prior.bytes && media.sha256 === prior.sha256 && sidecar.sha256 === prior.sidecar_sha256) {
                assertCurrent(); Object.assign(row, { status: 'duplicate', bytes: media.bytes, filename: prior.filename, dateFolder: prior.date_folder }); continue;
              }
            } catch { /* Missing/changed originals are retained; a retry gets a new unique name. */ }
          }
          if (total >= 2 * 1024 * 1024 * 1024) throw fail();
          const response = await content(item);
          if (!response.ok || !response.body) { await response.body?.cancel(); throw fail(); }
          reader = response.body.getReader();
          assertCurrent();
          const disposition = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1];
          const filename = safeName(disposition ?? item.filename);
          childDirectory(value, category, date);
          fd = openSync(join(folder, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
          row.filename = filename;
          const hash = createHash('sha256');
          while (true) {
            const { done, value: chunk } = await reader.read();
            assertCurrent(); childDirectory(value, category, date);
            if (done) break;
            total += chunk.byteLength; row.bytes += chunk.byteLength;
            if (row.bytes > fileLimit || total > 2 * 1024 * 1024 * 1024) throw fail();
            writeAll(fd, chunk); hash.update(chunk);
          }
          if (!row.bytes) throw fail();
          fsyncSync(fd); closeSync(fd); fd = undefined;
          const sha256 = hash.digest('hex');
          assertCurrent(); childDirectory(value, category, date);
          const data = Buffer.from(JSON.stringify({ ...item.metadata, localSave: { version: 2, category, accountId: userId, outputId: item.outputId, generationId, filename, bytes: row.bytes, sha256, complete: true } }, null, 2));
          if (data.byteLength > 4 * 1024 * 1024) throw fail();
          // Record expected hashes before the sidecar write. After interruption, a
          // retry can verify both completed files without downloading them again.
          db.query('INSERT OR REPLACE INTO studio_local_exports_v2 VALUES (?,?,?,?,?,?,?,?,?,?)').run(userId, value.effective_path, item.outputId, generationId, category, date, filename, row.bytes, sha256, createHash('sha256').update(data).digest('hex'));
          fd = openSync(join(folder, filename + '.studio.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
          writeAll(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined;
          assertCurrent(); childDirectory(value, category, date);
          row.status = 'saved';
        } catch {
          row.status = 'failed'; row.error = 'Save failed: check the connection, folder access, free space and size limits. Partial files are retained; retry creates a new file.';
        } finally { if (fd !== undefined) try { closeSync(fd); } catch {} if (reader) try { await reader.cancel(); } catch {} }
      }
      job.status = job.items.every(i => i.status === 'failed') ? 'failed' : job.items.some(i => i.status === 'failed') ? 'partial' : 'completed';
    } finally { busy.delete(userId); jobs.set(userId, { job, updated: Date.now() }); options.finished?.(job); }
  })();
  return job;
}
