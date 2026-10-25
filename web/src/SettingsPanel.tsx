import { useEffect, useRef, useState } from 'react'
import { Copy, FolderOpen, Settings } from 'lucide-react'
import { studioApi } from './api'
import { Button, Input } from './ui'
import { folderSavingSupported } from './folder-save'
import type { LocalStorageSettings } from '../../shared/local-storage'
import { BrowsingSettings, type BrowsingController } from './BrowsingSettings'
import { AccentColorPicker } from './AccentColorPicker'

export function useLocalStorageSettings(accountId: string | null) {
  const owner = useRef(accountId); owner.current = accountId
  const version = useRef(0), pending = useRef(false), saving = useRef(false)
  const [snapshot, setSnapshot] = useState<{ owner: string | null; value: LocalStorageSettings } | null>(null)
  const [message, setMessage] = useState<{ owner: string | null; text: string; source: 'action' | 'status' } | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const settings = snapshot?.owner === accountId ? snapshot.value : null
  const error = message?.owner === accountId ? message.text : ''
  async function refresh(signal?: AbortSignal) {
    if (!accountId || pending.current) return
    const revision = version.current
    try {
      const value = await studioApi.localStorage(accountId, signal)
      if (owner.current === accountId && revision === version.current && !signal?.aborted) { saving.current = !!value.busy; setSnapshot({ owner: accountId, value }); setMessage(current => current?.source === 'status' ? null : current) }
    } catch (e) { if (owner.current === accountId && revision === version.current && !signal?.aborted) setMessage({ owner: accountId, source: 'status', text: e instanceof Error ? e.message : 'Storage status unavailable.' }) }
  }
  useEffect(() => {
    version.current++; pending.current = false; saving.current = false; setWorking(null)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() { await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, saving.current ? 1500 : 10000) }
    if (accountId) void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [accountId])
  async function mutate(action: () => Promise<LocalStorageSettings>) {
    if (!accountId || pending.current) return
    pending.current = true; const revision = ++version.current; setWorking(accountId); setMessage(null)
    try {
      const value = await action()
      if (owner.current === accountId && version.current === revision) { saving.current = !!value.busy; setSnapshot({ owner: accountId, value }) }
    } catch (e) { if (owner.current === accountId && version.current === revision) setMessage({ owner: accountId, source: 'action', text: e instanceof Error ? e.message : 'Storage action failed.' }) }
    finally { if (owner.current === accountId && version.current === revision) { pending.current = false; setWorking(null) } }
  }
  const toggleAuto = (enabled: boolean) => mutate(() => studioApi.setAutoSave(accountId!, enabled))
  const retryAuto = (generationId: string) => mutate(() => studioApi.retryAutoSave(accountId!, generationId))
  const configure = (path: string) => mutate(() => studioApi.configureLocalStorage(accountId!, path))
  const save = (ids: string[]) => mutate(async () => {
    const { job } = await studioApi.saveLocal(accountId!, ids)
    return { ...settings!, enabled: true, busy: job.status === 'saving', job }
  })
  return { settings, error, refresh, configure, save, toggleAuto, retryAuto, mutating: working === accountId && !!accountId, busy: working === accountId && !!accountId || !!settings?.busy }
}
type StorageController = ReturnType<typeof useLocalStorageSettings>

export function SettingsPanel({ accountId, accountName, accentColor, onAccentColor, onAccount, onGuide, onGallery, storage, browsing }: {
  accountId: string | null; accountName?: string; accentColor: string; onAccentColor: (color: string) => void; onAccount: () => void; onGuide: () => void; onGallery: () => void; storage: StorageController; browsing: BrowsingController
}) {
  const [path, setPath] = useState(''), [copyMessage, setCopyMessage] = useState('')
  const { settings, busy } = storage
  useEffect(() => { setPath(settings?.basePath ?? ''); setCopyMessage('') }, [settings?.basePath, settings?.effectivePath])
  async function copyPath() {
    const effectivePath = settings?.effectivePath
    if (!effectivePath) return
    try { await navigator.clipboard.writeText(effectivePath); setCopyMessage('Path copied.') }
    catch { setCopyMessage('Clipboard unavailable. Select and copy the path below.') }
  }
  return <section className="settings-page" aria-labelledby="settings-title">
    <h1 id="settings-title"><Settings size={21} />Settings</h1>
    <div className="columns is-variable is-4 settings-columns">
      <div className="column is-two-thirds"><section className="panel-card settings-card" aria-labelledby="storage-title">
        <h2 id="storage-title" className="section-title"><FolderOpen size={17} />Storage</h2>
        <h3>Local output destination</h3>
        <p>Save outputs to a folder on the computer running this Studio server.</p>
        {!accountId ? <p>Connect your account to view its destination.</p> : !settings ? <p role="status">{storage.error || 'Loading storage settings…'}</p> : !settings.enabled ? <p>Local folder saving is not enabled on this server. Browser folder saving and ZIP downloads remain available.</p> : <>
          <div className="settings-line"><div><strong>Auto-save completed outputs</strong><p>On by default after a destination is configured.</p></div><Button type="button" role="switch" aria-checked={settings.autoSave !== false} aria-label="Auto-save completed outputs" variant={settings.autoSave !== false ? 'default' : 'secondary'} disabled={storage.mutating} onClick={() => void storage.toggleAuto(settings.autoSave === false)}>{settings.autoSave !== false ? 'On' : 'Off'}</Button></div>
          <p role="status">{settings.autoSaveStatus}</p>
          <p>New Studio work and newly discovered Civitai website work are saved after completion. Older history stays manual. Turning this off pauses queued work without deleting files; turning it on starts a fresh cutoff. Use Retry for paused entries.</p>
          {settings.autoSaveSince && <p className="field-help">New-work cutoff: {new Date(settings.autoSaveSince).toLocaleString()}.</p>}
          <form onSubmit={event => { event.preventDefault(); setCopyMessage(''); void storage.configure(path) }}>
            <label className="field-label" htmlFor="output-destination">Existing absolute base directory</label>
            <Input id="output-destination" value={path} onChange={event => setPath(event.target.value)} placeholder="Enter the full local directory path" autoComplete="off" spellCheck={false} disabled={busy} required />
            <p className="field-help">Studio creates a separate account folder inside this directory. Choose a folder outside this project; linked and network directories are not supported.</p>
            <div className="settings-actions"><Button type="submit" disabled={busy || !path}>{busy ? 'Save in progress…' : 'Validate and save destination'}</Button><Button type="button" variant="ghost" onClick={() => void storage.refresh()} disabled={busy}>Refresh status</Button></div>
          </form>
          {settings.effectivePath && <div className="effective-destination"><label className="field-label" htmlFor="effective-output-destination">Effective output directory · this account</label><Input id="effective-output-destination" value={settings.effectivePath} readOnly onFocus={event => event.currentTarget.select()} /><div className="settings-actions"><Button type="button" variant="secondary" onClick={() => void copyPath()}><Copy size={14} />Copy path</Button><Button type="button" variant="ghost" onClick={onGallery}>Open My generations</Button></div><p role="status" aria-live="polite">{copyMessage}</p></div>}
          <p>Select outputs in My generations and choose <strong>Save to configured folder</strong>. Manual saving remains available when auto-save is off. Pending workflows keep their original destination if you change this path.</p>
        </>}
        <div className="settings-divider" />
        <h3>Browser folder and ZIP downloads</h3>
        <p>{folderSavingSupported() ? 'Save to folder opens your browser’s folder picker. Permission lasts for the current browser session.' : 'Folder picking is unavailable in this browser. Use Download ZIP to save dated folders.'} The browser does not disclose the full path. This destination is separate from the server setting above.</p>
        <h3>Date organization</h3><p>Originals and metadata sidecars are grouped into <code>images/YYYY-MM-DD</code>, <code>videos/YYYY-MM-DD</code>, <code>audio/YYYY-MM-DD</code>, <code>3d-models/YYYY-MM-DD</code> and <code>lora/YYYY-MM-DD</code> directories using UTC timestamps. Local saves use unique filenames and skip verified duplicates. Limits: 50 outputs, 100 MiB per audio file, 500 MiB per other media file, 1 GiB per LoRA checkpoint, 2 GiB per manual local batch. Automatic saving handles one output per transfer; checkpoints and training samples share the lora category. ZIP archives remain limited to 150 MiB.</p>
        {settings?.enabled && <AutoSaveQueue storage={storage} />}
      </section></div>
      <div className="column"><BrowsingSettings accountId={accountId} browsing={browsing} /><section className="panel-card settings-card appearance-card" aria-labelledby="appearance-title"><h2 id="appearance-title" tabIndex={-1} className="section-title">Appearance</h2><AccentColorPicker color={accentColor} onChange={onAccentColor} /></section>
        <section className="panel-card settings-card"><h2 className="section-title">Account</h2><p>{accountId ? accountName || 'Civitai connected' : 'Civitai disconnected'}</p><div className="account-guide-actions"><Button type="button" variant="secondary" onClick={onAccount}>{accountId ? 'Manage connection' : 'Connect Civitai'}</Button><Button type="button" variant="ghost" onClick={onGuide}>Getting started &amp; Buzz guide</Button></div><p>Output destinations and save history belong to the connected account.</p></section>
      </div>
    </div>
  </section>
}

export function LocalSaveProgress({ storage }: { storage: StorageController }) {
  const { settings, error, busy } = storage, job = settings?.job
  if (!error && !job) return null
  return <section className="panel-card settings-card local-save-progress" aria-label="Configured folder save">
    {error && <p role="alert" className="error-box">{error} <Button type="button" variant="ghost" size="sm" onClick={() => void storage.refresh()}>Refresh storage status</Button></p>}
    {job && <><h2 className="section-title">{job.automatic ? 'Automatic folder save' : 'Configured folder save'}</h2><p role="status" aria-live="polite">{job.status === 'saving' ? 'Saving originals…' : job.status === 'completed' ? 'Folder save complete.' : 'Some outputs could not be saved.'} {job.items.filter(item => ['saved', 'duplicate'].includes(item.status)).length} of {job.items.length} ready.</p>
      <ul>{job.items.map(item => <li key={item.outputId}><span className="local-save-name">{item.category}/{item.dateFolder}/{item.filename ?? item.outputId}</span><span>{item.status === 'duplicate' ? 'Already saved' : item.status} · {(item.bytes / 1024 / 1024).toFixed(1)} MiB</span>{item.error && <p>{item.error}</p>}</li>)}</ul>
      {!job.automatic && !busy && job.items.some(item => item.status === 'failed') && <Button type="button" variant="secondary" onClick={() => void storage.save(job.items.filter(item => item.status === 'failed').map(item => item.outputId))}>Retry failed outputs</Button>}
    </>}
  </section>
}

function AutoSaveQueue({ storage }: { storage: StorageController }) {
  const queue = storage.settings?.autoQueue ?? []
  return <section className="auto-save-queue" aria-label="Automatic save queue"><h3>Automatic save queue</h3><p>Continues while Bun is running, even with the browser closed. A restart with memory-only credentials pauses downloads until you reconnect. Website history may be incomplete; older or undiscovered work can be saved manually.</p><p className="field-help">Up to 100 active workflows and 1,000 unsaved outputs per account. Showing {queue.length} of {storage.settings?.autoQueueTotal ?? 0} entries, with unfinished work first.</p>
    {!queue.length ? <p>No new workflows queued.</p> : <ul>{queue.map(entry => <li key={entry.generationId}><details><summary>{entry.status} · {entry.saved}/{entry.total} outputs · {entry.generationId}</summary><p>{entry.message}</p><p className="effective-queue-path">Destination: {entry.destination}</p>{['paused','failed'].includes(entry.status) && <Button type="button" variant="secondary" size="sm" disabled={storage.busy || storage.settings?.autoSave === false} onClick={() => void storage.retryAuto(entry.generationId)}>Retry this workflow</Button>}</details></li>)}</ul>}
  </section>
}
