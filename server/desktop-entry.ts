import { isAbsolute, join } from 'node:path'
import { desktopBuild, initializeDesktop } from './desktop-runtime'
import { assets } from '../build/desktop/assets'

async function main() {
  if (!desktopBuild) throw new Error('Desktop executable required')
  // No environment-derived configuration or developer credential can enter
  // this executable. Native bootstrap arrives through a private stdin pipe.
  for (const name of Object.keys(process.env)) {
    if (/^(STUDIO_|CIVITAI_|VITE_|BUN_|NODE_OPTIONS$|NODE_ENV$|PORT$|HOST$|PUBLIC_BASE_URL$)/.test(name)) delete process.env[name]
  }
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let input = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('Native parent disconnected')
    input += decoder.decode(chunk.value, { stream: true })
    if (input.length > 16384) throw new Error('Invalid bootstrap')
    if (input.endsWith('\n')) break
  }
  const config = JSON.parse(input)
  const key = Buffer.from(config.encryptionKey ?? '', 'base64')
  if (!isAbsolute(config.dataDir ?? '') || key.length !== 32 || key.toString('base64') !== config.encryptionKey
    || !/^studio_desktop_[a-f0-9]{32}$/.test(config.gateName ?? '') || !/^[a-f0-9]{64}$/.test(config.gate ?? '')) throw new Error('Invalid bootstrap')
  initializeDesktop({ dataDir: config.dataDir, encryptionKey: key, gateName: config.gateName, gate: config.gate, assets })
  process.env.NODE_ENV = 'production'
  process.env.HOST = '127.0.0.1'
  process.env.PORT = '0'
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:0'
  process.env.STUDIO_DATABASE_PATH = join(config.dataDir, 'studio.sqlite')
  process.env.STUDIO_LOCAL_OUTPUTS = 'false'
  // Native parent retains stdin for its lifetime. EOF also handles crashes or
  // forced termination on every platform, without polling process IDs.
  void (async () => { try { for (;;) { if ((await reader.read()).done) break } } finally { process.exit(0) } })()
  await import('./index')
}
main().catch(() => { console.error('Civitai Studio desktop service could not start.'); process.exit(1) })
