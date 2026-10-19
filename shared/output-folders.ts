export const outputCategories = ['images', 'videos', 'audio', '3d-models', 'lora'] as const
export type OutputCategory = typeof outputCategories[number]
export function outputCategory(generation: { mediaType?: unknown }, output: { kind?: unknown; role?: unknown }): OutputCategory {
  if (generation.mediaType === 'training' || output.kind === 'checkpoint' || output.role === 'training-sample') return 'lora'
  return output.kind === 'audio' ? 'audio' : output.kind === 'video' ? 'videos' : output.kind === 'model3d' ? '3d-models' : 'images'
}
export const validOutputCategory = (value: unknown): value is OutputCategory => outputCategories.includes(value as OutputCategory)
