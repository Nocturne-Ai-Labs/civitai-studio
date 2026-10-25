export type DesktopUpdateAction = 'check' | 'download' | 'cancel' | 'apply'
export type DesktopUpdateStatus = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'ready' | 'applying' | 'error' | 'manual'
export type DesktopUpdateState = {
  version: string
  platform: 'windows-x86_64' | 'darwin-aarch64' | 'darwin-x86_64' | 'linux-x86_64'
  channel: 'beta'
  supported: boolean
  status: DesktopUpdateStatus
  availableVersion: string | null
  notes: string | null
  publishedAt: string | null
  downloadedBytes: number
  totalBytes: number | null
  message: string
  releaseUrl: string | null
  checkedAt: string | null
  canRetry: boolean
}
export type DesktopUpdatesSnapshot = { desktop: boolean; state: DesktopUpdateState | null; busy: boolean; busyMessage: string | null }
