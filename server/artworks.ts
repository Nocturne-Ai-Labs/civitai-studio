import { assertConnectionCurrent, type BearerLease } from './connection';
import { artworkPeriods, artworkSorts, type Artwork, type ArtworkResource } from '../shared/artworks'
import { safeSiteMediaUrl, siteJson, SiteError } from './models'
import { browsingMask, contentRating, ratingAllowed, type BrowsingPreference } from '../shared/browsing'

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const text = (value: unknown, max = 10000) => typeof value === 'string' ? value.slice(0, max) : ''
export const positiveId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export function publicArtwork(raw: any, mode: BrowsingPreference['mode'] = 'safe', siteHost: 'civitai.com' | 'civitai.red' = 'civitai.com'): Artwork | null {
  if (!raw || !positiveId(raw.id) || !['image', 'video'].includes(raw.type)) return null
  const rating = contentRating(raw)
  if (!ratingAllowed(rating,mode)) return null
  // Some Site responses wrap generation fields under meta.meta. Never flatten
  // arbitrary provider objects or send the raw metadata/workflow to the browser.
  const layers = [record(raw.meta)]
  for (let depth = 0; depth < 2; depth++) {
    const nested = record(layers.at(-1)?.meta)
    if (!Object.keys(nested).length) break
    layers.push(nested)
  }
  const meta = Object.assign({}, ...layers)
  const resources = new Map<number, ArtworkResource>()
  for (const layer of layers) for (const resource of (Array.isArray(layer.civitaiResources) ? layer.civitaiResources : []).slice(0, 200)) {
    if (!positiveId(resource?.modelVersionId)) continue
    const prior = resources.get(resource.modelVersionId)
    resources.set(resource.modelVersionId, { ...prior, versionId: resource.modelVersionId, typeHint: text(resource.type, 80), ...(typeof resource.weight === 'number' && Number.isFinite(resource.weight) ? { weight: resource.weight } : {}) })
  }
  for (const id of (Array.isArray(raw.modelVersionIds) ? raw.modelVersionIds : []).slice(0, 200)) if (positiveId(id) && !resources.has(id)) resources.set(id, { versionId: id })
  const parameters: Artwork['parameters'] = {}
  for (const key of ['seed', 'steps', 'sampler', 'cfgScale', 'clipSkip', 'Size', 'width', 'height', 'Model', 'Model hash', 'Scheduler', 'denoise', 'duration', 'fps']) {
    const value = meta[key]
    if (typeof value === 'string') parameters[key] = value.slice(0, 300)
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) parameters[key] = value
  }
  return { id: raw.id, rating, postId: positiveId(raw.postId) ? raw.postId : null, url: safeSiteMediaUrl(raw.url), siteUrl: `https://${siteHost}/images/${raw.id}`, type: raw.type, creator: text(raw.username, 100), createdAt: text(raw.createdAt, 80), prompt: text(meta.prompt), negativePrompt: text(meta.negativePrompt), parameters, resources: [...resources.values()].slice(0, 24), resourcesTruncated: resources.size > 24, hasMetadata: layers.some(layer => Object.keys(layer).length > 0) }
}
export async function listArtworks(key: BearerLease, query: URLSearchParams, preference: BrowsingPreference) {
  const type = query.get('type') ?? 'image', sort = query.get('sort') ?? 'Newest', period = query.get('period') ?? 'AllTime', cursor = query.get('cursor') ?? ''
  if (!['image', 'video'].includes(type) || !artworkSorts.includes(sort as any) || !artworkPeriods.includes(period as any) || cursor.length > 1000 || /[\x00-\x1f]/.test(cursor)) throw new SiteError('Invalid artwork browsing filters.', 400)
  const params = new URLSearchParams({ type, sort, period, limit: '20', withMeta: 'true', browsingLevel: String(browsingMask(preference.mode)) })
  const siteHost = query.get('siteHost') ?? 'civitai.com'
  if (siteHost !== 'civitai.com' && siteHost !== 'civitai.red') throw new SiteError('Use a Civitai.com or Civitai.red site link.',400)
  const targetFields = ['imageId', 'postId'].filter(field => query.has(field))
  if (targetFields.length > 1 || targetFields.some(field => query.getAll(field).length !== 1)
    || (targetFields.length && (query.has('modelId') || query.has('modelVersionId')))) throw new SiteError('Choose one artwork or post, without model filters.', 400)
  const targetField = targetFields[0]
  let targetId: number | null = null
  if (targetField) {
    const value = query.get(targetField)!
    if (!/^[1-9]\d*$/.test(value) || !positiveId(Number(value))) throw new SiteError('Use a positive artwork or post ID.', 400)
    targetId = Number(value); params.set(targetField, value)
    // Site videos are image entities. A direct link must not inherit the image-only filter.
    params.delete('type'); params.set('sort', 'Oldest'); params.set('period', 'AllTime')
    if (targetField === 'imageId' && cursor) throw new SiteError('Single artwork lookup does not accept a cursor.', 400)
  }
  for (const field of ['modelId', 'modelVersionId']) if (query.has(field)) {
    const value = query.get(field)!
    if (!/^\d+$/.test(value) || !positiveId(Number(value))) throw new SiteError('Use a positive model or version ID.', 400)
    params.set(field, value)
  }
  if (cursor) params.set('cursor', cursor)
  const payload = await siteJson(key, `images?${params}`)
  assertConnectionCurrent(key)
  const next = payload?.metadata?.nextCursor
  const rawItems = (Array.isArray(payload?.items) ? payload.items : []).slice(0, 20)
  if (targetField && rawItems.some((item: any) => item?.[targetField === 'imageId' ? 'id' : 'postId'] !== targetId)) throw new SiteError('Civitai returned artwork outside the requested link. Nothing was selected.', 502)
  const items = rawItems.map((item: any) => publicArtwork(item,preference.mode,siteHost)).filter(Boolean)
  if (targetField === 'imageId' && items.length !== 1) throw new SiteError('This artwork is unavailable under your browsing preference or Civitai account/region restrictions. It may also be private or removed. Review Settings → Browsing.', 404)
  return { items, nextCursor: targetField !== 'imageId' && typeof next === 'string' && next.length <= 1000 && !/[\x00-\x1f]/.test(next) ? next : null }
}
