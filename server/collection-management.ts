import { assertConnectionCurrent, ConnectionError, type BearerLease } from './connection'
import { callCivitaiTool, McpError } from './civitai-mcp'
import { db } from './storage'
import { getBrowsingPreference } from './browsing'
import { contentRating, ratingAllowed, type BrowsingMode } from '../shared/browsing'
import { safeSiteMediaUrl } from './models'
import type { CollectionDestination, CollectionFollow, CollectionMutation, CollectionType, PublicCollection } from '../shared/collections'

type Dependencies = { connection:BearerLease; readBody:(request:Request)=>Promise<Record<string,unknown>|null> }
const types = ['Image','Post','Model','Article']
const validId = (value:unknown):value is number => Number.isInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const plain = (value:unknown):value is Record<string,unknown> => !!value&&typeof value==='object'&&!Array.isArray(value)
const only = (value:Record<string,unknown>,keys:string[]) => Object.keys(value).every(key=>keys.includes(key))
const text = (value:unknown,length:number) => typeof value==='string'?value.replace(/<[^>]*>/g,'').slice(0,length):''
const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}})
class ManagementError extends Error { constructor(message:string,readonly status=400,readonly code='collection_action_failed'){super(message)} }
const activeFollows = new Set<string>()
const activeMutations = new Set<string>()
export const collectionManagementBusy = () => activeFollows.size > 0 || activeMutations.size > 0
db.exec(`CREATE TABLE IF NOT EXISTS collection_follows(user_id TEXT NOT NULL,collection_id INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(user_id,collection_id));
CREATE TABLE IF NOT EXISTS collection_mutations(user_id TEXT NOT NULL,collection_id INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(user_id,collection_id));`)
function storeDestination(userId:string,item:CollectionDestination) {
 db.query('INSERT INTO collection_destinations VALUES (?,?,?) ON CONFLICT(user_id,collection_id) DO UPDATE SET record_json=excluded.record_json').run(userId,item.id,JSON.stringify(item))
}
function destination(userId:string,id:number):CollectionDestination|null {
 const row=db.query<{record_json:string},[string,number]>('SELECT record_json FROM collection_destinations WHERE user_id=? AND collection_id=?').get(userId,id)
 if(!row)return null
 const item=JSON.parse(row.record_json) as CollectionDestination
 if(!item.revision){item.revision=crypto.randomUUID();storeDestination(userId,item)}
 return item
}
function publicDestination(item:CollectionDestination,mode:BrowsingMode):CollectionDestination {
 // Saved metadata is not a fresh, individually rated cover authorization.
 return {...item,coverUrl:null}
}
function writePermission(key:BearerLease) {
 assertConnectionCurrent(key)
 if(key.scopes!==null&&(key.scopes&262144)!==262144)throw new ManagementError('Collections Write permission is required. Reconnect an account key with that permission.',403)
}
function browsing(request:Request,userId:string) {
 const preference=getBrowsingPreference(userId)
 if(request.headers.get('X-Studio-Browsing')!==preference.revision)throw new ManagementError('Browsing preferences changed. Refresh Settings before discovering collections.',409,'browsing_changed')
 return preference
}
function current(deps:Dependencies,userId:string,revision?:string) {
 assertConnectionCurrent(deps.connection)
 if(deps.connection.userId!==userId)throw new ManagementError('The active account changed.',403)
 if(revision&&getBrowsingPreference(userId).revision!==revision)throw new ManagementError('Browsing preferences changed. Refresh collections.',409,'browsing_changed')
}
export async function readPublicSiteCollectionResource(path:string):Promise<any> {
 // Paths are constructed exclusively by reviewed collection/article handlers.
 if(!/^(?:collections(?:\/[1-9]\d*)?|articles\/[1-9]\d*)(?:\?[^#]*)?$/.test(path))throw new ManagementError('Unsupported public resource.')
 let response:Response
 try{response=await fetch(`https://civitai.com/api/v1/${path}`,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)})}catch{throw new ManagementError('Civitai discovery is temporarily unavailable. Try again later.',502)}
 if(!response.ok){await response.body?.cancel();throw new ManagementError(response.status===404?'This item is private, unlisted, unavailable under regional restrictions, or missing. Open Civitai to check it.':response.status===429?'Civitai is rate limiting discovery. Wait before trying again.':'Civitai could not load this information.',response.status===404?404:response.status===429?429:502)}
 const reader=response.body?.getReader();if(!reader)throw new ManagementError('Civitai returned an empty response.',502)
 const chunks:Uint8Array[]=[];let size=0
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();throw new ManagementError('Civitai returned too much collection information.',502)}chunks.push(value)}}finally{reader.releaseLock()}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new ManagementError('Civitai returned invalid collection information.',502)}
}
function collection(raw:any,mode:BrowsingMode):PublicCollection|null {
 if(!validId(raw?.id)||raw.read!=='Public')return null
 const rating=contentRating(raw)
 if(!ratingAllowed(rating,mode))return null
 // Collection masks describe the collection, not its cover. The current REST
 // response flattens away the cover rating, so it cannot qualify a safe preview.
 const cover=plain(raw.coverImage)&&ratingAllowed(contentRating(raw.coverImage),mode)?safeSiteMediaUrl(raw.coverImage.url):null
 return {id:raw.id,name:text(raw.name,100),description:text(raw.description,1000),type:text(raw.type,30),read:'Public',creator:text(raw.user?.username,100),itemCount:Number.isInteger(raw.itemCount)&&raw.itemCount>=0?raw.itemCount:null,coverUrl:cover,rating,url:`https://${mode==='mature'?'civitai.red':'civitai.com'}/collections/${raw.id}`}
}
function getFollow(userId:string,id:number):CollectionFollow {
 const row=db.query<{record_json:string},[string,number]>('SELECT record_json FROM collection_follows WHERE user_id=? AND collection_id=?').get(userId,id)
 const record:CollectionFollow=row?JSON.parse(row.record_json):{collectionId:id,revision:crypto.randomUUID(),state:'unknown',following:null,requestedFollowing:null,message:'Your current Civitai follow state is not exposed by the public API. Choose an explicit action.',updatedAt:new Date().toISOString()}
 if(record.state==='running'&&!activeFollows.has(`${userId}:${id}`)){record.state='uncertain';record.revision=crypto.randomUUID();record.message='This follow request was interrupted. Check Civitai directly; Studio cannot safely repeat it without knowing its result.'}
 saveFollow(userId,record);return record
}
function saveFollow(userId:string,record:CollectionFollow) {
 db.query('INSERT INTO collection_follows VALUES (?,?,?) ON CONFLICT(user_id,collection_id) DO UPDATE SET record_json=excluded.record_json').run(userId,record.collectionId,JSON.stringify(record))
}
function mutation(userId:string,id:number):CollectionMutation|null {
 const row=db.query<{record_json:string},[string,number]>('SELECT record_json FROM collection_mutations WHERE user_id=? AND collection_id=?').get(userId,id)
 if(!row)return null
 const record:CollectionMutation=JSON.parse(row.record_json)
 if(record.state==='running'&&!activeMutations.has(`${userId}:${id}`)){record.state='uncertain';record.message='An earlier collection change was interrupted. Check Civitai before making another change here.';saveMutation(userId,id,record)}
 return record
}
function saveMutation(userId:string,id:number,value:CollectionMutation){db.query('INSERT INTO collection_mutations VALUES (?,?,?) ON CONFLICT(user_id,collection_id) DO UPDATE SET record_json=excluded.record_json').run(userId,id,JSON.stringify(value))}
function clearMutation(userId:string,id:number){db.query('DELETE FROM collection_mutations WHERE user_id=? AND collection_id=?').run(userId,id)}

export async function collectionManagementApi(request:Request,url:URL,userId:string,deps:Dependencies):Promise<Response|null> {
 const path=url.pathname.slice('/api/studio/v1/collections'.length)
 if(!/^\/(public|destinations|follows)(?:\/|$)/.test(path))return null
 try {
 current(deps,userId)
 if(request.method==='GET'&&path==='/public') {
  const preference=browsing(request,userId),query=url.searchParams.get('query')??'',sort=url.searchParams.get('sort')??'Newest',cursor=url.searchParams.get('cursor')
  if([...url.searchParams.keys()].some(key=>!['query','sort','cursor'].includes(key))||query.length>100||!['Newest','Most Followers'].includes(sort)||(cursor&&(!validId(Number(cursor))||sort!=='Newest')))throw new ManagementError('Choose a valid collection search and sort. Only Newest supports more pages.')
  const params=new URLSearchParams({limit:'30',query,sort,nsfw:String(preference.mode!=='safe')});if(cursor)params.set('cursor',cursor)
  const result=await readPublicSiteCollectionResource(`collections?${params}`)
  current(deps,userId,preference.revision)
  return json({items:(Array.isArray(result.items)?result.items:[]).slice(0,30).map((item:any)=>collection(item,preference.mode)).filter(Boolean),nextCursor:sort==='Newest'&&validId(result.metadata?.nextCursor)?result.metadata.nextCursor:null})
 }
 const publicMatch=/^\/public\/(\d+)$/.exec(path)
 if(request.method==='GET'&&publicMatch) {
  const id=Number(publicMatch[1]);if(!validId(id))throw new ManagementError('Invalid collection ID.')
  const preference=browsing(request,userId),raw=await readPublicSiteCollectionResource(`collections/${id}`)
  current(deps,userId,preference.revision)
  const item=collection(raw,preference.mode)
  if(!item||item.id!==id)throw new ManagementError('This collection is not available under your browsing preference or Civitai restrictions.',404)
  return json({collection:item})
 }
 const followMatch=/^\/follows\/(\d+)$/.exec(path)
 if(followMatch&&['GET','POST'].includes(request.method)) {
  const id=Number(followMatch[1]);if(!validId(id))throw new ManagementError('Invalid collection ID.')
  if(request.method==='GET')return json({follow:getFollow(userId,id)})
  const body=await deps.readBody(request);current(deps,userId)
  if(!plain(body)||!only(body,['revision','following','confirm'])||typeof body.following!=='boolean'||body.confirm!==true)throw new ManagementError('Explicitly choose Follow or Unfollow.')
  const record=getFollow(userId,id),token=`${userId}:${id}`
  if(body.revision!==record.revision)throw new ManagementError('Follow status changed. Reload it before another action.',409)
  if(['running','uncertain'].includes(record.state))return json({follow:record})
  if(record.state==='confirmed'&&record.following===body.following)return json({follow:record})
  writePermission(deps.connection)
  if(activeFollows.size>=4)throw new ManagementError('Collection changes are busy. Try again shortly.',429)
  activeFollows.add(token);let dispatched=false
  record.state='running';record.requestedFollowing=body.following;record.revision=crypto.randomUUID();record.message='Waiting for Civitai to confirm this follow action.';saveFollow(userId,record)
  try {
   const result=await callCivitaiTool(deps.connection,'follow_collection',{collectionId:id,unfollow:!body.following},{uncertainAfterDispatch:true,beforeDispatch:()=>{current(deps,userId);dispatched=true}})
   if(result.ok!==true||result.collectionId!==id||result.following!==body.following)throw new McpError('Civitai did not confirm the requested follow state.',true)
   record.state='confirmed';record.following=body.following;record.message=`Civitai confirmed ${body.following?'Following':'Unfollowed'}. Changes made on Civitai later cannot be read here.`
  } catch(error) {
   record.state=dispatched||error instanceof McpError&&error.ambiguous?'uncertain':'failed'
   record.message=record.state==='uncertain'?'The follow action may have completed. Check Civitai directly; further follow changes are blocked here to avoid repeating an unknown result.':error instanceof Error?error.message:'No follow action was sent. Try again later.'
  } finally {record.revision=crypto.randomUUID();record.updatedAt=new Date().toISOString();saveFollow(userId,record);activeFollows.delete(token)}
  current(deps,userId);return json({follow:record})
 }
 if(request.method==='GET'&&path==='/destinations') {
  const mode=getBrowsingPreference(userId).mode
  const rows=db.query<{collection_id:number},[string]>('SELECT collection_id FROM collection_destinations WHERE user_id=? ORDER BY collection_id DESC').all(userId)
  const pending=db.query<{collection_id:number},[string]>('SELECT collection_id FROM collection_mutations WHERE user_id=?').all(userId)
  return json({items:rows.map(row=>publicDestination(destination(userId,row.collection_id)!,mode)),pendingActions:pending.map(row=>mutation(userId,row.collection_id))})
 }
 const savedMatch=/^\/destinations\/(\d+)$/.exec(path)
 if(savedMatch&&['PATCH','DELETE'].includes(request.method)) {
  const id=Number(savedMatch[1]),body=await deps.readBody(request);current(deps,userId)
  if(!validId(id)||!plain(body)||!only(body,request.method==='PATCH'?['revision','label']:['revision']))throw new ManagementError('Invalid saved collection action.')
  const item=destination(userId,id);if(!item)throw new ManagementError('Saved collection not found.',404)
  if(body.revision!==item.revision)throw new ManagementError('This saved collection changed. Reload before editing it.',409)
  if(request.method==='PATCH') {
   if(typeof body.label!=='string'||!body.label.trim()||body.label.trim().length>80)throw new ManagementError('Use a local label of 1–80 characters.')
   item.label=body.label.trim();item.revision=crypto.randomUUID();storeDestination(userId,item)
   return json({destination:publicDestination(item,getBrowsingPreference(userId).mode)})
  }
  // This only forgets the local shortcut. Provider collection, memberships,
  // transfer recovery records, and uncertain follow/edit records remain intact.
  db.query('DELETE FROM collection_destinations WHERE user_id=? AND collection_id=?').run(userId,id)
  return json({deleted:true})
 }
 if((request.method==='POST'&&path==='/destinations')||(request.method==='PUT'&&savedMatch)) {
  const body=await deps.readBody(request);current(deps,userId)
  if(!plain(body)||!only(body,['mode','id','name','description','type','read','write','nsfw','confirm','revision'])||!['create','save'].includes(String(body.mode))||typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>30||typeof body.description!=='string'||body.description.length>300||!types.includes(String(body.type))||!['Private','Public','Unlisted'].includes(String(body.read)))throw new ManagementError('Choose an item type, a name of 1–30 characters, a description up to 300 characters, and visibility.')
  const existingId=savedMatch?Number(savedMatch[1]):null
  if(existingId!==null&&!validId(existingId))throw new ManagementError('Invalid collection ID.')
  const existing=existingId?destination(userId,existingId):null
  if(existingId&&(!existing||existing.source!=='created'))throw new ManagementError('Edit collections created through this Studio account here. Manage other collections on Civitai.',404)
  if(existing&&(body.revision!==existing.revision||existing.type!==body.type))throw new ManagementError('The collection changed. Reload before editing; its item type cannot change.',409)
  const read=body.read as CollectionDestination['read'],write=body.write===undefined?'Private':body.write,nsfw=body.nsfw===undefined?false:body.nsfw
  if(!['Private','Public','Review'].includes(String(write))||typeof nsfw!=='boolean')throw new ManagementError('Choose valid contribution access and a mature-content preference.')
  const record:CollectionDestination={id:0,name:body.name.trim(),description:body.description,type:body.type as CollectionType,read,write:write as CollectionDestination['write'],nsfw,source:body.mode==='save'&&!existing?'saved':'created',verified:false,revision:crypto.randomUUID(),...(existing?.label?{label:existing.label}:{})}
  if(record.source==='saved') {
   if(!validId(body.id)||body.confirm!==true)throw new ManagementError('Supply a Civitai collection ID and confirm this saved shortcut.')
   record.id=body.id
   const prior=destination(userId,record.id);if(prior)return json({destination:publicDestination(prior,getBrowsingPreference(userId).mode)})
   if(db.query<{n:number},[string]>('SELECT count(*) n FROM collection_destinations WHERE user_id=?').get(userId)!.n>=200)throw new ManagementError('You can keep up to 200 saved collection shortcuts. Forget one before adding another.')
   const preference=getBrowsingPreference(userId)
   try {
    const raw=await readPublicSiteCollectionResource(`collections/${record.id}`)
    current(deps,userId,preference.revision)
    const remote=collection(raw,preference.mode)
    if(!remote||remote.id!==record.id)throw new ManagementError('This collection is not available under your browsing preference.',404)
    if(!types.includes(remote.type))throw new ManagementError('This collection uses an unsupported item type.')
    Object.assign(record,{name:remote.name,description:remote.description,type:remote.type,read:'Public',verified:true,coverUrl:remote.coverUrl,itemCount:remote.itemCount,rating:remote.rating,nsfw:remote.rating?.level!==1})
   } catch(error){if(!(error instanceof ManagementError&&error.status===404))throw error}
   current(deps,userId,preference.revision);storeDestination(userId,record)
   return json({destination:publicDestination(record,preference.mode)},201)
  }
  if((read!=='Private'||write!=='Private')&&body.confirm!==true)throw new ManagementError('Confirm the visibility and contribution access before changing this Civitai collection.')
  const preference=getBrowsingPreference(userId)
  if(nsfw&&preference.mode!=='mature')throw new ManagementError('Enable mature browsing in Settings before creating a mature collection.',403)
  const key=existingId??0,token=`${userId}:${key}`
  if(mutation(userId,key))throw new ManagementError('An earlier collection change has an unconfirmed result. Inspect Civitai; Studio will not repeat it. You can save a known collection ID instead.',409)
  writePermission(deps.connection)
  if(!existing&&db.query<{n:number},[string]>('SELECT count(*) n FROM collection_destinations WHERE user_id=?').get(userId)!.n>=200)throw new ManagementError('Forget a saved collection shortcut before creating another.')
  activeMutations.add(token);let dispatched=false
  const pending:CollectionMutation={collectionId:existingId,name:record.name,state:'running',message:'Waiting for Civitai to confirm this collection change.'};saveMutation(userId,key,pending)
  try {
   const result=await callCivitaiTool(deps.connection,'upsert_collection',{...(existingId?{id:existingId}:{}),name:record.name,description:record.description,type:record.type,read:record.read,write:record.write,nsfw:record.nsfw},{uncertainAfterDispatch:true,beforeDispatch:()=>{current(deps,userId,preference.revision);if(existingId&&destination(userId,existingId)?.revision!==existing?.revision)throw new ManagementError('This saved collection changed before dispatch.',409);dispatched=true}})
   if(result.ok!==true||!validId(result.id)||(existingId&&result.id!==existingId)||result.name!==record.name||result.type!==record.type)throw new McpError('Civitai did not confirm the collection identity.',true)
   record.id=result.id;record.verified=true
   // A dispatched receipt belongs to the original account even after logout;
   // persist it for recovery, then reject a stale response to the browser.
   storeDestination(userId,record);clearMutation(userId,key)
  } catch(error) {
   if(dispatched||error instanceof McpError&&error.ambiguous){pending.state='uncertain';pending.message='This change may have completed. Inspect the collection on Civitai; repeating it here is blocked.';saveMutation(userId,key,pending)}else clearMutation(userId,key)
   throw error
  } finally {activeMutations.delete(token)}
  current(deps,userId);return json({destination:publicDestination(record,getBrowsingPreference(userId).mode)},existing?200:201)
 }
 throw new ManagementError('Collection action not found.',404)
 }catch(error){return json({error:{code:error instanceof ManagementError?error.code:'collection_action_failed',message:error instanceof ManagementError||error instanceof McpError||error instanceof ConnectionError?error.message:'The collection service is unavailable.'}},error instanceof ManagementError||error instanceof McpError?error.status:error instanceof ConnectionError?403:502)}
}
