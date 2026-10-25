import type { Database } from 'bun:sqlite'
import { desktopAccent, type DesktopAppearance } from '../shared/desktop-appearance'

export class DesktopAppearanceError extends Error { constructor(message: string, readonly status: number) { super(message) } }
export function createDesktopAppearance(db: Database) {
  db.exec('CREATE TABLE IF NOT EXISTS desktop_appearance(id INTEGER PRIMARY KEY CHECK(id=1),accent_color TEXT NOT NULL,revision TEXT NOT NULL)')
  const read = (): DesktopAppearance => {
    const row = db.query<{ accent_color: string; revision: string }, []>('SELECT accent_color,revision FROM desktop_appearance WHERE id=1').get()
    return { desktop: true, accentColor: row ? desktopAccent(row.accent_color) : null, revision: row?.revision ?? 'initial' }
  }
  const write = db.transaction((value: unknown, revision: unknown) => {
    const color = desktopAccent(value)
    if (!color || typeof revision !== 'string' || revision.length > 80) throw new DesktopAppearanceError('Choose a valid accent color.', 400)
    const current = read()
    if (current.revision !== revision) throw new DesktopAppearanceError('The saved color changed. Reload it before saving again.', 409)
    if (current.accentColor === color) return current
    const next = crypto.randomUUID()
    db.query('INSERT INTO desktop_appearance(id,accent_color,revision) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET accent_color=excluded.accent_color,revision=excluded.revision').run(color, next)
    return { desktop: true, accentColor: color, revision: next }
  })
  return { read, write }
}
