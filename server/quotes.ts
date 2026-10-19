import type { TrainingReview } from '../shared/training'
import type { BearerLease } from './connection'
import type { CostReview, GenerationPolicy, GenerationPreview, WorkflowOptions } from '../shared/quotes'
import type { MediaType } from '../shared/generation-catalog'

export type PreparedGeneration = { imageGraph?: import('../shared/quotes').ImageGraphReview & {sources:import('../shared/workflows').FrozenImageSource[]}; draft?: import('../shared/image-workflows').DraftReview; sourceWorkflow?: { operation: import('../shared/workflows').SourceOperation; settings: Record<string,unknown>; sources: import('../shared/workflows').FrozenImageSource[] }; mediaType: MediaType | 'training'; training?: TrainingReview; providerInput: Record<string, unknown>; storedInput: Record<string, unknown>; fingerprint: string; policy: GenerationPolicy; workflowRequest: Record<string, unknown>; source?: { generationId: string; outputId: string; operation?: 'imageUpscaler' | 'imageBackgroundRemoval' | 'imageEdit' | 'imageAnimation' | 'imageTo3D' | 'transcode' | 'videoUpscaler' | 'videoInterpolation'; targetWidth?: number; containerFormat?: 'mp4' | 'webM'; prompt?: string; shouldTexture?: boolean; duration?: '5' | '10'; aspectRatio?: '16:9' | '9:16' | '1:1'; format?: 'png' | 'webp'; scaleFactor?: number; interpolationFactor?: number; width?: number | null; height?: number | null; numberOfRepeats?: number; model?: string | null; assetIdentity: string } }
export type SavedQuote = PreparedGeneration & { userId: string; id: string; expiresAt: number; connectionRevision: string; review: CostReview }
const quotes = new Map<string, SavedQuote>()
export function normalizeWorkflowOptions(value: unknown): WorkflowOptions {
  if (value === undefined) return { tips: { creators: 0, civitai: 0 }, priority: 'normal' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workflow options.')
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => !['tips', 'priority'].includes(key))) throw new Error('Unsupported workflow option.')
  const priority = source.priority ?? 'normal'
  if (typeof priority !== 'string' || !['low', 'normal', 'high'].includes(priority)) throw new Error('Invalid generation priority.')
  const tips = source.tips === undefined ? { creators: 0, civitai: 0 } : source.tips
  if (!tips || typeof tips !== 'object' || Array.isArray(tips) || Object.keys(tips).some(key => !['creators', 'civitai'].includes(key))) throw new Error('Invalid workflow tips.')
  const rates = tips as Record<string, unknown>
  for (const key of ['creators', 'civitai']) if (typeof rates[key] !== 'number' || !Number.isFinite(rates[key]) || (rates[key] as number) < 0 || (rates[key] as number) > 2) throw new Error('Tip rates must be between 0 and 2.')
  return { tips: { creators: rates.creators as number, civitai: rates.civitai as number }, priority: priority as WorkflowOptions['priority'] }
}
export function normalizePolicy(value: unknown): GenerationPolicy {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid payment policy.')
  const source = value as Record<string, unknown>, result: GenerationPolicy = {}
  if (Object.keys(source).some(key => !['currencies', 'allowMatureContent', 'upgradeMode'].includes(key))) throw new Error('Unsupported payment policy field.')
  if (source.currencies !== undefined) {
    if (!Array.isArray(source.currencies) || source.currencies.length < 1 || source.currencies.length > 3 || source.currencies.some(item => !['blue', 'green', 'yellow'].includes(String(item))) || new Set(source.currencies).size !== source.currencies.length) throw new Error('Choose distinct Blue, Green or Yellow currencies.')
    result.currencies = source.currencies as GenerationPolicy['currencies']
  }
  if (source.allowMatureContent !== undefined) {
    if (typeof source.allowMatureContent !== 'boolean') throw new Error('Invalid mature-content policy.')
    result.allowMatureContent = source.allowMatureContent
  }
  if (source.upgradeMode !== undefined) {
    if (!['manual', 'automatic'].includes(String(source.upgradeMode))) throw new Error('Invalid upgrade policy.')
    result.upgradeMode = source.upgradeMode as GenerationPolicy['upgradeMode']
  }
  return result
}
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null
function safeText(value: unknown, secret: string, max = 1000): string {
  if (typeof value !== 'string') return ''
  return value.split(secret).join('[redacted]').replace(/https?:\/\/\S+/gi, '[provider link omitted]').replace(/(?:bearer\s+|(?:token|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi, '[redacted]').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max)
}
export function normalizeReview(payload: any, secret: string): CostReview {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid preview response.')
  const cost = object(payload.cost), transactions = object(payload.transactions)
  function entries(value: unknown, label: string) {
    if (value == null) return null
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) throw new Error(`Invalid ${label} breakdown.`)
    return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, raw], index) => {
      const number = typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw) <= Number.MAX_SAFE_INTEGER ? raw : null
      if (number === null || (label === 'Fixed cost' && !Number.isInteger(number))) throw new Error(`Invalid ${label} value.`)
      return { name: safeText(key, secret, 160) || `${label} ${index + 1}`, value: number }
    })
  }
  const fixed = entries(cost.fixed, 'Fixed cost')?.map(item => ({ name: item.name, amount: item.value })) ?? null
  const factors = entries(cost.factors, 'Cost factor')
  if (cost.tips != null && (typeof cost.tips !== 'object' || Array.isArray(cost.tips))) throw new Error('Invalid tip breakdown.')
  const providerTips = object(cost.tips)
  const tips = { creators: amount(providerTips.creators), civitai: amount(providerTips.civitai) }
  for (const key of ['creators', 'civitai']) if (providerTips[key] != null && amount(providerTips[key]) === null) throw new Error('Invalid tip amount.')
  if (cost.fees != null && (typeof cost.fees !== 'object' || Array.isArray(cost.fees))) throw new Error('Invalid fee breakdown.')
  const feeEntries = cost.fees == null ? null : Object.entries(object(cost.fees))
  const list = transactions.list == null ? null : transactions.list
  const steps = Array.isArray(payload.steps) ? payload.steps : []
  if ((feeEntries?.length ?? 0) > 100 || (list != null && (!Array.isArray(list) || list.length > 100)) || steps.length > 20) throw new Error('Preview exceeds review limits.')
  const fees = feeEntries?.map(([resource, value], index) => {
    const fee = amount(value)
    if (fee === null) throw new Error('Invalid resource fee.')
    return { resource: /^urn:air:[a-z0-9]+:[a-z0-9]+:civitai:\d+@\d+$/i.test(resource) ? resource.slice(0, 250) : `Resource fee ${index + 1}`, amount: fee }
  }).sort((a, b) => a.resource.localeCompare(b.resource)) ?? null
  const normalizedTransactions = list?.map((item: any) => {
    const value = amount(item?.amount)
    if (value === null || !['debit', 'credit'].includes(item?.type) || !['blue', 'green', 'yellow', 'fakeRed'].includes(item?.accountType)) throw new Error('Invalid transaction estimate.')
    return { accountType: item.accountType, amount: value, type: item.type }
  }).sort((a: any, b: any) => `${a.accountType}:${a.type}:${a.amount}`.localeCompare(`${b.accountType}:${b.type}:${b.amount}`)) ?? null
  const warnings: CostReview['warnings'] = []
  for (const [index, step] of steps.entries()) {
    const values = step?.warnings ?? []
    if (!Array.isArray(values) || values.length > 20) throw new Error('Preview exceeds warning limits.')
    for (const warning of values) warnings.push({ step: index + 1, code: safeText(warning?.code, secret, 80), message: safeText(warning?.message, secret), deprecatedAt: safeText(warning?.deprecatedAt, secret, 80) || null, retiresAt: safeText(warning?.retiresAt, secret, 80) || null, replacement: safeText(warning?.replacement, secret, 300) || null })
  }
  return { total: amount(cost.total), base: amount(cost.base), variable: typeof cost.variable === 'boolean' ? cost.variable : null, tips, fixed, factors, fees, transactions: normalizedTransactions, insufficientBuzz: typeof transactions.insufficientBuzz === 'boolean' ? transactions.insufficientBuzz : null, warnings }
}
export async function boundedPreviewJson(response: Response): Promise<unknown> {
  const max = 2 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('Preview too large.') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty preview.')
  const chunks: Uint8Array[] = []; let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > max) { await reader.cancel(); throw new Error('Preview too large.') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export function saveQuote(userId: string, key: BearerLease, prepared: PreparedGeneration, review: CostReview): SavedQuote {
  for (const [id, quote] of quotes) if (quote.expiresAt <= Date.now()) quotes.delete(id)
  const owned = [...quotes.values()].filter(quote => quote.userId === userId)
  for (const old of owned.slice(0, Math.max(0, owned.length - 2))) quotes.delete(old.id)
  if (quotes.size >= 1000) throw new Error('Too many previews. Try again shortly.')
  const quote = { ...structuredClone(prepared), userId, id: `quote_${crypto.randomUUID()}`, expiresAt: Date.now() + 120_000, connectionRevision: key.revision, review }
  quotes.set(quote.id, quote)
  return quote
}
export const getQuote = (userId: string, id: string) => { const value = quotes.get(id); return value?.userId === userId ? value : null }
export const discardQuote = (id: string) => { quotes.delete(id) }
export function publicQuote(quote: SavedQuote): GenerationPreview {
  return { ...(quote.imageGraph ? { imageGraph: {...quote.imageGraph,sources:quote.imageGraph.sources.map(({identity,...source})=>source)} } : {}), ...(quote.draft ? { draft: quote.draft } : {}), ...(quote.sourceWorkflow ? { workflow: { operation: quote.sourceWorkflow.operation, settings: quote.sourceWorkflow.settings, sources: quote.sourceWorkflow.sources.map(({ identity, ...source }) => source) } } : {}), ...(quote.mediaType === 'audio' ? { music: structuredClone(quote.providerInput) } : {}), id: quote.id, expiresAt: new Date(quote.expiresAt).toISOString(), mediaType: quote.mediaType, engine: quote.source ? (quote.source.operation ?? 'imageUpscaler') : String(quote.mediaType === 'audio' ? 'aceStepAudio' : quote.providerInput.engine ?? quote.sourceWorkflow?.operation ?? ''), ...(quote.source ? { source: { generationId: quote.source.generationId, outputId: quote.source.outputId, operation: quote.source.operation, targetWidth: quote.source.targetWidth, containerFormat: quote.source.containerFormat, prompt: quote.source.prompt, shouldTexture: quote.source.shouldTexture, duration: quote.source.duration, aspectRatio: quote.source.aspectRatio, format: quote.source.format, scaleFactor: quote.source.scaleFactor, interpolationFactor: quote.source.interpolationFactor, width: quote.source.width, height: quote.source.height, numberOfRepeats: quote.source.numberOfRepeats, model: quote.source.model } } : {}), ...(quote.training ? { training: quote.training } : {}), ...(quote.workflowRequest.tips ? { options: normalizeWorkflowOptions({ tips: quote.workflowRequest.tips, priority: (quote.workflowRequest.steps as { priority?: string }[])?.[0]?.priority }) } : {}), policy: quote.policy, review: quote.review }
}
