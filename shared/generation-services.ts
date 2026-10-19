// Public ListServices contract: https://orchestration.civitai.com/openapi/v2-consumers.json
// IDs are opaque. Never dispatch submit/estimate URLs or infer inputs from IDs.
export type GenerationService = {
  id: string; name: string; category: string; step: string | null
  parameters: Record<string, string>; inputs: string[]; outputs: string[]
  status: 'available' | 'degraded' | 'unavailable' | 'unknown'
}
export type GenerationServices = { items: GenerationService[]; checkedAt: string; cached: boolean }

export function normalizeService(value: unknown): GenerationService | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, any>
  if (typeof v.id !== 'string' || !v.id || v.id.length > 500 || typeof v.category !== 'string' || !['image','video','audio','3d'].includes(v.category)) return null
  if (!v.parameters || typeof v.parameters !== 'object' || Array.isArray(v.parameters) || Object.keys(v.parameters).length > 24) return null
  const parameters: Record<string,string> = Object.create(null)
  for (const [key, val] of Object.entries(v.parameters)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || key.length > 80 || typeof val !== 'string' || val.length > 200) return null
    parameters[key] = val
  }
  const modes = (values: unknown) => Array.isArray(values) ? values.filter((x): x is string => typeof x === 'string' && x.length < 40).slice(0,12) : []
  return { id:v.id, name:typeof v.name === 'string' && v.name.trim() ? v.name.slice(0,200) : v.id, category:v.category,
    step:typeof v.step === 'string' ? v.step.slice(0,100) : null, parameters,
    inputs:modes(v.modalities?.input), outputs:modes(v.modalities?.output),
    status:['available','degraded','unavailable'].includes(v.status) ? v.status : 'unknown' }
}

// Every discriminator published by the service must be preserved by the reviewed
// adapter. A newer model/version cannot accidentally use an older starter input.
export function serviceMatchesInput(service: GenerationService, input: Record<string,unknown>): boolean {
  return Object.keys(service.parameters).length > 0 && Object.entries(service.parameters).every(([key,value]) => input[key] === value)
}
