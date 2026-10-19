import * as Tabs from '@radix-ui/react-tabs'
import { Check, Film, ImagePlus, LoaderCircle, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ImageSource } from '../../shared/workflows'
import { studioApi } from './api'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger, Input } from './ui'

type SourcePage = Awaited<ReturnType<typeof studioApi.imageSources>>
type GallerySource = SourcePage['gallery'][number]
const originalUrl = (source: { generationId: string; outputId: string }) => `/api/studio/v1/generations/${encodeURIComponent(source.generationId)}/outputs/${encodeURIComponent(source.outputId)}/content`
const galleryKey = (source: GallerySource) => JSON.stringify([source.generationId, source.outputId])

function SourceThumbnail({ source, label }: { source?: { generationId: string; outputId: string; type?: 'image' | 'video' }; label: string }) {
  const [failed, setFailed] = useState(false)
  const url = source ? originalUrl(source) : null
  useEffect(() => setFailed(false), [url])
  // Do not fetch video originals just to populate the chooser.
  return <span className="source-thumbnail">{url && source?.type !== 'video' && !failed
    ? <img src={url} loading="lazy" decoding="async" alt="" onError={() => setFailed(true)} />
    : <span className="source-thumbnail-fallback">{source?.type === 'video' ? <Film size={28} /> : <ImagePlus size={28} />}<span>{failed ? 'Preview unavailable' : label}</span></span>}</span>
}

export function ImageSourcePicker({ accountId, value, onChange, mediaType = 'image' }: { accountId: string; value: ImageSource | null; onChange: (source: ImageSource | null) => void; mediaType?: 'image' | 'video' }) {
  const [page, setPage] = useState<SourcePage | null>(null)
  const [gallery, setGallery] = useState(''), [saved, setSaved] = useState(''), [search, setSearch] = useState('')
  const [file, setFile] = useState<File | null>(null), [localPreview, setLocalPreview] = useState<string | null>(null), [uploadedId, setUploadedId] = useState('')
  const [open, setOpen] = useState(false), [tab, setTab] = useState('gallery'), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null), listController = useRef<AbortController | null>(null)
  const scope = `${accountId}:${mediaType}`, activeScope = useRef(scope)
  activeScope.current = scope
  const galleryItems = (page?.gallery ?? []).filter(item => item.type === mediaType)
  const savedItems = (page?.items ?? []).filter(item => item.type === mediaType)
  const visibleGallery = galleryItems.filter(item => item.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const visibleSaved = savedItems.filter(item => item.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const selectedGallery = galleryItems.find(item => galleryKey(item) === gallery)
  const selectedSaved = savedItems.find(item => item.id === saved)

  useEffect(() => {
    if (!file) { setLocalPreview(null); return }
    const url = URL.createObjectURL(file); setLocalPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  async function loadSources() {
    listController.current?.abort()
    const request = new AbortController(), requestScope = scope
    listController.current = request; setLoading(true); setError('')
    try {
      const result = await studioApi.imageSources(accountId, request.signal)
      if (!request.signal.aborted && activeScope.current === requestScope) setPage(result)
    } catch (e) {
      if (!request.signal.aborted && activeScope.current === requestScope) setError(e instanceof Error ? e.message : 'Sources unavailable.')
    } finally {
      if (!request.signal.aborted && activeScope.current === requestScope) setLoading(false)
    }
  }
  useEffect(() => {
    setPage(null); setGallery(''); setSaved(''); setSearch(''); setFile(null); setUploadedId(''); setOpen(false); setTab('gallery'); setBusy(false)
    void loadSources()
    return () => { listController.current?.abort(); controller.current?.abort() }
  }, [scope])

  async function select(upload = false, recover = false) {
    if (busy) return
    if (upload && (!file || file.size > 8 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) { setError('Choose PNG, JPEG or WebP up to 8 MiB.'); return }
    const recovery = recover && value?.recovery ? { id: value.id, revision: value.revision, action: value.recovery } : undefined
    if (recover && !recovery) return
    if (!upload && !selectedGallery) return
    const request = new AbortController(), requestScope = scope
    controller.current = request; setBusy(true); setError('')
    try {
      const result = upload
        ? await studioApi.uploadImageSource(accountId, file!, request.signal, recovery)
        : await studioApi.selectImageSource(accountId, selectedGallery!.generationId, selectedGallery!.outputId, request.signal)
      if (request.signal.aborted || activeScope.current !== requestScope) return
      onChange(result.source)
      setPage(current => current ? { ...current, items: [result.source, ...current.items.filter(item => item.id !== result.source.id)] } : { gallery: [], items: [result.source] })
      if (upload) setUploadedId(result.source.id)
      if (result.source.status === 'ready') setOpen(false)
    } catch (e) {
      if (!request.signal.aborted && activeScope.current === requestScope) setError(e instanceof Error ? e.message : 'Source unavailable.')
    } finally {
      if (!request.signal.aborted && activeScope.current === requestScope) setBusy(false)
    }
  }
  function choose(tabName: string) { setTab(tabName); setSearch(''); setError(''); setOpen(true) }
  const selectedUrl = value?.origin ? originalUrl(value.origin) : value?.id === uploadedId ? localPreview : null
  return <section className="form-field image-source-picker">
    <div className="source-picker-heading"><h3>Source {mediaType}</h3>{value && <span className={`pill${value.status === 'ready' ? ' source-ready' : ''}`}>{value.status === 'ready' ? 'Ready' : value.status}</span>}</div>
    <p className="field-help">{mediaType === 'image' ? 'Choose an image from My generations or upload one to use as a source.' : 'Choose an owned original video from My generations. Local video uploads are not available.'}</p>
    {value ? <div className="source-selected-card">
      {selectedUrl ? value.type === 'video'
        ? <video className="workflow-source-preview" controls preload="metadata" src={selectedUrl} />
        : <img className="workflow-source-preview" src={selectedUrl} alt="Selected source image" />
        : <div className="source-selected-placeholder"><ImagePlus size={28} /><span>{value.kind === 'upload' ? 'Saved uploaded image' : 'Source selected'}</span></div>}
      <div className="source-selected-info"><strong>{value.label}</strong><p className="field-help">{value.mime ?? value.type}{value.size ? ` · ${(value.size / 1024 / 1024).toFixed(2)} MiB` : ''}{value.width && value.height ? ` · ${value.width} × ${value.height}` : ''}{value.duration ? ` · ${value.duration}s` : ''}</p><p className="field-help">{value.message}</p>{value.expiresAt && <p className="field-help">Source expires {new Date(value.expiresAt).toLocaleDateString()}.</p>}</div>
    </div> : <div className="source-empty-preview"><ImagePlus size={30} /><strong>No source {mediaType} selected</strong><span className="field-help">Select {mediaType === 'image' ? 'an image' : 'a video'} to use in this workflow.</span></div>}
    <Dialog open={open} onOpenChange={next => { if (!busy) { setOpen(next); if (next) { setTab('gallery'); setSearch(''); setError('') } } }}>
      <div className="source-picker-actions"><DialogTrigger asChild><Button type="button" variant={value ? 'secondary' : 'default'} disabled={busy}><ImagePlus size={15} />{value ? `Change ${mediaType}` : `Choose ${mediaType}`}</Button></DialogTrigger>{mediaType === 'image' && <Button type="button" variant="secondary" disabled={busy} onClick={() => choose('upload')}><Upload size={15} />Upload image</Button>}{value && <Button type="button" variant="ghost" disabled={busy} onClick={() => onChange(null)}>Remove {mediaType}</Button>}</div>
      <DialogContent className="source-media-dialog" closeDisabled={busy} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
        <DialogTitle>Choose source {mediaType}</DialogTitle><DialogDescription>{mediaType === 'image' ? 'Select an original image or explicitly upload a local file. Generation starts only after cost review and confirmation.' : 'Select an original video saved in your Studio gallery.'}</DialogDescription>
        <Tabs.Root value={tab} onValueChange={next => { if (!busy) { setTab(next); setSearch(''); setError('') } }}>
          <Tabs.List className="source-media-tabs" aria-label="Source location"><Tabs.Trigger value="gallery" disabled={busy}>My generations <span>{galleryItems.length}</span></Tabs.Trigger><Tabs.Trigger value="saved" disabled={busy}>Saved sources <span>{savedItems.length}</span></Tabs.Trigger>{mediaType === 'image' && <Tabs.Trigger value="upload" disabled={busy}>Upload image</Tabs.Trigger>}</Tabs.List>
          <Tabs.Content value="gallery" className="source-media-panel">
            <div className="source-media-toolbar"><Input aria-label={`Search gallery ${mediaType}s`} placeholder="Search your generations…" value={search} onChange={event => setSearch(event.target.value)} disabled={loading || busy} /><Button type="button" variant="ghost" disabled={loading || busy} onClick={() => void loadSources()}>Refresh</Button></div>
            {loading ? <p className="source-media-empty" role="status"><LoaderCircle size={18} className="spin" />Loading your {mediaType}s…</p> : visibleGallery.length ? <div className="source-media-grid" aria-label={`Gallery ${mediaType}s`}>{visibleGallery.map(item => <Button type="button" key={galleryKey(item)} className="source-media-card" variant="secondary" aria-pressed={gallery === galleryKey(item)} disabled={busy} onClick={() => setGallery(galleryKey(item))}><SourceThumbnail source={item} label={mediaType === 'video' ? 'Video original' : 'Image original'} /><span className="source-media-label">{item.label}</span>{gallery === galleryKey(item) && <span className="source-media-check"><Check size={16} /></span>}</Button>)}</div> : <div className="source-media-empty"><ImagePlus size={28} /><strong>{search ? 'No matching media' : `No gallery ${mediaType}s yet`}</strong><p>{search ? 'Try another search.' : 'Sync Civitai workflows in My generations to make their original media available here.'}</p></div>}
            <div className="source-media-footer"><p className="field-help">Up to 500 originals from the latest 100 saved workflows.</p><Button type="button" disabled={busy || !selectedGallery || loading} onClick={() => void select()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Use selected {mediaType}</Button></div>
          </Tabs.Content>
          <Tabs.Content value="saved" className="source-media-panel">
            <Input aria-label="Search saved sources" placeholder="Search saved sources…" value={search} onChange={event => setSearch(event.target.value)} disabled={loading || busy} />
            {loading ? <p className="source-media-empty" role="status">Loading saved sources…</p> : visibleSaved.length ? <div className="source-media-grid" aria-label="Saved sources">{visibleSaved.map(item => <Button type="button" key={item.id} className="source-media-card" variant="secondary" aria-pressed={saved === item.id} disabled={busy} onClick={() => setSaved(item.id)}><SourceThumbnail source={item.origin ? { ...item.origin, type: item.type } : undefined} label={item.kind === 'upload' ? 'Uploaded image' : mediaType} /><span className="source-media-label">{item.label}<small>{item.status} · {item.id.slice(-8)}</small></span>{saved === item.id && <span className="source-media-check"><Check size={16} /></span>}</Button>)}</div> : <div className="source-media-empty"><ImagePlus size={28} /><strong>{search ? 'No matching sources' : 'No saved sources yet'}</strong><p>Sources you select or upload will appear here for reuse.</p></div>}
            <div className="source-media-footer"><p className="field-help">Only ready sources can be used for cost review.</p><Button type="button" disabled={busy || !selectedSaved || loading} onClick={() => { if (selectedSaved) { onChange(selectedSaved); setOpen(false) } }}>Use saved source</Button></div>
          </Tabs.Content>
          {mediaType === 'image' && <Tabs.Content value="upload" className="source-media-panel source-upload-panel">
            <label className="source-upload-field"><Upload size={26} /><strong>Choose an image from your device</strong><span className="field-help">PNG, JPEG or WebP · up to 8 MiB</span><Input aria-label="Choose local source image" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setUploadedId(''); setError('') }} /></label>
            {localPreview && <figure className="source-upload-preview"><img className="workflow-source-preview" src={localPreview} alt="Local image selected for upload" /><figcaption className="field-help">{file?.name} · local preview</figcaption></figure>}
            <p className="field-help">Choosing a file only previews it on this device. The Upload button sends it to Civitai as a source; nothing is published or generated.</p>
            {value?.recovery && <div className="notice"><p>Reselect this source's original file to explicitly {value.recovery === 'renew' ? 'renew its expired upload' : 'retry its upload'}. This sends the image to Civitai.</p><Button type="button" variant="secondary" disabled={busy || !file} onClick={() => void select(true, true)}>{value.recovery === 'renew' ? 'Renew expired source' : 'Retry source upload'}</Button></div>}
            {value && value.status !== 'ready' && <p className="notice" role="status">{value.message}</p>}
            <div className="source-media-footer"><span className="field-help">Upload only when you are ready to share this image with Civitai.</span><Button type="button" disabled={busy || !file} onClick={() => void select(true)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}Upload image to Civitai</Button></div>
          </Tabs.Content>}
        </Tabs.Root>
        {error && <div className="error-box" role="alert">{error}</div>}
      </DialogContent>
    </Dialog>
    {error && !open && <div className="error-box" role="alert">{error}<Button type="button" variant="ghost" size="sm" disabled={loading || busy} onClick={() => void loadSources()}>Retry loading sources</Button></div>}
  </section>
}