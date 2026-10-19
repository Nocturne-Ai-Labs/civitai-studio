import { imageCapability, imageFieldError, imageParameterError, hostedKrea, kreaRatios } from '../../shared/image-capabilities'
import { compatibleBaseModels } from '../../shared/resource-mapping'
import { Tooltip } from './controls'
import { ModelThumbnail } from './ModelThumbnail'
import { ImageParameterControls } from './ImageParameterControls'
import { WorkflowSelection } from './WorkflowControls'
import { generationModelChoices, generationModelValue } from './model-types'
import { SourceWorkflowComposer } from './SourceWorkflowComposer'
import { MetadataExtractor } from './MetadataExtractor'
import { VideoWorkflowControls } from './VideoWorkflowControls'
import { MusicControls, MusicLyrics } from './MusicControls'
import { musicProviderInput } from '../../shared/music'
import { draftProfile, draftProblem, normalizeDraft } from '../../shared/image-workflows'
import { suggestedModelPath } from '../../shared/composer'
import { ltxDefaults,normalizeVideoSettings } from '../../shared/video-workflows'
import type { RecoveredMetadata } from './image-metadata'
import type { SourceOperation, WorkflowId } from '../../shared/workflows'
import { GenerationReview } from './GenerationReview'
import type { GenerationPreview, WorkflowOptions } from '../../shared/quotes'
import { ArtworkBrowser } from './ArtworkBrowser'
import type { ArtworkScope } from '../../shared/artworks'
import { browsingLabels, type BrowsingPreference } from '../../shared/browsing'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Box, ChevronDown, Film, Gauge, Image as ImageIcon, LoaderCircle, Music, Search, Sparkles, Trash2 } from 'lucide-react'
import { engineVariants, generationEngines, starterInput, type MediaType } from '../../shared/generation-catalog'
import { ApiError, studioApi } from './api'
import { applyResource, compatibility, combinePrompts, configError, promptLimit, selectedResources, parseAir, type ComposerConfig, type PromptGroup, type ModelVersion, type ResourceSlot } from '../../shared/composer'
import { PromptGroups } from './PromptGroups'
import type { PromptDraft } from '../../shared/prompt-library'
import { ModelBrowser } from './ModelBrowser'
import { PresetControls } from './PresetControls'
import { Button, Input, Textarea } from './ui'

const mediaLabels: { id: MediaType; label: string; icon: typeof ImageIcon }[] = [
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'video', label: 'Video', icon: Film },
  { id: 'audio', label: 'Music', icon: Music },
  { id: 'model3d', label: '3D model', icon: Box },
]

type RememberedPath={engine:string;variant:string;key:string;model?:'raw'|'turbo'}
type ResourceVisual={scope:string;name:string;versionName:string;type:string;image?:ModelVersion['images'][number]}
const hostedVisualKey=(input:Record<string,unknown>)=>`hosted:${JSON.stringify([input.engine,input.model,input.size])}`
const pathKey = (media:MediaType,engine:string,variant:string,input?:Record<string,unknown>|null) => `${media}:${engine}:${variant}${media==='image'&&engine==='comfy'&&variant==='krea2'?':'+String(input?.model??'raw'):''}`
const pretty = (value: Record<string, unknown>) => JSON.stringify(value, null, 2)
const guidedAvailable = (mediaType: MediaType, engine: string, variant: string) =>
  (mediaType === 'image' && (Boolean(imageCapability(starterInput(mediaType, engine, variant))) || hostedKrea(starterInput(mediaType, engine, variant))))
  || (mediaType === 'video' && ['kling','ltx2.3'].includes(engine))
  || (mediaType === 'model3d' && engine === 'fal' && variant === 'meshy')
  || (mediaType === 'audio' && engine === 'aceStepAudio')

export function GenerationComposer({ active, accountId, connected, sessionLoading, submitting, onSubmit, browsing }: {
  active: boolean; accountId: string | null; connected: boolean; sessionLoading: boolean; submitting: boolean; onSubmit: (previewId: string, recoveryGenerationId?: string) => Promise<void>; browsing: BrowsingPreference | null
}) {
  const [quote, setQuote] = useState<GenerationPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmationError, setConfirmationError] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [recoveryGenerationId, setRecoveryGenerationId] = useState<string | undefined>()
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const previewController = useRef<AbortController | null>(null)
  const confirmLock = useRef(false)
  const [mediaType, setMediaType] = useState<MediaType>('image')
  const [sourceWorkflow,setSourceWorkflow] = useState<SourceOperation|'extractMetadata'|null>(null)
  const [engine, setEngine] = useState('sdcpp')
  const [variant, setVariant] = useState('sdxl')
  const [advanced, setAdvanced] = useState(false)
  const [draftMode,setDraftMode]=useState(false)
  const [draftAvailability,setDraftAvailability]=useState<{input:string;available:boolean;reason?:string;acceleratorAir?:string}|null>(null)
  const [checkingDraft,setCheckingDraft]=useState(false)
  const draftController=useRef<AbortController|null>(null)
  const [draft, setDraft] = useState(pretty(starterInput('image', 'sdcpp', 'sdxl')))
  const [draftError, setDraftError] = useState('')
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserPurpose,setBrowserPurpose]=useState<'checkpoint'|'lora'|'all'>('checkpoint')
  const [resourceBases,setResourceBases]=useState<Record<string,string>>({})
  const [resourceVisuals,setResourceVisuals]=useState<Record<string,ResourceVisual>>({})
  const resourceScope=JSON.stringify([accountId,connected,browsing?.revision,browsing?.mode])
  function rememberVisual(version:ModelVersion,key=version.air){
    setResourceVisuals(current=>({...current,[key]:{scope:resourceScope,name:version.name,versionName:version.versionName,type:version.type,image:version.images.find(image=>image.type==='image')}}))
  }
  function openModels(purpose:'checkpoint'|'lora'|'all'){setBrowserPurpose(purpose);setBrowserOpen(true)}
  const [artworkScope, setArtworkScope] = useState<ArtworkScope | null>(null)
  const [selectionNotice, setSelectionNotice] = useState('')
  const [promptGroups, setPromptGroups] = useState<PromptGroup[]>([{ id: 'prompt-1', label: '', text: '' }])
  const [undoChange, setUndoChange] = useState<{ apply: () => void } | null>(null)
  const negativeDraft = useRef('')
  useEffect(() => {
    if (!undoChange) return
    const timer = window.setTimeout(() => setUndoChange(null), 12000)
    return () => window.clearTimeout(timer)
  }, [undoChange])
  useEffect(() => {
    if (!selectionNotice) return
    const timer = window.setTimeout(() => setSelectionNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [selectionNotice])
  const pathDrafts = useRef(new Map<string, string>())
  const lastPaths = useRef<Partial<Record<MediaType,RememberedPath>>>({})
  const undoPathRestore=useRef<{media:MediaType;draft:string;path:RememberedPath}|null>(null)
  const [resourceNames, setResourceNames] = useState<Record<string, string>>({})
  const [resourceWords, setResourceWords] = useState<Record<string, string[]>>({})
  const metadataRevision = useRef<string | null>(null)
  const [activeGroup, setActiveGroup] = useState('prompt-1')
  const [options, setOptions] = useState<WorkflowOptions>({ tips: { creators: 0, civitai: 0 }, priority: 'normal' })
  useEffect(() => {
    previewController.current?.abort()
    setQuote(null); setPreviewing(false); setConfirmationError(''); setAttempted(false); setBlocked(false); setRecoveryRequired(false); setRecoveryGenerationId(undefined)
    return () => previewController.current?.abort()
  }, [accountId, connected, draft, mediaType, engine, variant, promptGroups, options, draftMode])
  useEffect(()=>{draftController.current?.abort();setDraftAvailability(null);setCheckingDraft(false);return()=>draftController.current?.abort()},[draft,accountId,connected,draftMode])
  useEffect(() => {
    if (!quote || !accountId) return
    return () => { void studioApi.discardPreview(quote.id, accountId).catch(() => {}) }
  }, [quote, accountId])
  useEffect(() => {
    if (!quote) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [quote])
  const parsed = useMemo(() => {
    try {
      const value = JSON.parse(draft) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch { return null }
  }, [draft])
  function pendingUndoPath() {
    const restore=undoPathRestore.current
    return restore&&restore.media===mediaType&&restore.draft===draft&&restore.path.engine===engine&&restore.path.variant===variant?restore.path:null
  }
  function currentPathIdentity():RememberedPath {
    const restored=pendingUndoPath()
    if(restored)return restored
    const previous=lastPaths.current[mediaType]
    // Keep both key and build selector while an existing draft is invalid.
    if(!parsed&&previous?.engine===engine&&previous.variant===variant)return {...previous}
    return {engine,variant,key:pathKey(mediaType,engine,variant,parsed),...(mediaType==='image'&&engine==='comfy'&&variant==='krea2'&&['raw','turbo'].includes(String(parsed?.model))?{model:parsed!.model as 'raw'|'turbo'}:{})}
  }
  function currentPathKey() {return currentPathIdentity().key}
  useEffect(()=>{
    lastPaths.current[mediaType]=currentPathIdentity()
    if(pendingUndoPath())undoPathRestore.current=null
  },[mediaType,engine,variant,parsed,draft])
  const localDraftProblem=draftProblem(parsed)
  const fixedDraft=parsed&&!localDraftProblem?draftProfile(parsed):null
  const draftReady=draftAvailability?.available===true&&draftAvailability.input===draft&&!localDraftProblem
  async function checkDraftAvailability() {
    if(!accountId||!parsed||!connected||checkingDraft)return
    draftController.current?.abort();const controller=new AbortController();draftController.current=controller;setCheckingDraft(true)
    try {const result=await studioApi.draftAvailability(parsed,accountId,controller.signal);if(!controller.signal.aborted)setDraftAvailability({...result,input:draft})}
    catch(error){if(!controller.signal.aborted)setDraftAvailability({input:draft,available:false,reason:error instanceof Error?error.message:'Draft availability could not be confirmed.'})}
    finally{if(!controller.signal.aborted)setCheckingDraft(false)}
  }

  const profile = mediaType === 'image' && parsed ? imageCapability(parsed) : null
  const resourceKey = JSON.stringify(parsed ? [...new Set(selectedResources(parsed).map(resource => resource.air))].slice(0, 30) : [])
  useEffect(() => {
    const revision = resourceScope
    const cached = metadataRevision.current === revision ? resourceWords : {}
    if (metadataRevision.current !== revision) { setResourceWords({}); setResourceNames({}); setResourceBases({}); setResourceVisuals({}); metadataRevision.current = revision }
    if (!accountId || !connected || !browsing?.revision) return
    const controller = new AbortController()
    void (async () => {
      // Sequential, bounded discovery restores trigger words for presets/JSON too.
      for (const air of JSON.parse(resourceKey) as string[]) {
        if (controller.signal.aborted) break
        if (cached[air] !== undefined && resourceVisuals[air]?.scope===revision) continue
        const id = parseAir(air)?.versionId
        if (!id || !Number.isSafeInteger(id)) continue
        try {
          const version = await studioApi.modelVersion(accountId,id,controller.signal)
          if (controller.signal.aborted) break
          if (version.air !== air) continue
          rememberVisual(version)
          setResourceNames(current => ({ ...current, [air]: `${version.name} · ${version.versionName}` }))
          setResourceWords(current => ({ ...current, [air]: version.trainedWords }));setResourceBases(current=>({...current,[air]:version.baseModel}))
        } catch { /* Selection stays intact if optional metadata is unavailable. */ }
      }
    })()
    return () => controller.abort()
  }, [accountId, connected, resourceKey, resourceScope])
  const managedKrea = mediaType === 'image' && parsed !== null && hostedKrea(parsed)
  const guided = mediaType === 'image' ? Boolean(profile) || managedKrea : mediaType==='video'&&engine==='ltx2.3' ? parsed?.operation==='createVideo'&&parsed?.model==='22b-distilled'&&parsed?.quantity===1&&parsed?.duration===3&&!parsed?.images : guidedAvailable(mediaType, engine, variant)
  function rememberChange() {
    const previousPath={...currentPathIdentity()}
    pathDrafts.current.set(previousPath.key, draft)
    if (typeof parsed?.negativePrompt === 'string') negativeDraft.current = parsed.negativePrompt
    const previousNegative = negativeDraft.current
    setUndoChange({apply:()=>{
      // Restore identity before state. The pending snapshot also wins over a
      // prior render's passive effect until the matching restored render commits.
      undoPathRestore.current={media:mediaType,draft,path:previousPath}
      lastPaths.current[mediaType]={...previousPath}
      setDraft(draft); setDraftMode(draftMode); setPromptGroups(promptGroups)
      setMediaType(mediaType); setEngine(engine); setVariant(variant); setAdvanced(advanced)
      setSourceWorkflow(sourceWorkflow); setResourceNames(resourceNames); setResourceWords(resourceWords)
      negativeDraft.current = previousNegative
      setSelectionNotice('Restored.'); setDraftError('')
    }})
  }
  function preserveSettings(nextMedia:MediaType, target:Record<string,unknown>) {
    const next={...target}
    const targetProfile=nextMedia==='image'?imageCapability(next):null
    if(parsed&&targetProfile) {
      for(const [name,capability] of Object.entries(targetProfile.fields)) {
        if(parsed[name]!==undefined&&!imageFieldError(capability,parsed[name]))next[name]=parsed[name]
      }
      next.negativePrompt=typeof parsed.negativePrompt==='string'?parsed.negativePrompt:negativeDraft.current
      if(typeof parsed.seed==='number'&&Number.isInteger(parsed.seed)&&parsed.seed>=0&&parsed.seed<=2147483647)next.seed=parsed.seed
    }
    if(parsed&&nextMedia==='image'&&hostedKrea(next)) {
      if(typeof parsed.quantity==='number'&&Number.isInteger(parsed.quantity)&&parsed.quantity>=1&&parsed.quantity<=10)next.quantity=parsed.quantity
      if(typeof parsed.aspectRatio==='string'&&kreaRatios.includes(parsed.aspectRatio))next.aspectRatio=parsed.aspectRatio
      if(typeof parsed.creativity==='string'&&['raw','low','medium','high'].includes(parsed.creativity))next.creativity=parsed.creativity
      if(typeof parsed.seed==='number'&&Number.isInteger(parsed.seed)&&parsed.seed>=-2147483648&&parsed.seed<=2147483647)next.seed=parsed.seed
      if(next.engine==='krea')for(const name of ['intensity','complexity','movement']) {
        const value=parsed[name]
        if(typeof value==='number'&&Number.isInteger(value)&&value>=-100&&value<=100)next[name]=value
      }
    }
    if(parsed&&nextMedia==='video'&&next.engine==='ltx2.3') {
      if(typeof parsed.negativePrompt==='string')next.negativePrompt=parsed.negativePrompt
      if(typeof parsed.seed==='number'&&Number.isInteger(parsed.seed)&&parsed.seed>=0&&parsed.seed<=2147483647)next.seed=parsed.seed
    }
    return next
  }
  function choose(nextMedia: MediaType, nextEngine: string, nextVariant?: string, nextModel?:'raw'|'turbo', restoreKey?:string, resetCurrent = false) {
    const field = engineVariants[`${nextMedia}:${nextEngine}`]
    const chosenVariant = nextVariant ?? field?.values[0] ?? ''
    const starter=starterInput(nextMedia,nextEngine,chosenVariant,nextModel)
    const currentKey = currentPathKey(), nextKey = restoreKey ?? pathKey(nextMedia,nextEngine,chosenVariant,starter)
    if (currentKey === nextKey && !resetCurrent) return
    const saved = resetCurrent ? undefined : pathDrafts.current.get(nextKey)
    let invalidSaved = false
    let next = starter
    if (saved) {
      try {
        const value: unknown = JSON.parse(saved)
        if (value && typeof value === 'object' && !Array.isArray(value)) next = value as Record<string, unknown>
        else invalidSaved = true
      } catch { invalidSaved = true }
    }
    rememberChange()
    // Returning to a saved path restores its tuning; only a new path inherits
    // valid independent settings from the current selection.
    if (!saved) {
      next=preserveSettings(nextMedia,next)
      // Raw/Turbo are explicit choices. A new choice starts with that build's
      // published sampler defaults; returning restores the exact saved tuning.
      if(nextMedia==='image'&&nextEngine==='comfy'&&chosenVariant==='krea2') {
        next.steps=starter.steps;next.cfgScale=starter.cfgScale
        if(mediaType==='image'&&engine==='comfy'&&variant==='krea2'&&parsed) {
          for(const resource of selectedResources(parsed)) {
            // Official Raw/Turbo checkpoints are tied to their own selectors.
            if(resource.slot==='diffusionModel'&&[3072329,3072332].includes(parseAir(resource.air)?.versionId??0))continue
            next=applyResource(next,resource)
          }
        }
      }
    }
    const nextPromptKey = nextMedia === 'audio' ? 'musicDescription' : 'prompt'
    next[nextPromptKey] = combinePrompts(promptGroups)
    setDraftMode(false); setSourceWorkflow(null)
    setMediaType(nextMedia); setEngine(nextEngine); setVariant(chosenVariant)
    setDraft(invalidSaved ? saved! : pretty(next))
    setDraftError(''); setSelectionNotice('Selection updated.')
    setAdvanced(invalidSaved || !guidedAvailable(nextMedia, nextEngine, chosenVariant))
  }

  function setField(name: string, value: unknown) {
    setUndoChange(null)
    setDraft(pretty({ ...(parsed ?? starterInput(mediaType, engine, variant)), [name]: value }))
    setDraftError('')
  }

  function changeGroups(groups: PromptGroup[]) {
    if (!parsed) return
    setUndoChange(null)
    setPromptGroups(groups)
    setDraft(pretty({ ...parsed, [mediaType === 'audio' ? 'musicDescription' : 'prompt']: combinePrompts(groups) }))
    setDraftError('')
  }
  function applyPromptDraft(value: PromptDraft) {
    if (!parsed || value.groups.length > 20 || combinePrompts(value.groups).length > promptLimit(mediaType, parsed).max) return
    rememberChange()
    setPromptGroups(value.groups)
    setDraft(pretty({ ...parsed, [mediaType === 'audio' ? 'musicDescription' : 'prompt']: combinePrompts(value.groups), ...(value.negativePrompt === undefined ? {} : { negativePrompt: value.negativePrompt }) }))
    setDraftError(''); setSelectionNotice('Prompt text applied. Your generation settings are preserved.')
  }
  function changeJson(text: string) {
    setUndoChange(null)
    setDraft(text); setDraftError('')
    try {
      const value = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      // Only an actual JSON prompt change collapses the groups; toggling modes does not.
      if (typeof value.prompt === 'string' && value.prompt !== combinePrompts(promptGroups)) {
        const groups = [{ id: crypto.randomUUID(), label: '', text: value.prompt }]
        setPromptGroups(groups)
        setDraft(pretty({ ...value, prompt: combinePrompts(groups) }))
      } else if (value.prompt === undefined && combinePrompts(promptGroups)) {
        setPromptGroups([{ id: crypto.randomUUID(), label: '', text: '' }])
      }
      const field = engineVariants[`${mediaType}:${engine}`]
      if (field && typeof value[field.field] === 'string') setVariant(value[field.field])
    } catch { /* Keep invalid JSON editable; group editing is disabled until repaired. */ }
  }
  function loadPreset(config: ComposerConfig) {
    const problem = configError(config)
    if (problem) { setDraftError(problem); return }
    const nextEngine = String(config.input.engine)
    const field = engineVariants[`${config.mediaType}:${nextEngine}`]
    const nextVariant = field ? String(config.input[field.field] ?? field.values[0]) : ''
    rememberChange()
    setMediaType(config.mediaType); setEngine(nextEngine); setVariant(nextVariant)
    setDraftMode(false); setSourceWorkflow(null)
    setDraft(pretty(config.input)); setPromptGroups(config.promptGroups)
    setResourceNames({}); setResourceWords({}); setDraftError('')
    setAdvanced(!guidedAvailable(config.mediaType, nextEngine, nextVariant))
    setSelectionNotice('Preset loaded.')
  }

  function addResource(version: ModelVersion, slot: ResourceSlot, strength = 1) {
    if (!parsed || compatibility(mediaType, parsed, version).slot !== slot) return
    rememberChange()
    rememberVisual(version)
    setDraft(pretty(applyResource(parsed, { air: version.air, slot, strength: Number.isFinite(strength) ? strength : 1 })))
    setResourceNames(current => ({ ...current, [version.air]: `${version.name} · ${version.versionName}` }))
    setResourceWords(current => ({ ...current, [version.air]: version.trainedWords }));setResourceBases(current=>({...current,[version.air]:version.baseModel}))
    setSelectionNotice(`${version.name} · ${version.versionName} selected.`)
    setDraftError('')
  }
  function switchToResource(version:ModelVersion,kreaChoice?:'raw'|'turbo') {
    const path=suggestedModelPath(version,kreaChoice)
    if(!path)return
    rememberChange()
    rememberVisual(version)
    let next:Record<string,unknown>=preserveSettings(path.media,{...path.input,prompt:combinePrompts(promptGroups)})
    if(path.engine==='comfy'&&path.variant==='krea2'){next.steps=path.input.steps;next.cfgScale=path.input.cfgScale}
    if(path.slot)next=applyResource(next,{air:version.air,slot:path.slot,strength:1})
    else if(hostedKrea(next))rememberVisual(version,hostedVisualKey(next))
    setBrowserOpen(false)
    setMediaType(path.media);setEngine(path.engine);setVariant(path.variant);setDraft(pretty(next))
    setSourceWorkflow(null);setDraftMode(false);setAdvanced(!guidedAvailable(path.media,path.engine,path.variant))
    setDraftError('');setSelectionNotice(`${version.name} · ${version.versionName} selected.`)
    setResourceNames(current=>({...current,[version.air]:`${version.name} · ${version.versionName}`}))
    setResourceWords(current=>({...current,[version.air]:version.trainedWords}));setResourceBases(current=>({...current,[version.air]:version.baseModel}))
  }
  function setModelVariant(name:'model'|'modelVersion',value:string) {
    if(!parsed||parsed[name]===value)return
    rememberChange()
    let next:Record<string,unknown>={...parsed,[name]:value}
    // These selectors change architecture (Z Image Base/Turbo or Klein size).
    // Keep numeric tuning, but do not carry incompatible checkpoint/add-on AIRs.
    for(const resource of selectedResources(parsed))next=applyResource(next,resource,true)
    const targetProfile=imageCapability(next)
    if(targetProfile)for(const [field,capability] of Object.entries(targetProfile.fields)) {
      if(imageFieldError(capability,next[field]))next[field]=capability.default
    }
    setDraft(pretty(next));setDraftError('');setSelectionNotice('Selection updated.')
  }
  function selectWorkflow(id:WorkflowId) {
    if(id==='draft'){if(localDraftProblem){setDraftError(localDraftProblem);return}setSourceWorkflow(null);setDraftMode(true);setAdvanced(false);return}
    setDraftMode(false)
    if (!['createImage','textTo3D','video','createMusic'].includes(id)) { setSourceWorkflow(id as SourceOperation|'extractMetadata'); return }
    setSourceWorkflow(null)
    const nextMedia:MediaType=id==='textTo3D'?'model3d':id==='video'?'video':id==='createMusic'?'audio':'image'
    if (nextMedia===mediaType) return
    const previous=lastPaths.current[nextMedia]
    const nextEngine=previous?.engine??(nextMedia==='audio'?'aceStepAudio':nextMedia==='model3d'?'fal':nextMedia==='video'?'ltx2.3':'sdcpp')
    const nextVariant=previous?.variant??(nextMedia==='model3d'?'meshy':nextMedia==='image'?'sdxl':'')
    choose(nextMedia,nextEngine,nextVariant,previous?.model,previous?.key)
  }
  function applyMetadata(value:RecoveredMetadata) {
    const next=starterInput('image','sdcpp','sdxl'),profile=imageCapability(next)!
    next.prompt=value.prompt;next.negativePrompt=value.negativePrompt
    const skipped:string[]=[]
    for(const [name,number] of Object.entries(value.settings)) {
      if(name==='seed'&&typeof number==='number'&&Number.isSafeInteger(number))next.seed=number
      else if(name in profile.fields&&!imageFieldError(profile.fields[name as keyof typeof profile.fields],number))next[name]=number
      else skipped.push(name)
    }
    pathDrafts.current.set(currentPathKey(),draft)
    setMediaType('image');setEngine('sdcpp');setVariant('sdxl');setDraft(pretty(next));setPromptGroups([{id:crypto.randomUUID(),label:'',text:value.prompt}]);setAdvanced(false);setSourceWorkflow(null)
    setSelectionNotice(`Metadata applied to an SDXL starter. Resource hints require explicit model selection.${skipped.length?` Skipped invalid settings: ${skipped.join(', ')}.`:''}`)
  }
  function insertWords(words: string[]) {
    if (!parsed) return
    const target = promptGroups.find(group => group.id === activeGroup) ?? promptGroups[0]!
    let combined = combinePrompts(promptGroups).toLocaleLowerCase()
    const additions: string[] = []
    for (const value of words) {
      const word = value.trim()
      if (!word) continue
      const escaped = word.toLocaleLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(combined)) continue
      additions.push(word); combined += `, ${word.toLocaleLowerCase()}`
    }
    if (!additions.length) { setSelectionNotice('These trigger words are already in your prompt.'); return }
    const groups = promptGroups.map(group => group.id === target.id ? { ...group, text: [group.text.trim(),additions.join(', ')].filter(Boolean).join(', ') } : group)
    if (combinePrompts(groups).length > promptLimit(mediaType,parsed).max) { setDraftError('Trigger words would exceed the prompt limit. Shorten the prompt before inserting.'); return }
    changeGroups(groups); setSelectionNotice(`Trigger words inserted into Prompt ${promptGroups.indexOf(target)+1}.`)
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if(draftMode&&!draftReady){setDraftError('Check Draft resource availability before previewing.');return}
    if (Object.values(options.tips).some(rate => !Number.isFinite(rate) || rate < 0 || rate > 2)) { setDraftError('Choose tip percentages from 0 to 200.'); return }
    if (!parsed || parsed.engine !== engine) { setDraftError('Enter a JSON object whose engine matches the selected engine.'); return }
    if(mediaType==='video'&&engine==='ltx2.3'&&guided&&!advanced)try {normalizeVideoSettings('imageToVideo',Object.fromEntries(Object.keys(ltxDefaults).map(key=>[key,parsed[key]])))}catch(error){setDraftError(error instanceof Error?error.message:'Choose valid video settings.');return}
    if (mediaType === 'image') { const problem = imageParameterError(draftMode&&fixedDraft?{...parsed,steps:fixedDraft.steps,cfgScale:1}:parsed); if (problem) { setDraftError(problem); return } }
    if(draftMode)try{normalizeDraft(parsed)}catch(error){setDraftError(error instanceof Error?error.message:'Draft settings are invalid.');return}
    if (mediaType === 'audio') { try { musicProviderInput(parsed) } catch(error) { setDraftError(error instanceof Error ? error.message : 'Choose valid music settings.'); return } }
    if (guided && typeof parsed.prompt === 'string' && !parsed.prompt.trim()) { setDraftError('Enter a prompt to generate.'); return }
    if (combinePrompts(promptGroups).length > promptLimit(mediaType, parsed).max) { setDraftError('Combined prompt exceeds the selected engine limit.'); return }
    if ((parsed[mediaType === 'audio' ? 'musicDescription' : 'prompt'] ?? '') !== combinePrompts(promptGroups)) { setDraftError('The description must be synchronized with your prompt groups.'); return }
    setDraftError('')
    if (!accountId || previewing || confirmLock.current) return
    previewController.current?.abort()
    const controller = new AbortController(); previewController.current = controller
    setPreviewing(true); setQuote(null); setConfirmationError(''); setAttempted(false); setBlocked(false); setRecoveryRequired(false); setRecoveryGenerationId(undefined)
    try {
      const result = await studioApi.preview({ recipe: draftMode ? 'draft' : 'workflow', mediaType, input: parsed, options }, accountId, controller.signal)
      if (!controller.signal.aborted) { setQuote(result.preview); setClock(Date.now()) }
    } catch (error) { if (!controller.signal.aborted) setDraftError(error instanceof Error ? error.message : 'Cost preview is unavailable. Try again.') }
    finally { if (!controller.signal.aborted) setPreviewing(false) }
  }
  async function confirm() {
    if (!quote || confirmLock.current || blocked || quote.review.insufficientBuzz === true || quote.review.total === null) return
    if (!attempted && Date.now() >= Date.parse(quote.expiresAt)) { setClock(Date.now()); return }
    confirmLock.current = true; setConfirming(true); setAttempted(true); setConfirmationError('')
    try { await onSubmit(quote.id, recoveryGenerationId); setQuote(null) }
    catch (error) {
      setConfirmationError(error instanceof Error ? error.message : 'Confirmation is unavailable. Retry the same confirmation.')
      if (error instanceof ApiError && error.code === 'recovery_required') { setRecoveryRequired(true); setBlocked(false); if (error.recoveryGenerationId) setRecoveryGenerationId(error.recoveryGenerationId) }
      else if (!recoveryRequired && error instanceof ApiError && ['preview_required', 'preview_changed', 'invalid_input', 'insufficient_scope', 'provider_rejected', 'provider_rate_limited', 'unauthenticated'].includes(error.code ?? '')) setBlocked(true)
    } finally { confirmLock.current = false; setConfirming(false) }
  }

  const limit = promptLimit(mediaType, parsed ?? {})
  const config: ComposerConfig | null = parsed && parsed.engine === engine ? { version: 1, mediaType, input: parsed, promptGroups } : null
  const resources = parsed ? selectedResources(parsed) : []
  const hostedVisual=parsed&&resourceVisuals[hostedVisualKey(parsed)]?.scope===resourceScope?resourceVisuals[hostedVisualKey(parsed)]:undefined
  const checkpoint=resources.find(resource=>['model','diffuserModel','diffusionModel','checkpointModel'].includes(resource.slot))
  const loraBase=checkpoint?resourceBases[checkpoint.air]??(parsed?compatibleBaseModels(mediaType,parsed)[0]:undefined):parsed?compatibleBaseModels(mediaType,parsed)[0]:undefined
  const availableGenerationModels = generationModelChoices(mediaType, draftMode)
  const selectedModelValue = generationModelValue(engine, variant, currentPathIdentity().model)
  const currentEngineLabel = generationEngines[mediaType].find(item => item.id === engine)?.label ?? engine
  const matchesWorkflow = mediaType !== 'model3d' || (parsed?.operation === 'textTo3D' && parsed?.version === 'v6')
  const currentGenerationModel = matchesWorkflow ? availableGenerationModels.find(item => item.value === selectedModelValue) : undefined
  const generationModelOptions = currentGenerationModel ? availableGenerationModels : [...availableGenerationModels, { value: 'current-configuration', label: `Current configuration · ${currentEngineLabel}${variant ? ` · ${variant}` : ''}` }]
  function selectGenerationModel(value: string) {
    const choice = availableGenerationModels.find(item => item.value === value)
    if (!choice) return
    choose(mediaType, choice.engine, choice.variant, choice.model, undefined, !currentGenerationModel && choice.value === selectedModelValue)
    if (draftMode) setDraftMode(true)
  }
  const inputValue = (key: string) => typeof parsed?.[key] === 'string' ? parsed[key] as string : ''
  const numberValue = (key: string, fallback: number) => typeof parsed?.[key] === 'number' ? parsed[key] as number : fallback
  // Keep account-keyed composer hooks/state alive across workspace navigation.
  // Unmount the inactive UI subtree so Radix portals cannot retain focus/dialogs.
  // Existing quote expiry continues ticking; returning never submits it automatically.
  if (sourceWorkflow==='extractMetadata' && active) return <div className="generation-split-form"><WorkflowSelection value="extractMetadata" onChange={selectWorkflow}/><MetadataExtractor onApply={applyMetadata}/></div>
  if (sourceWorkflow && sourceWorkflow!=='extractMetadata') return <SourceWorkflowComposer active={active} key={`${accountId}:${sourceWorkflow}`} operation={sourceWorkflow} onWorkflow={selectWorkflow} accountId={accountId} connected={connected} browsing={browsing} sdxl={parsed?.engine==='sdcpp'&&parsed?.ecosystem==='sdxl'?parsed:{...starterInput('image','sdcpp','sdxl'),prompt:combinePrompts(promptGroups)}} onSubmit={onSubmit}/>
  if (!active) return null
  return <form className="generation-split-form" onSubmit={event => void submit(event)}>
    <div className="generation-form-content">
    <div className="composer-heading"><div><h1>Create something new</h1><p>Choose a medium, shape your prompt, and review the cost.</p></div><div className="medium-tabs" role="group" aria-label="Generation medium">
      {mediaLabels.map(item => <Button key={item.id} type="button" variant={mediaType === item.id ? 'default' : 'secondary'} aria-pressed={mediaType === item.id} onClick={() => selectWorkflow(item.id==='audio'?'createMusic':item.id==='video'?'video':item.id==='model3d'?'textTo3D':'createImage')}><item.icon size={15} />{item.label}</Button>)}
    </div></div>
    <WorkflowSelection accountId={accountId} connected={connected} revision={browsing?.revision} draftReason={draftMode ? null : mediaType === 'image' ? localDraftProblem : 'Select an SD1/SDXL Create Image setup first.'} value={draftMode ? 'draft' : mediaType === 'audio' ? 'createMusic' : mediaType === 'model3d' ? 'textTo3D' : mediaType === 'video' ? 'video' : 'createImage'} onChange={selectWorkflow} generationModel={{ value: currentGenerationModel ? selectedModelValue : 'current-configuration', options: generationModelOptions, onChange: selectGenerationModel, hint: !currentGenerationModel ? 'Your existing configuration is preserved. Choose a generation model to change it.' : !guided ? 'Complete the model settings below before reviewing the cost.' : undefined }} />
    <div className="columns composer-panes is-variable is-4">
    <div className="column is-half"><section className="panel-card generator-card prompt-pane" aria-labelledby="prompt-pane-title">
      <h2 id="prompt-pane-title" className="section-title">{mediaType === 'audio' ? 'Music description' : 'Prompt'}</h2>
      <PromptGroups groups={promptGroups} onChange={changeGroups} onActive={setActiveGroup} disabled={!parsed} max={limit.max} limitLabel={limit.label} library={accountId && parsed ? { accountId, context: { mediaType, workflow: draftMode ? 'draft' : mediaType === 'audio' ? 'createMusic' : mediaType === 'model3d' ? 'textTo3D' : mediaType === 'video' ? 'video' : 'createImage' }, negativePrompt: typeof parsed.negativePrompt === 'string' ? parsed.negativePrompt : undefined, onApply: applyPromptDraft } : undefined} />
      {mediaType === 'audio' && parsed && <MusicLyrics input={parsed} onField={setField}/>}
      {parsed && (profile || (mediaType === 'video' && guided)) && <div className="form-field"><label className="field-label" htmlFor="negative">Negative prompt</label><Textarea id="negative" value={inputValue('negativePrompt')} onChange={event => setField('negativePrompt', event.target.value)} /></div>}
      {(advanced || !guided) && <p className="field-help">The controls pane’s JSON includes prompt fields and stays synchronized with these groups. Repair invalid JSON there to resume prompt editing.</p>}
    </section></div>
    <div className="column is-half"><section className="panel-card generator-card controls-pane" aria-labelledby="controls-pane-title">
    <h2 id="controls-pane-title" className="section-title">Generation controls</h2>
    {mediaType !== 'audio' && (loraBase || resources.length > 0 || managedKrea) && <section className="composer-model-section composer-model-first" aria-labelledby="composer-model-title">
      <div className="composer-section-heading"><h3 id="composer-model-title">Checkpoint &amp; LoRA</h3><div className="composer-actions">
        <Button type="button" variant={checkpoint?'secondary':'default'} size="sm" disabled={!connected||!browsing} onClick={()=>openModels('checkpoint')}><Search size={14}/>{mediaType==='image'?'Choose model version':checkpoint?'Change model':'Choose model'}</Button>
        <Button type="button" variant="secondary" size="sm" disabled={!connected||!browsing||!loraBase} onClick={()=>openModels('lora')}>Add LoRA</Button>
      </div></div>
      <div className="selected-resources" aria-label="Selected generation resources">
        {!checkpoint&&<div className="selected-resource-default"><ModelThumbnail image={hostedVisual?.image} label={hostedVisual?.name??'Provider default'}/><div><strong>{hostedVisual?.name??(managedKrea?`Krea 2 · ${inputValue('model')==='krea2-large'?'Large':inputValue('model')==='krea2-medium-turbo'?'Medium Turbo':engine==='fal'&&inputValue('size')==='large'?'Large':'Medium'}`:currentGenerationModel?.label??currentEngineLabel)}</strong><p>{hostedVisual?.versionName??'Provider default model'}</p></div></div>}
        {resources.map(resource=>{
          const visual=resourceVisuals[resource.air]?.scope===resourceScope?resourceVisuals[resource.air]:undefined
          const isCheckpoint=['model','diffuserModel','diffusionModel','checkpointModel'].includes(resource.slot)
          const type=visual?.type??(isCheckpoint?'Checkpoint':resource.slot==='loras'?'LoRA':resource.slot)
          const name=visual?.name??(metadataRevision.current===resourceScope?resourceNames[resource.air]:undefined)??type
          const words=metadataRevision.current===resourceScope?resourceWords[resource.air]:undefined
          return <article className={`selected-resource selected-resource-card ${isCheckpoint?'checkpoint-resource':''}`} key={`${resource.slot}:${resource.air}`}>
            <ModelThumbnail image={visual?.image} label={name}/>
            <div className="selected-resource-info"><span className="resource-type">{type}</span><strong>{name}</strong>{visual?.versionName&&<p className="resource-version">{visual.versionName}</p>}
              {advanced&&<p className="resource-air">{resource.air}</p>}
              {words?.length?<div className="resource-trigger-actions"><details><summary>{words.length===1?'1 trigger word':`${words.length} trigger words`}</summary><p>{words.join(', ')}</p></details><Button type="button" variant="ghost" size="sm" disabled={!parsed} onClick={()=>insertWords(words)}>Insert triggers</Button></div>:<p className="resource-trigger-empty">{words?'No trigger words':'Trigger words unavailable'}</p>}
            </div>
            <div className="selected-resource-actions">
              {resource.slot==='loras'&&<label className="resource-strength"><span>Strength</span><Input type="number" step="0.05" aria-label={`LoRA strength for ${name}`} value={Number.isFinite(resource.strength)?resource.strength:''} onChange={event=>{if(parsed)setDraft(pretty(applyResource(parsed,{...resource,strength:event.target.value===''?NaN:Number(event.target.value)})))}}/></label>}
              <Tooltip label={`Remove ${name}`}><Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={()=>{if(parsed)setDraft(pretty(applyResource(parsed,resource,true)))}}><Trash2 size={14}/></Button></Tooltip>
            </div>
          </article>
        })}
      </div>
    </section>}
    {mediaType !== 'audio' && <div className="composer-model-footer"><Button type="button" variant="ghost" size="sm" disabled={!connected||!browsing} onClick={()=>setArtworkScope({})}><ImageIcon size={14}/>Browse / paste artwork</Button><span>{browsing?browsingLabels[browsing.mode]:'Browsing unavailable'}</span></div>}
    {!connected && <div className="notice mb-4"><strong>Ready when you are.</strong> Connect your Civitai account to choose models and preview your generation.</div>}

    <details className="composer-presets"><summary>Presets <span>Load or save a setup</span></summary><PresetControls accountId={accountId} config={config} onLoad={loadPreset} /></details>
    {draftMode && <section className="notice"><strong>Studio Draft adaptation</strong><p>{fixedDraft?.steps} steps · CFG 1 · {fixedDraft?.sampleMethod.toUpperCase()} · discrete schedule. The requested quantity is the actual image count (1–12), without Site’s four-image batch rounding. Your normal settings and custom resources are retained; Draft adds its pinned accelerator at weight 1. Presets save your normal image setup; select Draft again after loading.</p><p>Changing input requires another availability check. Cost and access are checked again at preview and confirmation.</p><Button type="button" variant="secondary" disabled={!connected||checkingDraft||Boolean(localDraftProblem)} onClick={()=>void checkDraftAvailability()}>{checkingDraft?'Checking resources…':'Check Draft availability'}</Button><p role="status">{localDraftProblem||draftAvailability?.reason||(draftReady?`Available: ${draftAvailability?.acceleratorAir}`:'Draft generation is disabled until resource availability is confirmed.')}</p></section>}


    {(selectionNotice || undoChange) && <div className="composer-selection-status"><span role="status" className="field-help">{selectionNotice}</span>{undoChange && <Button type="button" variant="ghost" size="sm" onClick={() => { undoChange.apply(); setUndoChange(null) }}>Undo</Button>}</div>}
    {advanced && mediaType === 'image' && parsed?.engine === 'sdcpp' && parsed?.ecosystem === 'flux1' && <p className="field-help">Flux.1 SD CPP uses diffuserModel, not the SD checkpoint field. Use the model or artwork browser to select compatible Flux.1 D/S models, LoRAs and VAEs. Studio currently requires VAE, CLIP-L and T5 AIRs under the OpenAPI schema; the recipe permits their omission. This documentation discrepancy is unresolved. Selection preserves those encoders and your other settings. The provider validates the complete configuration during cost preview.</p>}
    {!advanced && guided ? <>
      {mediaType === 'audio' && parsed && <MusicControls input={parsed} onField={setField}/>}
      {managedKrea && parsed && <section className="form-field compact-image-controls" aria-label="Krea image parameters">
        <div className="resolution-heading"><label className="field-label" htmlFor={engine==='fal'?'krea-size':undefined}>Size &amp; ratio</label>{engine==='fal'&&<select id="krea-size" className="shadcn-input" value={inputValue('size') || 'medium'} onChange={event => setField('size',event.target.value)}><option value="medium">Medium</option><option value="large">Large</option></select>}<span className="field-help">Automatic dimensions</span></div>
        <div className="resolution-tiles" role="group" aria-label="Aspect ratio">{kreaRatios.map(ratio => <Button type="button" key={ratio} variant={(inputValue('aspectRatio') || '1:1') === ratio ? 'default' : 'secondary'} aria-pressed={(inputValue('aspectRatio') || '1:1') === ratio} onClick={() => setField('aspectRatio',ratio)}><span className="ratio-outline" style={{aspectRatio:ratio.replace(':','/')}}/><span>{ratio}</span></Button>)}</div>
        <div className="image-parameter-grid"><div className="image-parameter"><label htmlFor="krea-quantity" className="field-label">Images</label><Input id="krea-quantity" type="number" min={1} max={10} step={1} value={numberValue('quantity',1)} onChange={event => setField('quantity',event.target.value === '' ? null : Number(event.target.value))} /></div><div className="image-parameter"><label htmlFor="krea-creativity" className="field-label">Creativity</label><select id="krea-creativity" className="shadcn-input" value={inputValue('creativity') || 'medium'} onChange={event => setField('creativity',event.target.value)}>{['raw','low','medium','high'].map(value => <option value={value} key={value}>{value}</option>)}</select></div></div>
        {engine==='krea'&&<div className="image-parameter-grid">{(['intensity','complexity','movement'] as const).map(name=><div className="image-parameter" key={name}><label htmlFor={`krea-${name}`} className="field-label">{name.charAt(0).toUpperCase()+name.slice(1)}</label><Input id={`krea-${name}`} type="number" min={-100} max={100} step={1} value={parsed[name]===null?'':numberValue(name,0)} onChange={event=>setField(name,event.target.value===''?null:Number(event.target.value))}/></div>)}</div>}
        <div className="form-field mt-3"><label htmlFor="krea-seed" className="field-label">Seed</label><Input id="krea-seed" type="number" min={-2147483648} max={2147483647} step={1} placeholder="Random" value={parsed.seed==null?'':numberValue('seed',0)} onChange={event=>setField('seed',event.target.value===''?null:Number(event.target.value))}/></div>
      </section>}
      {mediaType === 'image' && profile && parsed && <>

        {variant === 'flux1' && ['vaeModel','clipLModel','t5XXLModel'].map(name => <div className="form-field" key={name}><label className="field-label" htmlFor={name}>{name} AIR (required)</label><Input id={name} value={inputValue(name)} onChange={event => setField(name,event.target.value)} /></div>)}
        {variant === 'zImage' && <div className="form-field"><label htmlFor="z-model" className="field-label">Z Image model</label><select id="z-model" className="shadcn-input" value={inputValue('model')} onChange={event => setModelVariant('model',event.target.value)}><option value="turbo">Turbo</option><option value="base">Base</option></select></div>}
        {variant === 'flux2Klein' && <div className="form-field"><label htmlFor="klein-model" className="field-label">Klein version</label><select id="klein-model" className="shadcn-input" value={inputValue('modelVersion') || '4b'} onChange={event => setModelVariant('modelVersion',event.target.value)}>{['4b','4b-base','9b','9b-base'].map(value => <option key={value} value={value}>{value}</option>)}</select></div>}
        <ImageParameterControls key={`${engine}:${variant}`} profile={profile} lockedFields={draftMode?['steps','cfgScale']:[]} input={draftMode&&fixedDraft?{...parsed,steps:fixedDraft.steps,cfgScale:1}:parsed} onField={setField} onSize={(width,height) => { setUndoChange(null); setDraft(pretty({ ...parsed,width,height })) }} />
        <div className="form-field"><label className="field-label" htmlFor="seed">Seed</label><Input id="seed" type="number" step="1" value={parsed.seed == null ? '' : numberValue('seed',0)} onChange={event => setField('seed',event.target.value ? Number(event.target.value) : null)} placeholder="Random" /></div>
      </>}
      {mediaType === 'video' && engine==='ltx2.3' && parsed && <><p className="field-help">LTX 2.3 distilled · createVideo. Use the workflow menu for source-based video operations, or explicitly choose another engine.</p><VideoWorkflowControls operation="imageToVideo" settings={parsed} onField={setField}/></>}
      {mediaType === 'video' && engine==='kling' && <><div className="form-field"><label className="field-label" htmlFor="video-cfg">Guidance</label><Input id="video-cfg" type="number" min={0} max={1} step="0.05" value={numberValue('cfgScale', 0.5)} onChange={event => setField('cfgScale', Number(event.target.value))} /></div><div className="field-help">Kling is explicitly selected. Review its actual cost before generating.</div></>}
      {mediaType === 'model3d' && <div className="form-field"><label className="field-label" htmlFor="mesh-mode">Quality</label><div className="select-wrap"><select id="mesh-mode" className="input shadcn-input" value={inputValue('mode') || 'full'} onChange={event => setField('mode', event.target.value)}><option value="full">Full</option><option value="preview">Preview</option></select><ChevronDown size={14} className="select-arrow" /></div></div>}
    </> : <div className="form-field"><label className="field-label" htmlFor="advanced-input">Engine input JSON</label><Textarea id="advanced-input" className="advanced-input" spellCheck={false} value={draft} onChange={event => changeJson(event.target.value)} /><div className="field-help">Edit this engine’s documented fields. Civitai validates a cost preview before Studio submits a paid workflow. <a href="https://developer.civitai.com/orchestration/recipes" target="_blank" rel="noreferrer">Open Civitai recipes</a></div></div>}
    {mediaType !== 'audio' && accountId && browsing && <ModelBrowser key={`models:${accountId}:${browsing.revision}:${browserPurpose}:${browserPurpose === 'lora'||browserPurpose==='checkpoint' ? loraBase : ''}`} purpose={browserPurpose} baseModel={loraBase} accountId={accountId} browsing={browsing} open={browserOpen} onOpenChange={setBrowserOpen} mediaType={mediaType} input={parsed} onAdd={addResource} onSwitch={switchToResource} onAdvanced={() => { setBrowserOpen(false); setAdvanced(true) }} onArtwork={scope => { setBrowserOpen(false); setArtworkScope(scope) }} />}
    {mediaType !== 'audio' && accountId && browsing && artworkScope && <ArtworkBrowser key={`artwork:${accountId}:${browsing.revision}`} accountId={accountId} browsing={browsing} open onOpenChange={value => { if (!value) setArtworkScope(null) }} scope={artworkScope} mediaType={mediaType} input={parsed} onAdd={addResource} />}

    {mediaType !== 'audio' && <div className="composer-resource-tools"><Button type="button" variant="ghost" size="sm" disabled={!connected || !browsing} onClick={() => openModels('all')}>Browse all resources</Button></div>}
    <div className="composer-mode"><span>{advanced || !guided ? 'JSON editor' : 'Guided controls'}</span>{guided && !draftMode && mediaType !== 'audio' && <Button type="button" variant="ghost" size="sm" onClick={() => setAdvanced(value => !value)}>{advanced ? 'Show guided fields' : 'Edit JSON'}</Button>}</div>
    <details className="generation-output-options"><summary>Output &amp; cost options <span>{options.priority === 'normal' ? 'Standard' : options.priority === 'low' ? 'Low' : 'High'} priority · {Number.isFinite(options.tips.creators + options.tips.civitai) ? `${Number(((options.tips.creators + options.tips.civitai) * 100).toFixed(6))}% tips` : 'Review tips'}</span></summary><div className="field-row form-field">
      {mediaType === 'image' && parsed && <div><label className="field-label" htmlFor="image-format">Image format</label><select id="image-format" className="shadcn-input" value={inputValue('outputFormat')} onChange={event => setField('outputFormat',event.target.value || undefined)}><option value="">Provider default</option><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webP">WebP</option></select></div>}
      <div><label className="field-label" htmlFor="generation-priority">Generation priority</label><select id="generation-priority" className="shadcn-input" value={options.priority} onChange={event => setOptions(current => ({ ...current, priority: event.target.value as WorkflowOptions['priority'] }))}><option value="low">Low</option><option value="normal">Standard</option><option value="high">High</option></select></div>
    </div>
    <div className="field-row form-field">{(['creators','civitai'] as const).map(key => <div key={key}><label className="field-label" htmlFor={`tip-${key}`}>{key === 'creators' ? 'Creator' : 'Civitai'} tip (%)</label><Input id={`tip-${key}`} type="number" min={0} max={200} step={1} value={Number.isFinite(options.tips[key]) ? Number((options.tips[key]*100).toFixed(6)) : ''} onChange={event => setOptions(current => ({ ...current, tips: { ...current.tips, [key]: event.target.value === '' ? NaN : Number(event.target.value)/100 } }))} /></div>)}</div>
    <p className="field-help">Tips start at 0%. Preview confirms the cost for your tips and priority.</p></details>
    {draftError && <div className="error-box mb-3" role="alert">{draftError}</div>}
    <div className="settings-line"><span><Gauge size={14} className="mr-2" />Provider</span><span className="pill">Civitai Orchestration · {mediaType === 'model3d' ? '3D' : mediaType}</span></div>


    </section></div></div>
    </div>
    <div className="generator-bottom generation-action-bar"><div className="generation-action-copy"><strong>Ready to create?</strong><p>Review the Buzz estimate before you confirm.</p></div><Button type="button" size="sm" variant="secondary" disabled={!connected || sessionLoading || submitting || previewing || confirming || !parsed || (draftMode && !draftReady)} onClick={() => void submit()}>Buzz cost</Button><Button type="submit" disabled={!connected || sessionLoading || submitting || previewing || confirming || !parsed || (draftMode && !draftReady) || combinePrompts(promptGroups).length > limit.max}>{previewing ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{previewing ? 'Previewing…' : 'Review & generate'}</Button></div>
    {quote && <GenerationReview preview={quote} expired={clock >= Date.parse(quote.expiresAt)} confirming={confirming} attempted={attempted} blocked={blocked} recoveryRequired={recoveryRequired} error={confirmationError} onClose={() => setQuote(null)} onConfirm={() => void confirm()} onRefresh={() => { setQuote(null); void submit() }} />}
  </form>
}
