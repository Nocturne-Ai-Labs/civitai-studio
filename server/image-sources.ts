import { createHash } from 'node:crypto'
import { db, findGeneration } from './storage'
import { assertConnectionCurrent, providerFetch, type BearerLease } from './connection'
import { boundedPreviewJson } from './quotes'
import type { ImageSource, FrozenImageSource } from '../shared/workflows'

type StoredSource = ImageSource & { hash?:string; blobId?:string; generationId?:string; outputId?:string; retryBeforeDispatch?:boolean }
const active = new Set<string>(), limit = 8*1024*1024
db.exec(`CREATE TABLE IF NOT EXISTS workflow_image_sources(user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,id TEXT NOT NULL,hash TEXT,record_json TEXT NOT NULL,PRIMARY KEY(user_id,id),UNIQUE(user_id,hash))`)
function save(userId:string,source:StoredSource) { db.query('INSERT INTO workflow_image_sources VALUES (?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET record_json=excluded.record_json').run(userId,source.id,source.hash ?? null,JSON.stringify(source)) }
export function sourceRecord(userId:string,id:string):StoredSource {
  const row=db.query<{record_json:string},[string,string]>('SELECT record_json FROM workflow_image_sources WHERE user_id=? AND id=?').get(userId,id)
  if(!row)throw new Error('Choose a source owned by this account.')
  const value=JSON.parse(row.record_json) as StoredSource
  if(value.status==='uploading'&&!active.has(userId)){value.status='uncertain';value.message='Upload interrupted. Automatic re-upload is blocked.';save(userId,value)}
  if(value.status==='ready' && value.blobId && value.expiresAt && Date.parse(value.expiresAt)<=Date.now())value.status='expired'
  return value
}
export function publicSource(value:StoredSource|FrozenImageSource):ImageSource {
  const {id,revision,kind,label,type,mime,size,status,expiresAt,message,width,height,duration}=value
  const stored=value as StoredSource
  const origin=value.origin ?? (kind==='gallery'&&stored.generationId&&stored.outputId?{generationId:stored.generationId,outputId:stored.outputId}:undefined)
  const recovery=kind==='upload'&&status==='expired'&&stored.blobId?'renew':kind==='upload'&&status==='failed'&&(stored.retryBeforeDispatch===true||stored.message==='Upload stopped before dispatch.')?'retry':undefined
  return {id,revision,kind,label,type,mime,size,status,expiresAt,message,width,height,duration,...(origin?{origin}:{}),...(recovery?{recovery}: {})}
}
function capacity(userId:string) { const count=db.query<{n:number},[string]>('SELECT COUNT(*) n FROM workflow_image_sources WHERE user_id=?').get(userId)!.n; if(count>=200)throw new Error('This account has reached the 200 source-record limit.') }
export function registerGallerySource(userId:string,generationId:string,outputId:string):ImageSource {
  const generation=findGeneration(userId,generationId) as any
  const output=generation?.outputs?.find((item:any)=>item.id===outputId && ['image','video'].includes(item.kind) && item.role!=='thumbnail')
  if(!output||generation.mediaType!==output.kind||!generation.providerWorkflowId||['reserved','uncertain'].includes(generation.submissionState)||output.metadata?.available===false)throw new Error('Select an owned original image or video from a known workflow.')
  const hash=createHash('sha256').update(`gallery:${generationId}:${outputId}`).digest('hex')
  const old=db.query<{id:string},[string,string]>('SELECT id FROM workflow_image_sources WHERE user_id=? AND hash=?').get(userId,hash)
  if(old)return publicSource(sourceRecord(userId,old.id))
  capacity(userId)
  const source:StoredSource={id:`src_${crypto.randomUUID()}`,revision:crypto.randomUUID(),kind:'gallery',label:`Gallery ${output.kind} · ${generationId.slice(-12)} · ${outputId.slice(0,40)}`,type:output.kind,...mediaDetails(output),status:'ready',expiresAt:null,message:'Availability is refreshed before each preview.',hash,generationId,outputId}
  save(userId,source);return publicSource(source)
}
export function listImageSources(userId:string) {
  const uploads=db.query<{id:string},[string]>('SELECT id FROM workflow_image_sources WHERE user_id=? ORDER BY rowid DESC LIMIT 200').all(userId).map(row=>publicSource(sourceRecord(userId,row.id)))
  const rows=db.query<{record_json:string},[string]>('SELECT record_json FROM generations WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId)
  const gallery=rows.flatMap(row=>{const g=JSON.parse(row.record_json);if(!['image','video'].includes(g.mediaType)||!g.providerWorkflowId||['uncertain','reserved'].includes(g.submissionState))return [];return (g.outputs??[]).filter((o:any)=>o.kind===g.mediaType&&o.role!=='thumbnail'&&o.metadata?.available!==false).slice(0,50).map((o:any)=>({generationId:g.id,outputId:o.id,type:o.kind,label:`${String(g.input?.prompt??g.mediaType).slice(0,100)} · ${String(o.id).slice(0,30)}`}))}).slice(0,500)
  return {items:uploads,gallery}
}
function imageMime(bytes:Buffer) {
  if(bytes.length>=45 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(8)===13 && bytes.toString('ascii',12,16)==='IHDR' && bytes.readUInt32BE(16)>0 && bytes.readUInt32BE(20)>0 && bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND')return 'image/png'
  if(bytes.length>=4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes.at(-2)===255 && bytes.at(-1)===217)return 'image/jpeg'
  if(bytes.length>=20 && bytes.toString('ascii',0,4)==='RIFF' && bytes.readUInt32LE(4)+8===bytes.length && bytes.toString('ascii',8,12)==='WEBP' && ['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16)))return 'image/webp'
  return null
}
export async function uploadImageSource(request:Request,key:BearerLease,sessionCurrent:()=>boolean):Promise<ImageSource> {
  const userId=key.userId
  if(active.has(userId)||active.size>=2)throw new Error('Image uploads are busy. Wait before retrying.')
  active.add(userId);let source:StoredSource|undefined,dispatched=false,renewedFrom:StoredSource|undefined
  try {
    const reader=request.body?.getReader();if(!reader)throw new Error('Choose an image file.')
    const chunks:Uint8Array[]=[];let size=0
    let timer:ReturnType<typeof setTimeout>|undefined
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error('Image upload must finish within 60 seconds.'));void reader.cancel().catch(()=>{})},60000)})
    try { for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.length;if(size>limit){void reader.cancel().catch(()=>{});throw new Error('Images must be 8 MiB or smaller.')}chunks.push(part.value)} } finally {clearTimeout(timer);reader.releaseLock()}
    const bytes=Buffer.concat(chunks),mime=imageMime(bytes)
    if(!mime||mime!==request.headers.get('Content-Type')?.split(';')[0])throw new Error('Choose a valid PNG, JPEG or WebP image matching its declared type.')
    if(!sessionCurrent())throw new Error('The active session changed. Reconnect before uploading.')
    assertConnectionCurrent(key)
    const hash=createHash('sha256').update(bytes).digest('hex')
    const old=db.query<{id:string},[string,string]>('SELECT id FROM workflow_image_sources WHERE user_id=? AND hash=?').get(userId,hash)
    const recovery=request.headers.get('X-Source-Recovery'),sourceId=request.headers.get('X-Source-Id'),revision=request.headers.get('X-Source-Revision')
    if(recovery||sourceId||revision){
      if(!['retry','renew'].includes(recovery??'')||!old||sourceId!==old.id)throw new Error('Reselect the original file for this source and refresh its status.')
      const prior=sourceRecord(userId,old.id)
      if(prior.revision!==revision||publicSource(prior).recovery!==recovery)throw new Error('Source changed or cannot be safely retried. Refresh its status.')
      if(recovery==='renew')renewedFrom=prior
    } else if(old){const prior=sourceRecord(userId,old.id);if(prior.status==='uploading'){prior.status='uncertain';prior.message='Earlier upload interrupted. Automatic re-upload is blocked.';save(userId,prior)}return publicSource(prior)} // Re-upload requires a separate explicit action; uncertainty never permits it.
    if(!old)capacity(userId)
    source={id:old?.id??`src_${crypto.randomUUID()}`,revision:crypto.randomUUID(),kind:'upload',label:'Uploaded image',type:'image',mime,size,hash,status:'uploading',expiresAt:null,message:'Uploading image to Civitai.',retryBeforeDispatch:false}
    save(userId,source)
    const response=await providerFetch(key,'https://orchestration.civitai.com/v2/consumer/blobs',{method:'POST',headers:{'Content-Type':mime,Accept:'application/json'},body:bytes,redirect:'error',signal:AbortSignal.timeout(60000)},32768,()=>{if(!sessionCurrent())throw new Error('Session changed.');dispatched=true})
    if(!response.ok){const status=response.status;await response.body?.cancel();if([400,413,415,422].includes(status)){source.status='failed';source.message=`Civitai rejected the image upload (HTTP ${status}). Its MIME/size/moderation rules may differ from Studio's limits.`;save(userId,source);return publicSource(source)}throw new Error('Upload response unavailable.')}
    const blob=await boundedPreviewJson(response) as any
    if(typeof blob.id!=='string'||!blob.id||blob.id.length>300||blob.id.includes(key.bearer)||blob.type!=='image'||blob.available!==true)throw new Error('No available image blob confirmed.')
    assertConnectionCurrent(key);if(!sessionCurrent())throw new Error('Session changed.')
    source.blobId=blob.id;source.status='ready';source.expiresAt=new Date(Date.now()+27*86400000).toISOString();source.message='Image uploaded. It has not been published or used for generation.';save(userId,source)
    return publicSource(source)
  } catch(error) {
    if(source){if(!dispatched&&renewedFrom)source={...renewedFrom,revision:source.revision,status:'expired',message:'Renewal stopped before dispatch. Reselect the original file to renew explicitly.'};else {source.status=dispatched?'uncertain':'failed';source.retryBeforeDispatch=!dispatched;source.message=dispatched?'Upload outcome uncertain. This file will not be automatically uploaded again.':'Upload stopped before dispatch.'}save(userId,source);return publicSource(source)}
    throw error
  } finally {active.delete(userId)}
}
function mediaDetails(output:any) {
  const positive=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:undefined
  return {mime:['image/png','image/jpeg','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime'].includes(output.mimeType)?output.mimeType:null,size:positive(output.metadata?.size)??null,width:positive(output.metadata?.width),height:positive(output.metadata?.height),duration:positive(output.metadata?.duration)}
}
export async function resolveImageSources(userId:string,key:BearerLease,ids:string[],gallery:(generationId:string,outputId:string,type:'image'|'video')=>Promise<{url:string;output?:unknown}>,safe:(url:unknown)=>boolean,identity:(url:string)=>string) {
  if(!Array.isArray(ids)||ids.length<1||ids.length>9||ids.some(id=>typeof id!=='string'||!/^src_[a-f0-9-]{36}$/.test(id)))throw new Error('Choose between one and nine owned media sources.')
  const resolved:{source:FrozenImageSource;url:string}[]=[]
  for(const id of ids){const record=sourceRecord(userId,id);if(record.status!=='ready')throw new Error('The selected source is unavailable or expired.')
    let url:string
    if(record.kind==='gallery'){const fresh=await gallery(record.generationId!,record.outputId!,record.type);url=fresh.url;if(fresh.output)Object.assign(record,mediaDetails(fresh.output))}
    else {
      const response=await providerFetch(key,`https://orchestration.civitai.com/v2/consumer/blobs/${encodeURIComponent(record.blobId!)}/refresh`,{method:'POST',headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)},32768)
      if(!response.ok){await response.body?.cancel();throw new Error('Civitai could not refresh the uploaded image. It may have expired or become unavailable.')}
      const blob=await boundedPreviewJson(response) as any
      if(blob.id!==record.blobId||blob.type!==record.type||blob.available!==true||typeof blob.url!=='string')throw new Error('Uploaded source identity or availability changed.')
      url=blob.url
    }
    assertConnectionCurrent(key)
    if(!safe(url))throw new Error('Civitai did not return a safe source URL.')
    if(sourceRecord(userId,id).revision!==record.revision)throw new Error('Image source changed while refreshing.')
    resolved.push({url,source:{...publicSource(record),identity:createHash('sha256').update(`${record.hash}:${record.blobId??''}:${identity(url)}:${record.type==='video'?JSON.stringify([record.mime,record.size,record.width,record.height,record.duration]):''}`).digest('hex')}})
  }
  return resolved
}
export function sourcesCurrent(userId:string,sources:FrozenImageSource[]) {
  try{return sources.every(source=>{const row=sourceRecord(userId,source.id);return row.status==='ready'&&row.revision===source.revision})}catch{return false}
}
