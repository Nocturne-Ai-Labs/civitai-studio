import { providerFetch, ConnectionError, type BearerLease } from './connection'
// Only the official hosted MCP endpoint is used. No private RPC or arbitrary URL proxy.
const endpoint = 'https://mcp.civitai.com/mcp'
export class McpError extends Error {
  constructor(message: string, readonly ambiguous: boolean, readonly status = 502) { super(message) }
}
function providerError(value: unknown, dispatched: boolean, status = 502): McpError {
  // Inspect provider text only to classify it. Never return raw bodies, URLs or credentials.
  const text = typeof value === 'string' ? value.toLowerCase() : JSON.stringify(value ?? '').toLowerCase()
  if (status === 401 || status === 403 || /unauthori|forbidden|permission|scope|api.?key|bearer/.test(text)) return new McpError('Civitai denied this action. Check the permissions required for this action and reconnect the key.', false, 403)
  if (/onboard|muted|banned/.test(text)) return new McpError('Civitai requires an onboarded, non-muted account. Complete account setup on Civitai before retrying.', false, 403)
  if (/feature.{0,30}disabl|flag|collections.{0,30}disabl/.test(text)) return new McpError('Collections are disabled for this Civitai account or deployment.', false, 403)
  if (status === 429 || /rate.?limit|too many requests/.test(text)) return new McpError('Civitai is rate limiting this action. Try again later.', false, 429)
  if (/validation|invalid input|zod|unknown tool|method not found/.test(text)) return new McpError('Civitai rejected the tool input or this deployment does not expose the required tool.', false, 422)
  return new McpError(dispatched ? 'Civitai did not confirm the action. Its outcome may be uncertain.' : 'Civitai MCP could not be reached. No tool action was sent.', dispatched, status)
}
async function readRpc(response: Response, id: string, dispatched: boolean): Promise<any> {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw providerError('', dispatched, response.status) }
  if (!response.body) throw new McpError('Civitai returned no MCP result.', dispatched)
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let size = 0
  const sse = response.headers.get('content-type')?.includes('text/event-stream')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) { size += value.length; if (size > 2 * 1024 * 1024) throw new McpError('Civitai MCP returned an oversized result.', dispatched); text += decoder.decode(value, { stream: true }) }
      if (sse) {
        const events = text.replace(/\r\n/g, '\n').split('\n\n'); text = events.pop() ?? ''
        for (const event of events) {
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (!data) continue
          const message = JSON.parse(data)
          if (message.id === id) { await reader.cancel().catch(() => {}); return message }
        }
      }
      if (done) break
    }
    if (!sse) { const result = JSON.parse(text); if (result.id === id) return result }
    throw new McpError('Civitai MCP did not return the expected response ID.', dispatched)
  } finally { reader.releaseLock() }
}
export async function callCivitaiTool(key: BearerLease, name: 'upsert_collection' | 'follow_collection' | 'add_to_collection' | 'upload_image' | 'create_post' | 'get_post' | 'publish_post' | 'toggle_favorite_model', args: Record<string, unknown>, options?: { uncertainAfterDispatch?: boolean; beforeDispatch?: () => void }): Promise<Record<string, any>> {
  const callOptions = options
  let sessionId: string | null = null; let protocol = '2025-03-26'; let dispatched = false
  const headers = () => ({ Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': protocol, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) })
  async function rpc(method: string, params: unknown) {
    const id = crypto.randomUUID()
    // Local preparation may fail safely before any tool request is dispatched.
    const options: RequestInit = { method: 'POST', redirect: 'error', headers: headers(), signal: AbortSignal.timeout(60000), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }
    const response = await providerFetch(key, endpoint, options, name === 'toggle_favorite_model' ? 524288 : name === 'get_post' ? 32 : ['upload_image','create_post','publish_post'].includes(name) ? 64 : 262144, () => { if (method === 'tools/call') { callOptions?.beforeDispatch?.(); dispatched = true } })
    const nextSession = response.headers.get('mcp-session-id'); if (nextSession) sessionId = nextSession
    const message = await readRpc(response, id, dispatched)
    if (message.error) throw providerError(message.error, dispatched)
    if (!message.result || typeof message.result !== 'object') throw new McpError('Civitai returned an invalid MCP envelope.', dispatched)
    return message.result
  }
  try {
    const initialized = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'Civitai Studio', version: '0.1.0' } })
    if (typeof initialized.protocolVersion !== 'string') throw new McpError('Civitai did not negotiate an MCP protocol.', false)
    protocol = initialized.protocolVersion
    const notification = await providerFetch(key, endpoint, { method: 'POST', redirect: 'error', headers: headers(), signal: AbortSignal.timeout(15000), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    await notification.body?.cancel().catch(() => {})
    if (!notification.ok) throw providerError('', false, notification.status)
    const result = await rpc('tools/call', { name, arguments: args })
    if (result.isError === true || result.structuredContent?.ok === false) throw providerError(result.structuredContent ?? result.content, true)
    if (!result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) throw new McpError('Civitai returned no structured tool result; the action may have completed.', true)
    return result.structuredContent
  } catch (error) {
    // create_post is composite. Even permission/rate-limit/validation responses
    // after dispatch do not prove that creation or cleanup had no side effect.
    // No provider failure currently supplies authoritative rollback evidence.
    if (options?.uncertainAfterDispatch && dispatched) throw new McpError((error instanceof McpError ? error.message : 'Civitai did not confirm the collection save.') + ' The request was sent; its outcome is uncertain. Inspect the collection on Civitai before any further action.', true, error instanceof McpError ? error.status : 502)
    if (name === 'create_post' && dispatched) {
      throw new McpError('Civitai did not confirm post creation after the request was sent. A draft or published post may remain, even if the reported failure concerns permissions, rate limits or validation.', true, error instanceof McpError ? error.status : 502)
    }
    if (error instanceof ConnectionError) throw new McpError(error.message, dispatched, 403)
    if (error instanceof McpError) throw error
    throw new McpError(dispatched ? 'Civitai did not confirm the action. Its outcome may be uncertain.' : 'Civitai MCP connection failed. No tool action was sent.', dispatched)
  }
}
