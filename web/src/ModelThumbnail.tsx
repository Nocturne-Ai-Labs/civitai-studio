import { useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import type { ModelVersion } from '../../shared/composer'

// Callers pass only previews returned by the server's browsing-policy filter.
// Video-only and failed previews use the same quiet placeholder.
export function ModelThumbnail({ image, label, className='' }: { image?:ModelVersion['images'][number]; label:string; className?:string }) {
  const [failedUrl,setFailedUrl]=useState<string|null>(null)
  const url=image?.type==='image'?image.url:undefined
  return <div className={`model-thumbnail ${className}`}>
    {url&&failedUrl!==url?<img src={url} alt={`${label} preview`} loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailedUrl(url)}/>:<span role="img" aria-label={`No preview for ${label}`}><ImageIcon size={24}/></span>}
  </div>
}
