import { db } from './storage';
import { resolveBearer, assertConnectionCurrent, ConnectionError, type BearerLease } from './connection';
import { siteJson, SiteError } from './models';
import { callCivitaiTool, McpError } from './civitai-mcp';
import { getBrowsingPreference } from './browsing';
import { resourceAllowed } from '../shared/browsing';

const SOCIAL_WRITE = 524288;
const active = new Set<string>();
db.exec(`CREATE TABLE IF NOT EXISTS model_favorite_actions (
 user_id TEXT NOT NULL, request_id TEXT NOT NULL, model_id INTEGER NOT NULL,
 set_to INTEGER NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id)
); CREATE INDEX IF NOT EXISTS favorite_actions_model ON model_favorite_actions(user_id,model_id,created_at);`);
type Action = { request_id:string; model_id:number; set_to:number; status:string; message:string; created_at:number };
const json = (value:unknown,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
function capability(key:BearerLease) {
 const allowed=key.kind==='api_key' && (key.scopes===null || (key.scopes&SOCIAL_WRITE)!==0);
 return {writeAllowed:allowed,reason:key.kind==='oauth'?'Favorites browsing works with OAuth. Favorite changes currently require an explicit API-key connection; hosted MCP OAuth writes are unverified.':!allowed?'Favorite changes require SocialWrite permission on your API key.':''};
}
function latest(userId:string,modelId:number):Action|null {
 return db.query<Action,[string,number]>('SELECT * FROM model_favorite_actions WHERE user_id=? AND model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(userId,modelId);
}
function update(userId:string,action:Action,status:string,message:string) {
 db.query('UPDATE model_favorite_actions SET status=?,message=? WHERE user_id=? AND request_id=?').run(status,message,userId,action.request_id);
 action.status=status;action.message=message;
}
async function readFavorite(key:BearerLease,modelId:number):Promise<boolean|null> {
 // Match the account's browsing policy. Absence of an inaccessible/hidden
 // model is unknown, not proof that a favorite was removed.
 const preference=getBrowsingPreference(key.userId);
 const query=new URLSearchParams({ids:String(modelId),limit:'1',nsfw:preference.mode==='safe'?'false':'true'});
 const visible=await siteJson(key,`models?${query}`);
 if(getBrowsingPreference(key.userId).revision!==preference.revision)throw new SiteError('Browsing preference changed. Refresh favorite status.',409);
 if(!Array.isArray(visible.items)||!visible.items.some((item:any)=>item.id===modelId&&resourceAllowed(item,preference.mode)))return null;
 query.set('favorites','true');
 const favorites=await siteJson(key,`models?${query}`);
 if(getBrowsingPreference(key.userId).revision!==preference.revision)throw new SiteError('Browsing preference changed. Refresh favorite status.',409);
 if(!Array.isArray(favorites.items)||favorites.items.some((item:any)=>item.id!==modelId))throw new SiteError('Civitai returned inconsistent favorite information.');
 assertConnectionCurrent(key);
 return favorites.items.some((item:any)=>item.id===modelId);
}
function result(key:BearerLease,favorited:boolean|null,action:Action|null) {
 return {favorited,...capability(key),status:action?.status??'read',message:action && ['sending','uncertain','failed'].includes(action.status)?action.message:favorited===null?'Favorite status is unavailable for this model.':favorited?'Civitai currently lists this model as a favorite.':'Civitai does not currently list this visible model as a favorite.',pendingSetTo:action && ['sending','uncertain'].includes(action.status)?!!action.set_to:null};
}
export async function favoriteApi(request:Request,userId:string,modelId:number,readBody:(request:Request)=>Promise<Record<string,unknown>|null>) {
 const lock=`${userId}:${modelId}`;
 if(active.has(lock))return json({error:{message:'This favorite is being updated. Check its status shortly.'}},409);
 if(active.size>=4)return json({error:{message:'Favorite requests are busy. Try again shortly.'}},429);
 active.add(lock);
 try {
  const key=await resolveBearer(userId,{requiredScopes:4,service:'site'});
  if(request.method==='GET') {
   const action=latest(userId,modelId);
   if(action?.status==='sending')update(userId,action,'uncertain','The earlier favorite request was interrupted. Check status before changing it.');
   const favorited=await readFavorite(key,modelId);
   if(action?.status==='uncertain' && favorited!==null && favorited===!!action.set_to)update(userId,action,'confirmed','Civitai now reports the requested favorite state.');
   return json(result(key,favorited,action));
  }
  if(request.method!=='PUT')return json({error:{message:'Unsupported favorite action.'}},405);
  const body=await readBody(request);
  if(!body || Object.keys(body).some(name=>!['setTo','requestId'].includes(name)) || typeof body.setTo!=='boolean' || typeof body.requestId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId))return json({error:{message:'Choose an explicit favorite state and request ID.'}},400);
  assertConnectionCurrent(key);
  if(!capability(key).writeAllowed)return json({error:{message:capability(key).reason}},403);
  const duplicate=db.query<Action,[string,string]>('SELECT * FROM model_favorite_actions WHERE user_id=? AND request_id=?').get(userId,body.requestId);
  if(duplicate) {
   if(duplicate.model_id!==modelId || !!duplicate.set_to!==body.setTo)return json({error:{message:'This request ID belongs to a different favorite action.'}},409);
   // A repeated request never dispatches, even if a newer action superseded it.
   return json(result(key,await readFavorite(key,modelId),latest(userId,modelId)));
  }
  const prior=latest(userId,modelId);
  const current=await readFavorite(key,modelId);
  assertConnectionCurrent(key);
  if(prior && ['sending','uncertain'].includes(prior.status)) {
   if(current!==null && current===!!prior.set_to)update(userId,prior,'confirmed','Civitai reports the earlier requested state.');
   else if(body.setTo!==!!prior.set_to)return json({error:{message:'The earlier favorite change is uncertain. Check its status or explicitly retry the same requested value before reversing it.'}},409);
  }
  const action:Action={request_id:body.requestId,model_id:modelId,set_to:Number(body.setTo),status:current===body.setTo?'confirmed':'sending',message:current===body.setTo?'Civitai already reports this favorite state.':'Favorite change awaiting confirmation.',created_at:Date.now()};
  db.query('INSERT INTO model_favorite_actions VALUES (?,?,?,?,?,?,?)').run(userId,action.request_id,modelId,action.set_to,action.status,action.message,action.created_at);
  if(current===body.setTo)return json(result(key,current,action));
  let sent=false;
  try {
   const ack=await callCivitaiTool(key,'toggle_favorite_model',{modelId,setTo:body.setTo},{uncertainAfterDispatch:true,beforeDispatch:()=>{
    assertConnectionCurrent(key);
    if(key.kind!=='api_key'||latest(userId,modelId)?.request_id!==action.request_id)throw new ConnectionError('connection_changed');
    sent=true;
   }});
   if(ack.ok!==true || ack.modelId!==modelId || ack.favorited!==body.setTo)throw new McpError('Civitai did not confirm the requested favorite state.',true);
   const observed=await readFavorite(key,modelId);
   if(observed===body.setTo)update(userId,action,'confirmed','Civitai reports the requested favorite state.');
   else update(userId,action,'uncertain','The write was acknowledged, but its state is not confirmed by the favorites list. Check status before reversing it.');
   return json(result(key,observed,action));
  }catch(error) {
   const uncertain=sent || error instanceof McpError && error.ambiguous;
   update(userId,action,uncertain?'uncertain':'failed',uncertain?'Favorite change may have completed. Check status; an explicit retry sets the same value and never blindly toggles.':error instanceof ConnectionError||error instanceof McpError?error.message:'Favorite request failed before dispatch.');
   return json(result(key,null,action));
  }
 }catch(error){return json({error:{message:error instanceof ConnectionError||error instanceof SiteError?error.message:'Favorite information is temporarily unavailable.'}},error instanceof ConnectionError?403:error instanceof SiteError?error.status:502)}
 finally{active.delete(lock)}
}
