import { ModelThumbnail } from './ModelThumbnail'
import { ModelFavorite } from './ModelFavorite'
import { SiteCollectionSavePanel } from './SiteCollectionSavePanel'
import type { ArtworkScope } from '../../shared/artworks'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, Image as ImageIcon, LoaderCircle, Plus, Search, X } from 'lucide-react'
import { suggestedModelPath, kreaBranchChoice, compatibility, type ModelVersion, type ResourceSlot } from '../../shared/composer'
import type { MediaType } from '../../shared/generation-catalog'
import { studioApi, type ModelFilters, type ModelSearchResult } from './api'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from './ui'
import { Select } from './controls'
import { browsingLabels, type BrowsingPreference, type ContentRating } from '../../shared/browsing'
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Civitai model information is unavailable.'
const unavailableMessage = (version:ModelVersion) => !version.canGenerate ? 'This version is unavailable for your account. Try another version.' : 'This version is not supported here yet. Choose another model or version.'
const selectionLabel = (type?:string) => type === 'LORA' ? 'Add LoRA' : type === 'VAE' ? 'Use VAE' : type === 'TextualInversion' ? 'Add embedding' : 'Use model'
const modelTypes = ['Checkpoint', 'LORA', 'TextualInversion', 'VAE', 'LoCon', 'DoRA', 'Controlnet', 'Upscaler', 'Other']
const bases = ['Anima', 'Krea 2', 'Chroma', 'ZImageTurbo', 'ZImageBase', 'Qwen', 'Qwen 2.1', 'Flux.2 D', 'Flux.2 Klein 4B', 'Flux.2 Klein 4B-base', 'Flux.2 Klein 9B', 'Flux.2 Klein 9B-base', 'LTXV 2.3', 'LTXV 2.5', 'SDXL 1.0', 'SD 1.5', 'Pony', 'Illustrious', 'Flux.1 D', 'Flux.1 S', 'Wan Video 2.2 T2V-A14B', 'Wan Video 2.2 I2V-A14B']
const searchWords=(value:string):string[]=>value.toLowerCase().replace(/\bv(?=\d)/g,'').match(/[a-z]+|\d+/g)??[]
function rankedModels(items:ModelSearchResult[],query:string) {
  const words=searchWords(query)
  const score=(text:string)=>{
    const found=searchWords(text)
    if(!words.length)return 0
    const matched=words.reduce((total,word)=>total+(found.includes(word)?1:0),0)
    const exact=found.join(' ')===words.join(' ')
    const sameWords=matched===words.length&&found.every(word=>words.includes(word))
    return matched*10+(exact?100:sameWords?80:0)
  }
  return items.map(model=>({...model,versions:[...model.versions].sort((a,b)=>score(`${model.name} ${b.name}`)-score(`${model.name} ${a.name}`))})).sort((a,b)=>score(`${b.name} ${b.versions[0]?.name??''}`)-score(`${a.name} ${a.versions[0]?.name??''}`))
}
const coverageLabel = (value: boolean | null | undefined) => value === true ? 'Platform generation supported' : value === false ? 'No platform generation coverage' : 'Platform coverage not supplied'
function Preview({ image }: { image?: { url: string; rating: ContentRating; type: 'image' | 'video' } }) {
  return <><div className="model-preview">{!image ? <ImageIcon size={30} /> : image.type === 'video' ? <video src={image.url} muted controls playsInline preload="none" crossOrigin="anonymous" /> : <img src={image.url} alt="Model example" loading="lazy" referrerPolicy="no-referrer" />}</div>{image && <span className="content-rating">{image.rating.label}</span>}</>
}
export function ModelBrowser({ open, onOpenChange, accountId, mediaType, input, onAdd, onSwitch, onArtwork, browsing, purpose='all', baseModel }: { purpose?:'checkpoint'|'lora'|'all';baseModel?:string; browsing: BrowsingPreference; accountId: string; onSwitch?: (version:ModelVersion,choice?:'raw'|'turbo')=>void; onAdvanced: () => void; onArtwork: (scope: ArtworkScope) => void; open: boolean; onOpenChange: (open: boolean) => void; mediaType: MediaType; input: Record<string, unknown> | null; onAdd: (version: ModelVersion, slot: ResourceSlot) => void }) {
  const [favoriteAccess,setFavoriteAccess]=useState({allowed:false,reason:'Checking favorite permissions…'})
  const [collecting, setCollecting] = useState(false)
  const [filters, setFilters] = useState<ModelFilters>({ query: '', type: purpose==='checkpoint'?'Checkpoint':purpose==='lora'?'LORA':'', baseModel: purpose==='checkpoint'||purpose==='lora'?baseModel??'':'', sort: 'Highest Rated', supportsGeneration:'true' })
  const [activeFilters, setActiveFilters] = useState(filters)
  const [items, setItems] = useState<ModelSearchResult[]>([])
  const [versionChecks,setVersionChecks]=useState<Record<number,{version?:ModelVersion;error?:string}>>({})
  const [publishedOnly,setPublishedOnly]=useState(true)
  const [checkRetry,setCheckRetry]=useState(0)
  const effectiveQuery=useRef('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ModelSearchResult | null>(null)
  const [versionId, setVersionId] = useState<number | null>(null)
  const [version, setVersion] = useState<ModelVersion | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [versionBusy, setVersionBusy] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [retry, setRetry] = useState(0)
  const [selecting, setSelecting] = useState<number | null>(null)
  const [selectedVersions, setSelectedVersions] = useState<Record<number, number>>({})
  const [branchChoice,setBranchChoice]=useState<{id:number;version:ModelVersion}|null>(null)
  const [selectionError, setSelectionError] = useState<{ id: number; message: string } | null>(null)
  const selectionController = useRef<AbortController | null>(null)
  const searchController = useRef<AbortController | null>(null)
  useEffect(()=>{
    let current=true
    setFavoriteAccess({allowed:false,reason:'Checking favorite permissions…'})
    if(open)void studioApi.session().then(session=>{
      if(!current)return
      if(session.user?.id!==accountId){setFavoriteAccess({allowed:false,reason:'The active account changed. Reopen the model browser.'});return}
      const credential=session.credential,allowed=credential?.kind==='api_key'&&(credential.grantedScopes===null||(credential.grantedScopes&524288)!==0)
      setFavoriteAccess({allowed:!!allowed,reason:credential?.kind==='oauth'?'OAuth can browse favorites. Changes require an explicit API-key connection; hosted MCP OAuth writes are unverified.':allowed?'':'Favorite changes require an API key with SocialWrite permission.'})
    }).catch(()=>{if(current)setFavoriteAccess({allowed:false,reason:'Connection status is unavailable. Reopen the browser to retry.'})})
    return()=>{current=false}
  },[open,accountId])
  function favoriteConfirmed(id:number,favorited:boolean){
    if(activeFilters.favorites==='true'&&!favorited)setItems(current=>current.filter(item=>item.id!==id))
  }
  useEffect(() => {
    setItems([]); setVersionChecks({}); setSelectedVersions({}); setCursor(null); setSelectionError(null);setBranchChoice(null)
    if (!open) return
    searchController.current?.abort()
    const controller = new AbortController(); searchController.current = controller
    setBusy(true); setItems([]); setCursor(null); setError('')
    void (async()=>{
      let query=activeFilters.query
      let result=await studioApi.searchModels(accountId,activeFilters,controller.signal)
      // Site name search may not index a checkpoint's version name. Retry the
      // leading model term only for an empty result, retaining type/base policy.
      const first=query.trim().split(/\s+/)[0]??''
      if(!result.items.length&&first&&first!==query&&!controller.signal.aborted){query=first;result=await studioApi.searchModels(accountId,{...activeFilters,query},controller.signal)}
      if(!controller.signal.aborted){effectiveQuery.current=query;setItems(rankedModels(result.items,activeFilters.query));setCursor(result.nextCursor)}
    })().catch(error => { if (!controller.signal.aborted) setError(errorText(error)) }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => { controller.abort(); searchController.current?.abort() }
  }, [open, accountId, activeFilters])
  useEffect(() => {
    setCollecting(false); setDetail(null); setVersionId(null); setVersion(null); setDetailError('')
    if (!open || !detailId) return
    const controller = new AbortController(); setDetailBusy(true)
    void studioApi.model(accountId, detailId, controller.signal).then(result => { if (!controller.signal.aborted) { setDetail(result.model); setVersionId(selectedVersions[result.model.id] ?? rankedModels([result.model],activeFilters.query)[0]?.versions[0]?.id ?? null) } }).catch(error => { if (!controller.signal.aborted) setDetailError(errorText(error)) }).finally(() => { if (!controller.signal.aborted) setDetailBusy(false) })
    return () => controller.abort()
  }, [open, accountId, detailId, retry])
  useEffect(() => {
    setVersion(null)
    if (!open || !versionId) return
    const controller = new AbortController(); setVersionBusy(true); setDetailError('')
    void studioApi.modelVersion(accountId, versionId, controller.signal).then(value => { if (!controller.signal.aborted) setVersion(value) }).catch(error => { if (!controller.signal.aborted) setDetailError(errorText(error)) }).finally(() => { if (!controller.signal.aborted) setVersionBusy(false) })
    return () => controller.abort()
  }, [open, accountId, versionId, retry])
  async function more() {
    if (!cursor || busy) return
    const controller = new AbortController(); searchController.current?.abort(); searchController.current = controller
    setBusy(true); setError('')
    try {
      const result = await studioApi.searchModels(accountId, { ...activeFilters, query:effectiveQuery.current, cursor }, controller.signal)
      if (!controller.signal.aborted) { setItems(current => rankedModels([...new Map([...current, ...result.items].map(item => [item.id, item])).values()],activeFilters.query)); setCursor(result.nextCursor === cursor ? null : result.nextCursor) }
    } catch (error) { if (!controller.signal.aborted) setError(errorText(error)) } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  useEffect(() => () => searchController.current?.abort(), [])
  useEffect(() => {
    setSelecting(null); setSelectionError(null);setBranchChoice(null); setDetailId(null)
    return () => selectionController.current?.abort()
  }, [open, accountId, activeFilters])
  useEffect(()=>{
    if(!open||detailId)return
    const controller=new AbortController()
    const ids=[...new Set(items.map(model=>selectedVersions[model.id]??model.versions[0]?.id).filter((id):id is number=>typeof id==='number'))]
    let index=0
    async function worker(){while(!controller.signal.aborted&&index<ids.length){
      const id=ids[index++]!
      if(versionChecks[id])continue
      try{const value=await studioApi.modelVersion(accountId,id,controller.signal);if(!controller.signal.aborted)setVersionChecks(current=>({...current,[id]:{version:value}}))}
      catch(error){if(!controller.signal.aborted)setVersionChecks(current=>({...current,[id]:{error:errorText(error)}}))}
    }}
    void Promise.all([worker(),worker()])
    return()=>controller.abort()
  },[open,accountId,items,selectedVersions,detailId,activeFilters,checkRetry])
  function retryVersionCheck(id:number){
    setVersionChecks(current=>{const next={...current};delete next[id];return next})
    setCheckRetry(current=>current+1)
  }
  function usable(value:ModelVersion) {
    if(!input||!value.canGenerate||(purpose==='checkpoint'&&value.type!=='Checkpoint')||(purpose==='lora'&&value.type!=='LORA'))return false
    const slot=compatibility(mediaType,input,value).slot
    return purpose==='lora'?slot==='loras':Boolean(slot||(onSwitch&&(suggestedModelPath(value)||kreaBranchChoice(value))))
  }
  const visibleItems=items.filter(model=>{
    if(purpose==='checkpoint'&&model.type!=='Checkpoint')return false
    if(purpose==='lora'&&model.type!=='LORA')return false
    // A selected version says nothing about the model's other versions.
    // Keep the picker reachable, including when account lookup fails.
    return !publishedOnly||model.versions.length>0
  })
  async function selectLatest(model: ModelSearchResult) {
    const id = selectedVersions[model.id] ?? model.versions[0]?.id
    if (!id || !input) return
    selectionController.current?.abort()
    const controller = new AbortController(); selectionController.current = controller
    setSelecting(model.id); setSelectionError(null);setBranchChoice(null)
    try {
      const selected = await studioApi.modelVersion(accountId, id, controller.signal)
      if (controller.signal.aborted) return
      if(!usable(selected)){setSelectionError({id:model.id,message:unavailableMessage(selected)});return}
      const support = compatibility(mediaType, input, selected)
      if (!support.slot) {
        if(onSwitch&&suggestedModelPath(selected)){onSwitch(selected);onOpenChange(false);return}
        if(onSwitch&&kreaBranchChoice(selected)){setBranchChoice({id:model.id,version:selected});setSelectionError({id:model.id,message:'Choose Raw or Turbo for this Krea 2 version.'});return}
        setSelectionError({id:model.id,message:unavailableMessage(selected)});return
      }
      onAdd(selected, support.slot); onOpenChange(false)
    } catch (error) { if (!controller.signal.aborted) setSelectionError({ id: model.id, message: errorText(error) }) }
    finally { if (!controller.signal.aborted) setSelecting(null) }
  }
  const correctType=!version||purpose==='all'||(purpose==='checkpoint'?version.type==='Checkpoint':version.type==='LORA')
  const support = input && version && correctType ? compatibility(mediaType, input, version) : { reason: input ? 'Choose a version to check availability.' : 'Fix the composer JSON before adding a model.' }
  function chooseKrea(version:ModelVersion,choice:'raw'|'turbo') {
    if(onSwitch&&suggestedModelPath(version,choice)){onSwitch(version,choice);onOpenChange(false)}
  }
  const needsKreaChoice=Boolean(purpose!=='lora'&&correctType&&onSwitch&&version&&!support.slot&&kreaBranchChoice(version))
  const switchPath=purpose!=='lora'&&correctType&&onSwitch&&version&&!support.slot?suggestedModelPath(version):null
  return <Dialog open={open} onOpenChange={value => { if (!value) searchController.current?.abort(); onOpenChange(value) }}><DialogContent className="model-browser" showCloseButton={false}>
    <div className="model-browser-heading"><div><DialogTitle>{purpose==='checkpoint'?'Choose a model':purpose==='lora'?'Add a compatible LoRA':'All resources'}</DialogTitle><DialogDescription>{purpose==='lora'?`LoRAs for ${baseModel??'your selected model'}. Availability is checked for your account.`:purpose==='checkpoint'?'Search checkpoint models and choose a version.':'Browse checkpoints, LoRAs, VAEs, embeddings and other resource types. Selection still requires compatibility.'}</DialogDescription></div><Button type="button" variant="ghost" size="icon" aria-label="Close model browser" onClick={() => onOpenChange(false)}><X size={18} /></Button></div>
    {collecting && detail ? <SiteCollectionSavePanel key={`${accountId}:${detail.id}`} accountId={accountId} choices={[{ itemType: 'Model', itemId: detail.id, label: detail.name }]} onBack={() => setCollecting(false)} /> : detailId ? <div className="model-details"><Button type="button" variant="ghost" size="sm" onClick={() => setDetailId(null)}><ArrowLeft size={14} />Back to models</Button>
      {detailBusy && <p role="status">Loading model details…</p>}
      {detail && <><div className="columns is-multiline"><div className="column is-5-tablet"><Preview image={version?.images[0] ?? detail.images[0]} /></div><div className="column is-7-tablet"><h3>{detail.name}</h3><ModelFavorite key={`${accountId}:${detail.id}`} accountId={accountId} modelId={detail.id} writeAllowed={favoriteAccess.allowed} reason={favoriteAccess.reason} load onConfirmed={favoriteConfirmed} /><Button type="button" variant="secondary" onClick={() => setCollecting(true)}>Save model to collection</Button><p>{detail.type} · by {detail.creator || 'Unknown creator'}</p><p className="field-help">{detail.rating.label}{detail.mature ? ' · Mature model' : ''}</p><p className="field-help">{coverageLabel(detail.supportsGeneration)}</p><a href={detail.url} target="_blank" rel="noreferrer" className="model-external"><ExternalLink size={13} />Open on Civitai</a><div className="form-field mt-3"><label className="field-label">Version</label>{detail.versions.length ? <Select value={String(versionId ?? detail.versions[0]?.id)} label="Model version" onChange={value => { setVersion(null); setVersionId(Number(value)) }} options={detail.versions.map(v => ({ value: String(v.id), label: `${v.name} · ${v.baseModel} · ${v.rating.label}` }))} /> : <p>No published versions are available.</p>}</div>
      {versionBusy ? <p role="status">Checking generation availability…</p> : version && <><p>{version.baseModel} · {version.canGenerate ? 'Available for your account' : 'Unavailable for your account'}</p><p className="field-help">{version.rating.label}</p><p className="field-help">{coverageLabel(version.supportsGeneration ?? detail.versions.find(item=>item.id===version.id)?.supportsGeneration)}</p>{version.restriction && <p className="field-help">{version.restriction}</p>}<h4>Trigger words</h4><p>{version.trainedWords.join(', ') || 'None provided'}</p></>}
      {!support.slot && !switchPath && !needsKreaChoice && version && <p className="field-help">{unavailableMessage(version)}</p>}{needsKreaChoice&&version?<div className="composer-actions"><Button type="button" disabled={versionBusy||detailBusy} onClick={()=>chooseKrea(version,'raw')}>Use with Krea 2 Raw</Button><Button type="button" disabled={versionBusy||detailBusy} onClick={()=>chooseKrea(version,'turbo')}>Use with Krea 2 Turbo</Button></div>:<Button type="button" disabled={!version || versionBusy || detailBusy || (!support.slot && !switchPath)} onClick={() => {
        if(!version)return
        if(support.slot)onAdd(version,support.slot)
        else if(switchPath&&onSwitch)onSwitch(version)
        else return
        onOpenChange(false)
      }}><Plus size={14} />{selectionLabel(version?.type)}</Button>}<div className="composer-actions mt-3"><Button type="button" variant="secondary" onClick={() => onArtwork({ modelId: detail.id, label: detail.name })}>Artwork using this model</Button><Button type="button" variant="secondary" disabled={!version || versionBusy} onClick={() => { if (version) onArtwork({ modelVersionId: version.id, label: `${detail.name} · ${version.versionName}` }) }}>Artwork using this version</Button></div></div></div><h4>About this model</h4><p className="model-description">{detail.description || 'No description provided.'}</p>{version?.description && <><h4>Version notes</h4><p className="model-description">{version.description}</p></>}</>}
      {detailError && <div role="alert" className="error-box">{detailError}<Button type="button" variant="secondary" onClick={() => setRetry(value => value + 1)}>Retry</Button></div>}
    </div> : <>
      <Select label="Browse models" value={filters.favorites==='true'?'favorites':'all'} options={[{value:'all',label:'All models'},{value:'favorites',label:'My favorites'}]} onChange={value=>{const next={...filters,favorites:value==='favorites'?'true':''};setFilters(next);setActiveFilters(next)}} />
      {purpose==='checkpoint'&&<Select label="Model family in search" value={filters.baseModel||'all'} options={[{value:'all',label:'All model families'},...Array.from(new Set([...bases,...(baseModel?[baseModel]:[])])).map(base=>({value:base,label:base}))]} onChange={value=>{const next={...filters,baseModel:value==='all'?'':value};setFilters(next);setActiveFilters(next)}}/>}
      <div className="form-field"><div className="composer-actions"><Input aria-label="Search Civitai models" placeholder="Search models or browse below" value={filters.query} maxLength={100} onChange={event => setFilters({ ...filters, query: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setActiveFilters({ ...filters }) } }} /><Button type="button" variant="secondary" onClick={() => setActiveFilters({ ...filters })}><Search size={14} />Search</Button></div></div>
      <details className="model-search-options"><summary>Filters &amp; browsing</summary><Select label="Published versions" value={publishedOnly?'published':'all'} options={[{value:'published',label:'Models with published versions'},{value:'all',label:'Include models without published versions'}]} onChange={value=>setPublishedOnly(value==='published')}/><Select label="Generation coverage" value={filters.supportsGeneration === 'true' ? 'supported' : 'all'} options={[{value:'supported',label:'Platform generation supported'},{value:'all',label:'All models · check availability on selection'}]} onChange={value=>{const next={...filters,supportsGeneration:value==='supported'?'true':''};setFilters(next);setActiveFilters(next)}} /><div className="columns is-multiline model-filters">
        <div className="column is-4-tablet"><Select disabled={purpose!=='all'} label="Model type filter" value={filters.type || 'all'} options={[{ value: 'all', label: 'All model types' }, ...modelTypes.map(type => ({ value: type, label: type }))]} onChange={value => { const next = { ...filters, type: value === 'all' ? '' : value }; setFilters(next); setActiveFilters(next) }} /></div>
        {purpose!=='checkpoint'&&<div className="column is-4-tablet"><Select label="Base model filter" value={filters.baseModel || 'all'} options={[{ value: 'all', label: 'All base models' }, ...bases.map(base => ({ value: base, label: base }))]} onChange={value => { const next = { ...filters, baseModel: value === 'all' ? '' : value }; setFilters(next); setActiveFilters(next) }} /></div>}
        <div className="column is-4-tablet"><Select label="Model sort order" value={filters.sort} options={['Highest Rated', 'Most Downloaded', 'Newest'].map(sort => ({ value: sort, label: sort }))} onChange={sort => { const next = { ...filters, sort }; setFilters(next); setActiveFilters(next) }} /></div>
      </div>
      <p className="field-help">Browsing: {browsingLabels[browsing.mode]}. Change in Settings → Browsing. Preview ratings differ from model content ranges; unrated and Blocked previews stay hidden. Mature links open Civitai.red; account and region restrictions still apply.</p>
      </details>
      <div className="model-results-heading"><span>{browsingLabels[browsing.mode]}</span><span>Availability is checked per version</span></div>
      <div className="columns is-multiline model-cards">{visibleItems.map(model=>{
        const chosenVersion=model.versions.find(v=>v.id===(selectedVersions[model.id]??model.versions[0]?.id))
        const checked=chosenVersion?versionChecks[chosenVersion.id]:undefined
        const image=(checked?.version?.images??chosenVersion?.images??model.images).find(image=>image.type==='image')??model.images.find(image=>image.type==='image')
        const available=Boolean(checked?.version&&usable(checked.version))
        const status=!chosenVersion?'No published version':checked?.error?'Availability unknown':checked?.version?available?'Available for your account':checked.version.canGenerate?'Incompatible version':'Unavailable for your account':'Checking availability…'
        const words=checked?.version?.trainedWords??chosenVersion?.trainedWords??[]
        return <div className="column is-6-tablet is-4-desktop" key={model.id}><article className="model-card">
          <div className="model-card-art"><ModelThumbnail image={image} label={model.name}/>{image&&<span className="model-preview-rating">Preview · {image.rating.label}</span>}</div>
          <div className="model-card-body">
            <p className="model-card-kind">{model.type} · {chosenVersion?.baseModel??'No version'}</p><h3>{model.name}</h3>
            <Select label={`Version for ${model.name}`} value={String(selectedVersions[model.id]??model.versions[0]?.id??'none')} options={model.versions.length?model.versions.map(version=>({value:String(version.id),label:`${version.name} · ${version.rating.label}`})):[{value:'none',label:'No published version'}]} disabled={!model.versions.length||selecting!==null} onChange={value=>{setSelectedVersions(current=>({...current,[model.id]:Number(value)}));setSelectionError(null);setBranchChoice(null)}}/>
            <p className={`model-availability ${available?'is-available':''}`} role="status">{!checked&&chosenVersion&&<LoaderCircle size={12} className="spin"/>}{status}</p>
            {checked?.error&&<div className="model-check-error"><p>{checked.error}</p><Button type="button" variant="secondary" size="sm" onClick={()=>{if(chosenVersion)retryVersionCheck(chosenVersion.id)}}>Retry availability</Button></div>}
            <div className="model-card-actions"><Button type="button" size="sm" disabled={!input||selecting!==null||!available} onClick={()=>void selectLatest(model)}>{selecting===model.id?'Selecting…':selectionLabel(model.type)}</Button><Button type="button" variant="secondary" size="sm" onClick={()=>{selectionController.current?.abort();setSelecting(null);setDetailId(model.id)}}>Details</Button></div>
            {selectionError?.id===model.id&&<p role="alert" className="field-help">{selectionError.message}</p>}
            {branchChoice?.id===model.id&&<div className="composer-actions"><Button type="button" size="sm" onClick={()=>chooseKrea(branchChoice.version,'raw')}>Use with Raw</Button><Button type="button" size="sm" onClick={()=>chooseKrea(branchChoice.version,'turbo')}>Use with Turbo</Button></div>}
            <details className="model-card-more"><summary>{words.length?`${words.length} trigger ${words.length===1?'word':'words'} · more`:'No trigger words · more'}</summary>
              {!!words.length&&<p className="model-trigger-words">{words.join(', ')}</p>}
              <p>by {model.creator||'Unknown creator'}</p><p>{model.rating.label}{model.mature?' · Mature model':''}</p>
              <div className="model-card-secondary"><ModelFavorite accountId={accountId} modelId={model.id} initialFavorite={activeFilters.favorites==='true'?true:undefined} writeAllowed={favoriteAccess.allowed} reason={favoriteAccess.reason} onConfirmed={favoriteConfirmed}/><a href={model.url} target="_blank" rel="noreferrer" className="model-external">Civitai<ExternalLink size={12}/></a></div>
            </details>
          </div>
        </article></div>
      })}</div>
      {busy && <p role="status"><LoaderCircle size={15} className="spin" />Loading models…</p>}{!busy && !visibleItems.length && !error && <p>{activeFilters.favorites==='true'?'No favorites match these filters. Try clearing the search, model type or base-model filter.':'No models are available for these filters and browsing preference. Provider account or region restrictions may also apply.'}</p>}
      {error && <div className="error-box" role="alert">{error}<Button type="button" variant="secondary" onClick={() => setActiveFilters({ ...activeFilters })}>Retry</Button></div>}
      {publishedOnly&&items.length>visibleItems.length&&<p className="field-help">{items.length-visibleItems.length} results without published versions or outside this resource type are hidden. Include models without published versions to inspect them.</p>}{cursor && <Button type="button" variant="secondary" disabled={busy} onClick={() => void more()}>Load more</Button>}
    </>}
  </DialogContent></Dialog>
}
