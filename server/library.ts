import type { Database } from 'bun:sqlite'
import { libraryLimits, type LibraryState } from '../shared/library'

export class MediaLibraryError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message) }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
function nameOf(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > libraryLimits.name || /[\u0000-\u001f\u007f]/.test(value)) throw new MediaLibraryError('Use a folder name of 1–80 characters without control characters.')
  return value.trim()
}
function outputIdsOf(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > libraryLimits.moveBatch || value.some(id => typeof id !== 'string' || !id || id.length > 300 || /[\u0000-\u001f\u007f]/.test(id)) || new Set(value).size !== value.length) throw new MediaLibraryError('Choose 1–200 distinct media outputs.')
  return value as string[]
}

export function createMediaLibrary(db: Database) {
  db.exec('CREATE TABLE IF NOT EXISTS media_library (user_id TEXT PRIMARY KEY REFERENCES studio_users(id) ON DELETE CASCADE, record_json TEXT NOT NULL)')
  function read(userId: string): LibraryState {
    const initial: LibraryState = { revision: crypto.randomUUID(), folders: [] }
    db.query('INSERT OR IGNORE INTO media_library VALUES (?,?)').run(userId, JSON.stringify(initial))
    return JSON.parse(db.query<{ record_json: string }, [string]>('SELECT record_json FROM media_library WHERE user_id=?').get(userId)!.record_json)
  }
  function ownOutputs(userId: string, ids: string[]) {
    const rows = db.query<{ id: string }, string[]>(`SELECT DISTINCT json_extract(output.value, '$.id') AS id
      FROM generations AS generation, json_each(generation.record_json, '$.outputs') AS output
      WHERE generation.user_id=? AND COALESCE(json_extract(generation.record_json, '$.mediaType'),'image')!='training'
      AND COALESCE(json_extract(output.value, '$.role'),'') NOT IN ('thumbnail','checkpoint')
      AND COALESCE(json_extract(output.value, '$.kind'),'')!='checkpoint'
      AND json_extract(output.value, '$.id') IN (${ids.map(() => '?').join(',')})`).all(userId, ...ids)
    if (rows.length !== ids.length) throw new MediaLibraryError('Choose available original outputs from your own Studio library.')
  }
  function mutate(userId: string, method: string, path: string, body: unknown): LibraryState {
    if (!object(body) || typeof body.revision !== 'string') throw new MediaLibraryError('Reload your library before changing folders.')
    return db.transaction(() => {
      const state = read(userId)
      if (state.revision !== body.revision) throw new MediaLibraryError('Your library changed in another window. Reload folders and try again.', 409)
      const match = /^\/folders\/(folder_[a-f0-9-]{36})$/.exec(path)
      const folder = match ? state.folders.find(item => item.id === match[1]) : null
      const now = new Date().toISOString()
      if (method === 'POST' && path === '/folders') {
        if (!only(body, ['revision', 'name'])) throw new MediaLibraryError('Invalid folder request.')
        if (state.folders.length >= libraryLimits.folders) throw new MediaLibraryError('You can save up to 40 Studio folders.')
        const name = nameOf(body.name)
        if (state.folders.some(item => item.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) throw new MediaLibraryError('A folder with this name already exists.')
        state.folders.push({ id: `folder_${crypto.randomUUID()}`, name, createdAt: now, updatedAt: now, outputIds: [] })
      } else if (match && ['PATCH', 'DELETE'].includes(method)) {
        if (!folder) throw new MediaLibraryError('Folder not found.', 404)
        if (method === 'PATCH') {
          if (!only(body, ['revision', 'name'])) throw new MediaLibraryError('Invalid folder request.')
          const name = nameOf(body.name)
          if (state.folders.some(item => item.id !== folder.id && item.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) throw new MediaLibraryError('A folder with this name already exists.')
          folder.name = name; folder.updatedAt = now
        } else {
          if (!only(body, ['revision'])) throw new MediaLibraryError('Invalid folder request.')
          state.folders = state.folders.filter(item => item.id !== folder.id)
        }
      } else if (method === 'PUT' && path === '/memberships') {
        if (!only(body, ['revision', 'folderId', 'outputIds'])) throw new MediaLibraryError('Invalid folder membership request.')
        const target = body.folderId === null ? null : state.folders.find(item => item.id === body.folderId)
        if (body.folderId !== null && !target) throw new MediaLibraryError('Destination folder not found.', 404)
        const ids = outputIdsOf(body.outputIds)
        ownOutputs(userId, ids)
        const set = new Set(ids)
        for (const item of state.folders) {
          const previous = item.outputIds.length
          item.outputIds = item.outputIds.filter(id => !set.has(id))
          if (item.outputIds.length !== previous) item.updatedAt = now
        }
        if (target) { target.outputIds.push(...ids); target.updatedAt = now }
        if (state.folders.reduce((total, item) => total + item.outputIds.length, 0) > libraryLimits.memberships) throw new MediaLibraryError('Your library can organize up to 10,000 outputs in custom folders.')
      } else throw new MediaLibraryError('Library action not found.', 404)
      state.revision = crypto.randomUUID()
      db.query('UPDATE media_library SET record_json=? WHERE user_id=?').run(JSON.stringify(state), userId)
      return state
    }).immediate()
  }
  return { read, mutate }
}
