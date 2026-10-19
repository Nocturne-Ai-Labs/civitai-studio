import { canUpscale, canFinishVideo } from './UpscaleDialog'
import { WorkflowCancellation } from './WorkflowCancellation'
import { ArrowDownToLine, Box, Film, Image as ImageIcon, Music, X } from 'lucide-react'
import type { Generation, GenerationOutput } from './api'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from './ui'

const show = (value: unknown) => value === undefined || value === null || value === '' ? '—' : String(value)
const formatDate = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—'

export function GalleryMetadataDialog({ generation, output, onClose, onCloseAutoFocus, canceling, onCancel, onUpscale, onRemoveBackground, onEdit, onAnimate, onImageTo3D, onVideoFinish }: { onImageTo3D: () => void; onAnimate: () => void; onEdit: () => void; onVideoFinish:(operation:'videoUpscaler'|'videoInterpolation'|'transcode')=>void; onRemoveBackground: () => void; onUpscale: () => void; generation: Generation | null; output: GenerationOutput | null; onClose: () => void; onCloseAutoFocus?: (event:Event)=>void; canceling: boolean; onCancel: (action: 'cancel' | 'reconcile') => void }) {
  const kind = output?.kind ?? generation?.mediaType ?? 'image'
  const preview = kind === 'model3d' ? (output?.previewUrl !== output?.url && !/\.(?:glb|gltf|obj|fbx)(?:[?#]|$)/i.test(output?.previewUrl ?? '') ? output?.previewUrl : null) : kind === 'image' ? output?.previewUrl ?? output?.url : null
  const videoPoster = kind === 'video' && output?.previewUrl && (output.previewUrl !== output.url || /\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(output.previewUrl)) ? output.previewUrl : undefined
  const parameters = generation?.input.parameters ?? {}
  const contentUrl = generation && output ? `/api/studio/v1/generations/${encodeURIComponent(generation.id)}/outputs/${encodeURIComponent(output.id)}/content` : ''
  const rows: [string, unknown][] = [
    ['Source generation', parameters.sourceGenerationId],
    ['Source output', parameters.sourceOutputId],
    ['Video scale factor', parameters.scaleFactor],
    ['Interpolation factor', parameters.interpolationFactor],
    ['Upscale passes', parameters.numberOfRepeats],
    ['Medium', kind === 'model3d' ? '3D model' : kind],
    ['Engine', generation?.input.engine ?? parameters.engine],
    ['Model', generation?.input.model ?? parameters.model],
    ['Ecosystem', parameters.ecosystem],
    ['Operation', parameters.operation],
    ['Seed', parameters.seed],
    ['Steps', parameters.steps ?? parameters.numInferenceSteps],
    ['CFG / guidance', parameters.cfgScale ?? parameters.guidanceScale ?? parameters.cfg],
    ['Tempo (BPM)', parameters.bpm],
    ['Key', parameters.key],
    ['Language', parameters.language],
    ['Time signature', parameters.timeSignature],
    ['Vocal weight', parameters.vocalWeight],
    ['Instrumental weight', parameters.instrumentalWeight],
    ['Sampler', parameters.sampleMethod ?? parameters.sampler],
    ['Scheduler', parameters.schedule ?? parameters.scheduler],
    ['Dimensions', parameters.width && parameters.height ? `${parameters.width} × ${parameters.height}` : output?.metadata.width && output.metadata.height ? `${output.metadata.width} × ${output.metadata.height}` : null],
    ['Duration', output?.metadata.duration ? `${output.metadata.duration} seconds` : parameters.duration],
    ['Format', parameters.containerFormat ?? parameters.format ?? output?.metadata.format ?? output?.mimeType],
    ['Requested width', parameters.engine === 'transcode' ? parameters.width : null],
    ['Quantity', parameters.quantity],
    ['Aspect ratio', parameters.aspectRatio],
    ['Mode', parameters.mode],
    ['Model version', parameters.version],
    ['Textures', parameters.shouldTexture],
    ['Target polygons', parameters.targetPolycount],
    ['Topology', parameters.topology],
    ['Cost', generation?.cost ? `${generation.cost.estimated ? '≈' : ''}${generation.cost.amount} ${generation.cost.unit}` : null],
    ['Created', formatDate(generation?.createdAt)],
    ['Completed', formatDate(generation?.completedAt)],
    ['Output timestamp', formatDate(output?.createdAt)],
    ['Workflow ID', generation?.providerWorkflowId],
    ['Output ID', output?.id],
    ['Asset role', output?.role],
  ]
  return <Dialog open={!!generation} onOpenChange={open => { if (!open) onClose() }}><DialogContent className="metadata-dialog" showCloseButton={false} onCloseAutoFocus={onCloseAutoFocus}>
    <div className="metadata-heading"><div><DialogTitle>Generation details</DialogTitle><DialogDescription>{output ? `Provider metadata for this ${kind === 'model3d' ? '3D model' : kind} output.` : 'Settings and status for this generation.'}</DialogDescription></div><Button type="button" variant="ghost" size="icon" aria-label="Close details" onClick={onClose}><X size={16} /></Button></div>
    <div className="metadata-layout">
      <div className="metadata-preview">{kind === 'audio' ? <div className="audio-detail"><Music size={50}/>{contentUrl && <audio className="audio-player" src={contentUrl} controls preload="none" aria-label="Generated music"/>}</div> : kind === 'video' && contentUrl ? <video src={contentUrl} poster={videoPoster} controls preload="metadata" aria-label="Generated video" /> : preview ? <img src={preview} alt={generation?.input.prompt || 'Generated output'} /> : kind === 'model3d' ? <Box size={50} /> : kind === 'video' ? <Film size={50} /> : <ImageIcon size={50} />}</div>
      <div className="metadata-content">
        <div className="metadata-status"><span className={`media-status status-${generation?.status}`}>{generation?.status}</span>{contentUrl && <a className="button button-secondary button-sm" href={contentUrl} download><ArrowDownToLine size={13} />Save original</a>}</div>
        <div className="metadata-output-actions">
        {generation && output && canFinishVideo(generation,output) && <><Button variant="secondary" onClick={()=>onVideoFinish("transcode")}>Resize / convert</Button><Button variant="secondary" onClick={()=>onVideoFinish("videoUpscaler")}>Upscale video</Button><Button variant="secondary" onClick={()=>onVideoFinish("videoInterpolation")}>Smooth video</Button></>}
        {generation && output && canUpscale(generation,output) && <><Button variant="secondary" onClick={onImageTo3D}>Image to 3D</Button><Button variant="secondary" onClick={onAnimate}>Animate image</Button><Button variant="secondary" onClick={onEdit}>Edit with prompt</Button><Button variant="secondary" onClick={onUpscale}>Upscale</Button><Button variant="secondary" onClick={onRemoveBackground}>Remove background</Button></>}
        </div>
        {generation && <WorkflowCancellation generation={generation} busy={canceling} onAction={onCancel} />}
        <section><h3>{kind === 'audio' ? 'Music description' : 'Prompt'}</h3><p className="metadata-prompt">{show(generation?.input.prompt)}</p></section>
        {kind === 'audio' && <section><h3>Lyrics</h3><p className="metadata-prompt">{parameters.vocalWeight === 0 || parameters.instrumental === true ? 'Instrumental' : show(parameters.lyrics)}</p></section>}
        {generation?.input.negativePrompt && <section><h3>Negative prompt</h3><p className="metadata-prompt">{generation.input.negativePrompt}</p></section>}
        <section><h3>Generation parameters</h3><dl className="metadata-rows">{rows.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{show(value)}</dd></div>)}</dl></section>
        <details><summary>Full provider input</summary><pre>{JSON.stringify(parameters, null, 2)}</pre></details>
        <details><summary>Output metadata</summary><pre>{JSON.stringify(output?.metadata ?? {}, null, 2)}</pre></details>
      </div>
    </div>
  </DialogContent></Dialog>
}
