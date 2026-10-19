import { engineVariants, generationEngines, type MediaType } from '../../shared/generation-catalog'
import { videoSourceOperations, type SourceOperation, type WorkflowId } from '../../shared/workflows'

export type GenerationModelChoice = { value: string; label: string; engine: string; variant: string; model?: 'raw' | 'turbo' }

const mediaTypeLabels: Record<MediaType, string> = { image: 'Image', video: 'Video', model3d: '3D model', audio: 'Audio' }

// A workflow constrains the generated medium, independently of its source media
// and the engine/family used to produce it.
export function workflowModelType(workflow: WorkflowId): { value: MediaType; label: string } | null {
  if (workflow === 'extractMetadata') return null
  const value: MediaType = workflow === 'createMusic' ? 'audio'
    : workflow === 'textTo3D' || workflow === 'imageTo3D' ? 'model3d'
    : workflow === 'video' || videoSourceOperations.some(operation => operation === workflow) ? 'video'
    : 'image'
  return { value, label: mediaTypeLabels[value] }
}

const familyLabels: Record<string, string> = {
  sdxl: 'SDXL', sd1: 'SD 1 / SD 1.5', flux1: 'Flux.1', flux2Dev: 'Flux 2 Dev',
  flux2Klein: 'Flux 2 Klein', qwen: 'Qwen', zImage: 'Z Image', anima: 'Anima', chroma: 'Chroma',
  'krea2-medium': 'Krea 2 Medium', 'krea2-large': 'Krea 2 Large', 'krea2-medium-turbo': 'Krea 2 Medium Turbo',
}

export const generationModelValue = (engine: string, variant: string, model?: 'raw' | 'turbo') =>
  `${engine}:${variant}${engine === 'comfy' && variant === 'krea2' ? `/${model ?? 'raw'}` : ''}`

// This presents existing Studio paths. It does not add provider operations.
export function generationModelChoices(media: MediaType, draft = false): GenerationModelChoice[] {
  if (media === 'model3d') return [{ value: 'fal:meshy', label: 'Meshy v6', engine: 'fal', variant: 'meshy' }]
  const choices = generationEngines[media].flatMap<GenerationModelChoice>(engine => {
    // The existing H3 Comfy path requires image/reference/control input.
    if (media === 'video' && engine.id === 'minimax-h3-comfy') return []
    const variants = engineVariants[`${media}:${engine.id}`]?.values ?? ['']
    return variants.flatMap<GenerationModelChoice>(variant => {
      if (draft && (engine.id !== 'sdcpp' || !['sd1', 'sdxl'].includes(variant))) return []
      if (media === 'image' && engine.id === 'comfy' && variant === 'krea2') {
        return (['raw', 'turbo'] as const).map(model => ({ value: generationModelValue(engine.id, variant, model), label: `Krea 2 ${model === 'raw' ? 'Raw' : 'Turbo'}`, engine: engine.id, variant, model }))
      }
      const label = media === 'audio' ? 'ACE-Step 2B Turbo'
        : engine.id === 'flux2' ? `Flux 2 ${variant[0]!.toUpperCase()}${variant.slice(1)}`
        : media === 'image' && engine.id === 'comfy' && variant === 'qwen' ? 'Qwen 2.1'
        : media === 'image' && engine.id === 'fal' ? 'Krea 2 · FAL'
        : familyLabels[variant] ?? engine.label
      return [{ value: generationModelValue(engine.id, variant), label, engine: engine.id, variant }]
    })
  })
  return choices.map(choice => {
    if (choices.filter(other => other.label === choice.label).length < 2) return choice
    const provider = choice.engine === 'sdcpp' ? 'SD CPP' : choice.engine === 'comfy' ? 'Comfy' : 'hosted'
    return { ...choice, label: `${choice.label} · ${provider}` }
  })
}

// Labels mirror the fixed mappings in server/source-workflows.ts.
export function sourceGenerationModel(operation: SourceOperation, settings: Record<string, unknown>): string {
  const labels: Record<SourceOperation, string> = {
    imageVariations: 'SDXL', imageEdit: 'Flux.1 Kontext Pro', imageUpscaler: '4x-Remacri',
    imageBackgroundRemoval: 'Background removal · provider default', preprocessImage: 'Canny',
    imageTo3D: 'Meshy v6', imageToVideo: 'LTX 2.3 Distilled', firstLastVideo: 'LTX 2.3 Distilled',
    referenceVideo: 'MiniMax H3 · Comfy', videoUpscaler: 'FlashVSR', videoInterpolation: 'VFIMamba',
    preprocessVideo: 'Canny', videoEdit: 'Wan 2.7',
  }
  return operation === 'imageUpscaler' && typeof settings.model === 'string' && settings.model.trim()
    ? 'Custom upscaler' : labels[operation]
}
