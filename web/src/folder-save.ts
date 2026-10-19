import { validOutputCategory } from '../../shared/output-folders'
import type { DownloadItem } from './api'

// These picker APIs are not included in every TypeScript DOM library.
export interface Directory {
  getDirectoryHandle(name: string, options?: { create: boolean }): Promise<Directory>
  getFileHandle(name: string, options?: { create: boolean }): Promise<FileHandle>
  values(): AsyncIterable<FileHandle | DirectoryEntry>
}
interface DirectoryEntry { kind: 'directory'; name: string }
interface FileHandle { kind: 'file'; name: string; getFile(): Promise<File>; createWritable(): Promise<FileSystemWritableFileStream> }
const picker = () => (window as unknown as { showDirectoryPicker?: (options: { mode: string }) => Promise<Directory> }).showDirectoryPicker
export const folderSavingSupported = () => window.isSecureContext && !!picker()
export const chooseFolder = () => picker()!({ mode: 'readwrite' })
const blockSize = 4 * 1024 * 1024
async function hashes(file: File, signal: AbortSignal) {
  const result: string[] = []
  for (let offset = 0; offset < file.size; offset += blockSize) {
    signal.throwIfAborted()
    const hash = await crypto.subtle.digest('SHA-256', await file.slice(offset, offset + blockSize).arrayBuffer())
    result.push(Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''))
  }
  signal.throwIfAborted()
  return result
}
async function exists(dir: Directory, name: string) {
  try { await dir.getFileHandle(name); return true } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false
    if (error instanceof DOMException && error.name === 'TypeMismatchError') return true
    throw error
  }
}
export async function saveOutput(root: Directory, item: DownloadItem, accountId: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<'saved' | 'skipped'> {
  if (!validOutputCategory(item.category) || !item.filename || !item.dateFolder || !item.contentUrl || !item.metadata || !/^\d{4}-\d{2}-\d{2}$/.test(item.dateFolder)) throw new Error('Output manifest is incomplete.')
  signal.throwIfAborted()
  const categoryDir = await root.getDirectoryHandle(item.category, { create: true })
  const dir = await categoryDir.getDirectoryHandle(item.dateFolder, { create: true })
  // Only a completed, locally verified sidecar can establish a safe duplicate.
  for await (const entry of dir.values()) {
    signal.throwIfAborted()
    if (entry.kind !== 'file' || !entry.name.endsWith('.studio.json')) continue
    try {
      const sidecar = await entry.getFile()
      if (sidecar.size > 2 * 1024 * 1024) continue
      const record = JSON.parse(await sidecar.text())
      if (record.version !== 2 || record.category !== item.category || record.accountId !== accountId || record.outputId !== item.outputId || record.generationId !== item.metadata.generationId || record.complete !== true || typeof record.filename !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(record.filename)) continue
      const file = await (await dir.getFileHandle(record.filename)).getFile()
      if (file.size > 0 && file.size === record.bytes && JSON.stringify(await hashes(file, signal)) === JSON.stringify(record.sha256Blocks)) return 'skipped'
    } catch { signal.throwIfAborted() /* Untrusted/incomplete sidecars never authorize overwriting or skipping. */ }
  }
  const url = new URL(item.contentUrl, location.origin)
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/studio/v1/generations/')) throw new Error('Invalid content route.')
  const response = await fetch(url, { credentials: 'same-origin', signal })
  if (!response.ok || !response.body) throw new Error(`Media download failed (${response.status}).`)
  const headerName = response.headers.get('content-disposition')?.match(/filename="([a-zA-Z0-9_.-]+)"/)?.[1]
  const base = (headerName ?? item.filename).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 110)
  const dot = base.lastIndexOf('.')
  let filename: string
  do {
    filename = `${dot > 0 ? base.slice(0, dot) : base}-${crypto.randomUUID()}${dot > 0 ? base.slice(dot) : '.bin'}`
  } while (await exists(dir, filename) || await exists(dir, `${filename}.studio.json`))
  signal.throwIfAborted()
  const handle = await dir.getFileHandle(filename, { create: true })
  let writable: FileSystemWritableFileStream | undefined
  try {
    writable = await handle.createWritable()
    let bytes = 0
    const counter = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { bytes += chunk.byteLength; progress(bytes); controller.enqueue(chunk) } })
    await response.body.pipeThrough(counter).pipeTo(writable, { signal })
    writable = undefined
    signal.throwIfAborted()
    const file = await handle.getFile()
    if (!bytes || file.size !== bytes) throw new Error('The saved file is incomplete.')
    const sha256Blocks = await hashes(file, signal)
    const record = { ...item.metadata, version: 2, category: item.category, accountId, outputId: item.outputId, filename, bytes, blockSize, sha256Blocks, complete: true, exportedAt: new Date().toISOString() }
    signal.throwIfAborted()
    const sidecar = await dir.getFileHandle(`${filename}.studio.json`, { create: true })
    writable = await sidecar.createWritable()
    signal.throwIfAborted()
    await writable.write(JSON.stringify(record, null, 2))
    signal.throwIfAborted()
    await writable.close()
    writable = undefined
    return 'saved'
  } catch (error) {
    if (writable) await writable.abort().catch(() => {})
    // Preserve incomplete artifacts; a retry selects a distinct filename.
    throw error
  }
}
