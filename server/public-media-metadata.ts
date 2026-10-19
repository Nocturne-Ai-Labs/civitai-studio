import { locatorText } from './video-input'

const safeMediaNames=new Set(['mediaType','type','kind','mime','mimeType','width','height','duration','frameRate','fps','numFrames','quantity','generateAudio','enableAudio','keepAudio','enableBackgroundMusic','audioSetting','imageGuideStrength','frameGuideStrength','audioToVideoAttentionScale','sourceGenerationId','sourceOutputId','generationId','outputId','sourceIds'])
const privateName=/token|secret|password|authorization|cookie|api.?key|signature|blobId/i
const mediaName=/source|reference|image|video|audio|frame|url|uri|blob|cover|draftCache|keyframes|elements|voiceIds/i
const refKeys=new Set(['id','revision','kind','type','label','mime','size','width','height','duration','expiresAt','origin','generationId','outputId'])

// Public/export projection only: never mutate private original/recovery records.
export function publicMediaMetadata(value:unknown):any {
  let remaining=2000
  function clean(item:unknown,path:string,depth:number):unknown {
    if(--remaining<0||depth>12)return undefined
    if(typeof item==='string'){
      const prose=/^(?:parameters\.)?(?:prompt|negativePrompt|musicDescription|caption|lyrics|multiPrompt\.\d+\.prompt)$/.test(path)
      return prose?item.slice(0,10000):locatorText(item)?undefined:item.slice(0,10000)
    }
    if(item===null||typeof item==='boolean')return item
    if(typeof item==='number')return Number.isFinite(item)?item:undefined
    if(Array.isArray(item))return item.slice(0,100).map((v,i)=>clean(v,`${path}.${i}`,depth+1)).filter(v=>v!==undefined)
    if(!item||typeof item!=='object')return undefined
    const result:Record<string,unknown>={}
    for(const [key,v] of Object.entries(item)){
      if(key==='timeSignature' && typeof v==='string' && ['2','3','4','6'].includes(v)){result[key]=v;continue}
      if(['__proto__','prototype','constructor'].includes(key)||privateName.test(key)||locatorText(key))continue
      if(key==='sources'){
        // Registered provenance is safe only as a bounded, explicitly projected
        // opaque reference. No arbitrary media object is copied through here.
        if(Array.isArray(v))result.sources=v.slice(0,9).flatMap(ref=>{
          if(!ref||typeof ref!=='object'||typeof ref.id!=='string'||!/^src_[a-f0-9-]{36}$/.test(ref.id))return []
          return [clean(Object.fromEntries(Object.entries(ref).filter(([name])=>refKeys.has(name))),`${path}.sources`,depth+1)]
        }).filter(Boolean)
        continue
      }
      if(mediaName.test(key)&&!safeMediaNames.has(key))continue
      const next=clean(v,path?`${path}.${key}`:key,depth+1)
      if(next!==undefined)result[key]=next
    }
    return result
  }
  return clean(value,'',0)
}
