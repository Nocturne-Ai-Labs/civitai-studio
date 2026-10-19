import { useBrowsingSettings } from './BrowsingSettings'
import { SettingsPanel, LocalSaveProgress, useLocalStorageSettings } from './SettingsPanel'
import { BatchPostDialog, type BatchSelection } from './BatchPostDialog'
import { TrainingPanel } from './TrainingPanel'
import { UpscaleDialog, canUpscale, canFinishVideo } from './UpscaleDialog'
import { WorkflowCancellation } from './WorkflowCancellation'
import { CollectionsPanel } from './CollectionsPanel'
import { CollectionPostDialog } from './CollectionPostDialog'
import { chooseFolder, folderSavingSupported, saveOutput, type Directory } from './folder-save'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, Aperture, ArrowDownToLine, Box, Check,
  Clock3, Coins, Download, Film, FolderHeart, Image as ImageIcon, LoaderCircle, LockKeyhole,
  LogOut, Music, RefreshCw, Search, Settings, WandSparkles, X,
} from 'lucide-react'
import type { AppSession, BuzzBalance, Generation, GenerationOutput } from './api'
import { ApiError, setCsrfToken, studioApi } from './api'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from './ui'
import { GenerationComposer } from './GenerationComposer'
import { GalleryMetadataDialog } from './GalleryMetadataDialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { FilmstripPreview } from './FilmstripPreview'

type Page = 'generate' | 'gallery' | 'collections' | 'training' | 'settings'
type Notice = { kind: 'error' | 'info'; message: string } | null

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'
const dateFolder = (date: string) => {
  const parsed = new Date(date)
  return Number.isNaN(parsed.valueOf()) ? 'Unknown date' : parsed.toISOString().slice(0, 10)
}
const promptOf = (generation: Generation) => generation.input?.prompt || `${generation.mediaType === 'model3d' ? '3D' : generation.mediaType ?? 'Image'} generation`
const galleryDate = (generation: Generation) => dateFolder(generation.outputs[0]?.createdAt ?? generation.completedAt ?? generation.createdAt)

function GalleryOutputPreview({ generation, output }: { generation: Generation; output: GenerationOutput }) {
  const kind = output.kind ?? generation.mediaType ?? 'image'
  const preview = output.previewUrl
  const poster = preview && (preview !== output.url || /\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(preview)) && !/\.(?:mp4|webm|mov|mkv|glb|gltf|obj|fbx)(?:[?#]|$)/i.test(preview) ? preview : null
  const image = kind === 'image' ? preview ?? output.url : kind === 'video' || kind === 'model3d' ? poster : null
  const [failedImage, setFailedImage] = useState<string | null>(null)
  return <><div className="media-placeholder">{kind === 'audio' ? <Music size={36} /> : kind === 'video' ? <Film size={32} /> : kind === 'model3d' ? <Box size={32} /> : <ImageIcon size={32} />}<span>{kind === 'video' ? 'Open to play video' : kind === 'audio' ? 'Generated music' : kind === 'model3d' ? 'Open 3D details' : 'Open image details'}</span></div>{image && image !== failedImage && <img src={image} alt="" loading="lazy" onError={() => setFailedImage(image)} />}</>
}

function RecentFilmstrip({ generations, connected, loading, error, onOpen, onViewAll, onTraining, onConnect, onRefresh }: {
  generations: Generation[]; connected: boolean; loading: boolean; error: string
  onOpen: (id: string) => void; onViewAll: () => void; onTraining: (id: string) => void; onConnect: () => void; onRefresh: () => void
}) {
  const recent = connected ? generations.flatMap(generation => {
    const outputs = generation.outputs.filter(output => output.role !== 'thumbnail' && output.role !== 'checkpoint' && output.kind !== 'checkpoint' && (generation.mediaType !== 'training' || output.role === 'training-sample'))
    return outputs.length ? outputs.map(output => ({ generation, output: output as GenerationOutput | null }))
      : generation.mediaType === 'training' ? [] : [{ generation, output: null }]
  }).slice(0, 16) : []
  return <Tooltip.Provider skipDelayDuration={100}><section className="recent-filmstrip" aria-label="Recent generations">
    <div className="filmstrip-heading"><div><h2>Recent generations</h2><span role="status">{recent.length && loading ? 'Refreshing…' : recent.length && error ? 'Refresh unavailable' : 'All media'}</span></div><div>{recent.length > 0 && error && <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={onRefresh}>Retry</Button>}<Button type="button" variant="ghost" size="sm" onClick={onViewAll}>Open gallery</Button></div></div>
    {recent.length ? <div className="filmstrip-items" tabIndex={0} aria-label="Recent outputs; scroll horizontally">{recent.map(({ generation, output }) => {
      const training = generation.mediaType === 'training'
      const kind = output?.kind ?? (training ? output?.mimeType?.startsWith('video/') ? 'video' : 'image' : generation.mediaType ?? 'image')
      const id = output?.id ?? generation.id
      const preview = kind === 'model3d' ? output?.previewUrl : output?.previewUrl ?? output?.url
      const videoThumbnail = kind === 'video' && preview && (preview !== output?.url || /\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(preview))
      const imagePreview = preview && (kind === 'image' || videoThumbnail || (kind === 'model3d' && preview !== output?.url))
      const label = `${training ? 'Training ' : ''}${kind === 'model3d' ? '3D' : kind}`
      return <FilmstripPreview key={`${generation.id}:${id}`} generation={generation} output={output} label={label}><Button type="button" variant="ghost" className="filmstrip-item" onClick={() => training ? onTraining(generation.id) : onOpen(id)} aria-label={`${training ? 'Open training run' : 'Open details'}: ${label}, ${promptOf(generation)}; ${generation.status}`}>
        <span className="filmstrip-preview">{!output && ['queued', 'running'].includes(generation.status) ? <LoaderCircle size={22} className="spin" /> : kind === 'audio' ? <Music size={24} /> : kind === 'video' ? <Film size={24} /> : kind === 'model3d' ? <Box size={24} /> : <ImageIcon size={24} />}
          {imagePreview ? <img src={preview!} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} /> : null}
        </span><span className="filmstrip-caption"><span>{label}</span><span>{generation.status}</span></span>
      </Button></FilmstripPreview>
    })}</div> : <div className="filmstrip-empty" role="status"><div className="filmstrip-empty-icon" aria-hidden="true">{loading ? <LoaderCircle size={24} className="spin" /> : !connected ? <LockKeyhole size={24} /> : error ? <AlertCircle size={24} /> : <ImageIcon size={24} />}</div><div><strong>{loading ? 'Loading recent work…' : !connected ? 'Your recent work belongs here' : error ? 'Recent work could not be loaded' : 'Your filmstrip is ready'}</strong><p>{loading ? 'Gathering your latest media.' : !connected ? 'Connect to see your images, videos, music, and 3D creations.' : error || 'New images, videos, music, and 3D creations will appear here.'}</p></div>{!loading && !connected && <Button type="button" variant="secondary" size="sm" onClick={onConnect}>Connect account</Button>}{!loading && connected && error && <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>Retry</Button>}</div>}
  </section></Tooltip.Provider>
}
export function Studio() {
  const [theme, setTheme] = useState<'blue' | 'red'>(() => document.documentElement.dataset.theme === 'red' ? 'red' : 'blue')
  function chooseTheme(value: 'blue' | 'red') {
    document.documentElement.dataset.theme = value
    setTheme(value)
    try { localStorage.setItem('civitai-studio-theme', value) } catch { /* Preference remains usable when storage is unavailable. */ }
  }
  const [upscaleOutput, setUpscaleOutput] = useState<{ operation?: 'imageUpscaler' | 'imageBackgroundRemoval' | 'imageEdit' | 'imageAnimation' | 'imageTo3D' | 'transcode' | 'videoUpscaler' | 'videoInterpolation'; generation: Generation; output: GenerationOutput } | null>(null)
  const [batchSelection, setBatchSelection] = useState<BatchSelection[] | null>(null)
  const [collectionOutput, setCollectionOutput] = useState<{ generation: Generation; output: GenerationOutput } | null>(null)
  const [page, setPage] = useState<Page>('generate')
  const [session, setSession] = useState<AppSession | null>(null)
  const browsing = useBrowsingSettings(session?.connected ? session.user?.id ?? null : null)
  const localOutputs = useLocalStorageSettings(session?.connected ? session.user?.id ?? null : null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [sessionError, setSessionError] = useState('')
  const [buzz, setBuzz] = useState<BuzzBalance | null>(null)
  const [buzzLoading, setBuzzLoading] = useState(false)
  const [buzzError, setBuzzError] = useState('')
  const [galleryFocus,setGalleryFocus]=useState<string|null>(null)
  const [trainingFocus, setTrainingFocus] = useState<string | null>(null)
  useEffect(() => { if (page !== 'training' || !trainingFocus) return; const target = document.getElementById(`training-run-${trainingFocus}`); if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); setTrainingFocus(null) } }, [page, trainingFocus])
  useEffect(()=>{if(page==='gallery')setGalleryFocus(null)},[page])
  const [generations, setGenerations] = useState<Generation[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [galleryLoading, setGalleryLoading] = useState(false)
  const [galleryError, setGalleryError] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [connectOpen, setConnectOpen] = useState(false)
  const [disconnectError, setDisconnectError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const [query, setQuery] = useState('')
  const [download, setDownload] = useState<{ id: string; status: string; archiveUrl: string | null; error: string } | null>(null)
  const folderController = useRef<AbortController | null>(null)
  const folderHandle = useRef<Directory | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderRows, setFolderRows] = useState<{ id: string; status: string }[]>([])
  const [folderMessage, setFolderMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [cancelingIds, setCancelingIds] = useState<Set<string>>(new Set())
  const cancelRequests = useRef(new Map<string, AbortController>())
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const activeAccountId = useRef<string | null>(null)
  const sessionRequestId = useRef(0)

  const clearAccountView = useCallback(() => {
    cancelRequests.current.forEach(controller => controller.abort()); cancelRequests.current.clear(); setCancelingIds(new Set())
    folderController.current?.abort()
    folderController.current = null
    folderHandle.current = null
    setFolderBusy(false)
    setFolderRows([])
    setFolderMessage('')
    setUpscaleOutput(null)
    setBatchSelection(null)
    setCollectionOutput(null)
    setGalleryFocus(null)
    setTrainingFocus(null)
    setGenerations([])
    setSelected(new Set())
    setNextCursor(null)
    setDownload(null)
    setGalleryError('')
    setGalleryLoading(false)
    setBuzz(null)
    setBuzzLoading(false)
    setBuzzError('')
  }, [])

  const loadSession = useCallback(async () => {
    const requestId = ++sessionRequestId.current
    setSessionLoading(true)
    setSessionError('')
    try {
      const value = await studioApi.session()
      if (requestId !== sessionRequestId.current) return null
      const nextAccountId = value.connected ? value.user?.id ?? null : null
      if (activeAccountId.current !== nextAccountId) clearAccountView()
      activeAccountId.current = nextAccountId
      setSession(value)
      setCsrfToken(value.csrfToken)
      return value
    }
    catch (error) {
      if (requestId !== sessionRequestId.current) return null
      if (error instanceof ApiError && error.status === 401) {
        activeAccountId.current = null
        clearAccountView()
        setSession(null)
        setCsrfToken('')
        setSessionError('Session unavailable. Retry to check your connection.')
      } else {
        // An unavailable session service does not establish a logout/account change.
        // Abort writes, but retain the last confirmed identity and recovery state.
        folderController.current?.abort('session-unavailable')
        setSessionError(errorText(error))
      }
      return null
    } finally { if (requestId === sessionRequestId.current) setSessionLoading(false) }
  }, [clearAccountView])
  const loadBuzz = useCallback(async () => {
    if (!session?.connected || !session.user) return
    const accountId = session.user.id
    setBuzzLoading(true)
    setBuzzError('')
    try {
      const result = await studioApi.buzz()
      if (activeAccountId.current === accountId) setBuzz(result.balance)
    } catch (error) {
      if (activeAccountId.current === accountId) { setBuzz(null); setBuzzError(errorText(error)) }
    } finally {
      if (activeAccountId.current === accountId) setBuzzLoading(false)
    }
  }, [session])
  const loadGallery = useCallback(async () => {
    if (!session?.connected || !session.user) return
    const accountId = session.user.id
    setGalleryLoading(true)
    setGalleryError('')
    try {
      const page = await studioApi.generations()
      if (activeAccountId.current === accountId) { setGenerations(page.items); setNextCursor(page.nextCursor) }
    }
    catch (error) { if (activeAccountId.current === accountId) setGalleryError(errorText(error)) }
    finally { if (activeAccountId.current === accountId) setGalleryLoading(false) }
  }, [session])
  async function loadMore() {
    if (!nextCursor || !session?.connected || !session.user) return
    const accountId = session.user.id
    setGalleryLoading(true); setGalleryError('')
    try {
      const page = await studioApi.generations(nextCursor)
      if (activeAccountId.current === accountId) {
        setGenerations(current => [...new Map([...current, ...page.items].map(item => [item.id, item])).values()])
        setNextCursor(page.nextCursor)
      }
    }
    catch (error) { if (activeAccountId.current === accountId) setGalleryError(errorText(error)) }
    finally { if (activeAccountId.current === accountId) setGalleryLoading(false) }
  }

  useEffect(() => { void loadSession() }, [loadSession])
  useEffect(() => {
    const url = new URL(window.location.href)
    const code = url.searchParams.get('connectionError')
    if (!code) return
    const messages: Record<string, string> = {
      invalid_csrf: 'The connection form expired. Try connecting again.',
      oauth_unavailable: 'OAuth is not configured on this server. You can explicitly connect with your personal API key.',
      oauth_expired: 'This OAuth attempt expired or your account changed. Open Connect account and start again.',
      oauth_denied: 'Civitai authorization was declined. No API key fallback was attempted.',
      oauth_failed: 'Civitai connection could not be completed. Start a new connection attempt; tokens were not exposed.',
      invalid_key: 'Civitai did not accept that API key. Check it and try again.',
      rate_limited: 'Too many connection attempts. Try again later.',
      provider_unavailable: 'Civitai could not be reached. Try again shortly.',
    }
    setNotice({ kind: 'error', message: messages[code] ?? 'The Civitai connection could not be completed.' })
    url.searchParams.delete('connectionError')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])
  useEffect(() => { if (session) void loadGallery() }, [session, loadGallery])
  useEffect(() => {
    if (!session?.connected) return
    void loadBuzz()
    const timer = window.setInterval(() => { void loadBuzz() }, 60_000)
    return () => window.clearInterval(timer)
  }, [session, loadBuzz])
  const pendingGenerationIds = generations.filter(item => item.status === 'queued' || item.status === 'running').slice(0, 8).map(item => item.id).join('|')
  useEffect(() => {
    if (!pendingGenerationIds || !session?.connected || !session.user) return
    const accountId = session.user.id
    let active = true
    const poll = async () => {
      const results = await Promise.allSettled(pendingGenerationIds.split('|').map(id => studioApi.generation(id)))
      if (!active || activeAccountId.current !== accountId) return
      const updates = new Map(results.flatMap(result => result.status === 'fulfilled' ? [[result.value.generation.id, result.value.generation] as const] : []))
      if (updates.size) setGenerations(current => current.map(item => updates.get(item.id) ?? item))
    }
    const timer = window.setInterval(() => { void poll() }, 10_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [pendingGenerationIds, session?.connected, session?.user?.id])
  useEffect(() => {
    if (!download?.id || ['completed', 'partial', 'failed'].includes(download.status)) return
    let active = true
    const poll = async () => {
      try {
        const result = await studioApi.downloadStatus(download.id)
        if (active) setDownload({ id: result.download.id, status: result.download.status, archiveUrl: result.download.archiveUrl, error: result.download.items.find(x => x.error)?.error ?? '' })
      } catch (error) { if (active) setDownload(current => current ? { ...current, status: 'failed', error: errorText(error) } : current) }
    }
    const timer = window.setInterval(() => { void poll() }, 1800)
    void poll()
    return () => { active = false; window.clearInterval(timer) }
  }, [download?.id, download?.status])

  const filtered = useMemo(() => generations.filter(g => g.mediaType !== "training" && `${promptOf(g)} ${g.input.model ?? ''} ${g.input.engine ?? ''} ${JSON.stringify(g.input.parameters ?? {})}`.toLowerCase().includes(query.toLowerCase())), [generations, query])
  const grouped = useMemo(() => {
    const result = new Map<string, Generation[]>()
    for (const generation of filtered) {
      const key = galleryDate(generation)
      result.set(key, [...(result.get(key) ?? []), generation])
    }
    return [...result.entries()].sort(([a], [b]) => b.localeCompare(a))
  }, [filtered])
  const outputIds = useMemo(() => (page === 'gallery' ? filtered : page === 'generate' ? generations.filter(g=>g.mediaType!=='training').slice(0,9) : []).flatMap(g => g.outputs.filter(o => o.role !== 'thumbnail' && o.kind !== 'checkpoint').map(o => o.id)), [generations, filtered, page])
  const gallerySelected = useMemo(() => new Set([...selected].filter(id=>outputIds.includes(id))),[selected,outputIds])
  useEffect(() => { setSelected(current => { const next=new Set([...current].filter(id=>outputIds.includes(id))); return next.size===current.size?current:next }) },[outputIds])

  async function disconnect() {
    setDisconnecting(true); setDisconnectError(''); setNotice(null)
    try {
      await studioApi.disconnect()
      // Confirmed removal is authoritative even if the following session read fails.
      // Invalidate older reads so they cannot restore the disconnected account.
      sessionRequestId.current++
      setCsrfToken('')
      activeAccountId.current = null
      setSession(current => current ? { ...current, connected: false, user: null, credential: null, csrfToken: '', oauth: current.oauth ? { ...current.oauth, status: 'disconnected' } : undefined } : null)
      clearAccountView()
      await loadSession()
      setNotice({ kind: 'info', message: 'Civitai connection removed.' })
    }
    catch (error) { setDisconnectError(errorText(error)); setNotice({ kind: 'error', message: errorText(error) }) }
    finally { setDisconnecting(false) }
  }
  async function submitGeneration(previewId: string, recoveryGenerationId?: string) {
    if (!session?.connected) throw new Error('Connect your account before generating.')
    const accountId = session.user?.id ?? null
    setSubmitting(true); setNotice(null)
    try {
      const result = recoveryGenerationId ? await studioApi.retryGeneration(recoveryGenerationId, accountId ?? '') : await studioApi.submit(previewId, accountId ?? '')
      if (activeAccountId.current !== accountId) return
      setGenerations(current => [result.generation, ...current.filter(x => x.id !== result.generation.id)])
      void loadBuzz()
      setPage(result.generation.mediaType === 'training' ? 'training' : 'gallery')
      setNotice(result.generation.status === 'failed'
        ? { kind: 'error', message: result.generation.error ?? 'Civitai could not submit this generation.' }
        : { kind: 'info', message: 'Generation submitted. Its status will update as the provider responds.' })
    } catch (error) {
      if (activeAccountId.current !== accountId) return
      setNotice({ kind: 'error', message: errorText(error) })
      throw error
    }
    finally { setSubmitting(false) }
  }
  useEffect(() => () => { folderController.current?.abort() }, [])
  useEffect(() => {
    const refresh = () => { void loadSession() }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [loadSession])

  useEffect(() => {
    if (!folderBusy) return
    const timer = window.setInterval(() => { void loadSession() }, 3000)
    return () => window.clearInterval(timer)
  }, [folderBusy, loadSession])

  async function saveToFolder(ids: string[], retry = false) {
    ids = ids.filter(id=>outputIds.includes(id) || generations.some(g=>g.mediaType==='training' && g.outputs.some(o=>o.id===id && o.metadata?.available===true && ['checkpoint','training-sample'].includes(o.role ?? ''))))
    if(!ids.length)return
    if (folderController.current || !activeAccountId.current) return
    const accountId = activeAccountId.current
    const controller = new AbortController()
    folderController.current = controller
    setFolderBusy(true)
    setFolderMessage('Choose a destination folder.')
    const rows = retry ? folderRows.map(row => ids.includes(row.id) ? { ...row, status: 'pending' } : { ...row }) : ids.map(id => ({ id, status: 'pending' }))
    setFolderRows([...rows])
    const current = () => activeAccountId.current === accountId && folderController.current === controller
    try {
      const root = retry && folderHandle.current ? folderHandle.current : await chooseFolder()
      controller.signal.throwIfAborted()
      folderHandle.current = root
      setFolderMessage('Saving selected outputs…')
      for (let index = 0; index < rows.length; index++) {
        controller.signal.throwIfAborted()
        const row = rows[index]!
        if (!ids.includes(row.id)) continue
        try {
          // Recheck the account before each transfer, including changes in another tab.
          const sessionNow = await loadSession()
          controller.signal.throwIfAborted()
          if (!sessionNow?.connected || sessionNow.user?.id !== accountId || !current()) {
            controller.abort()
            controller.signal.throwIfAborted()
          }
          const result = await studioApi.download([row.id], 'files', controller.signal)
          const item = result.download.items[0]
          if (!item) throw new Error('No output manifest was returned.')
          row.status = await saveOutput(root, item, accountId, controller.signal, bytes => {
            if (current()) setFolderMessage(`Saving ${index + 1} of ${rows.length} · ${(bytes / 1048576).toFixed(1)} MB`)
          })
        } catch (error) {
          controller.signal.throwIfAborted()
          row.status = `Failed: ${errorText(error)}`
        }
        if (current()) setFolderRows(rows.map(row => ({ ...row })))
      }
      if (current()) setFolderMessage('Folder export finished. Saved files include metadata sidecars.')
    } catch (error) {
      if (current()) setFolderMessage(controller.signal.reason === 'session-unavailable' ? 'Folder export paused: session check unavailable. Retry unfinished outputs to revalidate your account and continue.' : controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError') ? 'Folder export canceled.' : errorText(error))
    } finally {
      if (current()) { folderController.current = null; setFolderBusy(false) }
    }
  }

  async function startDownload(ids: string[]) {
    ids = ids.filter(id=>outputIds.includes(id) || generations.some(g=>g.mediaType==='training' && g.outputs.some(o=>o.id===id && o.metadata?.available===true && ['checkpoint','training-sample'].includes(o.role ?? ''))))
    if(!ids.length)return
    if (!ids.length) return
    const accountId = activeAccountId.current
    setNotice(null); setDownload({ id: '', status: 'starting', archiveUrl: null, error: '' })
    try {
      const result = await studioApi.download(ids, 'zip')
      if (activeAccountId.current !== accountId) return
      setDownload({ id: result.download.id, status: result.download.status, archiveUrl: result.download.archiveUrl, error: result.download.items.find(item => item.error)?.error ?? '' })
    } catch (error) { if (activeAccountId.current === accountId) setDownload({ id: '', status: 'failed', archiveUrl: null, error: errorText(error) }) }
  }
  async function cancelWorkflow(id: string, action: 'cancel' | 'reconcile') {
    const accountId = activeAccountId.current
    if (!accountId || cancelRequests.current.has(id)) return
    const controller = new AbortController(); cancelRequests.current.set(id,controller)
    setCancelingIds(current => new Set([...current,id])); setNotice(null)
    try {
      const result = await studioApi.cancelGeneration(id,accountId,action,controller.signal)
      if (controller.signal.aborted || activeAccountId.current !== accountId) return
      setGenerations(current => current.map(item => item.id === id ? result.generation : item))
      setNotice({ kind: result.generation.cancellation?.state === 'uncertain' || result.generation.cancellation?.state === 'rejected' ? 'error' : 'info', message: result.generation.cancellation?.message ?? `Civitai reports ${result.generation.status}. No refund is promised.` })
      void loadBuzz()
    } catch (error) { if (!controller.signal.aborted && activeAccountId.current === accountId) setNotice({ kind: 'error', message: `${errorText(error)} Refresh workflow status before another cancellation attempt.` }) }
    finally {
      if (cancelRequests.current.get(id) === controller) { cancelRequests.current.delete(id); setCancelingIds(current => { const next = new Set(current); next.delete(id); return next }) }
    }
  }
  useEffect(() => () => cancelRequests.current.forEach(controller => controller.abort()), [])
  async function retryGeneration(id: string) {
    const accountId = activeAccountId.current
    setRetryingId(id); setNotice(null)
    try {
      const result = await studioApi.retryGeneration(id, accountId ?? '')
      if (activeAccountId.current !== accountId) return
      setGenerations(current => current.map(item => item.id === id ? result.generation : item))
      setNotice(result.generation.legacyRecovery?.state==='blocked'
        ? {kind:'info',message:result.generation.legacyRecovery.message}
        : result.generation.canRetry
        ? { kind: 'info', message: 'Civitai has not confirmed this submission yet. You can retry again with the same request ID.' }
        : { kind: 'info', message: 'Generation status recovered from Civitai.' })
    } catch (error) { if (activeAccountId.current === accountId) setNotice({ kind: 'error', message: errorText(error) }) }
    finally { setRetryingId(null) }
  }
  function toggleSelected(id: string) { setSelected(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next }) }
  function selectAll() { setSelected(new Set(outputIds)) }

  const reconnectRequired = session?.credential?.status === 'reconnect_required'
  const connectionOnline = Boolean(session?.connected && !reconnectRequired && !sessionError)
  const connectionLabel = sessionLoading ? 'Checking connection' : sessionError ? 'Connection unavailable' : reconnectRequired ? 'Reconnect needed' : session?.credential?.status === 'refreshing' ? 'Refreshing connection' : session?.connected ? 'Connected' : 'Not connected'

  return <div className="app-shell"><a className="skip-link" href="#workspace-content">Skip to workspace</a>
    <main className={`main-pane ${page === 'generate' ? 'generate-page' : ''}`}>
      <header className="topbar"><div className="header-brand"><Aperture size={24} aria-hidden="true" /><div><span>Civitai Studio</span><span className="header-connection"><i className={`connection-dot ${connectionOnline ? 'online' : ''}`} />{connectionLabel}</span></div></div><nav className="workspace-nav" aria-label="Workspace">{([{ id: 'generate', label: 'Generate', icon: WandSparkles }, { id: 'gallery', label: 'My generations', icon: ImageIcon }, { id: 'collections', label: 'Collections', icon: FolderHeart }, { id: 'training', label: 'LoRA training', icon: WandSparkles }, { id: 'settings', label: 'Settings', icon: Settings }] as const).map(item => <Button key={item.id} type="button" size="sm" variant="ghost" className={page === item.id ? 'workspace-nav-active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}><item.icon size={15} />{item.label}</Button>)}</nav><div className="top-actions"><div className="theme-switch" role="group" aria-label="Civitai color theme"><span className="theme-switch-label">Theme</span><Button type="button" variant="ghost" size="sm" aria-label="Civitai Blue theme" aria-pressed={theme === 'blue'} onClick={() => chooseTheme('blue')}>Blue</Button><Button type="button" variant="ghost" size="sm" aria-label="Civitai Red theme" aria-pressed={theme === 'red'} onClick={() => chooseTheme('red')}>Red</Button></div>{session?.connected && <Button variant="secondary" size="sm" className="buzz-button" onClick={() => void loadBuzz()} disabled={buzzLoading} aria-label={buzzError ? `Buzz balance unavailable: ${buzzError}. Retry` : buzz ? `Refresh Buzz balance: Blue ${buzz.blue.toLocaleString()}, Green ${buzz.green.toLocaleString()}, Yellow ${buzz.yellow.toLocaleString()}` : 'Refresh Buzz balance'} title={buzzError || (buzz ? `Blue ${buzz.blue.toLocaleString()} · Green ${buzz.green.toLocaleString()} · Yellow ${buzz.yellow.toLocaleString()}` : 'Refresh Buzz balance')}><Coins size={13} />{buzz ? <span className="header-buzz-pools">{(['blue','green','yellow'] as const).map(pool => <span key={pool} className={`buzz-pool buzz-${pool}`}><span>{pool[0]!.toUpperCase() + pool.slice(1)}</span><strong>{buzz[pool].toLocaleString()}</strong></span>)}</span> : buzzLoading ? 'Buzz…' : 'Buzz unavailable'}<RefreshCw size={11} className={buzzLoading ? 'spin' : ''} /></Button>}<Button type="button" variant="secondary" size="sm" className="account-button" onClick={() => { setDisconnectError(''); setConnectOpen(true) }}><LockKeyhole size={13} /><span>{reconnectRequired ? 'Reconnect' : session?.connected ? 'Account' : 'Connect account'}</span></Button></div></header>
      <div className="workspace" id="workspace-content" tabIndex={-1}>
        {page !== 'generate' && page !== 'settings' && <div className="page-heading"><h1>{page === 'gallery' ? 'My generations' : page === 'collections' ? 'Collections' : 'LoRA training'}</h1><p>{page === 'gallery' ? 'Review, organize, and save your creative work.' : page === 'collections' ? 'Keep your favorite work together and discover collections.' : 'Prepare a dataset, choose your settings, and review the cost.'}</p></div>}
        {notice && <div className={`workspace-notice ${notice.kind === 'error' ? 'error-box' : 'notice'} mb-4`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.kind === 'error' && <AlertCircle size={14} className="mr-2" />}{notice.message}</span><Button type="button" variant="ghost" size="icon" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></Button></div>}
        {sessionError && <div className="workspace-notice error-box mb-4" role="alert"><span><AlertCircle size={14} className="mr-2" />{sessionError}</span><Button type="button" variant="secondary" size="sm" disabled={sessionLoading} onClick={() => void loadSession()}>{sessionLoading ? 'Checking…' : 'Retry connection'}</Button></div>}
        <GenerationComposer browsing={browsing.settings} active={page === 'generate'} key={session?.connected ? session.user?.id : "offline"} accountId={session?.connected ? session.user?.id ?? null : null} connected={!!session?.connected} sessionLoading={sessionLoading} submitting={submitting} onSubmit={submitGeneration} />
        {page === 'generate' ? null : page === 'gallery' ? <Gallery onCreate={() => setPage('generate')} onConnect={() => setConnectOpen(true)} initialExpanded={galleryFocus} localSaveControl={localOutputs.settings?.enabled ? <Button type="button" variant="secondary" size="sm" disabled={localOutputs.busy} onClick={() => localOutputs.settings?.effectivePath ? void localOutputs.save([...gallerySelected]) : setPage('settings')}>{localOutputs.settings.effectivePath ? 'Save to configured folder' : 'Configure output folder'}</Button> : undefined} generations={filtered} loading={galleryLoading || sessionLoading} error={galleryError || (!session ? sessionError : '')} connected={!!session?.connected} onRefresh={() => void loadGallery()} onRetry={id => void retryGeneration(id)} retryingId={retryingId} onCancel={(id, action) => void cancelWorkflow(id, action)} cancelingIds={cancelingIds} onLoadMore={() => void loadMore()} hasMore={!!nextCursor} selected={gallerySelected} onToggle={toggleSelected} onClear={() => setSelected(new Set())} onVideoFinish={(generation, output, operation) => setUpscaleOutput({generation,output,operation})} onImageTo3D={(generation, output) => setUpscaleOutput({generation,output,operation:"imageTo3D"})} onAnimate={(generation, output) => setUpscaleOutput({generation,output,operation:"imageAnimation"})} onEdit={(generation, output) => setUpscaleOutput({generation,output,operation:"imageEdit"})} onRemoveBackground={(generation, output) => setUpscaleOutput({ generation, output, operation: "imageBackgroundRemoval" })} onUpscale={(generation, output) => setUpscaleOutput({ generation, output })} onBatch={items => setBatchSelection(items)} onCollection={(generation, output) => setCollectionOutput({ generation, output })} onSaveFolder={ids => void saveToFolder(ids)} folderBusy={folderBusy} onDownload={ids => void startDownload(ids)} onSelectAll={selectAll} query={query} setQuery={setQuery} groups={grouped} /> : page === 'settings' ? <SettingsPanel browsing={browsing} key={session?.connected ? session.user?.id : 'offline'} accountId={session?.connected ? session.user?.id ?? null : null} accountName={session?.user?.displayName} theme={theme} onTheme={chooseTheme} onAccount={() => setConnectOpen(true)} onGallery={() => setPage('gallery')} storage={localOutputs} /> : page === 'training' ? <TrainingPanel onConnect={() => setConnectOpen(true)} onSaveLocal={localOutputs.settings?.enabled && localOutputs.settings.effectivePath ? ids => void localOutputs.save(ids) : undefined} onSaveFolder={ids => void saveToFolder(ids)} onZip={ids => void startDownload(ids)} saveBusy={localOutputs.busy || folderBusy} key={session?.connected ? session.user?.id : 'offline'} accountId={session?.connected ? session.user?.id ?? null : null} runs={generations.filter(g=>g.mediaType==='training')} onSubmit={submitGeneration} onRefresh={() => void loadGallery()} onCancel={(id,action)=>void cancelWorkflow(id,action)} onRetry={id=>void retryGeneration(id)} cancelingIds={cancelingIds} hasMore={!!nextCursor} onLoadMore={()=>void loadMore()} /> : <CollectionsPanel onConnect={() => setConnectOpen(true)} key={session?.connected ? session.user?.id : "offline"} accountId={session?.connected ? session.user?.id ?? null : null} />}
        {(page === 'gallery' || page === 'settings' || page === 'training') && <LocalSaveProgress storage={localOutputs} />}
        {folderMessage && page !== 'generate' && <section className="panel-card p-4 mt-4" aria-label="Folder export"><p role="status" aria-live="polite">{folderMessage}</p><ul>{folderRows.map(row => <li key={row.id}>{row.id}: {row.status}</li>)}</ul>{folderBusy ? <Button variant="secondary" onClick={() => folderController.current?.abort()}>Cancel export</Button> : folderRows.some(row => row.status.startsWith('Failed:') || row.status === 'pending') && <Button variant="secondary" onClick={() => void saveToFolder(folderRows.filter(row => row.status.startsWith('Failed:') || row.status === 'pending').map(row => row.id), true)}>Retry unfinished outputs</Button>}</section>}
        {download && <div className="download-status panel-card" role="status" aria-live="polite"><div className="download-status-icon"><Download size={16} /></div><div className="download-status-body"><strong>{download.status === 'completed' || download.status === 'partial' ? 'Archive ready' : download.status === 'failed' ? 'Download could not be prepared' : 'Preparing date-organized archive'}</strong><span>{download.error || (download.status === 'completed' || download.status === 'partial' ? 'Entries are grouped by media category, then YYYY-MM-DD using UTC timestamps.' : 'You can keep browsing while the server gathers your files.')}</span></div>{download.archiveUrl && <a className="button button-primary" href={download.archiveUrl} download><ArrowDownToLine size={14} />Download ZIP</a>}<button className="quiet-close" aria-label="Dismiss download status" onClick={() => setDownload(null)}><X size={15} /></button></div>}
      </div>
      {page === 'generate' && <RecentFilmstrip generations={generations} connected={!!session?.connected} loading={galleryLoading||sessionLoading} error={galleryError} onConnect={() => setConnectOpen(true)} onRefresh={() => void loadGallery()} onTraining={id => { setTrainingFocus(id); setPage('training') }} onViewAll={() => { setQuery(''); setPage('gallery') }} onOpen={id=>{setQuery('');setGalleryFocus(id);setPage('gallery')}}/>}
      <footer className="status-bar"><div className="status-group"><span className={connectionOnline ? 'status-green' : ''}><i className={`connection-dot ${connectionOnline ? 'online' : ''}`} />{connectionLabel}</span><span><Clock3 size={11} className="mr-1" />Gallery folders use UTC</span></div><div className="status-group"><span>Studio API</span><span>{sessionLoading ? 'connecting…' : session ? 'ready' : sessionError ? 'unavailable' : 'awaiting connection'}</span></div></footer>
    </main>
    {upscaleOutput && session?.connected && session.user && <UpscaleDialog operation={upscaleOutput.operation} key={`${session.user.id}:${upscaleOutput.output.id}:${upscaleOutput.operation}`} accountId={session.user.id} generation={upscaleOutput.generation} output={upscaleOutput.output} onClose={() => setUpscaleOutput(null)} onSubmit={submitGeneration} />}
    {batchSelection && session?.connected && session.user && <BatchPostDialog key={session.user.id} accountId={session.user.id} selection={batchSelection} onClose={() => setBatchSelection(null)} onManage={() => { setBatchSelection(null); setPage("collections") }} />}
    {collectionOutput && session?.connected && session.user && <CollectionPostDialog key={`${session.user.id}:${collectionOutput.output.id}`} accountId={session.user.id} generation={collectionOutput.generation} output={collectionOutput.output} onClose={() => setCollectionOutput(null)} onManage={() => { setCollectionOutput(null); setPage('collections') }} />}
    <ConnectDialog connected={Boolean(session?.connected)} accountName={session?.user?.displayName} buzz={buzz} buzzLoading={buzzLoading} buzzError={buzzError} onRefreshBuzz={() => void loadBuzz()} onDisconnect={() => void disconnect()} disconnecting={disconnecting} disconnectError={disconnectError} oauth={session?.oauth} credential={session?.credential} credentialStorage={session?.credentialStorage} open={connectOpen} onOpenChange={setConnectOpen} csrfToken={session?.csrfToken ?? ''} />
  </div>
}

function Gallery({ onCreate, onConnect, initialExpanded, generations, loading, error, connected, onRefresh, onRetry, retryingId, onCancel, cancelingIds, onLoadMore, hasMore, selected, onToggle, onClear, onDownload, onSaveFolder, onCollection, onBatch, onUpscale, onRemoveBackground, onEdit, onAnimate, onImageTo3D, onVideoFinish, folderBusy, onSelectAll, query, setQuery, groups, localSaveControl }: {
  onCreate: () => void; onConnect: () => void; initialExpanded?:string|null; generations: Generation[]; loading: boolean; error: string; connected: boolean; onRefresh: () => void; onRetry: (id: string) => void; retryingId: string | null; onCancel: (id: string, action: 'cancel' | 'reconcile') => void; cancelingIds: Set<string>; onLoadMore?: () => void; hasMore?: boolean; selected: Set<string>; onToggle: (id: string) => void; onClear: () => void; onDownload: (ids: string[]) => void; onCollection: (generation: Generation, output: GenerationOutput) => void; onBatch: (items: BatchSelection[]) => void; onUpscale: (generation: Generation, output: GenerationOutput) => void; onImageTo3D: (generation: Generation, output: GenerationOutput) => void; onAnimate: (generation: Generation, output: GenerationOutput) => void; onEdit: (generation: Generation, output: GenerationOutput) => void; onRemoveBackground: (generation: Generation, output: GenerationOutput) => void; onVideoFinish: (generation:Generation,output:GenerationOutput,operation:'videoUpscaler'|'videoInterpolation'|'transcode')=>void; onSaveFolder: (ids: string[]) => void; folderBusy: boolean; onSelectAll: () => void; query: string; setQuery: (v: string) => void; groups?: [string, Generation[]][]; localSaveControl?: import('react').ReactNode
}) {
  const [expanded, setExpanded] = useState<string | null>(initialExpanded ?? null)
  const filmstripOrigin=useRef(initialExpanded ?? null)
  const restoreFilmstripFocus=useRef(false)
  const galleryHeading=useRef<HTMLHeadingElement|null>(null)
  const galleryTargets=useRef(new Map<string,HTMLButtonElement>())
  function closeDetail() {
    restoreFilmstripFocus.current=filmstripOrigin.current!==null
    setExpanded(null)
  }
  function closeDetailAutoFocus(event:Event) {
    const origin=filmstripOrigin.current
    filmstripOrigin.current=null
    if(!restoreFilmstripFocus.current||!origin)return
    restoreFilmstripFocus.current=false
    const tile=galleryTargets.current.get(origin)
    const target=tile?.isConnected?tile:galleryHeading.current
    if(target?.isConnected){event.preventDefault();target.focus()}
  }
  const visibleGroups = groups ?? [...generations.reduce((map, generation) => {
    const date = galleryDate(generation); map.set(date, [...(map.get(date) ?? []), generation]); return map
  }, new Map<string, Generation[]>()).entries()]
  const visibleOutputIds = generations.flatMap(g => g.outputs.filter(o => o.role !== 'thumbnail').map(o => o.id))
  const outputDetail = generations.flatMap(generation => generation.outputs.map(output => ({ generation, output }))).find(item => item.output.id === expanded)
  const detail = outputDetail ?? (generations.find(generation => generation.id === expanded) ? { generation: generations.find(generation => generation.id === expanded)!, output: null } : null)
  const batchOutputs = generations.filter(g=>(g.mediaType??'image')==='image').flatMap(generation=>generation.outputs.filter(output=>selected.has(output.id)&&output.role!=='thumbnail'&&(output.kind??'image')==='image'&&(!output.mimeType||['image/png','image/jpeg','image/gif','image/webp'].includes(output.mimeType))).map(output=>({generation,output})))
  const canBatch = selected.size>=2 && selected.size<=6 && batchOutputs.length===selected.size
  const singleCollectionOutput = selected.size === 1 ? generations.flatMap(generation => generation.outputs.map(output => ({ generation, output }))).find(item => selected.has(item.output.id) && item.output.role !== 'thumbnail' && (item.generation.mediaType ?? 'image') === 'image' && (item.output.kind ?? 'image') === 'image') : null
  const metadataDialog = <GalleryMetadataDialog onImageTo3D={() => { if (detail?.output) { setExpanded(null); onImageTo3D(detail.generation,detail.output) } }} onAnimate={() => { if (detail?.output) { setExpanded(null); onAnimate(detail.generation,detail.output) } }} onEdit={() => { if (detail?.output) { setExpanded(null); onEdit(detail.generation,detail.output) } }} onVideoFinish={operation=>{if(detail?.output){setExpanded(null);onVideoFinish(detail.generation,detail.output,operation)}}} onRemoveBackground={() => { if (detail?.output) { setExpanded(null); onRemoveBackground(detail.generation,detail.output) } }} onUpscale={() => { if (detail?.output) { setExpanded(null); onUpscale(detail.generation,detail.output) } }} generation={detail?.generation ?? null} output={detail?.output ?? null} onClose={closeDetail} onCloseAutoFocus={closeDetailAutoFocus} canceling={!!detail && cancelingIds.has(detail.generation.id)} onCancel={action => { if (detail) onCancel(detail.generation.id,action) }} />
  return <section className="panel-card gallery-panel">
    <div className="gallery-toolbar"><h2 ref={galleryHeading} tabIndex={-1} className="section-title m-0 mr-2"><ImageIcon size={15} className="section-icon" />My generations</h2><div className="search"><Search size={14} aria-hidden="true" /><Input aria-label="Search generations" placeholder="Search your work…" value={query} onChange={e => setQuery(e.target.value)} />{query && <Button type="button" variant="ghost" size="icon" className="search-clear" aria-label="Clear gallery search" onClick={() => setQuery('')}><X size={14} /></Button>}</div><Button type="button" variant="ghost" size="icon" aria-label={loading ? 'Refreshing gallery' : 'Refresh gallery'} onClick={onRefresh} disabled={!connected || loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /></Button></div>
    {selected.size > 0 && <div className="selection-bar"><span>{selected.size} selected</span>{localSaveControl}<Button variant="secondary" size="sm" onClick={() => onDownload([...selected])}><Download size={13} />Download ZIP</Button>{folderSavingSupported() ? <Button variant="secondary" size="sm" disabled={folderBusy} onClick={() => onSaveFolder([...selected])}>Save to folder</Button> : <span>Use Download ZIP to save dated folders in this browser.</span>}<Button variant="ghost" size="sm" onClick={onClear}>Clear</Button><Button type="button" variant="secondary" size="sm" disabled={!singleCollectionOutput} title="Choose one original generated image; only image posting is supported." onClick={() => { if (singleCollectionOutput) onCollection(singleCollectionOutput.generation, singleCollectionOutput.output) }}><FolderHeart size={13} />Add to collection</Button><Button variant="secondary" size="sm" disabled={!canBatch} title="Select 2-6 original PNG/JPEG/GIF/WebP images." onClick={()=>onBatch(batchOutputs)}>Post image set</Button></div>}
    <div className="gallery-controls"><span className="gallery-count"><ImageIcon size={12} />{generations.length} {generations.length === 1 ? 'generation' : 'generations'}</span><div className="control-actions"><span>{selected.size ? `${selected.size} outputs` : 'Grouped by date · UTC'}</span><Button variant="ghost" size="sm" disabled={!visibleOutputIds.length} onClick={onSelectAll}>Select all</Button><Button variant="ghost" size="sm" disabled={!connected} onClick={()=>onBatch([])}>Saved image sets</Button></div></div>
    {error && generations.length > 0 && <div className="error-box mb-3" role="status"><AlertCircle size={14} className="mr-2" />Refresh failed: {error}</div>}
    {loading && generations.length === 0 ? <div className="gallery-empty" role="status"><div className="empty-icon"><LoaderCircle size={22} className="spin" /></div><h3>Loading your generations…</h3><p>Gathering your latest images, videos, music, and 3D work.</p></div> : error && generations.length === 0 ? <div className="gallery-empty"><div className="empty-icon"><AlertCircle size={17} /></div><h3>Couldn’t load your gallery</h3><p>{error}</p><Button variant="secondary" size="sm" className="mt-3" onClick={onRefresh}>Try again</Button></div> : !connected ? <div className="gallery-empty"><div className="empty-icon"><LockKeyhole size={17} /></div><h3>Connect Civitai to see your gallery</h3><p>Your Studio history and available recent Civitai workflows appear here after you connect.</p><Button type="button" className="mt-4" onClick={onConnect}><LockKeyhole size={14} />Connect account</Button></div> : generations.length === 0 ? <div className="gallery-empty"><div className="empty-icon"><ImageIcon size={17} /></div><h3>{query.trim() ? 'No matching generations' : 'Your gallery is ready'}</h3><p>{query.trim() ? 'Try a different search or clear it to see your work.' : 'Images, videos, music, and 3D assets you create with Studio appear here. Recent Civitai workflows may also appear when your key has history access.'}</p>{query.trim() ? <Button type="button" variant="secondary" className="mt-4" onClick={() => setQuery('')}>Clear search</Button> : <Button type="button" className="mt-4" onClick={onCreate}><WandSparkles size={15} />Create your first generation</Button>}</div> : <div className="gallery-days">{visibleGroups.map(([date, items]) => <div className="gallery-day" key={date}><div className="day-heading"><Clock3 size={12} />{date}<span className="day-count">{items.length} generations · {items.reduce((n, g) => n + g.outputs.filter(o => o.role !== 'thumbnail').length, 0)} outputs</span></div><div className="media-grid">
      {items.filter(generation => generation.outputs.every(output => output.role === 'thumbnail')).map(generation => <article className="media-tile" key={generation.id}>
        <div className="media-preview"><div className="media-placeholder">{generation.status === 'queued' || generation.status === 'running' ? <LoaderCircle className="spin" size={20} /> : generation.status === 'failed' ? <AlertCircle size={20} /> : generation.mediaType === 'audio' ? <Music size={23} /> : generation.mediaType === 'video' ? <Film size={23} /> : generation.mediaType === 'model3d' ? <Box size={23} /> : <ImageIcon size={23} />}</div><span className={`media-status status-${generation.status}`}>{generation.status}</span></div>
        <div className="media-info"><div className="media-title" title={promptOf(generation)}>{promptOf(generation)}</div><div className="media-meta"><span>{new Date(generation.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span><span>{generation.cost ? `${generation.cost.estimated ? '≈' : ''}${generation.cost.amount} ${generation.cost.unit}` : generation.input.model || 'Civitai'}</span></div><div className="field-help">{generation.error ?? (generation.status === 'queued' || generation.status === 'running' ? 'Waiting for Civitai to return media.' : 'No downloadable output was returned.')}</div><Button ref={node=>{if(node)galleryTargets.current.set(generation.id,node);else galleryTargets.current.delete(generation.id)}} variant="ghost" size="sm" className="mt-2" onClick={() => setExpanded(generation.id)}>Details</Button>{generation.canRetry && <Button variant="secondary" size="sm" className="mt-2" disabled={retryingId === generation.id} onClick={() => onRetry(generation.id)}>{retryingId === generation.id ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />}Retry safely</Button>}<WorkflowCancellation generation={generation} busy={cancelingIds.has(generation.id)} onAction={action => onCancel(generation.id,action)} /></div>
      </article>)}
      {items.flatMap(generation => generation.outputs.filter(output => output.role !== 'thumbnail').map((output, index) => <article className="media-tile" key={output.id}>
      <button ref={node=>{if(node)galleryTargets.current.set(output.id,node);else galleryTargets.current.delete(output.id)}} className={`media-preview ${selected.has(output.id) ? 'is-selected' : ''}`} onClick={() => setExpanded(output.id)} aria-label={`Open ${output.kind ?? generation.mediaType ?? 'image'} output ${index + 1}: ${promptOf(generation)}`}>
        <GalleryOutputPreview generation={generation} output={output} />
        <span className="media-kind">{(output.kind ?? generation.mediaType) === 'model3d' ? '3D' : output.kind ?? generation.mediaType ?? 'image'}</span>
        <span className={`media-status status-${generation.status}`}>{generation.status}</span>
      </button>
      <button className={`media-select ${selected.has(output.id) ? 'selected' : ''}`} onClick={() => onToggle(output.id)} aria-pressed={selected.has(output.id)} aria-label={`${selected.has(output.id) ? 'Deselect' : 'Select'} output ${index + 1}: ${promptOf(generation)}`}>{selected.has(output.id) && <Check size={13} />}</button>
      <div className="media-info">{(output.kind ?? generation.mediaType) === 'audio' && <audio className="audio-player" src={`/api/studio/v1/generations/${encodeURIComponent(generation.id)}/outputs/${encodeURIComponent(output.id)}/content`} controls preload="none" aria-label={promptOf(generation) || 'Generated music'}/>}<div className="media-title" title={promptOf(generation)}>{promptOf(generation)}</div><div className="media-meta"><span>{new Date(generation.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span><span>{generation.cost ? `${generation.cost.estimated ? '≈' : ''}${generation.cost.amount} ${generation.cost.unit}` : generation.input.model || 'Civitai'}</span></div><div className="media-actions"><a className="button button-outline button-sm" href={`/api/studio/v1/generations/${encodeURIComponent(generation.id)}/outputs/${encodeURIComponent(output.id)}/content`} download><Download size={11} /> Save</a><Button variant="ghost" size="sm" onClick={() => setExpanded(output.id)}>Details</Button><Button type="button" variant="ghost" size="sm" disabled={(generation.mediaType ?? 'image') !== 'image' || (output.kind ?? 'image') !== 'image'} title="Collection posting supports original images only; audio, video and 3D are not supported." onClick={() => onCollection(generation, output)}><FolderHeart size={12} />Collect</Button>{(canFinishVideo(generation,output) || canUpscale(generation, output)) && <details className="media-more-actions"><summary>More actions</summary><div className="media-menu-actions">{canFinishVideo(generation,output) && <><Button variant="ghost" size="sm" onClick={()=>onVideoFinish(generation,output,"transcode")}>Resize / convert</Button><Button variant="ghost" size="sm" onClick={()=>onVideoFinish(generation,output,"videoUpscaler")}>Upscale video</Button><Button variant="ghost" size="sm" onClick={()=>onVideoFinish(generation,output,"videoInterpolation")}>Smooth video</Button></>}{canUpscale(generation, output) && <><Button variant="ghost" size="sm" onClick={() => onImageTo3D(generation,output)}>Image to 3D</Button><Button variant="ghost" size="sm" onClick={() => onAnimate(generation,output)}>Animate image</Button><Button variant="ghost" size="sm" onClick={() => onEdit(generation,output)}>Edit with prompt</Button><Button variant="ghost" size="sm" onClick={() => onUpscale(generation,output)}>Upscale</Button><Button variant="ghost" size="sm" onClick={() => onRemoveBackground(generation,output)}>Remove background</Button></>}</div></details>}</div>{((generation.mediaType ?? 'image') !== 'image' || (output.kind ?? 'image') !== 'image') && <p className="field-help">Collection posting supports original images only.</p>}<WorkflowCancellation generation={generation} busy={cancelingIds.has(generation.id)} onAction={action => onCancel(generation.id,action)} /></div>
    </article>))}</div></div>)}</div>}
    {<div className="gallery-footer"><span>Civitai history is limited to recent workflows when your key permits it.</span><span>{visibleOutputIds.length} outputs{hasMore && <Button variant="secondary" size="sm" className="ml-3" onClick={onLoadMore} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</Button>}</span></div>}
    {metadataDialog}
  </section>
}

function ConnectDialog({ open, onOpenChange, csrfToken, oauth, credential, credentialStorage, connected, accountName, buzz, buzzLoading, buzzError, onRefreshBuzz, onDisconnect, disconnecting, disconnectError }: { connected: boolean; accountName?: string; buzz: BuzzBalance | null; buzzLoading: boolean; buzzError: string; onRefreshBuzz: () => void; onDisconnect: () => void; disconnecting: boolean; disconnectError: string; open: boolean; onOpenChange: (v: boolean) => void; csrfToken: string; oauth?: AppSession["oauth"]; credential?: AppSession["credential"]; credentialStorage?: AppSession["credentialStorage"] }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="account-dialog">
    <DialogTitle>{connected ? 'Civitai account' : 'Connect your Civitai account'}</DialogTitle><DialogDescription>Connect with Civitai when available, or explicitly use your personal API key. Credentials stay on the Studio server.</DialogDescription>
    {connected && <section className="account-summary" aria-label="Connected account and Buzz balance"><strong>{accountName || 'Civitai account connected'}</strong>{buzz ? <dl className="account-buzz">{(['blue','green','yellow'] as const).map(pool => <div key={pool}><dt>{pool[0]!.toUpperCase() + pool.slice(1)} Buzz</dt><dd>{buzz[pool].toLocaleString()}</dd></div>)}</dl> : <p role="status">{buzzLoading ? 'Loading balance…' : buzzError || 'Balance unavailable'}</p>}{buzz && buzzError && <p role="alert">{buzzError}</p>}<div className="account-actions"><Button type="button" variant="secondary" size="sm" onClick={onRefreshBuzz} disabled={buzzLoading || disconnecting}>Refresh balance</Button><Button type="button" variant="destructive" size="sm" onClick={onDisconnect} disabled={disconnecting}><LogOut size={14} />{disconnecting ? 'Disconnecting…' : 'Disconnect Civitai'}</Button></div></section>}
    {disconnectError && <p role="alert" className="error-box">{disconnectError}</p>}
    {credential && <p>Connection: {credential.kind === 'oauth' ? 'Civitai OAuth' : 'personal API key'} ({credential.status}). Granted scope mask: {credential.grantedScopes ?? "Not supplied by Civitai"}.</p>}
    <p className="notice" role="status">{!credentialStorage ? 'Credential storage status is unavailable.' : credentialStorage.persistent ? 'API keys are encrypted on this server, stored separately for each account, and retained across server restarts.' : credentialStorage.mode === 'encrypted' ? 'API keys are encrypted in temporary server storage. Reconnect after the server restarts.' : 'API keys are kept only in server memory for this local session. Reconnect after the server restarts.'}</p>
    {credential?.status === 'reconnect_required' && <p className="error-box">This connection is unavailable. Reconnect your Civitai account to continue.</p>}
    {oauth?.enabled && <form method="post" action="/api/studio/v1/civitai/oauth/start"><input type="hidden" name="csrfToken" value={csrfToken} /><Button type="submit" disabled={!csrfToken}>Connect with Civitai</Button><p className="field-help">Authorize profile, resource and media access, generation/training, Buzz balance and collection management. Generation can spend your Buzz after Studio's cost confirmation. Collection OAuth compatibility has not been verified live.</p></form>}
    <form method="post" action="/api/studio/v1/civitai/key"><input type="hidden" name="csrfToken" value={csrfToken} /><label className="field-label" htmlFor="civitai-key">Civitai API key</label><Input id="civitai-key" name="apiKey" type="password" autoComplete="off" placeholder="Paste your API key" required /><div className="field-help">The server validates this key and then redirects back to Studio. The key never enters React state or browser storage.</div><div className="dialog-actions"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={!csrfToken}><LockKeyhole size={14} />{csrfToken ? 'Connect securely' : 'Loading secure form…'}</Button></div></form>
  </DialogContent></Dialog>
}
