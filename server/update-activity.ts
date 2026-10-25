// One synchronous barrier covers incoming requests and the final restart check.
// The updater's own status/actions do not acquire a work lease.
export function createUpdateActivity(backgroundBusy: () => boolean = () => false) {
  let active = 0, applying: string | null = null
  return {
    begin() {
      if (applying) return null
      active++
      let ended = false
      return () => { if (!ended) { ended = true; active-- } }
    },
    reserve(id: string) {
      if (applying || active || backgroundBusy()) return false
      applying = id
      return true
    },
    idle: () => active === 0 && !backgroundBusy(),
    busy: () => active > 0 || backgroundBusy(),
    reserved: (id: string) => applying === id,
    applying: () => applying !== null,
    resume(id?: string) { if (!id || applying === id) applying = null },
  }
}

export function holdResponse(response: Response, release?: (() => void) | null) {
  if (!release) return response
  if (!response.body) { release(); return response }
  const reader = response.body.getReader()
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) { release(); controller.close() }
        else controller.enqueue(chunk.value)
      } catch (error) { release(); controller.error(error) }
    },
    async cancel(reason) { try { await reader.cancel(reason) } finally { release() } },
  }), { status: response.status, statusText: response.statusText, headers: response.headers })
}
