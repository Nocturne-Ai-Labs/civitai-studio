import { canonicalAir, officialKreaVariant, resourceMapping, resourceProfile, resourceSlots, modelSwitchPaths, type ResourceSlot } from './resource-mapping'
export type { ResourceSlot } from './resource-mapping'
import { isDocumentedEngine, starterInput, type MediaType } from './generation-catalog'
import { musicProviderInput } from './music'
export type PromptGroup = { id: string; label: string; text: string }
export type ComposerConfig = { version: 1; mediaType: MediaType; input: Record<string, unknown>; promptGroups: PromptGroup[] }
export type Preset = { id: string; name: string; config: ComposerConfig; updatedAt: string }
export const combinePrompts = (groups: PromptGroup[]) => groups.map(group => group.text.trim()).filter(Boolean).join('\n\n')
export function promptLimit(media: MediaType, input: Record<string, unknown>) {
  if(media==='audio')return {max:3000,label:'Studio music description limit'}
  if (media === 'image' && (input.engine === 'krea' || (input.engine === 'fal' && input.model === 'krea2'))) return { max: 5000, label: 'Krea engine limit' }
  if (media === 'image' && input.engine === 'sdcpp' && ['flux1','flux2Dev','flux2Klein'].includes(String(input.ecosystem))) return { max: 1000, label: 'Flux.1 engine limit' }
  if (media === 'model3d' && input.engine === 'fal' && input.model === 'meshy' && input.operation === 'textTo3D') return { max: 600, label: 'Meshy limit' }
  if (media === 'image' && ['sdcpp', 'comfy'].includes(String(input.engine)) && ['sd1', 'sdxl'].includes(String(input.ecosystem))) return { max: 10000, label: 'Engine limit' }
  return { max: 10000, label: 'Studio limit; provider validates engine limits' }
}
export const builtInPresets = [
  { id: 'builtin:sdxl', name: 'SDXL image', media: 'image', engine: 'sdcpp', variant: 'sdxl' },
  { id: 'builtin:krea2', name: 'Comfy Krea 2 · Raw', media: 'image', engine: 'comfy', variant: 'krea2' },
  { id: 'builtin:kling', name: 'Kling video', media: 'video', engine: 'kling', variant: '' },
  { id: 'builtin:meshy', name: 'Meshy 3D', media: 'model3d', engine: 'fal', variant: 'meshy' },
  { id: 'builtin:music', name: 'ACE-Step instrumental', media: 'audio', engine: 'aceStepAudio', variant: '' },
].map(item => ({ id: item.id, name: item.name, config: { version: 1 as const, mediaType: item.media as MediaType, input: starterInput(item.media as MediaType, item.engine, item.variant), promptGroups: [{ id: 'prompt-1', label: '', text: '' }] } }))
export function configError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'A composer configuration is required.'
  const config = value as ComposerConfig
  if (config.version !== 1 || !config.input || typeof config.input !== 'object' || Array.isArray(config.input) || !isDocumentedEngine(config.mediaType, config.input.engine)) return 'Unsupported preset version or engine.'
  if (!Array.isArray(config.promptGroups) || config.promptGroups.length < 1 || config.promptGroups.length > 20 || config.promptGroups.some(group => !group || typeof group.id !== 'string' || group.id.length > 80 || typeof group.label !== 'string' || group.label.length > 80 || typeof group.text !== 'string' || group.text.length > 10000) || new Set(config.promptGroups.map(g => g.id)).size !== config.promptGroups.length) return 'Use 1–20 prompt groups with unique IDs and labels up to 80 characters.'
  if (combinePrompts(config.promptGroups) !== (config.input[config.mediaType==='audio'?'musicDescription':'prompt'] ?? '')) return 'Prompt groups and engine description/prompt must agree.'
  if(config.mediaType==='audio')try {musicProviderInput({...config.input,musicDescription:config.input.musicDescription||'Preset draft'})}catch(error){return error instanceof Error?error.message:'Invalid music preset.'}
  if (combinePrompts(config.promptGroups).length > promptLimit(config.mediaType, config.input).max) return 'Combined prompt exceeds the selected engine limit.'
  if (JSON.stringify(config).length > 32000) return 'Preset configuration is too large (32,000 characters maximum).'
  return null
}
export type ModelVersion = { id: number; rating: import('./browsing').ContentRating; modelRating?: import('./browsing').ContentRating; supportsGeneration?:boolean|null; restriction?:string|null; url?:string; modelId: number; air: string; name: string; versionName: string; type: string; baseModel: string; canGenerate: boolean; description: string; trainedWords: string[]; images: { url: string; rating: import('./browsing').ContentRating; type: 'image' | 'video' }[] }

export type Resource = { air: string; slot: ResourceSlot; strength?: number }
export const parseAir = canonicalAir
export const compatibility = resourceMapping
export function selectedResources(input: Record<string, unknown>): Resource[] {
  const result: Resource[] = []
  for (const slot of resourceSlots) if (!['loras','embeddings'].includes(slot) && typeof input[slot] === 'string' && parseAir(input[slot] as string)) result.push({air:input[slot] as string,slot})
  if (Array.isArray(input.loras)) for (const item of input.loras) { if (item && typeof item.air === 'string') result.push({ air: item.air, slot: 'loras', strength: item.strength }) }
  else if (input.loras && typeof input.loras === 'object') for (const [air, strength] of Object.entries(input.loras)) result.push({ air, slot: 'loras', strength: strength as number })
  if (Array.isArray(input.embeddings)) for (const air of input.embeddings) if (typeof air === 'string') result.push({ air, slot: 'embeddings' })
  return result
}
export function applyResource(input: Record<string, unknown>, resource: Resource, remove = false): Record<string, unknown> {
  const next = { ...input }
  if (resource.slot === 'loras') {
    const profile=resourceProfile('image',input)??resourceProfile('video',input)
    if (profile?.fields.loras === 'weightedArray') {
      const loras = (Array.isArray(input.loras) ? input.loras : []).filter(item => item && typeof item.air === 'string' && item.air !== resource.air)
      next.loras = remove ? loras : [...loras, { air: resource.air, strength: resource.strength ?? 1 }]
    } else {
      const loras = { ...(input.loras && !Array.isArray(input.loras) && typeof input.loras === 'object' ? input.loras : {}) } as Record<string, unknown>
      delete loras[resource.air]
      if (!remove) loras[resource.air] = resource.strength ?? 1
      next.loras = loras
    }
  } else if (resource.slot === 'embeddings') {
    const embeddings = (Array.isArray(input.embeddings) ? input.embeddings : []).filter(air => air !== resource.air)
    next.embeddings = remove ? embeddings : [...embeddings, resource.air]
  } else if (remove) delete next[resource.slot]
  else next[resource.slot] = resource.air
  return next
}

export type SuggestedModelPath={label:string;media:'image'|'video';engine:string;variant:string;input:Record<string,unknown>;slot?:ResourceSlot}
export function kreaBranchChoice(version:ModelVersion) {
  const air=canonicalAir(version.air)
  const type=version.type.toLowerCase()
  return version.canGenerate&&version.baseModel==='Krea 2'&&Boolean(air&&air.modelId===version.modelId&&air.versionId===version.id&&((type==='checkpoint'&&['checkpoint','diffusionmodel','unet'].includes(air.type))||(type==='lora'&&air.type==='lora')))&&!officialKreaVariant(version)
}
export function suggestedModelPath(version:ModelVersion,kreaChoice?:'raw'|'turbo'):SuggestedModelPath|null {
  if(!version.canGenerate)return null
  const official=officialKreaVariant(version)
  if(official==='medium'||official==='large')return {label:`Krea 2 ${official} · FAL`,media:'image',engine:'fal',variant:'krea2',input:{...starterInput('image','fal','krea2'),size:official}}
  if(official==='raw'||official==='turbo'||kreaBranchChoice(version)) {
    const model=official??kreaChoice
    if(!model)return null // Community versions need an explicit branch choice.
    const input=starterInput('image','comfy','krea2',model),support=compatibility('image',input,version)
    return support.slot?{label:`Krea 2 ${model} · Comfy`,media:'image',engine:'comfy',variant:'krea2',input,slot:support.slot}:null
  }
  for(const path of modelSwitchPaths) {
    const input={...starterInput(path.media,path.engine,path.variant),...path.overrides},support=compatibility(path.media,input,version)
    // Do not offer an add-on switch that leaves a required checkpoint empty.
    if(support.slot && !(input.model === '' && support.slot !== 'model'))return {...path,input,slot:support.slot}
  }
  return null
}
