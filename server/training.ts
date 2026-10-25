import { trainingProfiles, type TrainingEcosystem } from '../shared/training'
import { providerFetch, assertConnectionCurrent, type BearerLease } from './connection'
import { createHash } from 'node:crypto'
import { db } from './storage'
import { normalizePolicy, boundedPreviewJson, type PreparedGeneration } from './quotes'
import type { TrainingDataset, TrainingImageMetadata, TrainingItem, TrainingReview, TrainingSettings } from '../shared/training'
const fileLimit = 8*1024*1024, totalLimit = 128*1024*1024
const expired = (item:Partial<TrainingItem>) => !item.uploadedAt || !Number.isFinite(Date.parse(item.uploadedAt)) || Date.now()-Date.parse(item.uploadedAt)>27*86400000
const uploads = new Set<string>()
db.exec(`CREATE TABLE IF NOT EXISTS training_datasets(user_id TEXT NOT NULL,id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(user_id,id)); CREATE TABLE IF NOT EXISTS training_uploads(user_id TEXT NOT NULL,hash TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(user_id,hash));`)
const json = (value:unknown,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}})
const isObject = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype
const fieldsOnly = (value:Record<string,unknown>,fields:string[]) => Object.keys(value).every(key=>fields.includes(key))
function datasetName(value:unknown):string {
 if(typeof value!=='string'||!value.trim()||value.length>100)throw new Error('Use a dataset name of 1-100 characters.')
 return value.trim()
}
function imageMetadata(value:unknown):TrainingImageMetadata[] {
 const problem='Choose 1-32 distinct PNG/JPEG/WebP images, up to 8 MiB each and 128 MiB total, with captions up to 1024 characters.'
 if(!Array.isArray(value)||!value.length||value.length>32)throw new Error(problem)
 const items=value.map(item=>{
  if(!isObject(item)||!fieldsOnly(item,['hash','name','size','mime','caption'])||typeof item.name!=='string'||!item.name.trim()||item.name.length>200||!Number.isInteger(item.size)||Number(item.size)<1||Number(item.size)>fileLimit||typeof item.mime!=='string'||!['image/png','image/jpeg','image/webp'].includes(item.mime)||typeof item.hash!=='string'||!/^[a-f0-9]{64}$/.test(item.hash)||(item.caption!==undefined&&(typeof item.caption!=='string'||item.caption.length>1024)))throw new Error(problem)
  return {name:item.name,size:Number(item.size),mime:item.mime,hash:item.hash,caption:typeof item.caption==='string'?item.caption:''}
 })
 if(new Set(items.map(item=>item.hash)).size!==items.length||items.reduce((sum,item)=>sum+item.size,0)>totalLimit)throw new Error(problem)
 return items
}
function settingsFor(value:unknown):TrainingSettings {
 if(!isObject(value)||!fieldsOnly(value,['ecosystem','steps','triggerWord','prompts'])||!Number.isInteger(value.steps)||Number(value.steps)<1||Number(value.steps)>10000||typeof value.triggerWord!=='string'||value.triggerWord.length>200||!Array.isArray(value.prompts)||value.prompts.length>3||value.prompts.some(prompt=>typeof prompt!=='string'||!prompt.trim()||prompt.length>1000))throw new Error('Use 1-10000 steps, a trigger up to 200 characters, and up to three sample prompts of 1000 characters.')
 if(value.ecosystem!==undefined&&value.ecosystem!=='sdxl'&&value.ecosystem!=='sd1')throw new Error('Choose SDXL or SD1 / SD1.5 training.')
 return {ecosystem:value.ecosystem===undefined?'sdxl':value.ecosystem,steps:Number(value.steps),triggerWord:value.triggerWord,prompts:[...value.prompts] as string[]}
}
const newItems = (items:TrainingImageMetadata[]):TrainingItem[] => items.map(item=>({...item,id:crypto.randomUUID(),caption:item.caption??'',status:'pending'}))
const conflict = () => json({error:{message:'Dataset changed or an upload is active. Reload before saving.'}},409)
function save(userId:string,dataset:TrainingDataset) { db.query('INSERT INTO training_datasets VALUES (?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET record_json=excluded.record_json').run(userId,dataset.id,JSON.stringify(dataset)) }
function replaceDataset(userId:string,dataset:TrainingDataset,expectedRevision:string) {
 dataset.revision=crypto.randomUUID()
 return db.query("UPDATE training_datasets SET record_json=? WHERE user_id=? AND id=? AND json_extract(record_json, '$.revision')=?").run(JSON.stringify(dataset),userId,dataset.id,expectedRevision).changes===1
}
function ledger(userId:string,hash:string):Partial<TrainingItem>|null {
 const row=db.query<{record_json:string},[string,string]>('SELECT record_json FROM training_uploads WHERE user_id=? AND hash=?').get(userId,hash)
 if(!row)return null
 const value=JSON.parse(row.record_json)
 if(value.status==='uploading' && !uploads.has(userId)){value.status='uncertain';value.message='Upload interrupted; no blob ID was confirmed. Automatic re-upload is blocked.';saveUpload(userId,hash,value)}
 return value
}
function saveUpload(userId:string,hash:string,value:Partial<TrainingItem>) {db.query('INSERT INTO training_uploads VALUES (?,?,?) ON CONFLICT(user_id,hash) DO UPDATE SET record_json=excluded.record_json').run(userId,hash,JSON.stringify(value))}
export function datasetFor(userId:string,id:string):TrainingDataset|null {
 const row=db.query<{record_json:string},[string,string]>('SELECT record_json FROM training_datasets WHERE user_id=? AND id=?').get(userId,id)
 if(!row)return null
 const dataset:TrainingDataset=JSON.parse(row.record_json)
 dataset.items=dataset.items.map(item=>{const current={...item,...ledger(userId,item.hash)};return current.status==='ready'&&expired(current)?{...current,status:'expired' as const,message:'Confirmed blob is past the Studio retention window. Reselect the original and explicitly renew its upload.'}:current})
 return dataset
}
function reviseDatasets(userId:string,hash:string) {
 const rows=db.query<{record_json:string},[string]>('SELECT record_json FROM training_datasets WHERE user_id=?').all(userId)
 for(const row of rows){const dataset:TrainingDataset=JSON.parse(row.record_json);if(dataset.items.some(x=>x.hash===hash)){dataset.revision=crypto.randomUUID();save(userId,dataset)}}
}
export function validateTrainingQuote(userId:string,prepared:PreparedGeneration) {
 if(!prepared.training)return true
 const ecosystem=prepared.training.settings.ecosystem ?? 'sdxl'
 const profile=trainingProfiles[ecosystem]
 if(!profile || prepared.providerInput.engine!=='ai-toolkit' || prepared.providerInput.ecosystem!==ecosystem || prepared.providerInput.model!==profile.model || prepared.providerInput.steps!==prepared.training.settings.steps)return false
 const dataset=datasetFor(userId,prepared.training.datasetId)
 const items=(prepared.providerInput.trainingData as any)?.items
 return !!dataset && dataset.revision===prepared.training.revision && Array.isArray(items) && dataset.items.length===items.length && dataset.items.every((item,index)=>item.status==='ready'&&!expired(item)&&item.blobId===items[index]?.air&&item.caption===(items[index]?.caption??''))
}
export function prepareTraining(userId:string,body:Record<string,unknown>):PreparedGeneration {
 if(Object.keys(body).some(k=>!['recipe','datasetId','revision','settings','policy'].includes(k)))throw new Error('Invalid training request.')
 const dataset=typeof body.datasetId==='string'?datasetFor(userId,body.datasetId):null
 const settings=settingsFor(body.settings)
 if(!dataset || dataset.revision!==body.revision || !dataset.items.length || dataset.items.some(x=>x.status!=='ready'||!x.blobId||!x.uploadedAt||Date.now()-Date.parse(x.uploadedAt)>27*86400000))throw new Error('Save a complete, recently uploaded dataset before previewing.')
 const ecosystem:TrainingEcosystem=settings.ecosystem===undefined?'sdxl':settings.ecosystem
 if(!['sdxl','sd1'].includes(ecosystem))throw new Error('Choose SDXL or SD1 / SD1.5 training.')
 const profile=trainingProfiles[ecosystem]
 const policy=normalizePolicy(body.policy)
 const training:TrainingReview={profile:{...profile},datasetId:dataset.id,datasetName:dataset.name,revision:dataset.revision,items:dataset.items.map(x=>({name:x.name,caption:x.caption})),settings:{ecosystem,steps:settings.steps,triggerWord:settings.triggerWord,prompts:[...settings.prompts]}}
 const input={engine:'ai-toolkit',ecosystem,model:profile.model,steps:settings.steps,epochs:10,lr:0.0005,textEncoderLr:0.00005,trainTextEncoder:true,lrScheduler:'cosine',optimizerType:profile.optimizerType,networkDim:32,networkAlpha:profile.networkAlpha,noiseOffset:profile.noiseOffset,minSnrGamma:5,batchSize:1,triggerWord:settings.triggerWord,trainingData:{type:'blobs',items:dataset.items.map(x=>({air:x.blobId!,...(x.caption?{caption:x.caption}:{})}))},samples:{prompts:settings.prompts}}
 return {mediaType:'training',training,providerInput:input,storedInput:{prompt:`${profile.label} LoRA: ${dataset.name}`,engine:'ai-toolkit',model:input.model,parameters:{...input,nativeResolution:profile.nativeResolution,datasetId:dataset.id,datasetRevision:dataset.revision}},fingerprint:JSON.stringify({recipe:'training',training,input,policy}),policy,workflowRequest:{...policy,metadata:{studioTrainingDataset:dataset.id,studioTrainingEcosystem:ecosystem},steps:[{'$type':'training',input}]}}
}
export async function trainingApi(request:Request,url:URL,userId:string,readBody:(r:Request,n?:number)=>Promise<Record<string,unknown>|null>, key:BearerLease) {
 try {
 assertConnectionCurrent(key)
 if(key.userId!==userId)throw new Error('Reconnect the active account.')
 const path=url.pathname.slice('/api/studio/v1/training'.length)
 if(path==='/datasets' && request.method==='GET') {
 const rows=db.query<{id:string},[string]>('SELECT id FROM training_datasets WHERE user_id=? ORDER BY rowid DESC').all(userId)
 return json({items:rows.map(row=>datasetFor(userId,row.id))})
 }
 if(path==='/datasets' && request.method==='POST') {
 const body=await readBody(request,65536)
 assertConnectionCurrent(key)
 if(!isObject(body)||!fieldsOnly(body,['name','items','trainingSettings']))throw new Error('Invalid dataset request.')
 const name=datasetName(body.name),items=imageMetadata(body.items)
 const trainingSettings=body.trainingSettings===undefined?undefined:settingsFor(body.trainingSettings)
 if(uploads.has(userId))return conflict()
 if(db.query<{n:number},[string]>('SELECT count(*) n FROM training_datasets WHERE user_id=?').get(userId)!.n>=20)throw new Error('The account limit is 20 saved datasets.')
 const dataset:TrainingDataset={id:crypto.randomUUID(),name,revision:crypto.randomUUID(),createdAt:new Date().toISOString(),items:newItems(items),...(trainingSettings?{trainingSettings}:{})}
 save(userId,dataset);return json({dataset:datasetFor(userId,dataset.id)},201)
 }
 const match=/^\/datasets\/([^/]+)(?:\/(items)(?:\/([^/]+)\/upload)?)?$/.exec(path)
 const dataset=match?datasetFor(userId,match[1]!):null
 if(!dataset) return json({error:{message:'Dataset not found.'}},404)
 if(request.method==='PATCH'&&!match![2]) {
 const body=await readBody(request,65536)
 assertConnectionCurrent(key)
 if(!isObject(body)||!fieldsOnly(body,['revision','name','items','trainingSettings']))throw new Error('Invalid dataset request.')
 // Body reads yield: reload after the await, then compare-and-swap without
 // another await so concurrent edits or upload revision bumps cannot be lost.
 const current=datasetFor(userId,dataset.id)
 if(!current)return json({error:{message:'Dataset not found.'}},404)
 if(uploads.has(userId)||typeof body.revision!=='string'||body.revision!==current.revision)return conflict()
 const items=body.items
 if(!Array.isArray(items)||items.length<1||items.length>current.items.length||items.some(item=>!isObject(item)||!fieldsOnly(item,['id','caption'])||typeof item.id!=='string'||!current.items.some(old=>old.id===item.id)||typeof item.caption!=='string'||item.caption.length>1024)||new Set(items.map(item=>item.id)).size!==items.length)throw new Error('Keep at least one image, with each image included once and captions up to 1024 characters.')
 const expectedRevision=current.revision
 if(body.name!==undefined)current.name=datasetName(body.name)
 if(body.trainingSettings!==undefined)current.trainingSettings=settingsFor(body.trainingSettings)
 current.items=items.map(item=>({...current.items.find(old=>old.id===item.id)!,caption:item.caption}))
 // Removed images keep their upload ledger. Re-adding an uncertain file must not
 // silently become a fresh upload, and historical training runs stay intact.
 if(!replaceDataset(userId,current,expectedRevision))return conflict()
 return json({dataset:current})
 }
 if((request.method==='DELETE'&&!match![2])||(request.method==='POST'&&match![2]&&!match![3])) {
 const body=await readBody(request,65536)
 assertConnectionCurrent(key)
 const deleting=request.method==='DELETE'
 if(!isObject(body)||!fieldsOnly(body,deleting?['revision']:['revision','items']))throw new Error('Invalid dataset request.')
 const current=datasetFor(userId,dataset.id)
 if(!current)return json({error:{message:'Dataset not found.'}},404)
 if(uploads.has(userId)||typeof body.revision!=='string'||body.revision!==current.revision)return conflict()
 if(deleting) {
  const result=db.query("DELETE FROM training_datasets WHERE user_id=? AND id=? AND json_extract(record_json, '$.revision')=?").run(userId,current.id,current.revision)
  if(result.changes!==1)return conflict()
  // Delete only this local dataset record. Provider blobs, hash upload history,
  // and saved training runs are deliberately retained.
  return json({deleted:true})
 }
 const items=imageMetadata(body.items)
 if(current.items.length+items.length>32||current.items.reduce((sum,item)=>sum+item.size,0)+items.reduce((sum,item)=>sum+item.size,0)>totalLimit)throw new Error('A dataset can contain up to 32 images and 128 MiB total.')
 if(items.some(item=>current.items.some(existing=>existing.hash===item.hash)))throw new Error('These images already belong to this dataset. Choose distinct images to add.')
 const expectedRevision=current.revision
 current.items.push(...newItems(items))
 if(!replaceDataset(userId,current,expectedRevision))return conflict()
 return json({dataset:datasetFor(userId,current.id)})
 }
 if(request.method==='POST'&&match![3]) {
 const item=dataset.items.find(x=>x.id===match![3]);if(!item)throw new Error('Dataset image not found.')
 const renewing=item.status==='expired'
 if(item.status==='ready'||item.status==='uncertain'||item.status==='uploading')return json({dataset})
 if(renewing && (request.headers.get('X-Training-Renew')!=='true'||request.headers.get('X-Training-Revision')!==dataset.revision))throw new Error('Explicitly authorize renewal of this expired confirmed upload using the current dataset revision.')
 if(renewing && db.query("SELECT id FROM generations WHERE user_id=? AND json_extract(record_json, '$.submissionState') IN ('uncertain','reserved') LIMIT 1").get(userId))throw new Error('Recover the original pending submission before renewing dataset blobs.')
 if(uploads.has(userId)||uploads.size>=2)throw new Error('Uploads are busy. Wait before explicitly retrying.')
 const scope=key.scopes
 if(!key || (scope!=null&&(scope&32768)===0))throw new Error('Connect an account with AIServicesWrite permission.')
 uploads.add(userId)
 let dispatched=false
 try {
 if(request.headers.get('content-type')?.split(';')[0]!==item.mime)throw new Error('Selected file type changed.')
 const reader=request.body?.getReader();if(!reader)throw new Error('Select the original local file again.')
 const chunks:Uint8Array[]=[];let size=0
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>fileLimit||size>item.size){await reader.cancel();throw new Error('Image exceeds its declared size.')}chunks.push(value)}}finally{reader.releaseLock()}
 const bytes=Buffer.concat(chunks)
 if(bytes.length!==item.size||createHash('sha256').update(bytes).digest('hex')!==item.hash)throw new Error('Select the exact original file saved in this dataset.')
 const mime=bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null
 if(mime!==item.mime)throw new Error('Image signature does not match its declared type.')
 assertConnectionCurrent(key)
 saveUpload(userId,item.hash,{status:'uploading',message:'Uploading to Civitai; awaiting blob confirmation.'})
 const response=await providerFetch(key,'https://orchestration.civitai.com/v2/consumer/blobs',{method:'POST',headers:{'Content-Type':mime,Accept:'application/json'},body:bytes,redirect:'error',signal:AbortSignal.timeout(60000)},32768,()=>{
 if(datasetFor(userId,dataset.id)?.revision!==dataset.revision)throw new Error("Dataset changed before upload. Reload before retrying.")
 dispatched=true
 })
 if(!response.ok){await response.body?.cancel();throw new Error('Upload response was not confirmed.')}
 const blob=await boundedPreviewJson(response) as any
 if(typeof blob.id!=='string'||!blob.id||blob.id.length>300||blob.id.includes(key.bearer)||blob.type!=='image'||blob.available!==true)throw new Error('Civitai did not confirm an available image blob.')
 saveUpload(userId,item.hash,{status:'ready',blobId:blob.id,uploadedAt:new Date().toISOString(),message:'Civitai confirmed this image blob.'});reviseDatasets(userId,item.hash)
 }catch(error){saveUpload(userId,item.hash,{...(renewing&&!dispatched?{blobId:item.blobId,uploadedAt:item.uploadedAt}:{}),status:dispatched?'uncertain':renewing?'ready':'failed',message:dispatched?'Upload outcome uncertain. Re-upload of this file is blocked; inspect Civitai or contact support.':error instanceof Error?error.message:'Upload failed before dispatch.'})}finally{uploads.delete(userId)}
 assertConnectionCurrent(key)
 return json({dataset:datasetFor(userId,dataset.id)})
 }
 return json({error:{message:'Training action not found.'}},404)
 }catch(error){return json({error:{message:error instanceof Error?error.message:'Training request failed.'}},400)}
}
