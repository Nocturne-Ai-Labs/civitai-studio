import { SiteCollectionSavePanel } from './SiteCollectionSavePanel'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, Image as ImageIcon, X } from 'lucide-react'
import { artworkPeriods, artworkSorts, parseArtworkLink, type ArtworkLink, type Artwork, type ArtworkFilters, type ArtworkScope } from '../../shared/artworks'
import { compatibility, selectedResources, type ModelVersion, type ResourceSlot } from '../../shared/composer'
import type { MediaType } from '../../shared/generation-catalog'
import { studioApi } from './api'
import { Select } from './controls'
import { Button, Input, Dialog, DialogContent, DialogDescription, DialogTitle } from './ui'
import { browsingLabels, type BrowsingPreference } from '../../shared/browsing'

export const resourceAction = (slot?: ResourceSlot) => ['diffuserModel','diffusionModel','checkpointModel'].includes(slot ?? '') ? 'Use model' : slot === 'model' ? 'Use checkpoint' : slot === 'loras' ? 'Add LoRA' : slot === 'vaeModel' ? 'Use VAE' : slot === 'embeddings' ? 'Add embedding' : 'Unavailable'
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Civitai artwork is unavailable.'
type Resolution = { version?: ModelVersion; error?: string }
function ArtworkMedia({ artwork, detail = false }: { artwork: Artwork; detail?: boolean }) {
  const [failed, setFailed] = useState(false)
  return <div className={detail ? 'artwork-preview' : 'model-preview'}>{!artwork.url || failed ? <p><ImageIcon size={25} />Preview unavailable. Open the work on Civitai.</p> : artwork.type === 'video' ? <video src={artwork.url} controls playsInline preload="none" crossOrigin="anonymous" onError={() => setFailed(true)} /> : <img src={artwork.url} alt={`Site artwork by ${artwork.creator || 'unknown creator'}`} loading="lazy" crossOrigin="anonymous" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}</div>
}
export function ArtworkBrowser({ open, onOpenChange, accountId, scope, mediaType, input, onAdd, browsing }: {
  browsing: BrowsingPreference;
  open: boolean; onOpenChange: (value: boolean) => void; accountId: string; scope: ArtworkScope;
  mediaType: MediaType; input: Record<string, unknown> | null; onAdd: (version: ModelVersion, slot: ResourceSlot, strength?: number) => void
}) {
  const [collecting, setCollecting] = useState(false)
  const [filters, setFilters] = useState<ArtworkFilters>({ type: 'image', sort: 'Newest', period: 'AllTime' })
  const [items, setItems] = useState<Artwork[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<Artwork | null>(null)
  const [resolved, setResolved] = useState<Record<number, Resolution>>({})
  const [resolving, setResolving] = useState(false)
  const [retry, setRetry] = useState(0)
  const [notice, setNotice] = useState('')
  const [linkText, setLinkText] = useState('')
  const [linkError, setLinkError] = useState('')
  const [linked, setLinked] = useState<{ target: ArtworkLink } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const seenCursors = useRef(new Set<string>())
  useEffect(() => {
    controller.current?.abort()
    setItems([]); setCursor(null); setDetail(null); setError(''); setNotice('')
    seenCursors.current.clear()
    if (!open) return
    const request = new AbortController(); controller.current = request
    setBusy(true)
    void studioApi.artworks(accountId, { ...filters, ...(linked ? linked.target : scope) }, request.signal).then(page => {
      if (!request.signal.aborted) { setItems(page.items); setCursor(page.nextCursor); if (linked?.target.imageId) setDetail(page.items[0] ?? null) }
    }).catch(error => { if (!request.signal.aborted) setError(errorText(error)) }).finally(() => { if (!request.signal.aborted) setBusy(false) })
    return () => { request.abort(); controller.current?.abort() }
  }, [open, accountId, scope, filters, linked])
  useEffect(() => {
    setCollecting(false); setResolved({}); setNotice(''); setResolving(false)
    if (!open || !detail) return
    const request = new AbortController(); let index = 0
    const resources = detail.resources.slice(0, 24)
    setResolving(resources.length > 0)
    async function worker() {
      while (!request.signal.aborted && index < resources.length) {
        const resource = resources[index++]!
        try {
          const version = await studioApi.modelVersion(accountId, resource.versionId, request.signal)
          if (!request.signal.aborted) setResolved(current => ({ ...current, [resource.versionId]: { version } }))
        } catch (error) {
          if (!request.signal.aborted) setResolved(current => ({ ...current, [resource.versionId]: { error: errorText(error) } }))
        }
      }
    }
    void Promise.all([worker(), worker()]).finally(() => { if (!request.signal.aborted) setResolving(false) })
    return () => request.abort()
  }, [accountId, open, detail, retry])
  async function more() {
    if (!cursor || busy) return
    const request = new AbortController(); controller.current?.abort(); controller.current = request
    setBusy(true); setError('')
    try {
      const page = await studioApi.artworks(accountId, { ...filters, ...(linked ? linked.target : scope), cursor }, request.signal)
      if (!request.signal.aborted) {
        seenCursors.current.add(cursor)
        setItems(current => [...new Map([...current, ...page.items].map(item => [item.id, item])).values()])
        setCursor(page.nextCursor && !seenCursors.current.has(page.nextCursor) ? page.nextCursor : null)
      }
    } catch (error) { if (!request.signal.aborted) setError(errorText(error)) } finally { if (!request.signal.aborted) setBusy(false) }
  }
  function openLink(value = linkText) {
    try {
      const target = parseArtworkLink(value)
      controller.current?.abort(); setDetail(null); setCollecting(false); setLinkError(''); setLinked({ target })
    } catch (error) { setLinkError(errorText(error)) }
  }
  const selected = input ? selectedResources(input) : []
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="model-browser artwork-browser" showCloseButton={false}>
    <div className="model-browser-heading"><div><DialogTitle>Civitai artwork</DialogTitle><DialogDescription>Explore Site-posted images and videos, then select compatible resources for your generation.</DialogDescription></div><Button type="button" variant="ghost" size="icon" aria-label="Close artwork browser" onClick={() => onOpenChange(false)}><X size={18} /></Button></div>
    <section className="mb-3" aria-label="Open Civitai artwork link" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => {
      event.preventDefault(); event.stopPropagation()
      if (event.dataTransfer.files.length) { setLinkError('Drop one Civitai artwork link, not a file.'); return }
      const value = (event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')).split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).join('\n')
      setLinkText(value); openLink(value)
    }}>
      <label htmlFor="artwork-link">Paste Civitai image or video link</label>
      <div className="field has-addons"><div className="control is-expanded"><Input id="artwork-link" value={linkText} maxLength={2048} placeholder="civitai.com or civitai.red HTTPS image / post link" onChange={event => { setLinkText(event.target.value); setLinkError('') }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); openLink() } }} /></div><div className="control"><Button type="button" onClick={() => openLink()} disabled={!linkText.trim()}>Open</Button></div></div>
      <p className="field-help">Paste or drop one artwork/post link here. Browsing: {browsingLabels[browsing.mode]} (Settings → Browsing). Civitai account and region restrictions still apply.</p>
      {linkError && <p role="alert" className="error-box">{linkError}</p>}
    </section>
    {linked ? <p className="notice">Linked {linked.target.imageId ? `artwork #${linked.target.imageId}` : `post #${linked.target.postId}`} · <a href={`https://${linked.target.siteHost ?? "civitai.com"}/${linked.target.imageId ? 'images' : 'posts'}/${linked.target.imageId ?? linked.target.postId}`} target="_blank" rel="noreferrer">Open on Civitai</a> <Button type="button" variant="ghost" onClick={() => { setLinked(null); setLinkError('') }}>Return to browsing</Button></p> : scope.label && <p className="notice">{scope.label}{scope.modelVersionId ? ` · Version ${scope.modelVersionId}` : scope.modelId ? ` · Model ${scope.modelId}` : ''}</p>}
    {collecting && detail ? <SiteCollectionSavePanel key={`${accountId}:${detail.id}`} accountId={accountId} choices={[{ itemType: 'Image', itemId: detail.id, label: `${detail.type === 'video' ? 'Video' : 'Image'} by ${detail.creator || 'Unknown creator'}` }, ...(detail.postId ? [{ itemType: 'Post' as const, itemId: detail.postId, artworkId: detail.id, label: `Parent post for artwork #${detail.id}` }] : [])]} onBack={() => setCollecting(false)} /> : detail ? <>
      <Button type="button" variant="ghost" onClick={() => setDetail(null)}><ArrowLeft size={14} />Back to artwork</Button><Button type="button" variant="secondary" onClick={() => setCollecting(true)}>Save artwork to collection</Button>
      <div className="columns is-multiline"><div className="column is-6-tablet"><ArtworkMedia key={detail.id} artwork={detail} detail /><span className="content-rating">{detail.rating.label}</span><p>{detail.type === 'video' ? 'Video' : 'Image'} by {detail.creator || 'Unknown creator'}</p><a href={detail.siteUrl} target="_blank" rel="noreferrer">Open artwork on Civitai <ExternalLink size={12} /></a></div>
      <div className="column is-6-tablet artwork-metadata"><h3>Published generation metadata</h3>{!detail.hasMetadata && <p>No generation metadata was published for this work.</p>}<h4>Prompt</h4><p className="artwork-prompt">{detail.prompt || 'Not provided'}</p><h4>Negative prompt</h4><p className="artwork-prompt">{detail.negativePrompt || 'Not provided'}</p>{Object.keys(detail.parameters).length > 0 && <dl className="artwork-parameters">{Object.entries(detail.parameters).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{String(value)}</dd></div>)}</dl>}</div></div>
      <h3>Resources used in this work</h3><p className="field-help">Choose resources individually. Your prompt, settings and engine stay as you wrote them. Existing LoRAs are kept; model replacements are shown explicitly. Selecting a resource does not generate.</p>
      {notice && <p role="status" className="notice">{notice}</p>}
      {!detail.resources.length && <p>No resolvable Civitai model version IDs were published. Names alone cannot identify a generation resource.</p>}
      {detail.resourcesTruncated && <p className="notice">Showing the first 24 referenced resources. Open Civitai for the complete work.</p>}
      <div className="artwork-resources">{detail.resources.map(resource => {
        const result = resolved[resource.versionId], version = result?.version
        const support = version && input ? compatibility(mediaType, input, version) : { reason: !input ? 'Fix the composer JSON before selecting resources.' : 'Checking version availability…' }
        const isSelected = version && selected.some(item => item.air === version.air && item.slot === support.slot)
        const replacement = support.slot && !['loras', 'embeddings'].includes(support.slot) && input?.[support.slot] && input[support.slot] !== version?.air ? String(input[support.slot]) : null
        return <article key={resource.versionId} className="artwork-resource"><div><strong>{version ? `${version.name} · ${version.versionName}` : `Model version ${resource.versionId}`}</strong><p>{version ? `${version.type} · ${version.baseModel}` : resource.typeHint ? `Published type hint: ${resource.typeHint}` : 'Resource type not yet resolved'}{resource.weight !== undefined ? ` · Published strength ${resource.weight}` : ''}</p>{version && <p className="field-help">{version.rating.label} · {version.canGenerate ? 'Available for your account' : 'Unavailable for your account'}</p>}{result?.error ? <p role="alert">{result.error}</p> : <>{!support.slot && <p className="field-help">{support.reason}</p>}</>}{replacement && <p className="notice">Selecting this resource replaces the current {support.slot}: {replacement}. Other resources stay selected.</p>}{isSelected && <p className="field-help">Already selected; keeping your current strength and settings.</p>}<a href={version ? version.url ?? `https://civitai.com/models/${version.modelId}?modelVersionId=${version.id}` : `https://${browsing.mode === 'mature' ? 'civitai.red' : 'civitai.com'}/models?modelVersionId=${resource.versionId}`} target="_blank" rel="noreferrer">View on Civitai</a></div><Button type="button" variant="secondary" disabled={!version || !support.slot || Boolean(isSelected)} onClick={() => { if (version && support.slot) { onAdd(version, support.slot, resource.weight); setNotice(`${version.name} · ${version.versionName} selected in the composer.`) } }}>{isSelected ? 'Selected' : replacement ? `Replace ${support.slot === 'model' ? 'checkpoint / model' : support.slot === 'vaeModel' ? 'VAE' : 'model'}` : resourceAction(support.slot)}</Button></article>
      })}</div>
      {resolving && <p role="status">Resolving referenced versions…</p>}{!resolving && Object.values(resolved).some(result => result.error) && <Button type="button" variant="secondary" onClick={() => setRetry(value => value + 1)}>Retry resource lookup</Button>}
      <Button type="button" className="mt-3" onClick={() => onOpenChange(false)}>Return to generation</Button>
    </> : <>
      {!linked && <div className="columns is-multiline model-filters"><div className="column is-4-tablet"><Select label="Artwork media type" value={filters.type} options={[{ value: 'image', label: 'Images' }, { value: 'video', label: 'Videos' }]} onChange={value => setFilters({ ...filters, type: value as 'image' | 'video' })} /></div><div className="column is-4-tablet"><Select label="Artwork sort" value={filters.sort} options={artworkSorts.map(value => ({ value, label: value }))} onChange={sort => setFilters({ ...filters, sort })} /></div><div className="column is-4-tablet"><Select label="Artwork period" value={filters.period} options={artworkPeriods.map(value => ({ value, label: value === 'AllTime' ? 'All time' : value }))} onChange={period => setFilters({ ...filters, period })} /></div></div>}
      {!linked && scope.modelId && !scope.modelVersionId && <p className="field-help">Model-wide browsing starts with Newest. Civitai may fall back from engagement sorting for large models.</p>}
      <div className="columns is-multiline">{items.map(artwork => <div className="column is-6-tablet is-4-desktop" key={artwork.id}><article className="model-card"><ArtworkMedia artwork={artwork} /><span className="content-rating">{artwork.rating.label}</span><div className="model-card-body"><p>{artwork.type === 'video' ? 'Video' : 'Image'} by {artwork.creator || 'Unknown creator'}</p><Button type="button" variant="secondary" onClick={() => setDetail(artwork)}>View artwork & resources</Button></div></article></div>)}</div>
      {busy && <p role="status">Loading Site artwork…</p>}{!busy && !items.length && !error && <p>{linked ? 'No image or video is available for this link under your browsing preference or Civitai account/region restrictions. It may also be private or removed.' : 'No Site artwork is available for these filters and browsing preference. Provider account or region restrictions may also apply.'}</p>}
      {error && <div className="error-box" role="alert">{error}<Button type="button" variant="secondary" onClick={() => cursor ? void more() : linked ? setLinked({ target: linked.target }) : setFilters({ ...filters })}>Retry</Button></div>}
      {cursor && <Button type="button" variant="secondary" disabled={busy} onClick={() => void more()}>Load more</Button>}
    </>}
  </DialogContent></Dialog>
}
