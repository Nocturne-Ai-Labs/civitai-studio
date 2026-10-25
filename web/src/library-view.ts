import type { Generation, GenerationOutput } from './api'
import type { LibraryFolder } from '../../shared/library'

export const libraryOutput = (output: GenerationOutput) => output.role !== 'thumbnail' && output.role !== 'checkpoint' && output.kind !== 'checkpoint'
export const libraryKind = (generation: Generation, output?: GenerationOutput) => output?.kind ?? generation.mediaType ?? 'image'
export const libraryDate = (generation: Generation) => { const date = new Date(generation.outputs[0]?.createdAt ?? generation.completedAt ?? generation.createdAt); return Number.isFinite(date.valueOf()) ? date.toISOString().slice(0, 10) : 'Unknown date' }
export type LibraryFilters = { query: string; kind: string; status: string; sort: string }
export function libraryView(generations: Generation[], view: string, folders: LibraryFolder[], filters: LibraryFilters): Generation[] {
  const custom = folders.find(folder => folder.id === view)
  const membership = new Set((custom ? custom.outputIds : folders.flatMap(folder => folder.outputIds)))
  const smartKind = ['image', 'video', 'audio', 'model3d'].includes(view) ? view : null
  const kind = smartKind ?? (filters.kind === 'all' ? null : filters.kind)
  const query = filters.query.trim().toLocaleLowerCase()
  const result = generations.filter(generation => generation.mediaType !== 'training').flatMap(generation => {
    if (filters.status !== 'all' && (filters.status === 'active' ? !['queued', 'running'].includes(generation.status) : generation.status !== filters.status)) return []
    if (query && !`${generation.input.prompt} ${generation.input.model ?? ''} ${generation.input.engine ?? ''} ${JSON.stringify(generation.input.parameters ?? {})}`.toLocaleLowerCase().includes(query)) return []
    const original = generation.outputs.filter(libraryOutput)
    const outputs = original.filter(output => (!kind || libraryKind(generation, output) === kind) && (!custom || membership.has(output.id)) && (view !== 'unfiled' || !membership.has(output.id)))
    if (original.length && !outputs.length) return []
    if (!original.length && (custom || view === 'unfiled' || (kind && libraryKind(generation) !== kind))) return []
    if (view.startsWith('folder_') && !custom) return []
    return [{ ...generation, outputs }]
  })
  return result.sort((a, b) => filters.sort === 'title' ? (a.input.prompt || '').localeCompare(b.input.prompt || '') || a.id.localeCompare(b.id) : filters.sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}
export function libraryGroups(generations: Generation[], grouping: string, sort: string): [string, Generation[]][] {
  if (grouping === 'none' || sort === 'title') return [['All matching work', generations]]
  const map = new Map<string, Generation[]>()
  for (const generation of generations) { const date = libraryDate(generation); map.set(date, [...(map.get(date) ?? []), generation]) }
  return [...map.entries()].sort(([a], [b]) => sort === 'oldest' ? a.localeCompare(b) : b.localeCompare(a))
}
