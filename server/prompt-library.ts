import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { combinePrompts } from '../shared/composer'
import { validSnippet, validPromptSnapshot, promptDraftIdentity, type PromptSnippet, type PromptSnapshot, type PromptHistoryItem } from '../shared/prompt-library'

export class PromptLibraryError extends Error {}
export function createPromptLibrary(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS prompt_snippets (id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE, record_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS prompt_history (id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, record_json TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(user_id,id), UNIQUE(user_id,fingerprint));
    CREATE INDEX IF NOT EXISTS prompt_history_recent ON prompt_history(user_id,saved_at DESC);`)
  const prune = (userId: string) => {
    db.query('DELETE FROM prompt_history WHERE user_id=? AND saved_at<?').run(userId, new Date(Date.now() - 90 * 86400000).toISOString())
    db.query('DELETE FROM prompt_history WHERE user_id=? AND id NOT IN (SELECT id FROM prompt_history WHERE user_id=? ORDER BY saved_at DESC,id DESC LIMIT 100)').run(userId, userId)
  }
  return {
    snippets(userId: string): PromptSnippet[] {
      return db.query<{record_json:string},[string]>('SELECT record_json FROM prompt_snippets WHERE user_id=? ORDER BY updated_at DESC,id').all(userId).map(row => JSON.parse(row.record_json))
    },
    saveSnippet(userId: string, id: string | null, value: unknown): PromptSnippet | null {
      if (!validSnippet(value)) throw new PromptLibraryError('Use a name of 1–80 characters, a category and prompt text of 1–4,000 characters.')
      return db.transaction(() => {
        if (id && !db.query('SELECT id FROM prompt_snippets WHERE user_id=? AND id=?').get(userId, id)) return null
        if (!id && db.query<{n:number},[string]>('SELECT COUNT(*) n FROM prompt_snippets WHERE user_id=?').get(userId)!.n >= 200) throw new PromptLibraryError('Your prompt library has reached 200 presets. Remove one before saving another.')
        const item: PromptSnippet = { id: id ?? `snippet_${crypto.randomUUID()}`, name: value.name.trim(), category: value.category, text: value.text, updatedAt: new Date().toISOString() }
        db.query('INSERT INTO prompt_snippets VALUES (?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET record_json=excluded.record_json,updated_at=excluded.updated_at').run(item.id, userId, JSON.stringify(item), item.updatedAt)
        return item
      }).immediate()
    },
    deleteSnippet(userId: string, id: string) { return db.query('DELETE FROM prompt_snippets WHERE user_id=? AND id=?').run(userId, id).changes > 0 },
    history(userId: string): PromptHistoryItem[] {
      prune(userId)
      return db.query<{record_json:string},[string]>('SELECT record_json FROM prompt_history WHERE user_id=? ORDER BY saved_at DESC,id DESC').all(userId).map(row => {
        const item = JSON.parse(row.record_json) as PromptSnapshot
        return { id: item.id, savedAt: item.savedAt, context: item.context, preview: combinePrompts(item.groups).slice(0, 180) || 'Negative prompt only', groupCount: item.groups.length, hasNegative: item.negativePrompt !== undefined }
      })
    },
    snapshot(userId: string, id: string): PromptSnapshot | null {
      prune(userId)
      const row = db.query<{record_json:string},[string,string]>('SELECT record_json FROM prompt_history WHERE user_id=? AND id=?').get(userId, id)
      return row ? JSON.parse(row.record_json) : null
    },
    checkpoint(userId: string, value: unknown): PromptSnapshot {
      if (!validPromptSnapshot(value)) throw new PromptLibraryError('Use 1–20 prompt groups, supported workflow context, and up to 10,000 characters each for the combined and negative prompts. Empty prompts are not recorded.')
      return db.transaction(() => {
        const fingerprint = createHash('sha256').update(promptDraftIdentity(value)).digest('hex')
        const previous = db.query<{id:string},[string,string]>('SELECT id FROM prompt_history WHERE user_id=? AND fingerprint=?').get(userId, fingerprint)
        const latest = db.query<{saved_at:string},[string]>('SELECT saved_at FROM prompt_history WHERE user_id=? ORDER BY saved_at DESC LIMIT 1').get(userId)
        const savedAt = new Date(Math.max(Date.now(), latest ? Date.parse(latest.saved_at) + 1 : 0)).toISOString()
        const item: PromptSnapshot = { ...value, id: previous?.id ?? `prompt_${crypto.randomUUID()}`, savedAt }
        db.query('INSERT INTO prompt_history VALUES (?,?,?,?,?) ON CONFLICT(user_id,fingerprint) DO UPDATE SET record_json=excluded.record_json,saved_at=excluded.saved_at').run(item.id, userId, fingerprint, JSON.stringify(item), item.savedAt)
        prune(userId)
        return item
      }).immediate()
    },
    deleteHistory(userId: string, id: string) { return db.query('DELETE FROM prompt_history WHERE user_id=? AND id=?').run(userId, id).changes > 0 },
    clearHistory(userId: string) { db.query('DELETE FROM prompt_history WHERE user_id=?').run(userId) },
  }
}
