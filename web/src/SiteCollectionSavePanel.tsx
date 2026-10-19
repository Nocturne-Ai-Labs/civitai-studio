import { useEffect, useRef, useState } from 'react'
import type { CollectionDestination, SiteCollectionItem, SiteCollectionSave } from '../../shared/collections'
import { studioApi } from './api'
import { Button } from './ui'
import { Select } from './controls'
import { CollectionDestinations } from './CollectionsPanel'
const message = (error: unknown) => error instanceof Error ? error.message : 'The Site save is unavailable.'
const itemUrl = (item: SiteCollectionItem) => `https://civitai.com/${item.itemType === 'Model' ? 'models' : item.itemType === 'Post' ? 'posts' : 'images'}/${item.itemId}`
export function SiteCollectionSavePanel({ accountId, choices, onBack }: { accountId: string; choices: SiteCollectionItem[]; onBack: () => void }) {
  const [choice, setChoice] = useState(0)
  const item = choices[choice] ?? choices[0]!
  const [destinations, setDestinations] = useState<CollectionDestination[]>([])
  const [destinationId, setDestinationId] = useState('none')
  const [record, setRecord] = useState<SiteCollectionSave | null>(null)
  const [checked, setChecked] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [destinationRevision, setDestinationRevision] = useState(0)
  const [revision, setRevision] = useState(0)
  const [manage, setManage] = useState(false)
  const requests = useRef<AbortController[]>([])
  const sending = useRef(false)
  useEffect(() => {
    const controller = new AbortController(); requests.current.push(controller)
    setDestinations([]); setDestinationId('none'); setConfirmed(false); setChecked(false); setError('')
    void studioApi.collectionDestinations(accountId,controller.signal).then(result => { if (!controller.signal.aborted) { const matched = result.items.filter(dest => dest.type === item.itemType); setDestinations(matched); setDestinationId(matched[0] ? String(matched[0].id) : 'none') } }).catch(error => { if (!controller.signal.aborted) setError(message(error)) })
    return () => controller.abort()
  }, [accountId,item.itemType,destinationRevision])
  useEffect(() => {
    const controller = new AbortController(); requests.current.push(controller); let timer: number | undefined
    setRecord(null); setChecked(false); setConfirmed(false)
    if (destinationId === 'none') return () => controller.abort()
    async function load() {
      try {
        const result = await studioApi.siteCollectionSave(accountId,item.itemType,item.itemId,Number(destinationId),controller.signal)
        if (controller.signal.aborted) return
        setRecord(result.save); setChecked(true)
        if (result.save?.status === 'running') timer = window.setTimeout(() => void load(),2000)
      } catch (error) { if (!controller.signal.aborted) setError(message(error)) }
    }
    void load()
    return () => { controller.abort(); window.clearTimeout(timer) }
  },[accountId,item.itemType,item.itemId,destinationId,revision])
  useEffect(() => () => requests.current.forEach(request => request.abort()),[accountId])
  async function save() {
    if (!checked || !confirmed || destinationId === 'none' || sending.current || (record && record.status !== 'failed')) return
    sending.current = true; setBusy(true); setError('')
    const controller = new AbortController(); requests.current.push(controller)
    try {
      const result = await studioApi.saveSiteItem(accountId,{ itemType:item.itemType,itemId:item.itemId,artworkId:item.artworkId,destinationId:Number(destinationId),confirm:true },controller.signal)
      if (!controller.signal.aborted) { setRecord(result.save); setConfirmed(false); if (result.save.status === 'running') setRevision(value => value + 1) }
    } catch (error) {
      if (!controller.signal.aborted) { setError(`${message(error)} Reload save status before retrying; closing this view does not undo a request already sent.`); setChecked(false) }
    } finally { sending.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  const dest = destinations.find(dest => String(dest.id) === destinationId)
  return <section className="site-collection-save"><Button type="button" variant="ghost" disabled={busy} onClick={onBack}>Back to item</Button><h3>Save existing Site item</h3>
    <p>This saves a reference to an existing Civitai item. It does not upload media, create a post, copy a prompt or generate anything.</p>
    {choices.length > 1 && <Select label="Site item to save" value={String(choice)} disabled={busy} options={choices.map((choice,index) => ({ value:String(index),label:choice.itemType === 'Post' ? `Parent post #${choice.itemId}` : `Artwork #${choice.itemId}` }))} onChange={value => { setChoice(Number(value)); setManage(false); setConfirmed(false) }} />}
    <div className="notice"><strong>{item.label}</strong><p>{item.itemType} #{item.itemId}</p><a href={itemUrl(item)} target="_blank" rel="noreferrer">Open Site item</a></div>
    <p className="field-help">{item.itemType === 'Model' ? 'Uses the Site model ID, not a model-version ID.' : item.itemType === 'Image' ? 'Site images and videos both use Image collection membership.' : 'Saves the existing parent post, which may contain other artwork.'}</p>
    <Select label="Matched saved destination" value={destinationId} disabled={busy} options={[{ value:'none',label:`Choose a saved ${item.itemType} collection` },...destinations.map(dest => ({ value:String(dest.id),label:`${dest.name} · #${dest.id}` }))]} onChange={value => { setDestinationId(value); setConfirmed(false); setChecked(false) }} />
    {!destinations.length && <p>No saved {item.itemType} destinations. Create one or save an existing collection ID below.</p>}
    {dest && <p>Destination: <a href={`https://civitai.com/collections/${dest.id}`} target="_blank" rel="noreferrer">{dest.name} · #{dest.id}</a> ({dest.type}, {dest.read}). {dest.verified ? '' : 'User-supplied private/unlisted ID; Civitai checks permission.'}</p>}
    {record && <p role="status" className={record.status === 'uncertain' || record.status === 'failed' ? 'error-box' : 'notice'}><strong>{record.status === 'succeeded' ? 'Save acknowledged' : record.status}</strong><br />{record.message}</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
    <label className="collection-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !checked || !!record && record.status !== 'failed'} onChange={event => setConfirmed(event.target.checked)} />Save {item.itemType} #{item.itemId} to {dest ? `${dest.name} (#${dest.id})` : 'the selected collection'}.</label>
    <div className="composer-actions"><Button type="button" disabled={busy || !confirmed || !checked || !dest || !!record && record.status !== 'failed'} onClick={() => void save()}>{busy ? 'Saving…' : record?.status === 'failed' ? 'Retry save' : 'Confirm save to collection'}</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reload save status</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => setManage(value => !value)}>Create / save destination</Button></div>
    <p className="field-help">Only destinations saved for this Studio account are shown. Public discovery does not list all private collections. An uncertain save is never repeated automatically; inspect Civitai directly.</p>
    {manage && <CollectionDestinations key={`${accountId}:${item.itemType}`} accountId={accountId} itemType={item.itemType} onChange={() => setDestinationRevision(value => value + 1)} />}
  </section>
}
