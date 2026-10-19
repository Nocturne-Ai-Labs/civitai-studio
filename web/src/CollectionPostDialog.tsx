import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { CollectionDestination, CollectionTransfer } from '../../shared/collections'
import { studioApi, type Generation, type GenerationOutput } from './api'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from './ui'
import { Select } from './controls'
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Could not complete the collection request.'
export function CollectionPostDialog({ accountId, generation, output, onClose, onManage }: { accountId: string; generation: Generation; output: GenerationOutput; onClose: () => void; onManage: () => void }) {
  const [destinations, setDestinations] = useState<CollectionDestination[]>([])
  const [destinationId, setDestinationId] = useState('none')
  const [title, setTitle] = useState('Studio image')
  const [publication, setPublication] = useState('draft')
  const [publishConfirmed, setPublishConfirmed] = useState(false)
  const publicationController = useRef<AbortController | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [transfer, setTransfer] = useState<CollectionTransfer | null>(null)
  const [checked, setChecked] = useState(false)
  const [preview, setPreview] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); let objectUrl = ''
    void studioApi.collectionDestinations(accountId, controller.signal).then(result => { if (!controller.signal.aborted) { const compatible = result.items.filter(item => item.type === 'Image' || item.type === 'Post'); setDestinations(compatible); setDestinationId(compatible[0] ? String(compatible[0].id) : 'none') } }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)) })
    void studioApi.collectionPreview(accountId, output.id, controller.signal).then(blob => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setPreview(objectUrl) } }).catch(error => { if (!controller.signal.aborted) setPreviewError(errorText(error)) })
    return () => { alive.current = false; controller.abort(); publicationController.current?.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [accountId, output.id])
  useEffect(() => {
    const controller = new AbortController(); let timer: number | undefined
    async function poll() {
      try {
        const result = await studioApi.collectionTransfer(accountId, output.id, controller.signal)
        if (controller.signal.aborted) return
        setTransfer(result.transfer); setChecked(true)
        if (result.transfer?.active) timer = window.setTimeout(() => void poll(), 2000)
      } catch (error) { if (!controller.signal.aborted) { setError(errorText(error)); setChecked(false); timer = window.setTimeout(() => void poll(), 4000) } }
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [accountId, output.id, revision])
  async function submit() {
    if (!confirmed || !checked) return
    setBusy(true); setError('')
    try {
      const result = transfer ? await studioApi.retryCollectionTransfer(accountId, output.id) : await studioApi.startCollectionTransfer(accountId, { outputId: output.id, destinationId: Number(destinationId), title, publish: publication === 'public', confirm: true })
      if (alive.current) { setTransfer(result.transfer); setConfirmed(false); setRevision(value => value + 1) }
    } catch (error) { if (alive.current) { setError(errorText(error)); setChecked(false); setRevision(value => value + 1) } } finally { if (alive.current) setBusy(false) }
  }
  async function publish(action: 'publish' | 'reconcile') {
    if (!transfer || busy || (action === 'publish' && !publishConfirmed)) return
    const controller = new AbortController(); publicationController.current = controller
    setBusy(true); setError(''); setPublishConfirmed(false)
    try {
      const result = await studioApi.publishSavedDraft(accountId,output.id,action,transfer.publicationRevision ?? transfer.updatedAt,controller.signal)
      if (!controller.signal.aborted && alive.current) { setTransfer(result.transfer); setRevision(value => value + 1) }
    } catch (failure) { if (!controller.signal.aborted && alive.current) { setError(errorText(failure)); setChecked(false); setRevision(value => value + 1) } }
    finally { if (!controller.signal.aborted && alive.current) setBusy(false) }
  }
  const selected = destinations.find(item => String(item.id) === destinationId)
  const running = busy || !!transfer?.active
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="collection-post-dialog"><DialogTitle>Add generated image to a collection</DialogTitle><DialogDescription>This uploads the original image and creates a real Civitai post, then adds its Site image or post ID to your destination.</DialogDescription>
    <div className="columns is-multiline"><div className="column is-5-tablet"><div className="collection-original">{preview ? <img src={preview} alt="Original generated image selected for posting" /> : <p role="status">{previewError || 'Loading original preview…'}</p>}</div><p className="field-help">Original output · {new Date(generation.createdAt).toLocaleDateString()} · PNG/JPEG/GIF/WebP, at most 10 MiB.</p></div><div className="column is-7-tablet">
      {transfer ? <><h3>{transfer.destinationName}</h3><p>{transfer.destinationType} collection · #{transfer.destinationId}</p><p>Post title: {transfer.title}</p><p>Publication requested: {transfer.publishRequested ? 'Public' : 'Draft'}</p><p className="field-help">This output already has a saved posting attempt. Retrying uses its original destination and publication choice.</p></> : <>
        <div className="form-field"><label className="field-label">Saved destination</label><Select label="Destination collection" value={destinationId} onChange={setDestinationId} disabled={running} options={destinations.length ? destinations.map(item => ({ value: String(item.id), label: `${item.name} · ${item.type} · ${item.read}` })) : [{ value: 'none', label: 'No saved destinations' }]} />{selected && <p className="field-help">#{selected.id} · {selected.type} collection · {selected.read}{!selected.verified ? ' · User-supplied ID; Civitai will verify add permission' : ''}</p>}</div>
        <Button type="button" variant="ghost" size="sm" onClick={onManage}>Manage destinations</Button>
        <div className="form-field mt-3"><label className="field-label" htmlFor="collection-post-title">Post title</label><Input id="collection-post-title" maxLength={200} value={title} disabled={running} onChange={event => setTitle(event.target.value)} /></div>
        <div className="form-field"><Select label="Post publication" value={publication} onChange={setPublication} disabled={running} options={[{ value: 'draft', label: 'Keep as draft (default)' }, { value: 'public', label: 'Publish publicly now' }]} /></div>
      </>}
      <div className="notice mb-3">Draft items may not appear in collection views until published. A published post is public under Civitai’s rules even if the destination collection is private.</div>
      <p className="field-help">Studio does not copy your prompt or generation metadata into the post text. The original file may itself contain embedded metadata.</p>
    </div></div>
    {transfer && <section className="collection-stages" aria-label="Collection posting stages"><dl><div><dt>Original upload</dt><dd>{transfer.upload}</dd></div><div><dt>Post creation</dt><dd>{transfer.post}{transfer.sitePostId ? ` · Site post ${transfer.sitePostId}` : ''}</dd></div><div><dt>Publication</dt><dd>{transfer.publication}</dd></div><div><dt>Collection add</dt><dd>{transfer.membership}{transfer.siteImageIds.length ? ` · Site image ${transfer.siteImageIds.join(', ')}` : ''}</dd></div></dl><p role="status">{transfer.message}</p>{transfer.postUrl && <a href={transfer.postUrl} target="_blank" rel="noreferrer">View post on Civitai <ExternalLink size={13} /></a>}</section>}
    {transfer?.post === 'succeeded' && <section aria-label="Publish saved draft">
      <h3>Saved post publication</h3><p>{transfer.publicationMessage || `Saved post status: ${transfer.publication}.`}</p>
      {transfer.canPublish && <label className="collection-confirm"><input type="checkbox" checked={publishConfirmed} disabled={running || !checked} onChange={event => setPublishConfirmed(event.target.checked)} />I authorize publishing saved post #{transfer.sitePostId}, "{transfer.title}", publicly. It will be public even if {transfer.destinationName} is a private collection.</label>}
      <div className="dialog-actions">{transfer.canReconcilePublication && <Button variant="secondary" disabled={running || !checked} onClick={() => void publish('reconcile')}>Check publication status</Button>}{transfer.canPublish && <Button disabled={running || !checked || !publishConfirmed} onClick={() => void publish('publish')}>Publish saved draft publicly</Button>}</div>
    </section>}
    {error && <div className="error-box" role="alert">{error}<Button type="button" variant="ghost" onClick={() => setRevision(value => value + 1)}>Refresh status</Button></div>}
    {(!transfer || transfer.canRetry) && <label className="collection-confirm"><input type="checkbox" checked={confirmed} disabled={running} onChange={event => setConfirmed(event.target.checked)} />{transfer ? 'Retry only the unfinished stages shown above, using any saved Site post and image IDs.' : `I authorize uploading this original, creating a ${publication === 'public' ? 'publicly published post' : 'draft post'}, and adding it to the selected collection.`}</label>}
    <div className="dialog-actions"><Button type="button" variant="ghost" onClick={onClose}>Close</Button>{(!transfer || transfer.canRetry || transfer.active) && <Button type="button" disabled={running || !checked || !confirmed || (!transfer && (!preview || !selected || !title.trim())) || (!!transfer && !transfer.canRetry)} onClick={() => void submit()}>{running ? 'Working…' : transfer ? 'Retry unfinished stages' : publication === 'public' ? 'Upload, publish and add' : 'Upload draft and add'}</Button>}</div>
    <p className="field-help">Closing this dialog does not cancel an action already sent. Reopen it to view the saved stages. Video and 3D posting are not supported.</p>
  </DialogContent></Dialog>
}
