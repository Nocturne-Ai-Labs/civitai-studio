import { useEffect, useRef, useState } from 'react'
import { ExternalLink, FolderPlus, RefreshCw, Search } from 'lucide-react'
import type { CollectionDestination, CollectionType, CollectionVisibility, PublicCollection } from '../../shared/collections'
import { studioApi } from './api'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Textarea } from './ui'
import { Select } from './controls'
const message = (error: unknown) => error instanceof Error ? error.message : 'Collection action failed.'
export function CollectionDestinations({ accountId, onChange, itemType }: { accountId: string; onChange?: () => void; itemType?: CollectionType }) {
  const [items, setItems] = useState<CollectionDestination[]>([])
  const [mode, setMode] = useState('create')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<CollectionType>(itemType ?? 'Image')
  const [read, setRead] = useState<CollectionVisibility>('Private')
  const [confirmed, setConfirmed] = useState(false)
  const [edit, setEdit] = useState<number | undefined>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const alive = useRef(true)
  const mutations = useRef<AbortController[]>([])
  useEffect(() => { alive.current = true; const controller = new AbortController(); void studioApi.collectionDestinations(accountId, controller.signal).then(result => { if (alive.current) setItems(result.items) }).catch(error => { if (!controller.signal.aborted) setNotice(message(error)) }); return () => { alive.current = false; controller.abort(); mutations.current.forEach(request => request.abort()) } }, [accountId])
  async function refresh() {
    setBusy(true)
    try { const result = await studioApi.collectionDestinations(accountId); if (alive.current) { setItems(result.items); setNotice('Destinations refreshed.') } } catch (error) { if (alive.current) setNotice(message(error)) } finally { if (alive.current) setBusy(false) }
  }
  function reset() { setEdit(undefined); setMode('create'); setId(''); setName(''); setDescription(''); setType(itemType ?? 'Image'); setRead('Private'); setConfirmed(false) }
  async function save() {
    const controller = new AbortController(); mutations.current.push(controller)
    setBusy(true); setNotice('')
    try {
      const result = await studioApi.saveCollectionDestination(accountId, { mode, id: Number(id), name, description, type, read, confirm: confirmed }, edit, controller.signal)
      if (!alive.current) return
      setItems(current => [result.destination, ...current.filter(item => item.id !== result.destination.id)])
      setNotice(result.destination.source === 'saved' ? 'Destination saved for this account. Civitai will check add permission when you save an item.' : 'Civitai confirmed the collection. Destination saved.')
      reset(); onChange?.()
    } catch (error) { if (alive.current) setNotice(message(error)) } finally { if (alive.current) setBusy(false) }
  }
  return <section className="panel-card collection-panel" aria-label="Saved collection destinations"><div className="composer-actions"><h2 className="section-title">Saved destinations</h2><Button type="button" variant="ghost" size="icon" aria-label="Refresh saved destinations" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></Button></div>
    <p className="field-help">Collections created here and IDs you explicitly save. This is not a list of all your Civitai collections. Private collections cannot be discovered through public REST.</p>
    <div className="saved-destinations">{items.filter(item => !itemType || item.type === itemType).map(item => <article key={item.id}><strong>{item.name}</strong><p>{item.type} · {item.read} · #{item.id} · {item.source === 'created' ? 'Created in Studio' : item.verified ? 'Saved public destination' : 'User-supplied ID; not publicly verified'}</p><p>{item.description}</p><a href={`https://civitai.com/collections/${item.id}`} target="_blank" rel="noreferrer">Open on Civitai <ExternalLink size={12} /></a>{item.source === 'created' && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setEdit(item.id); setMode('create'); setName(item.name); setDescription(item.description); setType(item.type); setRead(item.read) }}>Edit collection</Button>}</article>)}</div>
    <h3 className="mt-4">{edit ? 'Update collection' : 'Add a destination'}</h3>
    {!edit && <Select label="Collection destination action" value={mode} onChange={value => { setMode(value); setConfirmed(false) }} options={[{ value: 'create', label: 'Create a Civitai collection' }, { value: 'save', label: 'Save an existing collection ID' }]} />}
    {mode === 'save' && <div className="form-field mt-3"><label className="field-label" htmlFor="collection-existing-id">Civitai collection ID</label><Input id="collection-existing-id" type="number" min={1} max={2147483647} value={id} onChange={event => setId(event.target.value)} /></div>}
    <div className="form-field mt-3"><label className="field-label" htmlFor="collection-name">{mode === 'save' ? 'Destination label' : 'Collection name'}</label><Input id="collection-name" maxLength={30} value={name} onChange={event => setName(event.target.value)} /></div>
    <div className="form-field"><label className="field-label" htmlFor="collection-description">Description</label><Textarea id="collection-description" maxLength={300} value={description} onChange={event => setDescription(event.target.value)} /></div>
    <div className="field-row form-field"><Select label="Collection item type" value={type} disabled={!!edit || !!itemType} onChange={value => setType(value as CollectionType)} options={[{ value: 'Image', label: 'Image collection' }, { value: 'Post', label: 'Post collection' }, { value: 'Model', label: 'Model collection' }]} /><Select label="Collection visibility" value={read} onChange={value => setRead(value as CollectionVisibility)} options={['Private','Public','Unlisted'].map(value => ({ value, label: value }))} /></div>
    {mode === 'save' ? <label className="collection-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I supplied this ID and have permission to add items. Private IDs cannot be verified until Civitai handles the action.</label> : <p className="field-help">This creates or updates a real Civitai collection. Write access stays Private. Collections Write permission is required.</p>}
    <div className="composer-actions mt-3"><Button type="button" disabled={busy || !name.trim() || (mode === 'save' && (!confirmed || !Number.isInteger(Number(id)) || Number(id) < 1))} onClick={() => void save()}><FolderPlus size={14} />{busy ? 'Saving…' : edit ? 'Update collection' : mode === 'save' ? 'Save destination' : 'Create collection'}</Button>{edit && <Button type="button" variant="ghost" disabled={busy} onClick={reset}>Cancel edit</Button>}</div>
    {notice && <p role="status" className="collection-message">{notice}</p>}
  </section>
}
export function CollectionsPanel({ accountId, onConnect }: { accountId: string | null; onConnect: () => void }) {
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [items, setItems] = useState<PublicCollection[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<PublicCollection | null>(null)
  const [detailError, setDetailError] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const requests = useRef<AbortController[]>([])
  const detailRequest = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!accountId) return
    requests.current.forEach(controller => controller.abort()); requests.current = []
    const controller = new AbortController(); requests.current.push(controller); setBusy(true); setError(''); setItems([]); setCursor(null)
    void studioApi.publicCollections(accountId, activeQuery, undefined, controller.signal).then(result => { if (!controller.signal.aborted) { setItems(result.items); setCursor(result.nextCursor) } }).catch(error => { if (!controller.signal.aborted) setError(message(error)) }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [accountId, activeQuery, revision])
  useEffect(() => () => requests.current.forEach(controller => controller.abort()), [])
  async function more() {
    if (!accountId || !cursor) return
    const controller = new AbortController(); requests.current.push(controller); setBusy(true)
    try { const result = await studioApi.publicCollections(accountId, activeQuery, cursor, controller.signal); if (!controller.signal.aborted) { setItems(current => [...new Map([...current, ...result.items].map(item => [item.id,item])).values()]); setCursor(result.nextCursor === cursor ? null : result.nextCursor) } } catch (error) { if (!controller.signal.aborted) setError(message(error)) } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  async function show(id: number) {
    if (!accountId) return
    detailRequest.current?.abort()
    const controller = new AbortController(); detailRequest.current = controller; requests.current.push(controller); setDetail(null); setDetailError(''); setDetailOpen(true)
    try { const result = await studioApi.publicCollection(accountId, id, controller.signal); if (!controller.signal.aborted) setDetail(result.collection) } catch (error) { if (!controller.signal.aborted) setDetailError(message(error)) }
  }
  if (!accountId) return <section className="panel-card workspace-empty"><div className="empty-icon"><FolderPlus size={22}/></div><h2>Your inspiration, organized</h2><p>Connect your Civitai account to discover public collections and save your own destinations.</p><Button type="button" onClick={onConnect}>Connect account</Button></section>
  return <div className="collections-workspace"><CollectionDestinations accountId={accountId} /><section className="panel-card collection-panel"><h2 className="section-title">Discover public collections</h2><p className="field-help">Public metadata only; private collections and collection contents are not exposed by this API. Open Civitai to view their contents.</p><div className="composer-actions mb-4"><Input aria-label="Search public collections" maxLength={100} placeholder="Collection name" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setActiveQuery(query); setRevision(value => value + 1) } }} /><Button type="button" variant="secondary" disabled={busy} onClick={() => { setActiveQuery(query); setRevision(value => value + 1) }}><Search size={14} />Search</Button></div>
    <div className="columns is-multiline collection-results">{items.map(item => <div className="column is-6-tablet is-4-desktop" key={item.id}><article className="model-card">{item.coverUrl && <div className="model-preview"><img src={item.coverUrl} alt="Collection cover" loading="lazy" referrerPolicy="no-referrer" /></div>}<div className="model-card-body"><h3>{item.name}</h3><p>{item.type} · by {item.creator}{item.itemCount !== null ? ` · ${item.itemCount} accepted items` : ''}</p><Button type="button" size="sm" variant="secondary" onClick={() => void show(item.id)}>Details</Button><a className="model-external" href={item.url} target="_blank" rel="noreferrer">Open on Civitai <ExternalLink size={12} /></a></div></article></div>)}</div>
    {busy && <p role="status">Loading public collections…</p>}{!busy && !items.length && !error && <p>No public collections match.</p>}{error && <div className="error-box" role="alert">{error}<Button type="button" variant="secondary" onClick={() => setRevision(value => value + 1)}>Retry</Button></div>}{cursor && <Button type="button" variant="secondary" disabled={busy} onClick={() => void more()}>Load more</Button>}
  </section><Dialog open={detailOpen} onOpenChange={setDetailOpen}><DialogContent><DialogTitle>{detail?.name ?? 'Collection details'}</DialogTitle><DialogDescription>Public collection metadata from Civitai.</DialogDescription>{detail ? <><p>{detail.type} · {detail.read} · #{detail.id} · {detail.creator}</p><p className="model-description">{detail.description || 'No description provided.'}</p>{['Image','Post','Model'].includes(detail.type) && <p>To use this destination, save its ID {detail.id} in Saved destinations with permission to add items.</p>}<a href={detail.url} target="_blank" rel="noreferrer">Open on Civitai</a></> : <p role="status">{detailError || 'Loading details…'}</p>}<div className="dialog-actions"><Button type="button" variant="secondary" onClick={() => setDetailOpen(false)}>Close</Button></div></DialogContent></Dialog></div>
}
