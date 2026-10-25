import type { TrainingItem } from '../../shared/training'

export const trainingImageLimit = 32
export const trainingTotalBytes = 128 * 1024 * 1024
export const formatTrainingBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

export async function prepareTrainingFiles(selected: File[], signal: AbortSignal, onFile: (name: string) => void) {
  if (!selected.length || selected.length > trainingImageLimit) throw new Error('Choose 1–32 JPEG, PNG or WebP images at a time.')
  if (selected.some(file => !file.size || file.size > 8 * 1024 * 1024 || file.name.length > 200)) throw new Error('Each image needs a filename up to 200 characters and a size between 1 byte and 8 MiB.')
  if (selected.reduce((total, file) => total + file.size, 0) > trainingTotalBytes) throw new Error('The selected images exceed the 128 MiB limit.')
  const files = new Map<string, File>()
  for (const file of selected) {
    signal.throwIfAborted()
    onFile(file.name)
    const bytes = await file.arrayBuffer()
    signal.throwIfAborted()
    const b = new Uint8Array(bytes)
    const mime = b.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => b[i] === value) ? 'image/png'
      : b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255 ? 'image/jpeg'
      : b.length >= 16 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP' ? 'image/webp' : null
    if (!mime) throw new Error(`${file.name} is not a supported JPEG, PNG or WebP image.`)
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('')
    signal.throwIfAborted()
    files.set(hash, file.type === mime ? file : new File([file], file.name, { type: mime, lastModified: file.lastModified }))
  }
  return { files, duplicates: selected.length - files.size }
}

export type CaptionImport = { filename: string; itemId?: string; imageName?: string; caption: string; problem?: string }
const stem = (name: string) => name.replace(/\.[^.]+$/, '').toLocaleLowerCase('en-US')

export async function prepareCaptionImport(files: File[], items: TrainingItem[], signal: AbortSignal): Promise<CaptionImport[]> {
  if (!files.length || files.length > 32 || files.some(file => !/\.txt$/i.test(file.name) || file.size > 16 * 1024)) throw new Error('Choose up to 32 .txt caption files, no more than 16 KiB each.')
  const proposals: CaptionImport[] = []
  for (const file of files) {
    const caption = (await file.text()).replace(/^\uFEFF/, '').trim()
    signal.throwIfAborted()
    const matching = items.filter(item => stem(item.name) === stem(file.name))
    proposals.push({ filename: file.name, caption, ...(matching.length === 1 ? { itemId: matching[0]!.id, imageName: matching[0]!.name } : {}),
      problem: !matching.length ? 'No image with this filename' : matching.length > 1 ? 'Several images share this filename' : !caption ? 'Caption is empty' : caption.length > 1024 ? 'Caption exceeds 1,024 characters' : undefined })
  }
  const counts = new Map<string, number>()
  for (const row of proposals) if (row.itemId) counts.set(row.itemId, (counts.get(row.itemId) ?? 0) + 1)
  return proposals.map(row => row.itemId && counts.get(row.itemId)! > 1 ? { ...row, problem: 'Several caption files match this image' } : row)
}
