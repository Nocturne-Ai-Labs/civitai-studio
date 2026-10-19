import { WorkflowOptionsFields } from './WorkflowControls'
import { Select } from './controls'
import { useEffect, useRef, useState } from 'react'
import type { GenerationPreview, WorkflowOptions } from '../../shared/quotes'
import { ApiError, studioApi, type Generation, type GenerationOutput } from './api'
import { GenerationReview } from './GenerationReview'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Textarea } from './ui'

export const canUpscale = (generation: Generation, output: GenerationOutput) => generation.mediaType === 'image' && output.kind === 'image' && output.role !== 'thumbnail' && !!generation.providerWorkflowId && !generation.canRetry

export const canFinishVideo = (generation: Generation, output: GenerationOutput) => generation.mediaType === 'video' && output.kind === 'video' && output.role !== 'thumbnail' && !!generation.providerWorkflowId && !generation.canRetry
export function UpscaleDialog({ accountId, generation, output, onClose, onSubmit, operation = 'imageUpscaler' }: { operation?: 'imageUpscaler' | 'imageBackgroundRemoval' | 'imageEdit' | 'imageAnimation' | 'imageTo3D' | 'transcode' | 'videoUpscaler' | 'videoInterpolation'; accountId: string; generation: Generation; output: GenerationOutput; onClose: () => void; onSubmit: (id: string, recoveryId?: string) => Promise<void> }) {
  const [options,setOptions] = useState<WorkflowOptions>({tips:{creators:0,civitai:0},priority:'normal'})
  const transcoding = operation === 'transcode'
  const knownWidth = typeof output.metadata.width === 'number' && output.metadata.width > 0 ? output.metadata.width : null
  const [targetWidth,setTargetWidth] = useState(Math.max(2,Math.floor(Math.min(1280,knownWidth ?? 1280)/2)*2))
  const [containerFormat,setContainerFormat] = useState<'mp4'|'webM'>('mp4')
  const modeling = operation === 'imageTo3D'
  const [shouldTexture,setShouldTexture] = useState(true)
  const animating = operation === 'imageAnimation'
  const [duration,setDuration] = useState<'5'|'10'>('5')
  const [aspectRatio,setAspectRatio] = useState<'16:9'|'9:16'|'1:1'>('16:9')
  const editing = operation === 'imageEdit'
  const [prompt, setPrompt] = useState('')
  const video = operation === 'videoUpscaler' || operation === 'videoInterpolation'
  const [factor,setFactor] = useState(2)
  const removing = operation === 'imageBackgroundRemoval'
  const [format, setFormat] = useState<'png' | 'webp'>('png')
  const [passes, setPasses] = useState(1)
  const [model, setModel] = useState('')
  const [quote, setQuote] = useState<GenerationPreview | null>(null)
  const quoteRef = useRef<GenerationPreview | null>(null)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const [recoveryId, setRecoveryId] = useState<string>()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { mounted.current = true; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => { mounted.current = false; clearInterval(timer); controller.current?.abort(); if (quoteRef.current) void studioApi.discardPreview(quoteRef.current.id, accountId).catch(() => {}) } }, [accountId])
  function clearQuote() { if (quoteRef.current) void studioApi.discardPreview(quoteRef.current.id, accountId).catch(() => {}); quoteRef.current = null; setQuote(null) }
  async function preview() {
    if (busy || confirming || recoveryRequired) return
    if (!video && !animating && !transcoding && Object.values(options.tips).some(value=>!Number.isFinite(value)||value<0||value>2)) { setError('Choose tip percentages from 0 to 200.'); return }
    clearQuote(); setBusy(true); setError(''); setAttempted(false); setBlocked(false)
    const request = new AbortController(); controller.current = request
    try {
      const result = transcoding ? await studioApi.previewTranscode({recipe:'transcode',sourceGenerationId:generation.id,sourceOutputId:output.id,width:targetWidth,containerFormat},accountId,request.signal) : modeling ? await studioApi.previewImageTo3D({recipe:'imageTo3D',options,sourceGenerationId:generation.id,sourceOutputId:output.id,shouldTexture},accountId,request.signal) : animating ? await studioApi.previewImageAnimation({recipe:'imageAnimation',sourceGenerationId:generation.id,sourceOutputId:output.id,prompt,duration,aspectRatio},accountId,request.signal) : editing ? await studioApi.previewImageEdit({recipe:'imageEdit',options,sourceGenerationId:generation.id,sourceOutputId:output.id,prompt},accountId,request.signal) : video ? await studioApi.previewVideoFinishing({recipe:operation,sourceGenerationId:generation.id,sourceOutputId:output.id,...(operation==='videoUpscaler'?{scaleFactor:factor}:{interpolationFactor:factor})},accountId,request.signal) : removing ? await studioApi.previewBackgroundRemoval({ recipe: 'imageBackgroundRemoval', options, sourceGenerationId: generation.id, sourceOutputId: output.id, format }, accountId, request.signal) : await studioApi.previewUpscale({ recipe: 'imageUpscaler', options, sourceGenerationId: generation.id, sourceOutputId: output.id, numberOfRepeats: passes, ...(model.trim() ? { model: model.trim() } : {}) }, accountId, request.signal)
      if (!mounted.current || request.signal.aborted) { void studioApi.discardPreview(result.preview.id, accountId).catch(() => {}); return }
      quoteRef.current = result.preview; setQuote(result.preview)
    } catch (failure) { if (mounted.current && !request.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not prepare preview.') }
    finally { if (mounted.current) setBusy(false) }
  }
  async function confirm() {
    if (!quote || confirming) return
    setConfirming(true); setAttempted(true); setError('')
    try { await onSubmit(quote.id, recoveryId); if (mounted.current) onClose() }
    catch (failure) {
      if (!mounted.current) return
      setError(failure instanceof Error ? failure.message : 'Confirmation could not be completed.')
      if (failure instanceof ApiError && failure.code === 'recovery_required') { setRecoveryRequired(true); setBlocked(false); setRecoveryId(failure.recoveryGenerationId) }
      else if (!recoveryRequired && failure instanceof ApiError && ['preview_required', 'preview_changed', 'invalid_input', 'insufficient_scope', 'provider_rejected', 'provider_rate_limited', 'unauthenticated'].includes(failure.code ?? '')) setBlocked(true)
    } finally { if (mounted.current) setConfirming(false) }
  }
  if (quote) return <GenerationReview preview={quote} expired={now >= Date.parse(quote.expiresAt)} confirming={confirming} attempted={attempted} error={error} blocked={blocked} recoveryRequired={recoveryRequired} onClose={() => { if (recoveryRequired) onClose(); else { clearQuote(); setError('') } }} onConfirm={() => void confirm()} onRefresh={() => void preview()} />
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent><DialogTitle>{transcoding ? "Resize / convert video" : modeling ? "Image to 3D" : animating ? "Animate image" : editing ? "Edit with prompt" : video ? operation === "videoUpscaler" ? "Upscale video" : "Smooth video" : removing ? "Remove background" : "Upscale image"}</DialogTitle><DialogDescription>Review the source and settings, then preview the Buzz cost.</DialogDescription>
    {(video || transcoding) ? <video controls preload="metadata" style={{maxHeight:240,maxWidth:"100%"}} src={`/api/studio/v1/generations/${encodeURIComponent(generation.id)}/outputs/${encodeURIComponent(output.id)}/content`} /> : <img style={{ maxHeight: 240, maxWidth: "100%", objectFit: "contain" }} src={`/api/studio/v1/generations/${encodeURIComponent(generation.id)}/outputs/${encodeURIComponent(output.id)}/content`} alt="Original image selected for processing" />}
    <p>{generation.input.prompt || 'Generated image'}</p><p className="field-help">Source output: {output.id}</p>
    {transcoding ? <div className="field"><label className="label" htmlFor="transcode-width">Output width (pixels)</label><Input id="transcode-width" type="number" min={2} max={Math.min(2048,knownWidth ?? 2048)} step={2} value={targetWidth} disabled={busy} onChange={event=>setTargetWidth(Number(event.target.value))} /><Select label="Container" value={containerFormat} onChange={value=>setContainerFormat(value as 'mp4'|'webM')} disabled={busy} options={[{value:'mp4',label:'MP4'},{value:'webM',label:'WebM'}]} /><p className="field-help">Source width: {knownWidth ?? 'not supplied; Studio will refresh it before preview'}. Choose an even width up to 2048, no larger than the original. Studio blocks resizing if the refreshed source width is unavailable. The provider controls codec and resulting height; check both dimensions before upscaling or smoothing. The original stays in your gallery.</p><p className="field-help">Pricing comes from Civitai’s preview. No fixed charge or free conversion is assumed.</p></div> : modeling ? <div className="field"><Select label="Model surface" value={shouldTexture?'textured':'bare'} onChange={value=>setShouldTexture(value==='textured')} disabled={busy} options={[{value:'textured',label:'Textured model'},{value:'bare',label:'Bare mesh'}]} /><p className="field-help">Meshy v6 · 30,000 target polygons · triangle topology · automatic symmetry · remeshing enabled. PBR, rigging and animation are off. Creates a separate 3D model and preserves the original image. Civitai validates the source; payment and content policy use provider defaults.</p></div> : animating ? <div className="field"><label className="label" htmlFor="image-animation-prompt">Describe the motion</label><Textarea id="image-animation-prompt" value={prompt} maxLength={1000} disabled={busy} placeholder="The subject slowly turns toward the camera" onChange={event => setPrompt(event.target.value)} /><Select label="Duration" value={duration} onChange={value=>setDuration(value as '5'|'10')} disabled={busy} options={[{value:'5',label:'5 seconds'},{value:'10',label:'10 seconds'}]} /><Select label="Aspect ratio" value={aspectRatio} onChange={value=>setAspectRatio(value as '16:9'|'9:16'|'1:1')} disabled={busy} options={['16:9','9:16','1:1'].map(value=>({value,label:value}))} /><p className="field-help">Kling v1.6 · Standard · guidance 0.5. Creates a new video from this image; the original stays in your gallery. Civitai validates the source and output options. Payment and content policy use provider defaults.</p></div> : editing ? <div className="field"><label className="label" htmlFor="image-edit-prompt">Describe your edit</label><Textarea id="image-edit-prompt" value={prompt} maxLength={1000} disabled={busy} placeholder="Make it daytime with a clear blue sky" onChange={event => setPrompt(event.target.value)} /><p className="field-help">Flux.1 Kontext Pro · one reference · one new image · square (1:1) · guidance 3.5. The original stays in your gallery. Payment and content policy use provider defaults.</p></div> : video ? <div className="field"><Select label={operation==='videoUpscaler'?'Scale factor':'Interpolation factor'} value={String(factor)} onChange={value=>setFactor(Number(value))} disabled={busy} options={(operation==='videoUpscaler'?[2,3,4]:[2,3]).map(value=>({value:String(value),label:`${value}x`}))} /><p className="field-help">{operation==='videoUpscaler'?'Upscaling output cannot exceed 2560 pixels on either side.':'Smoothing accepts a source up to 2048 pixels on either side.'}</p><p>Source dimensions: {typeof output.metadata.width==='number'&&typeof output.metadata.height==='number'?`${output.metadata.width} x ${output.metadata.height}`:'Not supplied; Civitai will validate size during preview/submission.'}</p><p className="field-help">Civitai validates source size and codec support. Studio does not transcode the source or promise an output codec. Payment/content policy use provider defaults.</p></div> : removing ? <div className="field"><Select label="Transparent output format" value={format} onChange={value => setFormat(value as "png" | "webp")} disabled={busy} options={[{ value:"png",label:"PNG (default)" },{ value:"webp",label:"WebP" }]} /><p className="field-help">Both formats preserve transparency. Original downloads retain the provider bytes. Payment and content policy use provider defaults.</p></div> : <>
    <div className="field"><label className="label" htmlFor="upscale-passes">Passes (1–3)</label><Input id="upscale-passes" type="number" min={1} max={3} step={1} value={passes} disabled={busy} onChange={event => setPasses(Number(event.target.value))} /></div>
    <div className="field"><label className="label" htmlFor="upscale-model">Optional upscaler AIR</label><Input id="upscale-model" value={model} maxLength={250} disabled={busy} placeholder="Leave blank for 4x-Remacri" onChange={event => setModel(event.target.value)} /></div>
    <p className="field-help">The provider default is 4x-Remacri. Additional passes compound scaling; Civitai validates the model and output limits. Payment and content policy use provider defaults.</p></>}
    {!video && !animating && !transcoding && <fieldset disabled={busy}><WorkflowOptionsFields value={options} onChange={setOptions}/></fieldset>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="composer-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy || (transcoding && (!Number.isInteger(targetWidth) || targetWidth < 2 || targetWidth > 2048 || targetWidth % 2 !== 0 || (knownWidth !== null && targetWidth > knownWidth))) || ((editing || animating) && (!prompt.trim() || prompt.length > 1000)) || (!transcoding && !modeling && !animating && !editing && !video && !removing && (!Number.isInteger(passes) || passes < 1 || passes > 3))} onClick={() => void preview()}>{busy ? 'Preparing preview…' : 'Preview Buzz cost'}</Button></div>
  </DialogContent></Dialog>
}
