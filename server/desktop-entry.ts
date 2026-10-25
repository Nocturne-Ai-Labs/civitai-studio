import { isAbsolute, join } from 'node:path'
import { desktopBuild, initializeDesktop } from './desktop-runtime'
import { assets } from '../build/desktop/assets'
import { initializeDesktopUpdater } from './desktop-updates'
import { NativeRecords } from './native-records'
import type { DesktopUpdateState } from '../shared/desktop-updates'

async function main() {
  if (!desktopBuild) throw new Error('Desktop executable required')
  // No environment-derived configuration or developer credential can enter
  // this executable. Native bootstrap arrives through a private stdin pipe.
  for (const name of Object.keys(process.env)) {
    if (/^(STUDIO_|CIVITAI_|VITE_|BUN_|NODE_OPTIONS$|NODE_ENV$|PORT$|HOST$|PUBLIC_BASE_URL$)/.test(name)) delete process.env[name]
  }
  const reader = Bun.stdin.stream().getReader()
  const records = new NativeRecords(65536, 16384)
  let input = '', following: string[] = []
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('Native parent disconnected')
    const lines = records.push(chunk.value)
    if (lines.length) { input = lines[0]!; following = lines.slice(1); break }
  }
  if (new TextEncoder().encode(input).length > 16384) throw new Error('Invalid bootstrap')
  const config = JSON.parse(input)
  const key = Buffer.from(config.encryptionKey ?? '', 'base64')
  if (!isAbsolute(config.dataDir ?? '') || key.length !== 32 || key.toString('base64') !== config.encryptionKey
    || !/^studio_desktop_[a-f0-9]{32}$/.test(config.gateName ?? '') || !/^[a-f0-9]{64}$/.test(config.gate ?? '')) throw new Error('Invalid bootstrap')
  initializeDesktop({ dataDir: config.dataDir, encryptionKey: key, gateName: config.gateName, gate: config.gate, assets })
  const unsupported: DesktopUpdateState = {
    version: '0.0.0', platform: process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64' : 'linux-x86_64', channel: 'beta', supported: false,
    status: 'manual', availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null,
    message: 'The desktop update controller is unavailable. Download the latest desktop release to update this installation.',
    releaseUrl: 'https://github.com/Nocturne-Ai-Labs/civitai-studio/releases', checkedAt: null, canRetry: false,
  }
  const updater = initializeDesktopUpdater(config.updater ?? unsupported, message => { process.stdout.write(JSON.stringify(message) + '\n') })
  const control = (line: string) => { try { updater.receive(JSON.parse(line)) } catch { /* unknown native control records never become API input */ } }
  process.env.NODE_ENV = 'production'
  process.env.HOST = '127.0.0.1'
  process.env.PORT = '0'
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:0'
  process.env.STUDIO_DATABASE_PATH = join(config.dataDir, 'studio.sqlite')
  process.env.STUDIO_LOCAL_OUTPUTS = 'false'
  // Native parent retains stdin for its lifetime. EOF also handles crashes or
  // forced termination on every platform, without polling process IDs.
  void (async () => {
    try {
      following.forEach(control)
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; records.push(chunk.value).forEach(control) }
    } finally { process.exit(0) }
  })()
  await import('./index')
}
main().catch(() => { console.error('Civitai Studio desktop service could not start.'); process.exit(1) })
