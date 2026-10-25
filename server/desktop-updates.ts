import type { DesktopUpdateAction, DesktopUpdateState, DesktopUpdatesSnapshot } from '../shared/desktop-updates'
import { createUpdateActivity } from './update-activity'

const actions = new Set<DesktopUpdateAction>(['check', 'download', 'cancel', 'apply'])
const statuses = new Set(['idle', 'checking', 'upToDate', 'available', 'downloading', 'ready', 'applying', 'error', 'manual'])
const platforms = new Set(['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64'])
const releases = 'https://github.com/Nocturne-Ai-Labs/civitai-studio/releases'
const nullableText = (value: unknown, max: number) => value === null || typeof value === 'string' && value.length <= max
export function updateState(value: unknown): DesktopUpdateState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as DesktopUpdateState
  if (typeof state.version !== 'string' || state.version.length > 80 || !platforms.has(state.platform) || state.channel !== 'beta'
    || typeof state.supported !== 'boolean' || !statuses.has(state.status) || typeof state.canRetry !== 'boolean'
    || typeof state.message !== 'string' || state.message.length > 4000 || !nullableText(state.availableVersion, 80)
    || !nullableText(state.notes, 10000) || !nullableText(state.publishedAt, 80) || !nullableText(state.checkedAt, 80)
    || !Number.isSafeInteger(state.downloadedBytes) || state.downloadedBytes < 0
    || state.totalBytes !== null && (!Number.isSafeInteger(state.totalBytes) || state.totalBytes < 0)
    || state.releaseUrl !== null && (typeof state.releaseUrl !== 'string' || !new RegExp('^' + releases.replaceAll('.', '\\.') + '(?:/tag/[A-Za-z0-9._-]+)?$').test(state.releaseUrl))) return null
  // Copy only the public protocol fields. Native paths and signatures never reach HTTP.
  return { version: state.version, platform: state.platform, channel: 'beta', supported: state.supported, status: state.status, availableVersion: state.availableVersion, notes: state.notes, publishedAt: state.publishedAt, downloadedBytes: state.downloadedBytes, totalBytes: state.totalBytes, message: state.message, releaseUrl: state.releaseUrl, checkedAt: state.checkedAt, canRetry: state.canRetry }
}

type Activity = ReturnType<typeof createUpdateActivity>
type Pending = { action: DesktopUpdateAction; resolve: (state: DesktopUpdateState) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export function createDesktopUpdater(initial: DesktopUpdateState, send: (message: unknown) => void) {
  let state = initial, activity: Activity | null = null, checkpoint: (() => boolean) | null = null, sequence = 0
  const pending = new Map<string, Pending>()
  return {
    configure(value: Activity, flush: () => boolean) { activity = value; checkpoint = flush },
    snapshot(): DesktopUpdatesSnapshot {
      const busy = activity?.busy() ?? false
      return { desktop: true, state: { ...state }, busy, busyMessage: busy ? 'Finish current uploads, downloads, saves, and account changes before restarting.' : null }
    },
    async action(action: DesktopUpdateAction) {
      if (!actions.has(action)) throw new Error('Choose a supported update action.')
      if (!state.supported && action !== 'check') throw new Error(state.message || 'This installation needs a manual update.')
      if (pending.size) throw new Error('An update action is already being handled. Please wait.')
      if (action === 'apply' && state.status !== 'ready') throw new Error('Download and verify the update before restarting.')
      if (action === 'cancel' && state.status !== 'downloading') throw new Error('There is no update download to cancel.')
      const id = crypto.randomUUID()
      if (action === 'apply' && (!activity || !activity.reserve(id))) throw new Error('Finish current uploads, downloads, saves, and account changes before restarting.')
      return new Promise<DesktopUpdateState>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); activity?.resume(id); reject(new Error('The desktop update controller did not respond. Try again.')) }, 12000)
        pending.set(id, { action, resolve, reject, timer })
        try { send({ desktopUpdateRequest: 1, id, action }) }
        catch { clearTimeout(timer); pending.delete(id); activity?.resume(id); reject(new Error('The desktop update controller is unavailable. Reopen Studio.')) }
      })
    },
    receive(value: unknown) {
      if (!value || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      if (record.desktopUpdateResume === 1 && typeof record.id === 'string') { activity?.resume(record.id); return }
      if (record.desktopUpdateShutdown === 1 && typeof record.id === 'string' && record.id.length <= 80) {
        const id = record.id
        let ok = false
        try { ok = !!activity?.reserved(id) && activity.idle() && checkpoint?.() === true } catch { /* stay running when flush cannot complete */ }
        if (!ok) activity?.resume(id)
        send({ desktopUpdateShutdownReady: 1, id, ok })
        return
      }
      if (record.desktopUpdateState !== 1) return
      if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) <= sequence) return
      const next = updateState(record.state)
      if (!next || next.version !== initial.version || next.platform !== initial.platform) return
      sequence = Number(record.sequence)
      state = next
      if (typeof record.id === 'string') {
        const action = pending.get(record.id)
        if (action) {
          clearTimeout(action.timer); pending.delete(record.id)
          if (action.action === 'apply' && state.status !== 'applying') activity?.resume(record.id)
          action.resolve({ ...state })
        }
      }
    },
  }
}

let updater: ReturnType<typeof createDesktopUpdater> | null = null
export function initializeDesktopUpdater(state: unknown, send: (message: unknown) => void) {
  const initial = updateState(state)
  if (updater || !initial) throw new Error('Invalid desktop update bootstrap')
  updater = createDesktopUpdater(initial, send)
  return updater
}
export const desktopUpdater = () => updater
export const browserUpdateSnapshot = (): DesktopUpdatesSnapshot => ({ desktop: false, state: null, busy: false, busyMessage: null })
