import { assertConnectionCurrent, ConnectionError, type BearerLease } from './connection'
import { siteJson, SiteError } from './models'
import type { CollectionDestination, CollectionTransfer, SiteCollectionSave, CollectionType } from '../shared/collections'
import { db } from './storage'
import { callCivitaiTool, McpError } from './civitai-mcp'
import { collectionManagementApi, collectionManagementBusy, readPublicSiteCollectionResource } from './collection-management'
import { getBrowsingPreference } from './browsing'
import { contentRating, ratingAllowed } from '../shared/browsing'
const maxImageBytes = 10 * 1024 * 1024
const collectionsWrite = 262144, mediaWrite = 64
const active = new Set<string>()
type StoredTransfer = CollectionTransfer & { batchUuids?: Record<string,string>; batchFingerprint?: string; uploadUuid?: string; postFailureBoundary?: 'pre-dispatch' | 'unknown' }
type Dependencies = {
  connection: BearerLease
  readBody: (request: Request) => Promise<Record<string, unknown> | null>
  ownedOutput: (userId: string, outputId: string) => { generation: Record<string, any>; output: Record<string, any> } | null
  outputContent: (userId: string, generation: Record<string, any>, outputId: string, maxBytes?: number) => Promise<Response>
}
class CollectionError extends Error { constructor(message: string, readonly status = 400) { super(message) } }
const validId = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
function keyFor(key: BearerLease, posting = false) {
  assertConnectionCurrent(key)
  const needed = collectionsWrite | (posting ? mediaWrite : 0)
  if (key.scopes != null && (key.scopes & needed) !== needed) throw new CollectionError('This action requires Collections Write' + (posting ? ' and Media Write' : '') + ' permission.',403)
  return key
}

function destination(userId: string, id: number): CollectionDestination | null {
  const row = db.query<{ record_json: string }, [string, number]>('SELECT record_json FROM collection_destinations WHERE user_id=? AND collection_id=?').get(userId, id)
  return row ? JSON.parse(row.record_json) : null
}
function storeTransfer(userId: string, record: StoredTransfer) {
  record.updatedAt = new Date().toISOString()
  db.query('INSERT INTO collection_transfers (user_id,output_id,record_json) VALUES (?,?,?) ON CONFLICT(user_id,output_id) DO UPDATE SET record_json=excluded.record_json').run(userId, record.outputId, JSON.stringify(record))
}
function getTransfer(userId: string, outputId: string): StoredTransfer | null {
  const row = db.query<{ record_json: string }, [string, string]>('SELECT record_json FROM collection_transfers WHERE user_id=? AND output_id=?').get(userId, outputId)
  if (!row) return null
  const record: StoredTransfer = JSON.parse(row.record_json)
  if (!active.has(`${userId}:${outputId}`) && record.post === 'failed' && record.postFailureBoundary !== 'pre-dispatch') {
    // Older failures were classified by provider wording, not dispatch evidence.
    // Preserve their IDs and require reconciliation rather than risking recreation.
    record.post = 'uncertain'; record.publication = 'unknown'
    record.message = 'This earlier failed post attempt has no reliable pre-dispatch evidence. Inspect your Civitai drafts and published posts for this image/title. Automatic post recreation is blocked; reconcile with Civitai support if needed.'
    storeTransfer(userId, record)
  }
  if (!active.has(`${userId}:${outputId}`) && [record.upload, record.post, record.membership].includes('running')) {
    if (record.post === 'running') { record.post = 'uncertain'; record.publication = 'unknown'; record.message = 'Post creation was interrupted. Check Civitai manually; Studio will not create another post for this output.' }
    else if (record.membership === 'running') { record.membership = 'failed'; record.message = 'Collection add was interrupted. Retry will reuse the saved Site IDs.' }
    else { record.upload = 'uncertain'; record.message = 'Upload was interrupted before post creation. Retry may upload the original again.' }
    storeTransfer(userId, record)
  }
  if (!active.has(`${userId}:${outputId}`) && ['checking','dispatching'].includes(record.publicationAction ?? '')) {
    record.publicationAction = 'uncertain'; record.publication = 'unknown'
    record.publicationMessage = 'Publication was interrupted. Check publication status before any further publish request.'
    record.publicationRevision = crypto.randomUUID(); storeTransfer(userId,record)
  }
  if (record.batch && !active.has(`${userId}:${outputId}`) && record.batch.some(item=>item.upload==='running')) {
    for(const item of record.batch) if(item.upload==='running'){item.upload='uncertain';item.message='Upload interrupted. Its UUID was not confirmed; automatic repetition is blocked.'}
    record.upload='uncertain';record.message='A batch upload is uncertain. Inspect Civitai before any further action.';storeTransfer(userId,record)
  }
  return record
}
function publicTransfer(userId: string, record: StoredTransfer): CollectionTransfer {
  const { batchUuids: _uuids, batchFingerprint: _fingerprint, uploadUuid: _private, postFailureBoundary: _boundary, ...result } = record
  result.active = active.has(`${userId}:${record.outputId}`)
  result.canRetry = !result.active && !record.batch?.some(item=>item.upload==='uncertain'||item.upload==='running') && record.post !== 'uncertain' && record.membership !== 'succeeded' && !(record.post === 'succeeded' && record.destinationType === 'Image' && record.siteImageIds.length !== 1)
  result.canPublish = !result.active && record.post === 'succeeded' && validId(record.sitePostId) && record.publication === 'draft' && !['uncertain','checking','dispatching'].includes(record.publicationAction ?? '')
  result.canReconcilePublication = !result.active && record.post === 'succeeded' && validId(record.sitePostId) && record.publication !== 'published'
  result.postUrl = validId(record.sitePostId) ? `https://civitai.com/posts/${record.sitePostId}` : null
  return result
}
function checkImage(found: ReturnType<Dependencies['ownedOutput']>) {
  if (!found) throw new CollectionError('Generated output not found for this account.', 404)
  if (found.output.role === 'thumbnail' || (found.generation.mediaType ?? 'image') !== 'image' || (found.output.kind ?? 'image') !== 'image') throw new CollectionError('Only original generated images can be posted. Video and 3D collection posting are not supported; thumbnails are never substituted.')
  return found
}
async function originalImage(response: Response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    const category = response.headers.get('X-Studio-Media-Failure')
    const detail = category === 'unsafe_target' ? 'Original image redirect target is outside the approved media hosts or failed URL safety checks.'
      : category === 'redirect_limit' ? 'Original image exceeded the safe redirect limit.'
      : category === 'invalid_redirect' ? 'Original image returned an invalid redirect.'
      : 'Could not fetch the original image. It may be unavailable or exceed the 10 MiB cap.'
    throw new CollectionError(detail, 502)
  }
  const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase()
  if (!mime || !['image/png','image/jpeg','image/gif','image/webp'].includes(mime)) { await response.body?.cancel().catch(() => {}); throw new CollectionError('Collection posting accepts only PNG, JPEG, GIF or WebP originals.') }
  if (Number(response.headers.get('content-length')) > maxImageBytes) { await response.body?.cancel().catch(() => {}); throw new CollectionError('Original image exceeds 10 MiB.') }
  const reader = response.body?.getReader(); if (!reader) throw new CollectionError('Original image was empty.')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxImageBytes) { await reader.cancel(); throw new CollectionError('Original image exceeds 10 MiB.') } chunks.push(value) }
  } finally { reader.releaseLock() }
  const bytes = Buffer.concat(chunks)
  const detected = bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.length >= 10 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)) ? 'image/gif'
    : bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : null
  if (detected !== mime) throw new CollectionError('Original image signature does not match its MIME type.')
  return { bytes, mime }
}
function transferGuard(userId: string, record: StoredTransfer, deps: Dependencies) {
  assertConnectionCurrent(deps.connection)
  const saved = getTransfer(userId,record.outputId)
  const dest = destination(userId,record.destinationId)
  if (!saved || JSON.stringify(saved) !== JSON.stringify(record) || !dest || dest.type !== record.destinationType)
    throw new CollectionError('The saved transfer or destination changed. No further action was sent.',409)
}
async function runTransfer(userId: string, record: StoredTransfer, deps: Dependencies) {
  let phase: 'upload' | 'post' | 'membership' = 'upload'
  try {
    const dest = destination(userId, record.destinationId)
    if (!dest || !['Image','Post'].includes(dest.type) || dest.type !== record.destinationType) throw new CollectionError('The saved destination changed. No further action was sent.')
    const found = checkImage(deps.ownedOutput(userId, record.outputId))
    if (record.upload !== 'succeeded') {
      record.upload = 'running'; record.message = 'Fetching and uploading the original image.'; storeTransfer(userId, record)
      const { bytes, mime } = await originalImage(await deps.outputContent(userId, found.generation, record.outputId, maxImageBytes))
      const result = await callCivitaiTool(keyFor(deps.connection, true), 'upload_image', { data: bytes.toString('base64'), contentType: mime }, {beforeDispatch:()=>transferGuard(userId,record,deps)})
      if (typeof result.uuid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.uuid)) throw new McpError('Civitai did not confirm a valid upload UUID. No post was requested.', true)
      record.uploadUuid = result.uuid; record.upload = 'succeeded'; storeTransfer(userId, record)
    }
    phase = 'post'
    if (record.post !== 'succeeded') {
      if (record.post === 'uncertain') throw new CollectionError('Post creation is uncertain. Check Civitai manually; automatic recreation is blocked.', 409)
      record.post = 'running'; record.message = 'Creating the Civitai post.'; storeTransfer(userId, record)
      const result = await callCivitaiTool(keyFor(deps.connection, true), 'create_post', { title: record.title, images: [{ uuid: record.uploadUuid, type: 'image' }], publish: record.publishRequested }, {beforeDispatch:()=>transferGuard(userId,record,deps)})
      if (result.ok !== true || !validId(result.id)) throw new McpError('Civitai did not confirm a valid post ID. Check Civitai manually; Studio will not create another post.', true)
      record.sitePostId = result.id
      record.siteImageIds = Array.isArray(result.imageIds) ? result.imageIds.filter(validId) : []
      record.post = 'succeeded'
      record.publication = typeof result.publishedAt === 'string' && Number.isFinite(Date.parse(result.publishedAt)) ? 'published' : result.publishedAt === null ? 'draft' : 'unknown'
      // Durable Site IDs are stored BEFORE membership is attempted.
      storeTransfer(userId, record)
    }
    phase = 'membership'
    const itemId = dest.type === 'Image' ? (record.siteImageIds.length === 1 ? record.siteImageIds[0] : null) : record.sitePostId
    if (!validId(itemId)) throw new CollectionError('The post exists, but Civitai returned no single Site image ID. Open the saved post and add it manually; Studio will not recreate it.', 409)
    record.membership = 'running'; record.message = 'Adding the Site item to the collection.'; storeTransfer(userId, record)
    const result = await callCivitaiTool(keyFor(deps.connection), 'add_to_collection', { itemType: dest.type, itemId, collectionIds: [dest.id] }, {beforeDispatch:()=>transferGuard(userId,record,deps)})
    if (result.ok !== true || result.itemType !== dest.type || result.itemId !== itemId || !Array.isArray(result.collectionIds) || !result.collectionIds.includes(dest.id)) throw new McpError('Civitai did not confirm collection membership. Retry will reuse the saved Site IDs.', true)
    record.membership = 'succeeded'
    record.message = record.publication === 'draft' ? 'Civitai confirmed collection membership. Draft items may not appear in collection views until published.' : record.publication === 'published' ? 'Civitai confirmed the post is published and the item is saved to the collection.' : 'Collection membership was confirmed, but publication status is unknown. Open the post to inspect it.'
    if (record.publishRequested && record.publication === 'draft') record.message += ' Publication was requested, but Civitai returned a draft. Studio will not publish it automatically.'
    storeTransfer(userId, record)
  } catch (error) {
    const ambiguous = error instanceof McpError && error.ambiguous
    // Once a post ID is durable, errors can never cause create_post to repeat.
    if (phase === 'post' && record.post !== 'succeeded') { record.post = ambiguous ? 'uncertain' : 'failed'; record.postFailureBoundary = ambiguous ? 'unknown' : 'pre-dispatch'; if (ambiguous) record.publication = 'unknown' }
    else if (phase === 'membership') record.membership = 'failed'
    else if (record.upload !== 'succeeded') record.upload = ambiguous ? 'uncertain' : 'failed'
    record.message = error instanceof ConnectionError || error instanceof CollectionError || error instanceof McpError ? error.message : 'The collection action failed. Review the stages before retrying.'
    if (record.post === 'uncertain') record.message += ' Check your drafts and published posts on Civitai for this image and title. If a post exists, finish collection membership there; if none is apparent, reconcile with Civitai support before attempting another post. Automatic post recreation is blocked.'
    storeTransfer(userId, record)
  } finally { active.delete(`${userId}:${record.outputId}`) }
}
async function runBatch(userId:string,record:StoredTransfer,deps:Dependencies) {
  let phase:'upload'|'post'|'membership'='upload'
  let item:NonNullable<StoredTransfer['batch']>[number]|undefined
  try {
    const key=keyFor(deps.connection,true)
    const ensureAccess=()=>{transferGuard(userId,record,deps);assertConnectionCurrent(key);keyFor(deps.connection,true);if(destination(userId,record.destinationId)?.type!=='Post')throw new CollectionError('The saved Post destination changed.',409)}
    ensureAccess()
    record.batchUuids ??= {}
    for(const next of record.batch!) {
      item=next
      const found=checkImage(deps.ownedOutput(userId,item.outputId))
      if(String(found.generation.id)!==item.generationId)throw new CollectionError('The saved original changed.',409)
      if(item.upload==='succeeded'&&record.batchUuids[item.outputId])continue
      if(item.upload==='uncertain')throw new CollectionError('An upload is uncertain. Automatic repetition is blocked.',409)
      item.upload='running';item.message='Fetching and uploading this original.';record.upload='running';record.message=`Uploading image ${record.batch!.indexOf(item)+1} of ${record.batch!.length}.`;storeTransfer(userId,record)
      const {bytes,mime}=await originalImage(await deps.outputContent(userId,found.generation,item.outputId,maxImageBytes))
      ensureAccess()
      const result=await callCivitaiTool(key,'upload_image',{data:bytes.toString('base64'),contentType:mime},{uncertainAfterDispatch:true,beforeDispatch:ensureAccess})
      if(typeof result.uuid!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.uuid))throw new McpError('Upload UUID was not confirmed.',true)
      record.batchUuids[item.outputId]=result.uuid;item.upload='succeeded';item.message='Original upload confirmed.';storeTransfer(userId,record)
    }
    record.upload='succeeded';storeTransfer(userId,record)
    phase='post'
    if(record.post!=='succeeded') {
      if(record.post==='uncertain')throw new CollectionError('Post creation is uncertain. Automatic recreation is blocked.',409)
      ensureAccess();record.post='running';record.message='Creating one post with the saved image order.';storeTransfer(userId,record)
      const result=await callCivitaiTool(key,'create_post',{title:record.title,images:record.batch!.map(x=>({uuid:record.batchUuids![x.outputId],type:'image'})),publish:record.publishRequested},{beforeDispatch:ensureAccess})
      if(result.ok!==true||!validId(result.id))throw new McpError('Civitai did not confirm the post ID.',true)
      record.sitePostId=result.id;record.siteImageIds=Array.isArray(result.imageIds)?result.imageIds.filter(validId):[];record.post='succeeded';record.publication=typeof result.publishedAt==='string'&&Number.isFinite(Date.parse(result.publishedAt))?'published':result.publishedAt===null?'draft':'unknown';storeTransfer(userId,record)
    }
    phase='membership';ensureAccess()
    record.membership='running';record.message='Adding the saved Site post to its Post collection.';storeTransfer(userId,record)
    const result=await callCivitaiTool(key,'add_to_collection',{itemType:'Post',itemId:record.sitePostId,collectionIds:[record.destinationId]},{beforeDispatch:ensureAccess})
    if(result.ok!==true||result.itemType!=='Post'||result.itemId!==record.sitePostId||!Array.isArray(result.collectionIds)||!result.collectionIds.includes(record.destinationId))throw new McpError('Collection membership was not confirmed.',true)
    record.membership='succeeded';record.message='Civitai acknowledged the post collection save. Draft visibility and moderation may affect its appearance.';storeTransfer(userId,record)
  } catch(error) {
    const ambiguous=error instanceof McpError&&error.ambiguous
    if(phase==='upload'){if(item&&item.upload!=='succeeded'){item.upload=ambiguous?'uncertain':'failed';item.message=ambiguous?'Upload outcome uncertain; automatic retry blocked.':'Upload failed before confirmed dispatch.'}record.upload=ambiguous?'uncertain':'failed'}
    else if(phase==='post'&&record.post!=='succeeded'){record.post=ambiguous?'uncertain':'failed';record.postFailureBoundary=ambiguous?'unknown':'pre-dispatch';if(ambiguous)record.publication='unknown'}
    else if(phase==='membership')record.membership='failed'
    record.message=error instanceof McpError||error instanceof CollectionError?error.message:'The batch could not be completed.'
    if(record.post==='uncertain')record.message+=' Inspect Civitai drafts and published posts by title/images. Studio will not recreate this post.'
    storeTransfer(userId,record)
  } finally {active.delete(`${userId}:${record.outputId}`)}
}
async function batchApi(request:Request,path:string,userId:string,deps:Dependencies) {
  if(path==='/batches'&&request.method==='GET') {
    const rows=db.query<{output_id:string},[string]>("SELECT output_id FROM collection_transfers WHERE user_id=? AND json_type(record_json,'$.batch')='array' ORDER BY rowid DESC LIMIT 100").all(userId)
    return json({items:rows.map(row=>publicTransfer(userId,getTransfer(userId,row.output_id)!))})
  }
  if(path==='/batches'&&request.method==='POST') {
    const body=await deps.readBody(request)
    if(!body||Object.keys(body).some(x=>!['requestId','outputIds','destinationId','title','publish','confirm'].includes(x))||body.confirm!==true||typeof body.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId)||!Array.isArray(body.outputIds)||body.outputIds.length<2||body.outputIds.length>6||new Set(body.outputIds).size!==body.outputIds.length||body.outputIds.some(x=>typeof x!=='string'||!x||x.length>160)||!validId(body.destinationId)||typeof body.title!=='string'||!body.title.trim()||body.title.length>200||(body.publish!==undefined&&typeof body.publish!=='boolean'))throw new CollectionError('Confirm 2-6 distinct originals, a Post destination and a title.')
    const id=`batch_${body.requestId}`
    const fingerprint=JSON.stringify({outputIds:body.outputIds,destinationId:body.destinationId,title:body.title.trim(),publish:body.publish===true})
    const previous=getTransfer(userId,id)
    if(previous){if(previous.batchFingerprint!==fingerprint)throw new CollectionError('This request ID is already bound to different saved settings.',409);return json({transfer:publicTransfer(userId,previous)},202)}
    // An identical authorization after a lost response/reopen resumes its record.
    const duplicate=db.query<{output_id:string},[string,string]>("SELECT output_id FROM collection_transfers WHERE user_id=? AND json_extract(record_json,'$.batchFingerprint')=? LIMIT 1").get(userId,fingerprint)
    if(duplicate)return json({transfer:publicTransfer(userId,getTransfer(userId,duplicate.output_id)!)},202)
    const dest=destination(userId,body.destinationId);if(!dest||dest.type!=='Post')throw new CollectionError('Choose a saved Post collection.')
    keyFor(deps.connection,true)
    const batch=body.outputIds.map(outputId=>{const found=checkImage(deps.ownedOutput(userId,outputId as string));if(found.output.mimeType&&!['image/png','image/jpeg','image/gif','image/webp'].includes(found.output.mimeType))throw new CollectionError('Each original must be PNG, JPEG, GIF or WebP.');return {outputId:outputId as string,generationId:String(found.generation.id),upload:'pending' as const,message:'Waiting to upload.'}})
    const record:StoredTransfer={outputId:id,generationId:'batch',batch,batchUuids:{},batchFingerprint:fingerprint,destinationId:dest.id,destinationName:dest.name,destinationType:'Post',title:body.title.trim(),publishRequested:body.publish===true,upload:'pending',post:'pending',membership:'pending',publication:'not-created',sitePostId:null,siteImageIds:[],message:'Batch authorized.',active:false,canRetry:true,updatedAt:new Date().toISOString(),postUrl:null}
    storeTransfer(userId,record);start(userId,record,deps);return json({transfer:publicTransfer(userId,record)},202)
  }
  const match=/^\/batches\/(batch_[a-f0-9-]+)(?:\/(retry|publication))?$/.exec(path)
  let record=match?getTransfer(userId,match[1]!):null
  if(!record?.batch)throw new CollectionError('Saved batch not found.',404)
  if(request.method==='GET'&&!match![2])return json({transfer:publicTransfer(userId,record)})
  if(request.method==='POST'&&match![2]) {
    const body=await deps.readBody(request);if(!body)throw new CollectionError('Confirm the saved batch action.')
    record=getTransfer(userId,match![1]!)
    if(!record?.batch)throw new CollectionError('Saved batch not found.',404)
    if(match![2]==='publication')return publishSavedDraft(userId,record.outputId,body,deps)
    if(body.confirm!==true||Object.keys(body).some(x=>x!=='confirm'))throw new CollectionError('Explicitly authorize retry of the saved unfinished stages.')
    if(!publicTransfer(userId,record).canRetry)throw new CollectionError('This batch cannot be repeated automatically. Inspect its saved stages.',409)
    keyFor(deps.connection,true);start(userId,record,deps);return json({transfer:publicTransfer(userId,record)},202)
  }
  throw new CollectionError('Batch action not found.',404)
}
function start(userId: string, record: StoredTransfer, deps: Dependencies) {
  const token = `${userId}:${record.outputId}`
  if (active.has(token)) return
  if (active.size >= 2) throw new CollectionError('Two collection transfers are already running. Try again shortly.', 429)
  active.add(token)
  void (record.batch ? runBatch(userId,record,deps) : runTransfer(userId, record, deps)).catch(() => { active.delete(token) /* Durable running state becomes uncertain on next read. */ })
}
async function publishSavedDraft(userId: string, outputId: string, body: Record<string, unknown>, deps: Dependencies) {
  if (Object.keys(body).some(name => !['action','confirm','revision'].includes(name)) || !['publish','reconcile'].includes(String(body.action)) || (body.action === 'publish' && body.confirm !== true)) throw new CollectionError('Explicitly confirm publication of this saved draft.')
  const record = getTransfer(userId,outputId)
  if(record?.batch) { for(const item of record.batch) checkImage(deps.ownedOutput(userId,item.outputId)) } else checkImage(deps.ownedOutput(userId,outputId))
  if (!record || record.post !== 'succeeded' || !validId(record.sitePostId)) throw new CollectionError('No confirmed Studio post exists for this output.',404)
  const token = `${userId}:${outputId}`
  if (active.has(token)) throw new CollectionError('This transfer is busy. Wait for its saved status.',409)
  if (record.publication === 'published') return json({ transfer:publicTransfer(userId,record) })
  if (body.action === 'publish' && (body.revision !== (record.publicationRevision ?? record.updatedAt) || !publicTransfer(userId,record).canPublish)) throw new CollectionError('Refresh publication status and explicitly confirm the saved draft again.',409)
  const key = deps.connection
  if (!key) throw new CollectionError('Reconnect your account.',403)
  if (body.action === 'publish') {
    const scope = key.scopes
    if (scope != null && (scope & mediaWrite) !== mediaWrite) throw new CollectionError('Publishing requires Media Write permission.',403)
  }
  if (active.size >= 2) throw new CollectionError('Collection actions are busy. Try again shortly.',429)
  active.add(token)
  let dispatching = false
  try {
    record.publicationAction = 'checking'; record.publicationMessage = 'Reading the saved Civitai post before publication.'; storeTransfer(userId,record)
    const post = await callCivitaiTool(key,'get_post',{ id:record.sitePostId })
    if (post.id !== record.sitePostId || (post.publishedAt !== null && !(typeof post.publishedAt === 'string' && Number.isFinite(Date.parse(post.publishedAt))))) throw new CollectionError('Civitai did not confirm the saved post identity and publication state.',502)
    if (post.publishedAt !== null) {
      record.publication = 'published'; record.publicationAction = 'published'; record.publicationMessage = 'Civitai reports this saved post is already published. No publish request was sent.'
    } else if (body.action === 'reconcile') {
      record.publication = 'draft'; record.publicationAction = 'draft'; record.publicationMessage = 'Civitai reports this post is still a draft. You may explicitly confirm a new publication attempt.'
    } else {
      assertConnectionCurrent(key)
      // Persist before dispatch; every ambiguous result must be read-reconciled.
      record.publicationAction = 'dispatching'; record.publication = 'unknown'; record.publicationMessage = 'Publication requested; awaiting Civitai confirmation.'; storeTransfer(userId,record)
      const result = await callCivitaiTool(key,'publish_post',{ id:record.sitePostId },{ uncertainAfterDispatch:true, beforeDispatch:()=>{ transferGuard(userId,record,deps); dispatching=true } })
      if (result.ok !== true || result.id !== record.sitePostId || typeof result.publishedAt !== 'string' || !Number.isFinite(Date.parse(result.publishedAt))) throw new CollectionError('Publication response was incomplete.',502)
      record.publication = 'published'; record.publicationAction = 'published'; record.publicationMessage = 'Civitai confirmed publication of the saved post. Existing collection membership is unchanged.'
    }
  } catch {
    record.publicationAction = 'uncertain'; record.publication = 'unknown'
    record.publicationMessage = dispatching ? 'Publication may have completed. Check publication status; Studio will only read the saved post until the result is known.' : 'The saved post could not be confirmed. No publish request was sent. Check publication status before trying again.'
  } finally {
    record.publicationRevision = crypto.randomUUID()
    try { storeTransfer(userId,record) } finally { active.delete(token) }
  }
  return json({ transfer:publicTransfer(userId,record) })
}
const activeSiteSaves = new Set<string>()
const siteSaveKey = (userId: string, itemType: string, itemId: number, destinationId: number) => `${userId}:${itemType}:${itemId}:${destinationId}`
function storeSiteSave(userId: string, record: SiteCollectionSave) {
  record.updatedAt = new Date().toISOString()
  db.query('INSERT INTO site_collection_saves (user_id,item_type,item_id,destination_id,record_json) VALUES (?,?,?,?,?) ON CONFLICT(user_id,item_type,item_id,destination_id) DO UPDATE SET record_json=excluded.record_json').run(userId, record.itemType, record.itemId, record.destinationId, JSON.stringify(record))
}
function getSiteSave(userId: string, itemType: CollectionType, itemId: number, destinationId: number): SiteCollectionSave | null {
  const row = db.query<{ record_json: string }, [string,string,number,number]>('SELECT record_json FROM site_collection_saves WHERE user_id=? AND item_type=? AND item_id=? AND destination_id=?').get(userId,itemType,itemId,destinationId)
  if (!row) return null
  const record: SiteCollectionSave = JSON.parse(row.record_json)
  if (record.status === 'running' && !activeSiteSaves.has(siteSaveKey(userId,itemType,itemId,destinationId))) {
    record.status = 'uncertain'; record.message = 'The save was interrupted. Inspect this item in the collection on Civitai. Automatic repetition is blocked.'; storeSiteSave(userId,record)
  }
  return record
}
async function siteSaveApi(request: Request, url: URL, userId: string, deps: Dependencies) {
  const body: Record<string, unknown> | null = request.method === 'GET' ? { itemType: url.searchParams.get('itemType'), itemId: Number(url.searchParams.get('itemId')), destinationId: Number(url.searchParams.get('destinationId')) } : await deps.readBody(request)
  assertConnectionCurrent(deps.connection)
  if (!body || !['Model','Image','Post','Article'].includes(String(body.itemType)) || !validId(body.itemId) || !validId(body.destinationId)) throw new CollectionError('Choose a valid Site item and collection ID.')
  const itemType = body.itemType as CollectionType, itemId = body.itemId as number, destinationId = body.destinationId as number
  const previous = getSiteSave(userId,itemType,itemId,destinationId)
  if (request.method === 'GET') return json({ save: previous })
  if (request.method !== 'POST' || body.confirm !== true) throw new CollectionError('Explicitly confirm the Site item and destination.')
  if (previous && previous.status !== 'failed') return json({ save: previous })
  const dest = destination(userId,destinationId)
  if (!dest || dest.type !== itemType) throw new CollectionError('Choose a type-matched destination saved for this account.')
  const key = keyFor(deps.connection)
  const token = siteSaveKey(userId,itemType,itemId,destinationId)
  if (activeSiteSaves.size >= 4) throw new CollectionError('Collection saves are busy. Try again shortly.', 429)
  activeSiteSaves.add(token)
  const record: SiteCollectionSave = { itemType,itemId,destinationId,status:'running',message:'Saving the existing Site item.',updatedAt:new Date().toISOString() }
  let attempted = false
  let articleBrowsingRevision:string|undefined
  try {
    storeSiteSave(userId,record)
    // Verify the actual Site model/artwork and parent-post relationship using
    // fixed documented reads. Never accept a URL or a version ID as a model ID.
    if (itemType === 'Model') {
      const model = await siteJson(key, `models/${itemId}`)
      if (model?.id !== itemId) throw new CollectionError('This Site model is unavailable.', 404)
    } else if(itemType==='Article') {
      const preference=getBrowsingPreference(userId)
      articleBrowsingRevision=preference.revision
      const article=await readPublicSiteCollectionResource(`articles/${itemId}`)
      assertConnectionCurrent(key)
      if(getBrowsingPreference(userId).revision!==preference.revision||article?.id!==itemId||article.status!=='Published'||!ratingAllowed(contentRating(article),preference.mode))throw new CollectionError('This published article is unavailable under your browsing preference or Civitai restrictions.',404)
    } else {
      const artworkId = itemType === 'Image' ? itemId : body.artworkId
      if (!validId(artworkId)) throw new CollectionError('A Site artwork ID is required to save its parent post.')
      const page = await siteJson(key, `images?${new URLSearchParams({ imageId: String(artworkId), limit: '1', nsfw: 'false' })}`)
      const artwork = Array.isArray(page?.items) ? page.items.find((item: any) => item?.id === artworkId) : null
      if (!artwork || !['image','video'].includes(artwork.type) || (itemType === 'Post' && artwork.postId !== itemId)) throw new CollectionError('The Site artwork or its parent post is unavailable or changed.',404)
    }
    assertConnectionCurrent(key)
    const current = destination(userId,destinationId)
    if (!current || current.type !== itemType) throw new CollectionError('The saved destination changed. No collection save was sent.',409)
    const result = await callCivitaiTool(key,'add_to_collection',{ itemType,itemId,collectionIds:[destinationId] }, { uncertainAfterDispatch:true, beforeDispatch:()=>{ if(articleBrowsingRevision&&getBrowsingPreference(userId).revision!==articleBrowsingRevision)throw new CollectionError('Browsing preferences changed. Review the article again.',409); if(destination(userId,destinationId)?.type!==itemType || getSiteSave(userId,itemType,itemId,destinationId)?.status!=='running')throw new CollectionError('The saved item or destination changed.',409); attempted=true } })
    if (result.ok !== true || result.itemType !== itemType || result.itemId !== itemId || !Array.isArray(result.collectionIds) || result.collectionIds.length !== 1 || result.collectionIds[0] !== destinationId) throw new McpError('Civitai returned an incomplete collection-save acknowledgement.',true)
    record.status = 'succeeded'; record.message = 'Civitai MCP acknowledged this save. Open the collection to inspect visibility or any review requirements; private membership is not independently readable here.'
  } catch (error) {
    record.status = error instanceof McpError ? (error.ambiguous ? 'uncertain' : 'failed') : attempted ? 'uncertain' : 'failed'
    record.message = error instanceof McpError || error instanceof CollectionError || error instanceof SiteError ? error.message : 'The collection save could not be confirmed.'
    if (record.status === 'uncertain') record.message += ' Inspect the item and collection on Civitai; automatic repetition is blocked.'
  } finally {
    // Persist before releasing the lock. An interrupted running row is read as uncertain.
    try { storeSiteSave(userId,record) } finally { activeSiteSaves.delete(token) }
  }
  assertConnectionCurrent(key)
  if(articleBrowsingRevision&&getBrowsingPreference(userId).revision!==articleBrowsingRevision)throw new CollectionError('Browsing preferences changed. Reload the saved action status.',409)
  return json({ save: record })
}
const activeDestinations = new Set<string>()
export const collectionWorkBusy = () => active.size > 0 || activeSiteSaves.size > 0 || activeDestinations.size > 0 || collectionManagementBusy()
export async function collectionApi(request: Request, url: URL, userId: string, deps: Dependencies): Promise<Response> {
  const destinationMutation = ['POST','PUT','PATCH','DELETE'].includes(request.method) && url.pathname.includes('/collections/destinations')
  if (destinationMutation && activeDestinations.has(userId)) return json({error:{message:'A destination change is in progress. Wait before retrying.'}},409)
  if (destinationMutation) activeDestinations.add(userId)
  try {
    const path = url.pathname.slice('/api/studio/v1/collections'.length)
    const managed=await collectionManagementApi(request,url,userId,deps)
    if(managed)return managed
    if (path === '/batches' || path.startsWith('/batches/')) return await batchApi(request,path,userId,deps)
    if (path === '/site-saves' && ['GET','POST'].includes(request.method)) return await siteSaveApi(request,url,userId,deps)
    const publicationMatch = /^\/transfers\/([^/]+)\/publication$/.exec(path)
    if (request.method === 'POST' && publicationMatch) {
      const outputId = decodeURIComponent(publicationMatch[1]!)
      const body = await deps.readBody(request)
      if (!body || outputId.length > 160) throw new CollectionError('Choose a saved Studio transfer.')
      return await publishSavedDraft(userId,outputId,body,deps)
    }
    const previewMatch = /^\/transfers\/([^/]+)\/preview$/.exec(path)
    if (request.method === 'GET' && previewMatch) {
      const outputId = decodeURIComponent(previewMatch[1]!)
      const found = checkImage(deps.ownedOutput(userId, outputId))
      const image = await originalImage(await deps.outputContent(userId, found.generation, outputId, maxImageBytes))
      return new Response(image.bytes, { headers: { 'Content-Type': image.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
    }
    const transferMatch = /^\/transfers\/([^/]+)(\/retry)?$/.exec(path)
    if (request.method === 'GET' && transferMatch && !transferMatch[2]) {
      const outputId = decodeURIComponent(transferMatch[1]!); checkImage(deps.ownedOutput(userId, outputId))
      const record = getTransfer(userId, outputId); return json({ transfer: record ? publicTransfer(userId, record) : null })
    }
    if (request.method === 'POST' && (path === '/transfers' || transferMatch?.[2])) {
      const body = await deps.readBody(request)
      if (!body || body.confirm !== true) throw new CollectionError('Confirm the upload and Civitai post action explicitly.')
      const outputId = transferMatch ? decodeURIComponent(transferMatch[1]!) : body.outputId
      if (typeof outputId !== 'string' || outputId.length > 160) throw new CollectionError('Choose one owned output.')
      const found = checkImage(deps.ownedOutput(userId, outputId))
      const previous = getTransfer(userId, outputId)
      keyFor(deps.connection, previous?.post !== 'succeeded')
      if (previous) {
        if (transferMatch?.[2]) {
          if (!publicTransfer(userId, previous).canRetry) throw new CollectionError('This action cannot be retried automatically. Inspect its saved post and stages.', 409)
          start(userId, previous, deps)
        }
        return json({ transfer: publicTransfer(userId, previous) }, 202)
      }
      if (transferMatch) throw new CollectionError('Transfer not found.', 404)
      if (!validId(body.destinationId) || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || (body.publish !== undefined && typeof body.publish !== 'boolean')) throw new CollectionError('Choose a saved destination, a title of 1–200 characters, and draft or publish.')
      const dest = destination(userId, body.destinationId)
      if (!dest) throw new CollectionError('Save this destination for your account before posting.', 404)
      if (dest.type !== 'Image' && dest.type !== 'Post') throw new CollectionError('Generated images require an Image or Post destination.')
      const record: StoredTransfer = { outputId, generationId: String(found.generation.id), destinationId: dest.id, destinationName: dest.name, destinationType: dest.type, title: body.title.trim(), publishRequested: body.publish === true, upload: 'pending', post: 'pending', membership: 'pending', publication: 'not-created', sitePostId: null, siteImageIds: [], message: 'Ready to upload the original.', active: false, canRetry: true, updatedAt: new Date().toISOString(), postUrl: null }
      storeTransfer(userId, record); start(userId, record, deps)
      return json({ transfer: publicTransfer(userId, record) }, 202)
    }
    throw new CollectionError('Collection action not found.', 404)
  } catch (error) {
    const safe = error instanceof ConnectionError || error instanceof CollectionError || error instanceof McpError
    return json({ error: { code: 'collection_action_failed', message: safe ? error.message + (error instanceof McpError && error.ambiguous ? ' Inspect Civitai before repeating this action.' : '') : 'The collection service is unavailable.', requestId: crypto.randomUUID() } }, error instanceof ConnectionError ? 403 : safe ? error.status : 502)
  } finally { if(destinationMutation) activeDestinations.delete(userId) }
}
