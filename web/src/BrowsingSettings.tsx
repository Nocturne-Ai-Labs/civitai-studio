import { useEffect, useRef, useState } from 'react'
import { browsingLabels, browsingModes, type BrowsingMode, type BrowsingPreference } from '../../shared/browsing'
import { setActiveBrowsing, studioApi } from './api'
import { Button } from './ui'
import { Select } from './controls'

export function useBrowsingSettings(accountId: string | null) {
  const owner = useRef(accountId); owner.current = accountId
  const [snapshot,setSnapshot] = useState<{ owner: string; value: BrowsingPreference } | null>(null)
  const [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const sequence = useRef(0), mutating = useRef(false), channel = useRef<BroadcastChannel | null>(null)
  const pendingRefresh = useRef(false), mutationSerial = useRef(0)
  const settings = snapshot?.owner === accountId ? snapshot.value : null
  function accept(value: BrowsingPreference) {
    if (!accountId || owner.current !== accountId) return
    setActiveBrowsing(accountId,value.revision)
    setSnapshot({ owner: accountId, value }); setError('')
  }
  function invalidate() {
    if (accountId) setActiveBrowsing(accountId,null)
    setSnapshot(null)
  }
  async function refresh(signal?: AbortSignal) {
    if (!accountId) return
    if (mutating.current) { pendingRefresh.current = true; return }
    const current = ++sequence.current
    try {
      const value = await studioApi.browsingPreference(accountId,signal)
      if (owner.current === accountId && current === sequence.current && !signal?.aborted) accept(value)
    } catch (e) { if (owner.current === accountId && current === sequence.current && !signal?.aborted) { invalidate(); setError(e instanceof Error ? e.message : 'Browsing preference unavailable.') } }
  }
  useEffect(() => {
    sequence.current++; mutationSerial.current++; pendingRefresh.current = false; mutating.current = false; setBusy(false); setError(''); invalidate()
    const controller = new AbortController()
    const changed = () => { sequence.current++; invalidate(); void refresh(controller.signal) }
    const localChanged = (event: Event) => { if ((event as CustomEvent).detail === accountId) changed() }
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('studio-browsing-preference')
      channel.current.onmessage = event => { if (event.data?.accountId === accountId) changed() }
    }
    const focused = () => { if (document.visibilityState === 'visible') void refresh(controller.signal) }
    window.addEventListener('studio-browsing-changed',localChanged)
    window.addEventListener('focus',focused)
    document.addEventListener('visibilitychange',focused)
    const timer = window.setInterval(focused,15000)
    void refresh(controller.signal)
    return () => {
      sequence.current++; mutationSerial.current++; pendingRefresh.current = false; mutating.current = false
      controller.abort(); window.clearInterval(timer); channel.current?.close(); channel.current = null
      window.removeEventListener('studio-browsing-changed',localChanged); window.removeEventListener('focus',focused); document.removeEventListener('visibilitychange',focused)
      if (accountId) setActiveBrowsing(accountId,null)
    }
  },[accountId])
  async function change(mode: BrowsingMode) {
    if (!accountId || mutating.current) return
    const mutation = ++mutationSerial.current
    mutating.current = true; setBusy(true); const current = ++sequence.current; invalidate(); setError('')
    try {
      const value = await studioApi.setBrowsingPreference(accountId,mode)
      if (owner.current === accountId && mutation === mutationSerial.current) {
        // A change notification during PUT makes its response potentially stale.
        // Keep discovery gated until the queued GET reads the current revision.
        if (current === sequence.current && !pendingRefresh.current) accept(value)
        channel.current?.postMessage({accountId})
      }
    } catch (e) { if (owner.current === accountId && mutation === mutationSerial.current && current === sequence.current) setError(e instanceof Error ? e.message : 'Could not save browsing preference. Refresh and try again.') }
    finally {
      if (owner.current === accountId && mutation === mutationSerial.current) {
        mutating.current = false; setBusy(false)
        if (pendingRefresh.current) { pendingRefresh.current = false; void refresh() }
      }
    }
  }
  return { settings, error, busy, change, refresh }
}
export type BrowsingController = ReturnType<typeof useBrowsingSettings>
export function BrowsingSettings({ accountId, browsing }: { accountId: string | null; browsing: BrowsingController }) {
  const [choice,setChoice] = useState<BrowsingMode>('safe')
  useEffect(() => { setChoice(browsing.settings?.mode ?? 'safe') },[accountId,browsing.settings?.revision])
  return <section className="panel-card settings-card" aria-labelledby="browsing-title"><h2 id="browsing-title" className="section-title">Browsing</h2>
    <p>Choose which Civitai community artwork and model previews this account can show.</p>
    {!accountId ? <p>Connect your account to change its browsing preference.</p> : <>
      <Select label="Community content level" value={choice} disabled={!browsing.settings || browsing.busy} options={browsingModes.map(mode => ({value:mode,label:browsingLabels[mode]}))} onChange={value => setChoice(value as BrowsingMode)} />
      {choice === 'mature' && <p>Includes adult content rated R, X and XXX alongside safe artwork. Apply only if you are 18 or older and want to see it.</p>}
      <Button type="button" disabled={!browsing.settings || browsing.busy || choice === browsing.settings.mode} onClick={() => void browsing.change(choice)}>{browsing.busy ? 'Saving…' : choice === 'mature' ? 'I’m 18+ — include mature content' : 'Apply browsing preference'}</Button>
      {browsing.error ? <p role="alert">{browsing.error} <Button type="button" variant="ghost" onClick={() => void browsing.refresh()}>Refresh preference</Button></p> : !browsing.settings ? <p role="status">Loading browsing preference…</p> : <p role="status">Saved: {browsingLabels[browsing.settings.mode]}.</p>}
      <p className="field-help">Saved per account. Civitai.com and Civitai.red links use this setting. Provider account and region restrictions still apply. Theme and generation content policy are separate.</p>
    </>}
  </section>
}
