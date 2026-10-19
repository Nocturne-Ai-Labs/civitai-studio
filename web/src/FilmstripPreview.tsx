import type { ReactElement } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Box, Film, Image as ImageIcon, Music } from 'lucide-react'
import type { Generation, GenerationOutput } from './api'

export function FilmstripPreview({ generation, output, label, children }: {
  generation: Generation; output: GenerationOutput | null; label: string; children: ReactElement
}) {
  const kind = output?.kind ?? (generation.mediaType === 'training' ? output?.mimeType?.startsWith('video/') ? 'video' : 'image' : generation.mediaType)
  const image = kind === 'model3d' ? (output?.previewUrl !== output?.url ? output?.previewUrl : null) : output?.previewUrl ?? output?.url
  const poster = kind === 'video' && output?.previewUrl && (output.previewUrl !== output.url || /\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(output.previewUrl)) ? output.previewUrl : undefined
  const original = output?.url ? `/api/studio/v1/generations/${encodeURIComponent(generation.id)}/outputs/${encodeURIComponent(output.id)}/content` : null
  return <Tooltip.Root delayDuration={180}>
    <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content className="filmstrip-hover-preview" side="top" sideOffset={12} collisionPadding={12} hideWhenDetached aria-label={`${label} preview`}>
      <div className="filmstrip-hover-media">{kind === 'video' && original ? <video src={original} poster={poster} autoPlay loop muted playsInline preload="none" aria-label="Muted video preview" /> : (kind === 'image' || kind === 'model3d') && image ? <img src={image} alt="" /> : kind === 'audio' ? <Music size={56} /> : kind === 'model3d' ? <Box size={56} /> : kind === 'video' ? <Film size={56} /> : <ImageIcon size={56} />}</div>
      <div className="filmstrip-hover-caption"><strong>{label}</strong><span>{generation.input?.prompt || 'Generated media'}</span><small>{kind === 'video' ? 'Muted preview · Open for playback controls' : 'Open for details'}</small></div>
    </Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root>
}
