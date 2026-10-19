import { useEffect, useRef, useState } from 'react'
import { BookmarkPlus, Download, RefreshCw, Save, Trash2 } from 'lucide-react'
import { builtInPresets, configError, type ComposerConfig, type Preset } from '../../shared/composer'
import { studioApi } from './api'
import { Button, Input } from './ui'
import { Select } from './controls'
export function PresetControls({ accountId, config, onLoad }: { accountId: string | null; config: ComposerConfig | null; onLoad: (config: ComposerConfig) => void }) {
  const [items, setItems] = useState<Preset[]>([])
  const [selected, setSelected] = useState('builtin:sdxl')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    setItems([])
    if (!accountId) return
    const controller = new AbortController()
    void studioApi.presets(accountId, controller.signal).then(result => setItems(result.items)).catch(error => { if (!controller.signal.aborted) setMessage(error.message) })
    return () => controller.abort()
  }, [accountId])
  async function refresh() {
    if (!accountId) return
    setBusy(true); setMessage('')
    try { const result = await studioApi.presets(accountId); if (mounted.current) setItems(result.items) } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Could not load presets.') } finally { if (mounted.current) setBusy(false) }
  }
  async function save(update: boolean) {
    if (!accountId || !config) return
    const problem = configError(config)
    if (problem) { setMessage(problem); return }
    setBusy(true); setMessage('')
    try {
      const result = await studioApi.savePreset(accountId, name, config, update ? selected : undefined)
      if (!mounted.current) return
      setItems(current => [result.preset, ...current.filter(item => item.id !== result.preset.id)])
      setSelected(result.preset.id); setMessage(update ? 'Preset updated.' : 'Preset saved.')
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Could not save preset.') } finally { if (mounted.current) setBusy(false) }
  }
  async function remove() {
    if (!accountId || selected.startsWith('builtin:')) return
    setBusy(true)
    try {
      await studioApi.deletePreset(accountId, selected)
      if (!mounted.current) return
      setItems(current => current.filter(item => item.id !== selected)); setSelected('builtin:sdxl'); setName(''); setMessage('Preset deleted. Your current composer is unchanged.')
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Could not delete preset.') } finally { if (mounted.current) setBusy(false) }
  }
  const target = [...builtInPresets, ...items].find(item => item.id === selected)
  return <section className="preset-controls form-field" aria-label="Generation presets">
    <label className="field-label">Presets</label>
    <div className="composer-actions"><Select label="Choose a preset" value={selected} disabled={busy} onChange={value => { setSelected(value); setName(items.find(item => item.id === value)?.name ?? '') }} options={[...builtInPresets.map(item => ({ value: item.id, label: `Built-in · ${item.name}` })), ...items.map(item => ({ value: item.id, label: `My preset · ${item.name}` }))]} />
      <Button type="button" variant="secondary" size="sm" disabled={busy || !target} onClick={() => { if (target) { onLoad(structuredClone(target.config)); setMessage('Preset loaded. Review before generating.') } }}><Download size={13} />Load</Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Refresh my presets" disabled={!accountId || busy} onClick={() => void refresh()}><RefreshCw size={14} /></Button>
    </div>
    <div className="composer-actions mt-2"><Input aria-label="Preset name" onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} placeholder="Name your preset" value={name} maxLength={80} disabled={!accountId || busy} onChange={event => setName(event.target.value)} />
      <Button type="button" variant="secondary" size="sm" disabled={!accountId || busy || !config || !name.trim()} onClick={() => void save(false)}><BookmarkPlus size={14} />Save new</Button>
      {!selected.startsWith('builtin:') && <><Button type="button" variant="secondary" size="sm" disabled={busy || !config || !name.trim()} onClick={() => void save(true)}><Save size={14} />Update</Button><Button type="button" variant="ghost" size="icon" aria-label={`Delete preset ${target?.name ?? ''}`} disabled={busy} onClick={() => void remove()}><Trash2 size={14} /></Button></>}
    </div>
    <p className="field-help">Built-ins are read-only. My presets belong to your connected account.</p>
    {message && <p className="field-help" role="status">{message}</p>}
  </section>
}
