import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, CheckCircle2, Download, ExternalLink, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react'
import type { DesktopUpdateAction, DesktopUpdatesSnapshot } from '../../shared/desktop-updates'
import { studioApi } from './api'
import { Button } from './ui'
import './desktop-updates.css'

const releases = 'https://github.com/Nocturne-Ai-Labs/civitai-studio/releases'
const message = (error: unknown) => error instanceof Error ? error.message : 'Studio could not check for updates. Try again.'
export function useDesktopUpdates(sessionReady: boolean) {
  const [snapshot, setSnapshot] = useState<DesktopUpdatesSnapshot | null>(null), [error, setError] = useState('')
  const [loading, setLoading] = useState(true), [working, setWorking] = useState<DesktopUpdateAction | null>(null), [deferred, setDeferred] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null), serial = useRef(0), sending = useRef(false), mounted = useRef(true), automatic = useRef(false)
  async function refresh() {
    if (sending.current) return
    request.current?.abort()
    const controller = new AbortController(), revision = ++serial.current; request.current = controller
    try {
      const result = await studioApi.desktopUpdates(controller.signal)
      if (mounted.current && !controller.signal.aborted && revision === serial.current) { setSnapshot(result); setError('') }
    } catch (error) { if (mounted.current && !controller.signal.aborted && revision === serial.current) setError(message(error)) }
    finally { if (mounted.current && !controller.signal.aborted && revision === serial.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true; void refresh()
    return () => { mounted.current = false; request.current?.abort() }
  }, [])
  useEffect(() => {
    if (!snapshot?.desktop) return
    const active = ['checking', 'downloading', 'ready', 'applying'].includes(snapshot.state?.status ?? '')
    const timer = setInterval(() => void refresh(), active ? 1000 : 10000)
    return () => clearInterval(timer)
  }, [snapshot?.desktop, snapshot?.state?.status])
  async function action(value: DesktopUpdateAction) {
    if (sending.current || !sessionReady) return
    sending.current = true; request.current?.abort()
    const controller = new AbortController(), revision = ++serial.current; request.current = controller
    setWorking(value); setError('')
    try {
      const result = await studioApi.desktopUpdateAction(value, controller.signal)
      if (mounted.current && !controller.signal.aborted && revision === serial.current) { setSnapshot(result); if (value !== 'cancel') setDeferred(null) }
    } catch (error) { if (mounted.current && !controller.signal.aborted && revision === serial.current) setError(message(error)) }
    finally { sending.current = false; if (mounted.current && revision === serial.current) setWorking(null) }
  }
  useEffect(() => {
    if (!sessionReady || automatic.current || !snapshot?.desktop || !snapshot.state || !['idle', 'manual'].includes(snapshot.state.status)) return
    automatic.current = true
    void action('check')
  }, [sessionReady, snapshot?.desktop, snapshot?.state?.status])
  return { snapshot, loading, error, working, ready: sessionReady, refresh, action, deferred, defer: () => setDeferred(snapshot?.state?.availableVersion ?? null) }
}
export type DesktopUpdateController = ReturnType<typeof useDesktopUpdates>

export function DesktopUpdateNotice({ updates, onOpen }: { updates: DesktopUpdateController; onOpen: () => void }) {
  const state = updates.snapshot?.state
  if (!state || !['available', 'ready', 'manual'].includes(state.status) || !state.availableVersion || updates.deferred === state.availableVersion) return null
  return <Button type="button" variant="secondary" size="sm" className="header-update-button" onClick={onOpen}><Download size={13} />{state.status === 'ready' ? 'Update ready' : 'Update available'}</Button>
}

export function DesktopUpdatesCard({ updates, clientBusy }: { updates: DesktopUpdateController; clientBusy: boolean }) {
  const { snapshot, loading, error, working } = updates, state = snapshot?.state
  const active = !!working || !!state && ['checking', 'downloading', 'applying'].includes(state.status)
  const applying = working === 'apply' || state?.status === 'applying'
  const busy = clientBusy || snapshot?.busy
  const progress = state?.totalBytes && state.totalBytes > 0 ? Math.min(100, Math.round(state.downloadedBytes / state.totalBytes * 100)) : null
  const summary = state?.notes?.trim().split(/\n\s*\n/)[0]?.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s+/gm, '').slice(0, 500)
  return <section className="panel-card settings-card desktop-updates-card" aria-labelledby="desktop-updates-title">
    <h2 id="desktop-updates-title" tabIndex={-1} className="section-title"><RefreshCw size={17} />App updates</h2>
    {loading && !snapshot ? <p role="status">Loading update settings…</p> : !snapshot?.desktop ? <><p>In-app updates are available in the installed desktop app.</p><p>Download the desktop version to get update checks and restart to apply new releases.</p><a className="desktop-release-link" href={releases} target="_blank" rel="noreferrer">Get Civitai Studio for desktop<ExternalLink size={13} /></a></> : state && <>
      <div className="desktop-update-version"><strong>Version {state.version}</strong><span>Beta channel</span></div>
      <p role="status" aria-live="polite" className="desktop-update-status">{active && <LoaderCircle size={15} className="spin" />}{state.status === 'upToDate' && <CheckCircle2 size={15} />}{applying ? 'Restarting Studio to apply the update…' : state.message}</p>
      {state.availableVersion && ['available', 'downloading', 'ready', 'error', 'manual'].includes(state.status) && <div className="desktop-update-release"><strong>Version {state.availableVersion}</strong>{summary && <p>{summary}</p>}{state.releaseUrl && <a className="desktop-release-link" href={state.releaseUrl} target="_blank" rel="noreferrer">Read release notes<ExternalLink size={13} /></a>}</div>}
      {state.status === 'downloading' && <div className="desktop-update-progress"><progress max={state.totalBytes || 1} value={state.totalBytes ? state.downloadedBytes : undefined} aria-label="Update download progress" />{progress !== null ? <span>{progress}% · {(state.downloadedBytes / 1048576).toFixed(1)} of {((state.totalBytes ?? 0) / 1048576).toFixed(1)} MB</span> : <span>{(state.downloadedBytes / 1048576).toFixed(1)} MB downloaded</span>}</div>}
      {state.status === 'ready' && <p>Your update is downloaded and verified. Restart when you are ready; your account, library, and settings stay in place.</p>}
      {state.status === 'ready' && busy && <p className="desktop-update-busy">{clientBusy ? 'Finish current saves or account actions before restarting.' : snapshot.busyMessage}</p>}
      <div className="settings-actions desktop-update-actions">
        <Button type="button" variant="secondary" disabled={active || !updates.ready} onClick={() => void updates.action('check')}><RefreshCw size={14} />{working === 'check' || state.status === 'checking' ? 'Checking…' : 'Check for updates'}</Button>
        {state.supported && (state.status === 'available' || state.status === 'error' && state.canRetry && !!state.availableVersion) && <Button type="button" disabled={active || !updates.ready} onClick={() => void updates.action('download')}><ArrowDownToLine size={14} />{state.status === 'error' ? 'Retry download' : 'Download update'}</Button>}
        {state.status === 'downloading' && <Button type="button" variant="ghost" disabled={!!working || !updates.ready} onClick={() => void updates.action('cancel')}>Cancel download</Button>}
        {state.status === 'ready' && <><Button type="button" disabled={active || !!busy || !updates.ready} onClick={() => void updates.action('apply')}><RotateCw size={14} />Restart to apply update</Button><Button type="button" variant="ghost" disabled={active} onClick={updates.defer}>Later</Button></>}
        {!state.supported && <a className="desktop-release-link" href={state.releaseUrl || releases} target="_blank" rel="noreferrer">Download the latest release<ExternalLink size={13} /></a>}
      </div>
      {updates.deferred === state.availableVersion && state.status === 'ready' && <p>Restart postponed. The downloaded update will stay ready while Studio is open.</p>}
      {state.checkedAt && <p className="desktop-update-checked">Last checked {new Date(state.checkedAt).toLocaleString()}.</p>}
    </>}
    {error && <p role="alert" className="error-box">{error}{!snapshot && <Button type="button" size="sm" variant="ghost" onClick={() => void updates.refresh()}>Retry</Button>}</p>}
  </section>
}
