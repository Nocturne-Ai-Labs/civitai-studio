import { providerFetch, ConnectionError, type BearerLease } from './connection';
import { parseAir, type ModelVersion } from '../shared/composer'
import { resourceProfiles } from './resource-profiles'
import type { MediaType } from '../shared/generation-catalog'
import { getBrowsingPreference } from './browsing'
import { hasReviewedResourceFamily, resourceMapping, resourceSlots } from '../shared/resource-mapping'
import { contentRating, ratingAllowed, resourceRating, resourceAllowed, type BrowsingMode } from '../shared/browsing'

export class SiteError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}
// Fixed Site paths only; credentials never accompany media requests.
export async function siteJson(key: BearerLease, path: string): Promise<any> {
  try {
    const response = await providerFetch(key, `https://civitai.com/api/v1/${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' }, path.startsWith('model') ? 4 : 32)
    if (!response.ok) {
      await response.body?.cancel()
      throw new SiteError(response.status === 429 ? 'Civitai is rate limiting requests. Try again shortly.' : [401,403,404,451].includes(response.status) ? 'This item is unavailable under Civitai account/region restrictions, private, or removed. Your Studio browsing preference cannot override provider restrictions.' : 'Civitai could not load this information. Check your connection and permissions.', [404, 429, 503].includes(response.status) ? response.status : 502)
    }
    const maxBytes = 8 * 1024 * 1024
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new SiteError('Civitai returned too much data. Narrow your filters.') }
    const reader = response.body?.getReader()
    if (!reader) throw new SiteError('Civitai returned an empty response.')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) { await reader.cancel(); throw new SiteError('Civitai returned too much data. Narrow your filters.') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (error instanceof ConnectionError) throw new SiteError(error.message,403)
    if (error instanceof SiteError) throw error
    throw new SiteError('Civitai is temporarily unavailable or timed out. Try again, or choose a specific model version.', 503)
  }
}
export function safeSiteMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['image.civitai.com', 'images.civitai.com'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) return null
    return url.href
  } catch { return null }
}
const activeDiscovery = new Map<string, number>()
export async function withDiscoveryLimit<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  const count = activeDiscovery.get(accountId) ?? 0
  if (count >= 4) throw new SiteError('Too many model or artwork requests. Try again shortly.', 429)
  activeDiscovery.set(accountId, count + 1)
  try { return await task() } finally {
    const remaining = (activeDiscovery.get(accountId) ?? 1) - 1
    if (remaining) activeDiscovery.set(accountId, remaining)
    else activeDiscovery.delete(accountId)
  }
}
const text = (value: unknown, max = 300) => typeof value === 'string' ? value.slice(0, max) : ''
// Return provider descriptions as plain text. React still escapes the result.
function description(value: unknown) {
  return text(value, 50000).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<\/?(?:p|br|li|div|h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim().slice(0, 16000)
}
function previews(values: unknown, mode: BrowsingMode) {
  if (!Array.isArray(values)) return []
  return values.flatMap(item => {
    if (!item || typeof item.url !== 'string') return []
    const url = safeSiteMediaUrl(item.url)
    const rating = contentRating(item)
    return url && ratingAllowed(rating,mode) ? [{ url, rating, type: item.type === 'video' ? 'video' as const : 'image' as const }] : []
  }).slice(0, 6)
}
function modelVisible(model:any,mode:BrowsingMode){return resourceAllowed(model,mode)}
export function publicModel(model:any,mode:BrowsingMode='safe') {
  if(!modelVisible(model,mode))return null
  const versions=(Array.isArray(model.modelVersions)?model.modelVersions:[]).slice(0,100).filter((v:any)=>resourceAllowed(v,mode,model)).map((v:any)=>({id:Number(v.id),name:text(v.name),baseModel:text(v.baseModel),rating:resourceRating(v.nsfwLevel==null?model:v),supportsGeneration:typeof v.supportsGeneration==='boolean'?v.supportsGeneration:null,images:previews(v.images,mode),trainedWords:Array.isArray(v.trainedWords)?v.trainedWords.filter((x:unknown)=>typeof x==='string').slice(0,30).map((word:string)=>word.slice(0,1000)):[]}))
  return {id:Number(model.id),rating:resourceRating(model),mature:model.nsfw===true,supportsGeneration:typeof model.supportsGeneration==='boolean'?model.supportsGeneration:null,name:text(model.name),type:text(model.type),creator:text(model.creator?.username),description:description(model.description),versions,images:versions.flatMap((v:any)=>v.images).slice(0,6),url:`https://${model.nsfw===true||mode==='mature'?'civitai.red':'civitai.com'}/models/${Number(model.id)}`}
}
export async function resolveModelVersion(key: BearerLease, id: number, browsingMode?: BrowsingMode): Promise<ModelVersion> {
  const [full, mini] = await Promise.all([siteJson(key, `model-versions/${id}`), siteJson(key, `model-versions/mini/${id}`)])
  if (full?.id !== id || !Number.isSafeInteger(full?.modelId) || full.modelId <= 0) throw new SiteError('Civitai returned inconsistent model version information.')
  const mode=browsingMode??getBrowsingPreference(key.userId).mode
  if (!modelVisible(full.model,mode)||!resourceAllowed(full,mode,full.model)) throw new SiteError('This model is unavailable under your browsing preference. Review Settings → Browsing.',404)
  const air = text(full.air ?? mini.air, 250), parsed=parseAir(air)
  if(!parsed||parsed.modelId!==full.modelId||parsed.versionId!==id||!mini.air||mini.air!==air)throw new SiteError('Canonical model AIR could not be confirmed consistently.')
  return { id, rating: resourceRating(full.nsfwLevel == null ? full.model : full), modelRating:resourceRating(full.model), supportsGeneration:typeof full.supportsGeneration==='boolean'?full.supportsGeneration:null, restriction:mini.canGenerate===true?null:mini.checkPermission===true?'Provider permission or early-access restriction.':'Provider reports this version unavailable for this account.', url:`https://${full.model?.nsfw===true||mode==='mature'?'civitai.red':'civitai.com'}/models/${full.modelId}?modelVersionId=${id}`, modelId: Number(full.modelId), air, name: text(full.model?.name ?? mini.modelName), versionName: text(full.name ?? mini.versionName), type: text(full.model?.type), baseModel: text(full.baseModel ?? mini.baseModel), canGenerate: mini.canGenerate === true, description: description(full.description), trainedWords: Array.isArray(full.trainedWords) ? full.trainedWords.filter((v: unknown) => typeof v === 'string').slice(0, 30).map((word: string) => word.slice(0,1000)) : [], images: previews(full.images,mode) }
}
// Schema-backed advanced input is broader than the browser's reviewed family map.
// Resolve the actual schema branch; provider whatif validates remaining compatibility.
function resourceFamily(value: string): string | null {
  const family = value.toLowerCase()
  if (['sd1', 'sd15'].includes(family)) return 'sd1'
  if (family === 'sdxl') return 'sdxl'
  if (family === 'flux1') return 'flux1'
  if (family.startsWith('flux2')) return 'flux2'
  if (family.startsWith('qwen')) return 'qwen'
  if (family.startsWith('zimage')) return 'zimage'
  if (family === 'anima') return 'anima'
  return null
}
export async function validateGenerationResources(key: BearerLease, media: MediaType, input: Record<string, unknown>): Promise<string | null> {
  const profile = resourceProfiles.find(item => item.media === media && Object.entries(item.selectors).every(([name, value]) => (input[name] ?? item.defaults[name]) === value))
  const knownFields = new Set(resourceProfiles.flatMap(item => Object.keys(item.fields)))
  const resources: { air: string; field: string; strength?: number }[] = []
  for (const field of knownFields) {
    const value = input[field]
    if (value === undefined || value === null) continue
    const shape = profile?.fields[field]
    // A named model discriminator is not an AIR. Unrecognized AIR fields never
    // bypass the selected engine/schema combination.
    if (!shape) {
      if ((typeof value === 'string' && value.includes(':')) || (['loras', 'embeddings'].includes(field) && typeof value === 'object')) return `${field} is not an AIR resource field for this engine configuration.`
      continue
    }
    if (field === 'embeddings' && input.engine === 'comfy') return 'Comfy embeddings remain disabled because the recipe and schema disagree.'
    if (shape === 'air') {
      if (typeof value !== 'string' || !value) return `${field} must contain a canonical AIR.`
      resources.push({ air: value, field })
    } else if (shape === 'weights') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${field} must map AIRs to numeric strengths.`
      for (const [air, strength] of Object.entries(value)) {
        if (typeof strength !== 'number' || !Number.isFinite(strength)) return 'Every LoRA needs a finite numeric strength.'
        resources.push({ air, field, strength })
      }
    } else {
      if (!Array.isArray(value)) return `${field} must be an array.`
      for (const item of value) {
        if (shape === 'airs') {
          if (typeof item !== 'string') return `${field} must contain AIR strings.`
          resources.push({ air: item, field })
        } else {
          if (!item || typeof item.air !== 'string' || typeof item.strength !== 'number' || !Number.isFinite(item.strength)) return `${field} must contain AIRs with finite numeric strengths.`
          resources.push({ air: item.air, field, strength: item.strength })
        }
      }
    }
  }
  if (resources.length > 24) return 'Use at most 24 model resources per generation.'
  for (const resource of resources) {
    const air = parseAir(resource.air)
    if (!air) return 'Use canonical, version-pinned Civitai AIRs for model resources.'
    const version = await resolveModelVersion(key, air.versionId)
    if (version.air !== resource.air || version.id !== air.versionId || version.modelId !== air.modelId) return 'A model AIR no longer matches its canonical Civitai version.'
    if (!version.canGenerate) return `${version.name}: Civitai reports this version is unavailable for generation with this account.`
    // Enforce exact architecture rules where reviewed, without requiring every
    // documented advanced branch to have a browser-selection mapping.
    if(hasReviewedResourceFamily(media,input)&&resourceSlots.includes(resource.field as any)) {
      const mapped=resourceMapping(media,input,version)
      if(mapped.slot!==resource.field)return mapped.reason
    }
    const type = version.type.toLowerCase()
    if (resource.field === 'loras' && (air.type !== 'lora' || type !== 'lora')) return 'The loras field only accepts confirmed LORA resources.'
    if (resource.field === 'vaeModel' && (air.type !== 'vae' || type !== 'vae')) return 'The vaeModel field requires a confirmed VAE.'
    if (resource.field === 'embeddings' && (air.type !== 'embedding' || type !== 'textualinversion')) return 'The embeddings field requires textual inversion resources.'
    if (['model', 'diffuserModel', 'diffusionModel', 'checkpointModel'].includes(resource.field) && (!['checkpoint', 'diffusionmodel', 'unet'].includes(air.type) || type !== 'checkpoint')) return `${resource.field} requires a checkpoint or diffusion model.`
    const targetFamily = resourceFamily(String(input.ecosystem ?? ''))
    const sourceFamily = resourceFamily(air.ecosystem)
    // Flux1SdCppImageGenInput declares independent AIR text encoders with no
    // ecosystem constraint. Do not reject a reusable encoder's known family;
    // identity, availability and provider whatif still validate that resource.
    const independentFluxEncoder = media === 'image' && input.engine === 'sdcpp' && input.ecosystem === 'flux1' && ['clipLModel', 't5XXLModel'].includes(resource.field)
    if (!independentFluxEncoder && targetFamily && sourceFamily && targetFamily !== sourceFamily) return `${version.name}: resource ecosystem ${air.ecosystem} does not match ${input.ecosystem}.`
    // Other family aliases, provider-specific capability and parameter validation
    // remain with the mandatory provider whatif before any new paid submission.
  }
  return null
}
