// Replaced only by the desktop executable build. Environment variables cannot
// turn the browser server into a local desktop production server.
declare const STUDIO_DESKTOP_BUILD: boolean
export const desktopBuild = typeof STUDIO_DESKTOP_BUILD !== 'undefined' && STUDIO_DESKTOP_BUILD === true

type DesktopRuntime = { dataDir: string; encryptionKey: Buffer; gateName: string; gate: string; assets: Record<string, string> }
let runtime: DesktopRuntime | null = null
export function initializeDesktop(value: DesktopRuntime) {
  if (!desktopBuild || runtime) throw new Error('Desktop bootstrap unavailable')
  runtime = value
}
export function desktopRuntime() {
  if (!desktopBuild) return null
  if (!runtime) throw new Error('Desktop bootstrap required')
  return runtime
}
