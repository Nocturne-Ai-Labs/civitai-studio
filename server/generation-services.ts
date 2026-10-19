import { normalizeService, type GenerationServices } from '../shared/generation-services'
export class GenerationDiscoveryError extends Error { constructor(message:string,readonly status=503){super(message)} }

const cache = new Map<string, { result: GenerationServices; expires: number; attempted: number }>()
const active = new Set<string>()
const attempts = new Map<string,number>()
const ttl = 60_000

// Anonymous official metadata only. No bearer, cookies, caller URL, or provider
// submit/estimate metadata is forwarded. Private Studio access is enforced upstream.
export async function listGenerationServices(scope: string, refresh: boolean, signal?: AbortSignal): Promise<GenerationServices> {
  const now = Date.now(), previous = cache.get(scope)
  if (previous && previous.expires > now && !refresh) return { ...previous.result, cached:true }
  if (active.size >= 8 || active.has(scope) || now - (attempts.get(scope)??0) < 5000) throw new GenerationDiscoveryError('Please wait a few seconds before refreshing models again.',429)
  for (const [key,time] of attempts) if(now-time>ttl)attempts.delete(key)
  while(attempts.size>=200)attempts.delete(attempts.keys().next().value!)
  attempts.set(scope,now)
  active.add(scope)
  if (previous) previous.attempted = now
  try {
    const items = new Map<string, ReturnType<typeof normalizeService>>()
    const rawIds = new Set<string>()
    const timeout = AbortSignal.timeout(20_000)
    const combined = signal ? AbortSignal.any([signal,timeout]) : timeout
    let offset = 0, complete = false
    for (let page = 0; page < 20; page++) {
      const response = await fetch(`https://orchestration.civitai.com/v2/services?limit=200&offset=${offset}`, { method:'GET', headers:{Accept:'application/json'}, redirect:'error', signal:combined })
      if (!response.ok) { await response.body?.cancel(); throw new GenerationDiscoveryError(response.status === 429 ? 'Civitai is rate limiting model discovery. Retry shortly.' : 'Civitai live model discovery is unavailable.',response.status === 429 ? 429 : 503) }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Empty catalog')
      const chunks:Uint8Array[] = []; let bytes = 0
      try { while (true) { const {done,value} = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 4*1024*1024) { await reader.cancel(); throw new Error('Oversized catalog') }; chunks.push(value) } } finally { reader.releaseLock() }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!Array.isArray(payload.items) || payload.items.length > 200 || !Number.isSafeInteger(payload.totalCount) || payload.totalCount < 0 || payload.totalCount > 4000 || payload.offset !== offset) throw new Error('Invalid catalog page')
      for(const raw of payload.items) {
        if(typeof raw?.id!=='string'||!raw.id||raw.id.length>500||rawIds.has(raw.id))throw new Error('Inconsistent catalog pagination')
        rawIds.add(raw.id)
      }
      for (const raw of payload.items) { const service = normalizeService(raw); if (service && !items.has(service.id)) items.set(service.id,service) }
      offset += payload.items.length
      if (offset >= payload.totalCount) { complete = true; break }
      if (!payload.items.length) throw new Error('Catalog did not advance')
    }
    if (!complete) throw new Error('Incomplete catalog')
    const result:GenerationServices = { items:[...items.values()].filter((item):item is NonNullable<typeof item>=>Boolean(item)), checkedAt:new Date().toISOString(), cached:false }
    for (const [key,value] of cache) if (value.expires < now) cache.delete(key)
    while (cache.size >= 100) cache.delete(cache.keys().next().value!)
    cache.set(scope,{result,expires:Date.now()+ttl,attempted:now})
    return result
  } catch (error) {
    if (error instanceof GenerationDiscoveryError) throw error
    throw new GenerationDiscoveryError('Live Civitai models could not be refreshed. Your current configuration is preserved. Try again shortly.',503)
  } finally { active.delete(scope) }
}
