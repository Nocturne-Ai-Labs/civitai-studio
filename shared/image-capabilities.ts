// Reviewed 2026-09-27: OpenAPI allOf/$ref inheritance + SD1/SDXL/Anima recipes.
// Provider bounds and Site recommendations must never be conflated.
export type ImageField = 'quantity' | 'width' | 'height' | 'steps' | 'cfgScale'
export type NumericCapability = { label: string; min: number; max: number; step: number; integer?: boolean; multipleOf?: number; default: number; slider?: [number, number] }
export type ImageCapability = { name: string; modelField?: 'model' | 'diffuserModel' | 'diffusionModel'; fields: Record<ImageField, NumericCapability>; sizes: [number, number][]; resolutionTiers?: { label: string; sizes: [number, number][] }[]; guidance: string; siteGuidance?: string }
export const imageCapabilitySources = {
  schema: 'https://orchestration.civitai.com/openapi/v2-consumers.json',
  recipes: 'https://github.com/civitai/civitai-developer-docs/tree/main/orchestration/recipes',
  animaSite: 'https://github.com/civitai/civitai/blob/main/src/shared/form-graph/generation/image/anima.graph.ts',
}
export function imageCapability(input: Record<string, unknown>): ImageCapability | null {
  // ComfyAnimaCreateImageGenInput + inherited properties, OpenAPI 2026-09-27.
  // Checkpoint release names/sizes are not model selectors in this schema.
  if(input.engine==='comfy'&&input.ecosystem==='anima'&&(input.operation??'createImage')==='createImage') {
    return {name:'Anima · Comfy',modelField:'diffuserModel',fields:{
      quantity:{label:'Images',min:1,max:12,step:1,integer:true,default:1},
      width:{label:'Width',min:64,max:2048,step:1,integer:true,default:1024},
      height:{label:'Height',min:64,max:2048,step:1,integer:true,default:1024},
      steps:{label:'Steps',min:1,max:150,step:1,integer:true,default:30},
      cfgScale:{label:'CFG scale',min:0,max:30,step:0.1,default:4},
    },sizes:[[1024,1024],[1152,896],[896,1152],[1344,768],[768,1344]],guidance:'Select a confirmed Anima checkpoint version or use the provider default. Cost preview checks the complete configuration.'}
  }
  // ComfyChromaCreateImageGenInput / ComfyQwen21CreateImageGenInput, 2026-09-27.
  if(input.engine==='comfy'&&input.operation==='createImage'&&(input.ecosystem==='chroma'||(input.ecosystem==='qwen'&&input.model==='2.1'))) {
    const qwen=input.ecosystem==='qwen'
    return {name:qwen?'Comfy Qwen 2.1':'Comfy Chroma',modelField:qwen?'diffusionModel':'model',fields:{
      quantity:{label:'Images',min:1,max:12,step:1,integer:true,default:1},
      width:{label:'Width',min:64,max:2048,step:1,integer:true,default:1024},
      height:{label:'Height',min:64,max:2048,step:1,integer:true,default:1024},
      steps:{label:'Steps',min:1,max:150,step:1,integer:true,default:qwen?25:28},
      cfgScale:{label:'CFG scale',min:0,max:30,step:0.1,default:qwen?1:3.5},
    },sizes:[[1024,1024],[1152,896],[896,1152]],guidance:'Reviewed Comfy API bounds. Model availability and cost are confirmed by provider preview.'}
  }
  if (input.engine === 'comfy' && input.ecosystem === 'krea2' && input.operation === 'createImage' && ['raw', 'turbo'].includes(String(input.model))) {
    const turbo = input.model === 'turbo'
    const sizes: [number, number][] = [[1024,1024],[1024,768],[768,1024],[1024,576],[576,1024]]
    return { name: `Comfy Krea 2 ${turbo ? 'Turbo' : 'Raw'}`, fields: {
      quantity: { label: 'Images', min: 1, max: 12, step: 1, integer: true, default: 1 },
      width: { label: 'Width', min: 64, max: 2048, step: 1, integer: true, default: 1024 },
      height: { label: 'Height', min: 64, max: 2048, step: 1, integer: true, default: 1024 },
      steps: { label: 'Steps', min: 1, max: 150, step: 1, integer: true, default: turbo ? 8 : 20 },
      cfgScale: { label: 'CFG scale', min: 0, max: 30, step: 0.1, default: turbo ? 1 : 4 },
    }, sizes, resolutionTiers: [{ label: '1K', sizes }, { label: '2K', sizes: sizes.map(([w,h]) => [w*2,h*2]) }], guidance: 'Comfy Krea 2 accepts 64–2048 pixels per side, including 2048 × 2048. Resolution tiers here describe the longest edge. Cost and availability are confirmed by provider preview.' }
  }
  if (input.engine !== 'sdcpp' || input.operation !== 'createImage') return null
  const ecosystem = String(input.ecosystem)
  if (['flux1', 'flux2Klein', 'qwen', 'zImage'].includes(ecosystem)) {
    if (ecosystem === 'qwen' && input.model !== '20b') return null
    if (ecosystem === 'zImage' && !['base','turbo'].includes(String(input.model))) return null
    if (ecosystem === 'flux2Klein' && input.modelVersion !== undefined && !['4b','4b-base','9b','9b-base'].includes(String(input.modelVersion))) return null
    const flux = ecosystem.startsWith('flux'), flux1 = ecosystem === 'flux1', qwen = ecosystem === 'qwen', turbo = ecosystem === 'zImage' && input.model === 'turbo'
    const min = flux1 ? 832 : flux ? 512 : 64, max = flux1 ? 1216 : 2048, multiple = qwen ? 8 : 16
    return {
      name: flux1 ? 'Flux.1' : flux ? 'Flux 2 Klein' : qwen ? 'Qwen 20B' : `Z Image ${input.model}`,
      modelField: flux1 || ecosystem === 'zImage' ? 'diffuserModel' : undefined,
      fields: {
        quantity: { label: 'Images', min: 1, max: flux ? 4 : 12, step: 1, integer: true, default: 1 },
        width: { label: 'Width', min, max, step: multiple, multipleOf: multiple, integer: true, default: 1024 },
        height: { label: 'Height', min, max, step: multiple, multipleOf: multiple, integer: true, default: 1024 },
        steps: { label: 'Steps', min: flux ? 4 : 1, max: flux ? 50 : 150, step: 1, integer: true, default: flux1 ? 28 : turbo ? 9 : 20, slider: turbo ? [1,15] : [flux ? 4 : 1,50] },
        cfgScale: { label: 'CFG scale', min: flux ? 1 : 0, max: flux ? 20 : 30, step: 0.1, default: flux1 ? 3.5 : flux ? 5 : qwen ? 2.5 : turbo ? 1 : 4 },
      },
      sizes: flux1 ? [[1024,1024],[1216,832],[832,1216]] : [[1024,1024],[1152,896],[896,1152]],
      guidance: flux1 ? 'Recipe default: 1024 square, 28 steps, CFG 3.5. Studio requires diffuser, VAE and text encoders under the OpenAPI schema. The recipe permits omitting VAE/CLIP-L/T5; this discrepancy remains unresolved.' : flux ? 'Klein default: 1024 square, 20 steps, CFG 5. Version tiers share these provider bounds; distilled/base tuning may differ.' : qwen ? 'Native ~1024 square; recipe guidance 20–30 steps and CFG 2–4.' : turbo ? 'Turbo recipe guidance: 8–12 steps and CFG 1; provider defaults 9 / 1.' : 'Base recipe guidance: 20–30 steps and CFG 3–5; provider defaults 20 / 4.',
    }
  }
  if (!['sd1', 'sdxl', 'anima'].includes(ecosystem)) return null
  const anima = input.ecosystem === 'anima', sd1 = input.ecosystem === 'sd1'
  // This exact published version is identified by the official Site graph, not a name heuristic.
  const turbo = anima && typeof input.diffuserModel === 'string' && /^urn:air:anima:(checkpoint|diffusionmodel|unet):civitai:[1-9]\d*@3108589$/.test(input.diffuserModel)
  const size = sd1 ? 512 : 1024
  return {
    name: sd1 ? 'SD1' : anima ? 'Anima' : 'SDXL', modelField: anima ? 'diffuserModel' : 'model',
    fields: {
      quantity: { label: 'Images', min: 1, max: 12, step: 1, integer: true, default: 1 },
      width: { label: 'Width', min: 64, max: 2048, step: 16, integer: true, multipleOf: 16, default: size },
      height: { label: 'Height', min: 64, max: 2048, step: 16, integer: true, multipleOf: 16, default: size },
      steps: { label: 'Steps', min: 1, max: 150, step: 1, integer: true, default: anima ? 30 : 20, slider: anima ? turbo ? [1,15] : [8,50] : [1,50] },
      cfgScale: { label: 'CFG scale', min: 0, max: 30, step: 0.1, default: anima ? 4 : 7, slider: anima ? turbo ? [1,2] : [1,20] : [0,15] },
    },
    sizes: sd1 ? [[512,512],[512,768],[768,512]] : [[1024,1024],[1152,896],[896,1152],[1344,768],[768,1344]],
    guidance: sd1 ? 'Native 512 × 512. Larger dimensions are accepted by the API but may reduce quality.' : anima ? 'Native ~1 megapixel. SD CPP recipe recommends 25–35 steps and CFG 3–5; provider defaults are 30 / 4.' : 'Native ~1 megapixel. Recipe guidance: 20–30 steps, CFG 6–8. Distilled checkpoints may differ.',
    siteGuidance: anima ? turbo ? 'Exact Turbo version 3108589: Site Comfy sliders use steps 1–15 (default 8), CFG 1–2 (default 1). These are guidance only for this SD CPP path; availability remains provider-validated. Your values are not reset.' : 'Site Comfy base sliders use steps 8–50 (default 25), CFG 1–20 (default 7). These guide the slider, not the SD CPP hard limits or defaults. Custom checkpoints may differ.' : undefined,
  }
}
export function imageFieldError(field: NumericCapability, value: unknown): string | null {
  if (value === undefined) return null // Omitted fields retain documented provider defaults.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max || (field.integer && !Number.isInteger(value))) return `${field.label}: use ${field.integer ? 'a whole number' : 'a number'} from ${field.min} to ${field.max}.`
  if (field.multipleOf && value % field.multipleOf !== 0) return `${field.label}: use a multiple of ${field.multipleOf}.`
  return null
}
export function imageParameterError(input: Record<string, unknown>): string | null {
  if (input.outputFormat !== undefined && !['jpeg','png','webP'].includes(String(input.outputFormat))) return 'Choose JPEG, PNG, WebP or the provider default.'
  if (hostedKrea(input)) {
    if (input.resolution !== undefined || input.width !== undefined || input.height !== undefined) return 'Hosted Krea uses model/size tiers and aspectRatio. Remove resolution, width and height in JSON.'
    if (input.aspectRatio !== undefined && !kreaRatios.includes(String(input.aspectRatio))) return 'Choose a supported Krea aspect ratio.'
    if (input.engine === 'fal' && input.size !== undefined && !['medium','large'].includes(String(input.size))) return 'FAL Krea 2 size must be medium or large.'
    if (input.creativity !== undefined && !['raw','low','medium','high'].includes(String(input.creativity))) return 'Choose a supported Krea creativity setting.'
    if(input.seed!==undefined&&input.seed!==null) {
      const error=imageFieldError({label:'Seed',min:-2147483648,max:2147483647,step:1,integer:true,default:0},input.seed)
      if(error)return error
    }
    if(input.engine==='krea')for(const name of ['intensity','complexity','movement']) {
      const error=imageFieldError({label:name,min:-100,max:100,step:1,integer:true,default:0},input[name])
      if(error)return error
    }
    return imageFieldError({ label: 'Images', min: 1, max: 10, step: 1, integer: true, default: 1 },input.quantity)
  }
  const profile = imageCapability(input)
  if (!profile) return null
  for (const [key, field] of Object.entries(profile.fields)) {
    const error = imageFieldError(field, input[key]); if (error) return error
  }
  if (input.ecosystem === 'anima' && input.model !== undefined) return 'Anima does not accept model. Remove it in JSON; the built-in model needs no AIR, or use diffuserModel.'
  const required = input.ecosystem === 'flux1' ? ['diffuserModel','vaeModel','clipLModel','t5XXLModel'] : ['sd1','sdxl','chroma'].includes(String(input.ecosystem)) ? ['model'] : []
  for (const name of required) if (typeof input[name] !== 'string' || !String(input[name]).trim()) return `${name}: supply the required compatible model AIR before preview.`
  // No separate hard pixel-area limit is published for these selected createImage schemas.
  return null
}

export const kreaRatios = ['1:1','4:3','3:2','16:9','2.35:1','4:5','2:3','9:16']
export const hostedKrea = (input: Record<string, unknown>) => input.operation === 'createImage' && ((input.engine === 'fal' && input.model === 'krea2') || (input.engine === 'krea' && ['krea2-medium','krea2-large','krea2-medium-turbo'].includes(String(input.model))))

export function imageAdvancedReason(input: Record<string, unknown>): string {
  if (input.engine === 'sdcpp' && input.ecosystem === 'flux2Dev') return 'Flux 2 Dev remains advanced: its SD CPP schema has numeric bounds, but current recipe sizing guidance conflicts (no divisibility versus multiples of 8). Studio does not invent a hard grid; review JSON and let provider preview validate.'
  if (input.engine === 'sdcpp') return 'This operation or model selector is not mapped to guided controls. Choose a supported text-to-image starter or keep the complete input in JSON.'
  return 'Advanced-only: this engine has model/operation-specific field names, enum sizes or coupled sizing/count rules. Studio does not send generic steps, CFG, size or quantity controls to it. Use documented JSON; provider preview validates.'
}
