import * as Tabs from '@radix-ui/react-tabs'
import { useEffect, useRef, useState } from 'react'
import { BookOpen, History, Plus, Save, Trash2 } from 'lucide-react'
import { combinePrompts } from '../../shared/composer'
import { workflowChoices } from '../../shared/workflows'
import { promptCategories, promptDraftIdentity, validPromptSnapshot, validSnippet, type PromptContext, type PromptDraft, type PromptHistoryItem, type PromptSnapshot, type PromptSnippet, type PromptSnippetInput } from '../../shared/prompt-library'
import { studioApi } from './api'
import { Select } from './controls'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Textarea } from './ui'
import './prompt-library.css'

export type PromptLibraryProps = { accountId: string; context: PromptContext; groups: PromptDraft['groups']; negativePrompt?: string; onApply: (draft: PromptDraft) => void; max: number; disabled?: boolean; checkpointVersion?: number }
const emptySnippet: PromptSnippetInput = { name: '', category: 'quality', text: '' }
const categoryLabel = (value: string) => promptCategories.find(item => item.value === value)?.label ?? value
const workflowLabel = (value: string) => workflowChoices.find(item => item.id === value)?.label ?? value
const freshGroups = (groups: PromptDraft['groups']) => groups.map(group => ({ ...group, id: crypto.randomUUID() }))
// A page-session pause belongs to the account, rather than the currently
// mounted workflow. Navigation cannot silently resume cleared draft history.
const pausedHistoryAccounts = new Set<string>()

export function PromptLibrary({ accountId, context, groups, negativePrompt, onApply, max, disabled, checkpointVersion = 0 }: PromptLibraryProps) {
  const [open, setOpen] = useState(false), [tab, setTab] = useState('presets'), [search, setSearch] = useState(''), [category, setCategory] = useState('all')
  const [snippets, setSnippets] = useState<PromptSnippet[]>([]), [history, setHistory] = useState<PromptHistoryItem[]>([])
  const [selected, setSelected] = useState<PromptSnippet | null>(null), [snapshot, setSnapshot] = useState<PromptSnapshot | null>(null)
  const [editor, setEditor] = useState<PromptSnippetInput | null>(null), [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [historyStatus, setHistoryStatus] = useState('')
  const [deleting, setDeleting] = useState(false), [clearing, setClearing] = useState(false), [automatic, setAutomatic] = useState(() => !pausedHistoryAccounts.has(accountId))
  const scope = useRef(accountId); scope.current = accountId
  const viewOpen = useRef(open); viewOpen.current = open
  const mounted = useRef(true), requests = useRef(new Set<AbortController>()), detailRequest = useRef<AbortController | null>(null)
  const listRequest = useRef<AbortController | null>(null)
  const mutationActive = useRef(false)
  const saving = useRef<Promise<void> | null>(null), saved = useRef(''), clearingRef = useRef(false)
  const value = { context, groups, ...(negativePrompt === undefined ? {} : { negativePrompt }) }
  const identity = promptDraftIdentity(value)
  const latest = useRef({ value, identity, disabled, accountId }); latest.current = { value, identity, disabled, accountId }
  const controller = () => { const c = new AbortController(); requests.current.add(c); return c }
  const current = (owner: string, c?: AbortController) => mounted.current && scope.current === owner && !c?.signal.aborted
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; for (const c of requests.current) c.abort(); requests.current.clear() }
  }, [accountId])
  useEffect(() => {
    setOpen(false); setSnippets([]); setHistory([]); setSelected(null); setSnapshot(null); setEditor(null); setSearch(''); setError(''); setNotice(''); setHistoryStatus(''); setAutomatic(!pausedHistoryAccounts.has(accountId)); setBusy(false); setLoading(false); setDeleting(false); setClearing(false); saved.current = ''; clearingRef.current = false; mutationActive.current = false
  }, [accountId])

  async function checkpoint(manual = false) {
    const pending = latest.current
    if (!manual && pausedHistoryAccounts.has(pending.accountId)) return
    if (pending.disabled || clearingRef.current || !validPromptSnapshot(pending.value)) { if (manual) setHistoryStatus('Write a prompt before saving a snapshot.'); return }
    if (pending.identity === saved.current && !manual) return
    if (saving.current) { await saving.current; if (current(pending.accountId)) return checkpoint(manual); return }
    const c = controller(), owner = pending.accountId
    const request = (async () => {
      try {
        setHistoryStatus('Saving draft…')
        const {item} = await studioApi.checkpointPrompt(owner, pending.value, c.signal)
        if (current(owner, c)) {
          saved.current = pending.identity; setHistoryStatus('Draft saved to history')
          setHistory(items => [{id:item.id,savedAt:item.savedAt,context:item.context,preview:combinePrompts(item.groups).slice(0,180)||'Negative prompt only',groupCount:item.groups.length,hasNegative:item.negativePrompt!==undefined},...items.filter(previous=>previous.id!==item.id)].slice(0,100))
          // A list fetched before this checkpoint must not overwrite its new
          // row. Refreshing aborts the earlier read and reloads both tabs.
          if (viewOpen.current && !mutationActive.current) void load()
        }
      } catch (e) { if (current(owner, c)) setHistoryStatus(e instanceof Error ? `History: ${e.message}` : 'Draft history could not be saved.') }
      finally { requests.current.delete(c) }
    })()
    saving.current = request
    await request
    if (saving.current === request) saving.current = null
  }
  function setAutomaticHistory(enabled: boolean) {
    if (enabled) pausedHistoryAccounts.delete(accountId)
    else pausedHistoryAccounts.add(accountId)
    setAutomatic(enabled)
  }
  useEffect(() => {
    if (!automatic || disabled || !validPromptSnapshot(value) || identity === saved.current) return
    const timer = window.setTimeout(() => { void checkpoint() }, 1800)
    return () => window.clearTimeout(timer)
  }, [identity, accountId, automatic, disabled])
  useEffect(() => { if (checkpointVersion && automatic) void checkpoint() }, [checkpointVersion])

  async function load() {
    if (mutationActive.current) return
    listRequest.current?.abort()
    const c = controller(), owner = accountId
    listRequest.current = c
    setLoading(true); setError('')
    try {
      const [presets, snapshots] = await Promise.all([studioApi.promptSnippets(owner, c.signal), studioApi.promptHistory(owner, c.signal)])
      if (current(owner, c)) { setSnippets(presets.items); setHistory(snapshots.items) }
    } catch (e) { if (current(owner, c)) setError(e instanceof Error ? e.message : 'Prompt library unavailable.') }
    finally { requests.current.delete(c); if (current(owner, c)) setLoading(false) }
  }
  useEffect(() => { if (open) void load() }, [open, accountId])
  function cancelViewRequests() { listRequest.current?.abort(); detailRequest.current?.abort(); setLoading(false) }
  function show(nextTab: string) { setTab(nextTab); setOpen(true); setSearch(''); setEditor(null); setSelected(null); setSnapshot(null); setError(''); setNotice(''); setDeleting(false); setClearing(false) }
  async function editSave() {
    if (busy || !editor || !validSnippet(editor)) return
    const c = controller(), owner = accountId
    cancelViewRequests()
    mutationActive.current = true
    setBusy(true); setError('')
    try {
      const { item } = await studioApi.savePromptSnippet(owner, editingId, editor, c.signal)
      if (current(owner, c)) { setSnippets(items => [item, ...items.filter(old => old.id !== item.id)]); setSelected(item); setEditor(null); setNotice('Prompt preset saved.'); }
    } catch (e) { if (current(owner, c)) setError(e instanceof Error ? e.message : 'Could not save prompt preset.') }
    finally { requests.current.delete(c); if (current(owner, c)) { mutationActive.current = false; setBusy(false) } }
  }
  async function chooseHistory(id: string) {
    detailRequest.current?.abort()
    const c = controller(), owner = accountId; detailRequest.current = c
    setSnapshot(null); setError(''); setLoading(true); setDeleting(false)
    try { const { item } = await studioApi.promptSnapshot(owner, id, c.signal); if (current(owner, c)) setSnapshot(item) }
    catch (e) { if (current(owner, c)) setError(e instanceof Error ? e.message : 'Snapshot unavailable.') }
    finally { requests.current.delete(c); if (current(owner, c)) setLoading(false) }
  }
  async function remove(all = false) {
    if (busy) return
    const c = controller(), owner = accountId
    cancelViewRequests()
    mutationActive.current = true
    setBusy(true); setError('')
    try {
      if (all) {
        clearingRef.current = true; setAutomaticHistory(false)
        await saving.current
        if (!current(owner, c)) return
        await studioApi.deletePromptHistory(owner, null, c.signal)
        if (current(owner, c)) { setHistory([]); setSnapshot(null); setClearing(false); saved.current = latest.current.identity; setHistoryStatus('History cleared · automatic history paused'); }
      } else if (tab === 'presets' && selected) {
        await studioApi.deletePromptSnippet(owner, selected.id, c.signal)
        if (current(owner, c)) { setSnippets(items => items.filter(item => item.id !== selected.id)); setSelected(null) }
      } else if (snapshot) {
        clearingRef.current = true
        await saving.current
        if (!current(owner, c)) return
        await studioApi.deletePromptHistory(owner, snapshot.id, c.signal)
        if (current(owner, c)) {
          setHistory(items => items.filter(item => item.id !== snapshot.id)); setSnapshot(null)
          if (promptDraftIdentity(snapshot) === latest.current.identity) { setAutomaticHistory(false); setHistoryStatus('Snapshot deleted · automatic history paused') }
        }
      }
      if (current(owner, c)) { setDeleting(false); setNotice(all ? 'Prompt history cleared. Edit or save a new draft when ready.' : 'Prompt item deleted.') }
    } catch (e) { if (current(owner, c)) setError(e instanceof Error ? e.message : 'Could not remove prompt item.') }
    finally { requests.current.delete(c); if (current(owner, c)) { mutationActive.current = false; setBusy(false); clearingRef.current = false } }
  }
  function apply(mode: 'append' | 'replace' | 'restore') {
    let draft: PromptDraft
    if (mode === 'restore' && snapshot) draft = { groups: freshGroups(snapshot.groups), ...(snapshot.negativePrompt === undefined || negativePrompt === undefined ? {} : { negativePrompt: snapshot.negativePrompt }) }
    else if (selected) draft = { groups: mode === 'append' ? [...groups, { id: crypto.randomUUID(), label: selected.name, text: selected.text }] : [{ id: crypto.randomUUID(), label: selected.name, text: selected.text }] }
    else return
    if (draft.groups.length > 20 || combinePrompts(draft.groups).length > max) { setError(`This prompt needs at most 20 groups and ${max.toLocaleString()} characters. Shorten it or choose Replace.`); return }
    onApply(draft); setOpen(false)
  }
  const query = search.trim().toLocaleLowerCase()
  const filteredSnippets = snippets.filter(item => (category === 'all' || item.category === category) && `${item.name} ${item.text}`.toLocaleLowerCase().includes(query))
  const filteredHistory = history.filter(item => `${item.preview} ${workflowLabel(item.context.workflow)}`.toLocaleLowerCase().includes(query))
  return <div className="prompt-library-controls">
    <div className="prompt-library-actions"><Button type="button" variant="secondary" size="sm" onClick={() => show('presets')}><BookOpen size={14} />Prompt presets</Button><Button type="button" variant="ghost" size="sm" onClick={() => show('history')}><History size={14} />History</Button><Button type="button" variant="ghost" size="sm" disabled={disabled || !validPromptSnapshot(value)} onClick={() => void checkpoint(true)}><Save size={14} />Save draft</Button></div>
    <p className="prompt-history-status" role="status">{historyStatus || 'Draft history saves after a pause in typing.'}</p>
    <Dialog open={open} onOpenChange={next => { if (!busy) { if (!next) cancelViewRequests(); setOpen(next) } }}><DialogContent className="prompt-library-dialog" closeDisabled={busy}>
      <DialogTitle>Your prompt library</DialogTitle><DialogDescription>Reusable text and private draft history for this account. Applying text keeps your model, media sources and generation settings.</DialogDescription>
      <Tabs.Root value={tab} onValueChange={next => { if (!busy) { detailRequest.current?.abort(); setLoading(false); setTab(next); setEditor(null); setDeleting(false); setClearing(false); setError(''); setSearch('') } }}>
        <Tabs.List className="prompt-library-tabs" aria-label="Prompt library"><Tabs.Trigger value="presets">Prompt presets <span>{snippets.length}</span></Tabs.Trigger><Tabs.Trigger value="history">Draft history <span>{history.length}</span></Tabs.Trigger></Tabs.List>
        <div className="prompt-library-search"><Input aria-label="Search prompt library" placeholder={tab === 'presets' ? 'Search presets or trigger tags…' : 'Search draft text or workflow…'} value={search} onChange={event => setSearch(event.target.value)} disabled={busy} />{tab === 'presets' && <Select label="Prompt preset category" value={category} onChange={setCategory} options={[{ value: 'all', label: 'All categories' }, ...promptCategories]} />}</div>
        {loading && <p role="status" className="field-help">Loading prompt library…</p>}
        {error && <div className="error-box" role="alert">{error}<Button type="button" variant="ghost" size="sm" disabled={busy || loading} onClick={() => void load()}>Refresh library</Button></div>}
        {notice && <p role="status" className="notice">{notice}</p>}
        <Tabs.Content value="presets">
          <div className="prompt-library-create"><Button type="button" size="sm" disabled={busy} onClick={() => { setEditor({ ...emptySnippet }); setEditingId(null); setDeleting(false) }}><Plus size={14} />New preset</Button><Button type="button" variant="secondary" size="sm" disabled={busy || !combinePrompts(groups).trim() || combinePrompts(groups).length > 4000} onClick={() => { setEditor({ ...emptySnippet, text: combinePrompts(groups) }); setEditingId(null); setDeleting(false) }}>Save current prompt as preset</Button></div>
          {editor ? <div className="prompt-preset-editor"><label>Name<Input aria-label="Prompt preset name" maxLength={80} value={editor.name} disabled={busy} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label><label>Category<Select label="Preset category" value={editor.category} onChange={value => setEditor({ ...editor, category: value as PromptSnippetInput['category'] })} options={[...promptCategories]} disabled={busy} /></label><label>Prompt text<Textarea aria-label="Prompt preset text" value={editor.text} maxLength={4000} disabled={busy} onChange={event => setEditor({ ...editor, text: event.target.value })} /></label><p className="field-help">{editor.text.length.toLocaleString()} / 4,000 characters. LoRA trigger presets insert text only; they never add or change LoRA resources.</p><div className="prompt-library-actions"><Button type="button" disabled={busy || !validSnippet(editor)} onClick={() => void editSave()}>{busy ? 'Saving…' : 'Save preset'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setEditor(null)}>Cancel editing</Button></div></div> : <div className="prompt-library-columns"><div className="prompt-library-list" aria-label="Saved prompt presets">{filteredSnippets.map(item => <button type="button" key={item.id} className="prompt-library-item" aria-pressed={selected?.id === item.id} disabled={busy} onClick={() => { setSelected(item); setDeleting(false); setNotice('') }}><strong>{item.name}</strong><span>{categoryLabel(item.category)}</span><p>{item.text.slice(0, 140)}</p></button>)}{!loading && !filteredSnippets.length && <p className="prompt-library-empty">{query || category !== 'all' ? 'No presets match these filters.' : 'Save quality phrases, visual styles or LoRA trigger tags here to reuse them.'}</p>}</div><div className="prompt-library-preview">{selected ? <><span className="eyebrow">{categoryLabel(selected.category)}</span><h3>{selected.name}</h3><pre>{selected.text}</pre><p className="field-help">Append creates a new labeled prompt group. Replace changes the positive prompt only. Neither changes your model or LoRAs.</p><div className="prompt-library-actions"><Button type="button" disabled={disabled || busy || groups.length >= 20} onClick={() => apply('append')}>Append as group</Button><Button type="button" variant="secondary" disabled={disabled || busy} onClick={() => apply('replace')}>Replace prompt</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditor({ name: selected.name, category: selected.category, text: selected.text }); setEditingId(selected.id) }}>Edit</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={14} />Delete</Button></div></> : <p className="prompt-library-empty">Choose a preset to preview its text before applying it.</p>}</div></div>}
        </Tabs.Content>
        <Tabs.Content value="history"><div className="prompt-history-privacy"><p>Account-only history keeps up to 100 distinct drafts for 90 days. It stores ordered groups, labels and negative text, without model settings. Automatic history {automatic ? 'is on' : 'is paused'} for this editing session.</p><div className="prompt-library-actions"><Button type="button" variant="secondary" size="sm" disabled={busy} aria-pressed={automatic} onClick={() => setAutomaticHistory(!automatic)}>{automatic ? 'Pause automatic history' : 'Resume automatic history'}</Button><Button type="button" variant="ghost" size="sm" disabled={busy || !history.length} onClick={() => setClearing(true)}>Clear history</Button></div></div><div className="prompt-library-columns"><div className="prompt-library-list" aria-label="Prompt draft history">{filteredHistory.map(item => <button type="button" key={item.id} className="prompt-library-item" aria-pressed={snapshot?.id === item.id} disabled={busy} onClick={() => void chooseHistory(item.id)}><strong>{workflowLabel(item.context.workflow)} · {item.context.mediaType === 'model3d' ? '3D' : item.context.mediaType}</strong><span>{new Date(item.savedAt).toLocaleString()} · {item.groupCount} groups{item.hasNegative ? ' · negative' : ''}</span><p>{item.preview}</p></button>)}{!loading && !filteredHistory.length && <p className="prompt-library-empty">{query ? 'No drafts match this search.' : 'Your saved draft snapshots will appear here. Nothing is restored automatically.'}</p>}</div><div className="prompt-library-preview">{snapshot ? <><h3>{workflowLabel(snapshot.context.workflow)}</h3><p className="field-help">Saved {new Date(snapshot.savedAt).toLocaleString()}. Restores text into your current workflow.</p>{snapshot.groups.map((group, index) => <div key={group.id}><strong>{group.label || `Prompt ${index + 1}`}</strong><pre>{group.text || '(empty group)'}</pre></div>)}{snapshot.negativePrompt !== undefined && <div><strong>Negative prompt</strong><pre>{snapshot.negativePrompt || '(empty)'}</pre>{negativePrompt === undefined && <p className="field-help">Your current workflow has no negative field; that text will not be applied.</p>}</div>}<div className="prompt-library-actions"><Button type="button" disabled={disabled || busy} onClick={() => apply('restore')}>Restore this draft</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setDeleting(true)}>Delete snapshot</Button></div></> : <p className="prompt-library-empty">Select a snapshot to review every group before restoring. Your current draft stays unchanged until you choose Restore.</p>}</div></div></Tabs.Content>
        {(deleting || clearing) && <div className="prompt-library-confirm" role="alert"><p>{clearing ? 'Clear all draft history for this account? Automatic history will pause for this editing session.' : `Delete this ${tab === 'presets' ? 'prompt preset' : 'snapshot'}?`}</p><Button type="button" variant="destructive" disabled={busy} onClick={() => void remove(clearing)}>Confirm {clearing ? 'clear history' : 'delete'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { setDeleting(false); setClearing(false) }}>Cancel</Button></div>}
      </Tabs.Root>
    </DialogContent></Dialog>
  </div>
}
