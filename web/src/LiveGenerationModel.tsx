import { useEffect, useRef, useState } from 'react'
import type { GenerationServices } from '../../shared/generation-services'
import type { WorkflowId } from '../../shared/workflows'
import { studioApi } from './api'
import { Select } from './controls'
import { Button } from './ui'
import { serviceChoice, servicesForWorkflow } from './service-models'
import './generation-services.css'

export type ModelSelection = {value:string;options:{value:string;label:string}[];onChange:(value:string)=>void;readOnly?:boolean;hint?:string}
export function LiveGenerationModel({workflow,selection,accountId,revision,connected}:{workflow:WorkflowId;selection:ModelSelection;accountId?:string|null;revision?:string;connected?:boolean}) {
  const [catalog,setCatalog]=useState<GenerationServices|null>(null)
  const [loading,setLoading]=useState(false),[error,setError]=useState('')
  const request=useRef<AbortController|null>(null)
  const catalogScope=useRef('')
  const scope=`${accountId}:${revision}:${connected}`
  const currentScope=useRef(scope);currentScope.current=scope
  async function load(refresh=false) {
    if(!accountId||!connected||!revision)return
    if(request.current&&!request.current.signal.aborted)return
    const captured=scope,c=new AbortController();request.current?.abort();request.current=c;setLoading(true);setError('')
    try { const result=await studioApi.generationServices(accountId,refresh,c.signal);if(!c.signal.aborted&&currentScope.current===captured){catalogScope.current=captured;setCatalog(result)} }
    catch(e){if(!c.signal.aborted&&currentScope.current===captured)setError(e instanceof Error?e.message:'Live model discovery is unavailable.')}
    finally {if(request.current===c)request.current=null;if(!c.signal.aborted&&currentScope.current===captured)setLoading(false)}
  }
  useEffect(()=>{
    setCatalog(null);setError('');setLoading(false);void load()
    return()=>request.current?.abort()
  },[scope])
  useEffect(()=>{
    const onFocus=()=>{if(document.visibilityState==='visible'&&(!catalog||Date.now()-Date.parse(catalog.checkedAt)>60_000))void load()}
    const timer=window.setInterval(onFocus,60_000)
    window.addEventListener('focus',onFocus);return()=>{window.clearInterval(timer);window.removeEventListener('focus',onFocus)}
  },[scope,catalog])
  const visibleCatalog=catalogScope.current===scope?catalog:null
  const services=visibleCatalog?servicesForWorkflow(visibleCatalog.items,workflow):[]
  const seen=new Set<string>(),mapped=new Map<string,string>()
  const choices=services.flatMap(service=>{
    const choice=serviceChoice(service,workflow)
    const canSelect=choice&&selection.options.some(option=>option.value===choice)
    const value=canSelect?choice:`service:${service.id}`
    if(canSelect&&seen.has(value))return []
    seen.add(value)
    if(canSelect)mapped.set(value,choice)
    const sameName=services.filter(other=>other.name===service.name)
    const engine=service.parameters.engine
    const provider=engine?({sdcpp:'SD CPP',comfy:'Comfy',fal:'FAL',openai:'OpenAI',google:'Google',gemini:'Gemini',krea:'Krea'}[engine]??engine):''
    const needsVariant=sameName.some(other=>other.id!==service.id&&other.parameters.engine===engine)
    const variant=needsVariant?['model','version','ecosystem','modelVersion','provider'].filter(key=>sameName.some(other=>other.parameters.engine===engine&&other.parameters[key]!==service.parameters[key])).map(key=>service.parameters[key]).filter(Boolean).join(' · '):''
    const detail=sameName.length>1?[provider,variant].filter(Boolean).join(' · '):''
    return [{value,label:`${service.name}${detail?` · ${detail}`:''} · ${service.status}${canSelect?'':choice?' · Current Studio adapter':' · Studio support needed'}`,disabled:!canSelect||service.status==='unavailable'}]
  })
  const current=selection.options.find(option=>option.value===selection.value)
  if(!choices.some(option=>option.value===selection.value))choices.unshift({value:selection.value,label:`${current?.label??'Current configuration'} · ${visibleCatalog?'not confirmed in live choices':'not checked'}`,disabled:false})
  return <div className="form-field generation-model-field">
    <span className="field-label">Generation model</span>
    <Select label="Generation model" value={selection.value} options={choices} onChange={value=>{if(mapped.has(value))selection.onChange(mapped.get(value)!)}} />
    <div className="live-model-status"><p className="field-help" role="status">{loading?'Checking Civitai live services…':!connected?'Connect Civitai to load live generation models.':visibleCatalog?`${error?'Previous result':'Checked'} ${new Date(visibleCatalog.checkedAt).toLocaleTimeString()}${visibleCatalog.cached?' · cached for up to 1 minute':''} · ${services.length} workflow services`:'Live model list not loaded.'}</p><Button type="button" variant="secondary" disabled={loading||!connected||!revision} onClick={()=>void load(true)}>Refresh models</Button></div>
    {error&&<p className="field-help live-model-error" role="alert">{error} Previous results, if shown, may be stale.</p>}
    <p className="field-help">Service health is Civitai’s recent status, not account eligibility. New services marked “Studio support needed” cannot be selected yet. Your current setup stays unchanged.</p>
    {selection.hint&&<p className="field-help">{selection.hint}</p>}
  </div>
}
