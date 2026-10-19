import { db, findGeneration, onGenerationSaved, type StoredGeneration } from './storage';
import { assertConnectionCurrent, connectionStatus, resolveBearer, withAccountConnection, type BearerLease } from './connection';
import { destination, localSaveBusy, startLocalSave, type ManifestItem, type Destination } from './local-storage';
import type { LocalStorageSettings } from '../shared/local-storage';

db.exec(`CREATE TABLE IF NOT EXISTS studio_auto_preferences (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, since TEXT, message TEXT NOT NULL DEFAULT '', next_history INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS studio_auto_workflows (user_id TEXT NOT NULL, generation_id TEXT NOT NULL, workflow_id TEXT, destination_json TEXT NOT NULL, state TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', next_check INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,generation_id), UNIQUE(user_id,workflow_id));
CREATE TABLE IF NOT EXISTS studio_auto_outputs (user_id TEXT NOT NULL, generation_id TEXT NOT NULL, output_id TEXT NOT NULL, state TEXT NOT NULL, category TEXT NOT NULL, date_folder TEXT NOT NULL, filename TEXT, bytes INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id,generation_id,output_id));`);
type Preference = { user_id: string; enabled: number; since: string | null; message: string; next_history: number };
type Work = { user_id: string; generation_id: string; destination_json: string; state: string; next_check: number; created_at: number; message: string };
type Output = { output_id: string; category: string; date_folder: string; state: string };
type Adapter = {
  enabled: boolean;
  refresh: (userId: string, generation: any, lease: BearerLease) => Promise<any>;
  history: (userId: string, cutoff: string) => Promise<void>;
  manifest: (generation: any, output: any) => ManifestItem;
  content: (userId: string, generation: any, outputId: string) => Promise<Response>;
};
let adapter: Adapter | null = null, ticking = false;
function preference(userId: string) {
  db.query('INSERT OR IGNORE INTO studio_auto_preferences(user_id) VALUES (?)').run(userId);
  return db.query('SELECT * FROM studio_auto_preferences WHERE user_id=?').get(userId) as Preference;
}
export function destinationActivated(userId: string) {
  const p = preference(userId);
  // A destination edit must not exclude eligible website work not yet discovered.
  // Only initial activation fills this watermark; OFF -> ON resets it explicitly.
  if (p.enabled && !p.since) db.query('UPDATE studio_auto_preferences SET since=?,next_history=0 WHERE user_id=? AND since IS NULL').run(new Date().toISOString(), userId);
}
export function setAutoSave(userId: string, enabled: boolean) {
  const p = preference(userId);
  if (Boolean(p.enabled) === enabled) return;
  db.transaction(() => {
    db.query('UPDATE studio_auto_preferences SET enabled=?,since=?,next_history=0 WHERE user_id=?').run(enabled ? 1 : 0, enabled && destination(userId) ? new Date().toISOString() : null, userId);
    if (!enabled) {
      db.query("UPDATE studio_auto_workflows SET state='paused',message='Auto-save was turned off. Retry explicitly to resume this workflow.' WHERE user_id=? AND state!='done'").run(userId);
      db.query("UPDATE studio_auto_outputs SET state='paused' WHERE user_id=? AND state IN ('pending','saving')").run(userId);
    }
  })();
}
export function autoSettings(userId: string): Partial<LocalStorageSettings> {
  const p = preference(userId), connected = connectionStatus(userId);
  const rows = db.query("SELECT * FROM studio_auto_workflows WHERE user_id=? ORDER BY CASE WHEN state='done' THEN 1 ELSE 0 END,created_at DESC LIMIT 100").all(userId) as Work[];
  const count = (db.query('SELECT count(*) AS n FROM studio_auto_workflows WHERE user_id=?').get(userId) as any).n;
  return { autoSave: !!p.enabled, autoSaveSince: p.since,
    autoSaveStatus: !p.enabled ? 'Off. Existing paused work requires an explicit retry.' : !destination(userId) ? 'Waiting for a destination.' : !connected ? 'Paused: reconnect Civitai to continue.' : p.message || 'Watching new Studio and Civitai website workflows. Website history coverage is limited by Civitai.',
    autoQueueTotal: count, autoQueue: rows.map(row => {
      const items = db.query('SELECT state FROM studio_auto_outputs WHERE user_id=? AND generation_id=?').all(userId, row.generation_id) as { state: string }[];
      return { generationId: row.generation_id, status: row.state, message: row.message, destination: (JSON.parse(row.destination_json) as Destination).effective_path,
        total: items.length, saved: items.filter(i => i.state === 'saved').length, failed: items.filter(i => i.state === 'failed').length };
    }) };
}
export function retryAutoSave(userId: string, generationId: unknown) {
  if (typeof generationId !== 'string' || !preference(userId).enabled) throw new Error('Turn auto-save on before retrying a queued workflow.');
  if (localSaveBusy(userId)) throw new Error('Wait for the current save to finish.');
  const work = db.query('SELECT * FROM studio_auto_workflows WHERE user_id=? AND generation_id=?').get(userId, generationId) as Work | null;
  if (!work || !['failed', 'paused'].includes(work.state)) throw new Error('Choose a failed or paused workflow.');
  db.transaction(() => {
    db.query("UPDATE studio_auto_outputs SET state='pending',message='' WHERE user_id=? AND generation_id=? AND state!='saved'").run(userId, generationId);
    db.query("UPDATE studio_auto_workflows SET state='watching',next_check=0,message='',created_at=? WHERE user_id=? AND generation_id=?").run(Date.now(), userId, generationId);
  })();
}
function observe(userId: string, generation: StoredGeneration) {
  if (!adapter?.enabled) return;
  const p = preference(userId), target = destination(userId);
  const eligibleAt = typeof generation.autoSaveEligibleAt === 'string' ? Date.parse(generation.autoSaveEligibleAt) : NaN;
  if (!p.enabled || !p.since || !target || !Number.isFinite(eligibleAt) || eligibleAt < Date.parse(p.since) || eligibleAt > Date.now() + 60_000) return;
  const known = db.query('SELECT 1 FROM studio_auto_workflows WHERE user_id=? AND generation_id=?').get(userId, generation.id);
  const workflowId = typeof generation.providerWorkflowId === 'string' ? generation.providerWorkflowId : null;
  if (known) {
    if (workflowId) {
      const other = db.query('SELECT generation_id FROM studio_auto_workflows WHERE user_id=? AND workflow_id=?').get(userId,workflowId) as {generation_id:string}|null;
      if (other && other.generation_id !== generation.id) db.query("UPDATE studio_auto_workflows SET state='done',message='This workflow is tracked under its existing queue entry.' WHERE user_id=? AND generation_id=?").run(userId,generation.id);
      else db.query('UPDATE studio_auto_workflows SET workflow_id=? WHERE user_id=? AND generation_id=?').run(workflowId,userId,generation.id);
    }
    return;
  }
  if (workflowId && db.query('SELECT 1 FROM studio_auto_workflows WHERE user_id=? AND workflow_id=?').get(userId,workflowId)) return;
  const count = (db.query("SELECT count(*) AS n FROM studio_auto_workflows WHERE user_id=? AND state!='done'").get(userId) as any).n;
  const globalCount = (db.query("SELECT count(*) AS n FROM studio_auto_workflows WHERE state!='done'").get() as any).n;
  if (count >= 100 || globalCount >= 1000) { db.query('UPDATE studio_auto_preferences SET message=? WHERE user_id=?').run('Auto-save queue capacity reached (100 workflows per account). Some new work needs manual saving.', userId); return; }
  db.query("INSERT OR IGNORE INTO studio_auto_workflows VALUES (?,?,?,?,'watching','',0,?)").run(userId, generation.id, workflowId, JSON.stringify(target), Date.now());
}
function active(work: Work) {
  if (!adapter?.enabled || !preference(work.user_id).enabled) return false;
  const current = db.query('SELECT state FROM studio_auto_workflows WHERE user_id=? AND generation_id=?').get(work.user_id, work.generation_id) as { state: string } | null;
  return !!current && !['paused', 'failed', 'done'].includes(current.state);
}
function note(work: Work, state: string, message: string) {
  // A toggle/retry that happened while awaiting a network operation wins.
  if (!active(work)) return;
  db.query('UPDATE studio_auto_workflows SET state=?,message=? WHERE user_id=? AND generation_id=?').run(state, message, work.user_id, work.generation_id);
}
function enqueue(work: Work, generation: any) {
  if (!active(work) || !['succeeded', 'failed', 'canceled', 'expired'].includes(generation.status)) return;
  const outputs = (generation.outputs ?? []).filter((o: any) => o.role !== 'thumbnail' && (generation.mediaType === 'training' ? o.metadata?.available === true : o.metadata?.available !== false && typeof o.url === 'string'));
  if (outputs.length > 250) { note(work, 'failed', 'More than 250 outputs: save this workflow manually in batches.'); return; }
  const currentCount = (db.query("SELECT count(*) AS n FROM studio_auto_outputs WHERE user_id=? AND state!='saved'").get(work.user_id) as any).n;
  const existing = db.query('SELECT output_id FROM studio_auto_outputs WHERE user_id=? AND generation_id=?').all(work.user_id, work.generation_id) as { output_id: string }[];
  const added = outputs.filter((o: any) => !existing.some(e => e.output_id === o.id));
  if (currentCount + added.length > 1000) { note(work, 'failed', 'Queue reached 1,000 unsaved outputs. Complete existing work, then retry.'); return; }
  db.transaction(() => {
    for (const output of added) {
      const item = adapter!.manifest(generation, output);
      db.query("INSERT OR IGNORE INTO studio_auto_outputs(user_id,generation_id,output_id,state,category,date_folder) VALUES (?,?,?,'pending',?,?)").run(work.user_id, work.generation_id, output.id, item.category, item.dateFolder!);
    }
  })();
  const rows = db.query('SELECT state FROM studio_auto_outputs WHERE user_id=? AND generation_id=?').all(work.user_id, work.generation_id) as { state: string }[];
  if (rows.some(r => r.state === 'failed')) note(work, 'failed', 'Some outputs failed. Retry this workflow to continue; saved files are retained.');
  else if (rows.some(r => r.state !== 'saved')) note(work, 'ready', 'Outputs queued for the original destination.');
  else if (generation.autoOutputsPending) note(work, 'watching', 'Waiting for Civitai to make completed output artifacts available.');
  else if (generation.status === 'succeeded' && !rows.length) note(work, 'failed', 'Workflow completed without a usable original URL. Retry after refreshing its availability, or save manually.');
  else note(work, 'done', rows.length ? 'All available outputs saved.' : 'Workflow ended without available outputs.');
}
async function advance(work: Work) {
  if (!adapter || !active(work) || localSaveBusy(work.user_id)) return;
  const connection = connectionStatus(work.user_id);
  if (!connection) { note(work, work.state, 'Paused: reconnect this account to continue.'); return; }
  await withAccountConnection(work.user_id, connection.revision, async () => {
    const lease = await resolveBearer(work.user_id), assert = () => { if (!active(work)) throw new Error('Auto-save paused'); assertConnectionCurrent(lease); };
    let generation = findGeneration(work.user_id, work.generation_id) as any;
    if (!generation) { note(work, 'failed', 'Saved workflow was not found.'); return; }
    if (!generation.providerWorkflowId) {
      if(generation.submissionState==='blocked_recovery'){note(work,'done','Legacy recovery is blocked; inspect its preserved external ID in Studio. No workflow was submitted or discarded.');return;}
      note(work, generation.submissionState === 'rejected' ? 'done' : 'watching', 'Awaiting workflow identity. Recover an uncertain submission in Studio; auto-save never submits work.'); return;
    }
    try {
      if (Date.now() >= work.next_check) {
        db.query('UPDATE studio_auto_workflows SET next_check=? WHERE user_id=? AND generation_id=?').run(Date.now() + 30_000, work.user_id, work.generation_id);
        generation = await adapter!.refresh(work.user_id, generation, lease); assert();
      }
      enqueue(work, generation); if (!active(work)) return;
      const item = db.query("SELECT * FROM studio_auto_outputs WHERE user_id=? AND generation_id=? AND state='pending' ORDER BY output_id LIMIT 1").get(work.user_id, work.generation_id) as Output | null;
      if (!item) return;
      const output = generation.outputs.find((o: any) => o.id === item.output_id);
      if (!output) { note(work, 'failed', 'A queued output is no longer available.'); return; }
      const manifest = adapter!.manifest(generation, output);
      // Pin date/category as well as destination for the lifetime of this queue item.
      manifest.dateFolder = item.date_folder;
      manifest.metadata = { ...manifest.metadata, dateFolder: item.date_folder };
      if (manifest.category !== item.category) throw new Error('Output category changed');
      assert();
      db.query("UPDATE studio_auto_outputs SET state='saving' WHERE user_id=? AND generation_id=? AND output_id=?").run(work.user_id, work.generation_id, item.output_id);
      try {
        startLocalSave(work.user_id, [manifest], async () => { assert(); return adapter!.content(work.user_id, generation, item.output_id); }, assert, {
          automatic: true, destination: JSON.parse(work.destination_json), finished(job) {
            const result = job.items[0]!;
            const saved = ['saved', 'duplicate'].includes(result.status);
            const state = saved ? 'saved' : active(work) ? 'failed' : 'paused';
            db.query('UPDATE studio_auto_outputs SET state=?,filename=?,bytes=?,message=? WHERE user_id=? AND generation_id=? AND output_id=?').run(state, result.filename, result.bytes, result.error ?? '', work.user_id, work.generation_id, item.output_id);
            if (!saved) note(work, 'failed', result.error ?? 'Output save failed. Retry to continue.');
            else enqueue(work, generation);
          },
        });
      } catch { db.query("UPDATE studio_auto_outputs SET state='pending' WHERE user_id=? AND generation_id=? AND output_id=? AND state='saving'").run(work.user_id, work.generation_id, item.output_id); throw new Error('Destination unavailable'); }
    } catch { note(work, 'failed', 'Could not refresh or save this workflow. Check connection, destination and provider availability, then retry.'); }
  }, () => active(work));
}
export function initializeAutoSave(value: Adapter) {
  adapter = value;
  if (!value.enabled) return;
  // Interrupted output writes are retryable and verified against the file ledger.
  db.query("UPDATE studio_auto_outputs SET state='pending' WHERE state='saving'").run();
  onGenerationSaved(observe);
  // Existing configured destinations start from deployment time, never old history.
  for (const row of db.query('SELECT user_id FROM studio_local_destinations').all() as { user_id: string }[]) { const p = preference(row.user_id); if (p.enabled && !p.since) destinationActivated(row.user_id); }
  const timer = setInterval(() => void tick(), 5000); timer.unref();
}
async function tick() {
  if (ticking || !adapter?.enabled) return;
  ticking = true;
  try {
    // Fair, bounded work: at most four workflow status advances and one recent
    // history scan per tick. No paid endpoint exists in this worker adapter.
    const works = db.query("SELECT * FROM studio_auto_workflows WHERE state IN ('watching','ready') ORDER BY next_check,created_at LIMIT 4").all() as Work[];
    for (const work of works) {
      if (Date.now() - work.created_at > 30 * 86400_000) { note(work, 'failed', 'Automatic tracking expired after 30 days. Retry explicitly if the provider still retains this workflow.'); continue; }
      try { await advance(work); } catch { note(work, 'failed', 'Connection unavailable. Reconnect and retry.'); }
      // Rotate even disconnected/identity-pending workflows to prevent starvation.
      db.query('UPDATE studio_auto_workflows SET next_check=max(next_check,?) WHERE user_id=? AND generation_id=?').run(Date.now() + 5000, work.user_id, work.generation_id);
    }
    const prefs = db.query('SELECT * FROM studio_auto_preferences WHERE enabled=1 AND since IS NOT NULL AND next_history<=? ORDER BY next_history LIMIT 10').all(Date.now()) as Preference[];
    for (const p of prefs) {
      db.query('UPDATE studio_auto_preferences SET next_history=? WHERE user_id=?').run(Date.now() + 60_000, p.user_id);
      const connection = connectionStatus(p.user_id); if (!connection || !destination(p.user_id)) continue;
      try { await withAccountConnection(p.user_id, connection.revision, () => adapter!.history(p.user_id, p.since!), () => !!adapter?.enabled && !!preference(p.user_id).enabled && preference(p.user_id).since === p.since); }
      catch { db.query('UPDATE studio_auto_preferences SET message=? WHERE user_id=?').run('Website discovery paused or incomplete. Check the connection; discovery retries each minute. Existing queue remains available.', p.user_id); }
      break;
    }
  } finally { ticking = false; }
}
