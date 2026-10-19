import { useEffect, useRef, useState } from 'react'
import { Star } from 'lucide-react'
import { studioApi, type FavoriteState } from './api'
import { Button } from './ui'

export function ModelFavorite({ accountId,modelId,initialFavorite,writeAllowed,reason,load=false,onConfirmed }: {
 accountId:string;modelId:number;initialFavorite?:boolean;writeAllowed:boolean;reason:string;load?:boolean;
 onConfirmed:(modelId:number,favorited:boolean)=>void
}) {
 const [state,setState]=useState<FavoriteState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const request=useRef<AbortController|null>(null),working=useRef(false)
 useEffect(()=>{
  setState(null);setError('');setBusy(false);working.current=false
  if(load)void act()
  return()=>{request.current?.abort();working.current=false}
 },[accountId,modelId,load])
 async function act(setTo?:boolean) {
  if(working.current)return
  const controller=new AbortController();request.current=controller;working.current=true;setBusy(true);setError('')
  try {
   const next=setTo===undefined?await studioApi.modelFavorite(accountId,modelId,controller.signal):await studioApi.setModelFavorite(accountId,modelId,setTo,crypto.randomUUID(),controller.signal)
   if(controller.signal.aborted)return
   setState(next)
   if(next.favorited!==null && !['sending','uncertain'].includes(next.status))onConfirmed(modelId,next.favorited)
  }catch(error){if(!controller.signal.aborted)setError((error instanceof Error?error.message:'Favorite request failed.')+(setTo===undefined?'':' Check status before repeating a change.'))}
  finally{if(!controller.signal.aborted){working.current=false;setBusy(false)}}
 }
 const favorite=state?state.favorited:initialFavorite??null
 const pending=state?.pendingSetTo
 const target=pending!==null&&pending!==undefined?pending:favorite!==true
 const allowed=writeAllowed && state?.writeAllowed!==false
 return <div className="mt-2">
  <Button type="button" variant="secondary" size="sm" disabled={busy||!allowed} title={state?.reason||reason||undefined} onClick={()=>void act(target)}>
   <Star size={14} fill={favorite===true?'currentColor':'none'} />{busy?'Checking…':pending!==null&&pending!==undefined?(target?'Retry adding favorite':'Retry removing favorite'):favorite===true?'Remove favorite':'Add favorite'}
  </Button>
  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>void act()}>Check favorite status</Button>
  {(state?.reason||reason)&&<p className="field-help">{state?.reason||reason}</p>}
  {state?.message&&<p className="field-help" role="status">{state.message}</p>}
  {error&&<p className="field-help" role="alert">{error}</p>}
 </div>
}
