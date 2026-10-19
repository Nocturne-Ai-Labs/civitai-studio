import { db } from './storage'
import { browsingModes, type BrowsingMode, type BrowsingPreference } from '../shared/browsing'

db.exec(`CREATE TABLE IF NOT EXISTS studio_browsing_preferences (
  user_id TEXT PRIMARY KEY REFERENCES studio_users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('safe','pg13','mature')),
  revision TEXT NOT NULL
)`)

export function getBrowsingPreference(userId: string): BrowsingPreference {
  db.query('INSERT OR IGNORE INTO studio_browsing_preferences (user_id,mode,revision) VALUES (?,?,?)').run(userId,'safe',crypto.randomUUID())
  return db.query<{ mode: BrowsingMode; revision: string }, [string]>('SELECT mode,revision FROM studio_browsing_preferences WHERE user_id=?').get(userId)!
}
export function setBrowsingPreference(userId: string, mode: unknown): BrowsingPreference {
  if (typeof mode !== 'string' || !browsingModes.includes(mode as BrowsingMode)) throw new Error('Choose a supported browsing preference.')
  getBrowsingPreference(userId)
  db.query('UPDATE studio_browsing_preferences SET mode=?,revision=? WHERE user_id=?').run(mode,crypto.randomUUID(),userId)
  return getBrowsingPreference(userId)
}
