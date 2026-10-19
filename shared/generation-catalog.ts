import { imageCapability } from './image-capabilities'
import { musicStarter } from './music'
// Engine IDs and top-level discriminators from Civitai's consumer OpenAPI
// snapshot, checked 2026-09-26. Individual engine fields remain provider-owned.
export type MediaType = 'image' | 'video' | 'model3d' | 'audio'

export const generationEngines: Record<MediaType, { id: string; label: string }[]> = {
  audio:[{id:'aceStepAudio',label:'ACE-Step · default 2B turbo'}],
  image: [
    ['sdcpp', 'SD CPP · open models'], ['comfy', 'Comfy · open models'],
    ['flux2', 'Flux 2'], ['flux1-pro', 'Flux 1 Pro'], ['flux1-kontext', 'Flux 1 Kontext'],
    ['openai', 'OpenAI'], ['google', 'Google Imagen'], ['gemini', 'Gemini'],
    ['wan', 'Wan'], ['seedream', 'Seedream'], ['grok', 'Grok'],
    ['fal', 'FAL'], ['qwen', 'Qwen'], ['krea', 'Krea'],
  ].map(([id, label]) => ({ id: id!, label: label! })),
  video: [
    ['kling', 'Kling'], ['kling-v3', 'Kling v3'], ['wan', 'Wan'],
    ['veo3', 'Veo 3'], ['vidu', 'Vidu'], ['vidu-q3', 'Vidu Q3'],
    ['ltx2', 'LTX 2'], ['ltx2.3', 'LTX 2.3'], ['ltx2.5', 'LTX 2.5'],
    ['sora', 'Sora'], ['seedance', 'Seedance'], ['minimax', 'MiniMax'],
    ['minimax-h3', 'MiniMax H3'], ['minimax-h3-comfy', 'MiniMax H3 Comfy'],
    ['hunyuan', 'Hunyuan'], ['lightricks', 'Lightricks'], ['haiper', 'Haiper'],
    ['mochi', 'Mochi'], ['gemini-omni', 'Gemini Omni'], ['grok', 'Grok'],
    ['happyHorse', 'Happy Horse'], ['flux', 'Flux video'],
  ].map(([id, label]) => ({ id: id!, label: label! })),
  model3d: [
    { id: 'fal', label: 'FAL · Meshy / Tripo' },
    { id: 'comfy', label: 'Comfy · Hunyuan 3D / Trellis 2' },
    { id: 'unirig', label: 'UniRig' },
  ],
}

export const engineVariants: Partial<Record<`${MediaType}:${string}`, { field: string; values: string[] }>> = {
  'image:sdcpp': { field: 'ecosystem', values: ['sdxl', 'sd1', 'flux1', 'flux2Dev', 'flux2Klein', 'qwen', 'zImage', 'anima'] },
  'image:comfy': { field: 'ecosystem', values: ['sdxl', 'krea2', 'anima', 'chroma', 'qwen'] },
  'image:fal': { field: 'model', values: ['krea2'] },
  'image:krea': { field: 'model', values: ['krea2-medium', 'krea2-large', 'krea2-medium-turbo'] },
  'image:flux2': { field: 'model', values: ['dev', 'flex', 'pro', 'max', 'klein'] },
  'model3d:fal': { field: 'model', values: ['meshy', 'tripo'] },
  'model3d:comfy': { field: 'model', values: ['hunyuan3D', 'trellis2'] },
}

export function isDocumentedEngine(mediaType: unknown, engine: unknown): mediaType is MediaType {
  return (mediaType === 'image' || mediaType === 'video' || mediaType === 'model3d' || mediaType === 'audio')
    && typeof engine === 'string'
    && generationEngines[mediaType].some(item => item.id === engine)
}

export function starterInput(mediaType: MediaType, engine: string, variant?: string, model?: string): Record<string, unknown> {
  if(mediaType==='audio'&&engine==='aceStepAudio')return musicStarter()
  if (mediaType === 'image' && (engine === 'krea' || (engine === 'fal' && (!variant || variant === 'krea2')))) return { engine, model: engine === 'fal' ? 'krea2' : variant || 'krea2-medium', operation: 'createImage', prompt: '', aspectRatio: '1:1', creativity: 'medium', quantity: 1, imageStyleReferences: [], ...(engine === 'fal' ? { size: 'medium' } : {}) }
  if (mediaType === 'image' && engine === 'sdcpp' && (!variant || variant === 'sdxl')) {
    return { engine: 'sdcpp', ecosystem: 'sdxl', operation: 'createImage', model: 'urn:air:sdxl:checkpoint:civitai:101055@128078', prompt: '', width: 1024, height: 1024, quantity: 1, steps: 25, cfgScale: 7 }
  }
  if (mediaType === 'image' && engine === 'sdcpp' && variant === 'flux1') {
    // Resource IDs must come from the user's compatible selection/configuration.
    // Empty required AIR fields are intentional and block preview until supplied.
    return { engine, ecosystem: 'flux1', operation: 'createImage', diffuserModel: '', vaeModel: '', clipLModel: '', t5XXLModel: '', loras: {}, prompt: '', negativePrompt: '', width: 1024, height: 1024, quantity: 1, steps: 28, cfgScale: 3.5 }
  }
  if (mediaType === 'image' && engine === 'sdcpp') {
    const input: Record<string, unknown> = { engine, ecosystem: variant || 'sdxl', operation: 'createImage', prompt: '' }
    if (variant === 'sd1') input.model = ''
    if (variant === 'qwen') input.model = '20b'
    if (variant === 'zImage') input.model = 'turbo'
    if (variant === 'flux2Klein') input.modelVersion = '4b'
    const profile = imageCapability(input)
    if (profile) for (const [name, field] of Object.entries(profile.fields)) input[name] = field.default
    else Object.assign(input, { width: 1024, height: 1024, quantity: 1 })
    return input
  }
  if (mediaType === 'image' && engine === 'flux2') {
    return { engine, model: variant || 'dev', operation: 'createImage', prompt: '', width: 1024, height: 1024, quantity: 1 }
  }
  if (mediaType === 'image' && engine === 'comfy' && variant === 'krea2') return { engine, ecosystem: 'krea2', model: model === 'turbo' ? 'turbo' : 'raw', operation: 'createImage', prompt: '', width: 1024, height: 1024, quantity: 1, steps: model === 'turbo' ? 8 : 20, cfgScale: model === 'turbo' ? 1 : 4 }
  if (mediaType === 'image' && engine === 'comfy' && variant === 'anima') return {engine,ecosystem:'anima',operation:'createImage',prompt:'',width:1024,height:1024,quantity:1,steps:30,cfgScale:4}
  if (mediaType === 'image' && engine === 'comfy' && ['chroma','qwen'].includes(variant ?? '')) return { engine, ecosystem: variant!, model: variant === 'qwen' ? '2.1' : '', operation: 'createImage', prompt: '', width: 1024, height: 1024, quantity: 1, steps: variant === 'qwen' ? 25 : 28, cfgScale: variant === 'qwen' ? 1 : 3.5 }
  if (mediaType === 'image' && engine === 'comfy') return { engine, ecosystem: 'sdxl', operation: 'createImage', model: '', prompt: '', width: 1024, height: 1024 }
  if (mediaType === 'video' && engine === 'wan') return { engine, version: 'v2.2', provider: 'comfy', cfgScale: 4, prompt: '', width: 1280, height: 720, duration: 5 }
  // Consumer OpenAPI ComfyLtx23CreateVideoInput, checked 2026-09-27.
  if (mediaType === 'video' && engine === 'ltx2.3') return { engine, model: '22b-distilled', operation: 'createVideo', prompt: '', width: 1280, height: 720, duration: 3, fps: 24, steps: 8, guidanceScale: 1, generateAudio: false, quantity: 1 }
  if (mediaType === 'video' && engine === 'kling') return { engine, prompt: '', cfgScale: 0.5 }
  if (mediaType === 'model3d' && engine === 'fal' && (!variant || variant === 'meshy')) {
    return { engine, model: 'meshy', version: 'v6', operation: 'textTo3D', prompt: '', mode: 'full' }
  }
  if (mediaType === 'model3d' && engine === 'fal') return { engine, model: variant || 'tripo', operation: 'textTo3D', prompt: '' }
  const input: Record<string, unknown> = { engine }
  const discriminator = engineVariants[`${mediaType}:${engine}`]
  if (discriminator) input[discriminator.field] = variant || discriminator.values[0]
  if (mediaType !== 'model3d') input.prompt = ''
  return input
}
