import {randomInt} from 'node:crypto'
import {draftProfile,normalizeDraft,type DraftReview} from '../shared/image-workflows'
import {parseAir} from '../shared/composer'
import {resolveModelVersion,validateGenerationResources} from './models'
import type {BearerLease} from './connection'
import {normalizePolicy,normalizeWorkflowOptions,type PreparedGeneration} from './quotes'

const sdFamily=(ecosystem:string)=>['sd1','sd15'].includes(ecosystem.toLowerCase())?'sd1':['sdxl','sdxl1','pony','illustrious','noobai'].includes(ecosystem.toLowerCase())?'sdxl':null
export async function checkDraftResources(key:BearerLease,input:Record<string,unknown>) {
  const profile=draftProfile(input),base=normalizeDraft(input,true)
  const problem=await validateGenerationResources(key,'image',base);if(problem)throw new Error(problem)
  const resources=[String(base.model),...Object.keys(base.loras as object),...(typeof base.vaeModel==='string'?[base.vaeModel]:[]),...(Array.isArray(base.embeddings)?base.embeddings as string[]:[])]
  for(const value of resources)if(sdFamily(parseAir(value)!.ecosystem)!==input.ecosystem)throw new Error('Draft resources must belong to the selected SD family; unknown families are unavailable.')
  const accelerator=await resolveModelVersion(key,profile.acceleratorVersion),air=parseAir(accelerator.air)
  if(!air||air.modelId!==accelerator.modelId||air.versionId!==profile.acceleratorVersion||air.type!=='lora'||accelerator.type.toLowerCase()!=='lora'||!accelerator.canGenerate||sdFamily(air.ecosystem)!==input.ecosystem)throw new Error('The pinned Draft accelerator is unavailable or incompatible for this account. Choose Create Image or retry availability later.')
  return {...profile,acceleratorAir:accelerator.air}
}
export async function prepareDraft(key:BearerLease,body:Record<string,unknown>):Promise<PreparedGeneration> {
  if(Object.keys(body).some(name=>!['recipe','mediaType','input','options','policy'].includes(name))||body.mediaType!=='image'||!body.input||typeof body.input!=='object'||Array.isArray(body.input))throw new Error('Choose a valid Draft image input.')
  const input=body.input as Record<string,unknown>,base=normalizeDraft(input),profile=await checkDraftResources(key,input)
  const providerInput={...base,seed:base.seed??randomInt(0,2147483648),loras:{...base.loras as object,[profile.acceleratorAir]:1}}
  const draft:DraftReview={revision:profile.revision,acceleratorAir:profile.acceleratorAir,acceleratorVersion:profile.acceleratorVersion,steps:profile.steps,cfgScale:1,sampleMethod:profile.sampleMethod,quantity:Number(base.quantity),seed:Number(providerInput.seed),input:providerInput}
  const options=normalizeWorkflowOptions(body.options),policy=normalizePolicy(body.policy)
  return {mediaType:'image',draft,providerInput,storedInput:{prompt:base.prompt,negativePrompt:base.negativePrompt,model:base.model,engine:'sdcpp',parameters:{...providerInput,studioWorkflow:'draft',draftProfile:profile}},policy,fingerprint:JSON.stringify({recipe:'draft',draft,policy,options}),workflowRequest:{...policy,tips:options.tips,steps:[{$type:'imageGen',priority:options.priority,input:providerInput}]}}
}
export async function validateDraft(key:BearerLease,prepared:PreparedGeneration) {
  try {
    const review=prepared.draft;if(!review)throw new Error('Missing Draft profile.')
    const p=prepared.providerInput,loras={...(p.loras as Record<string,unknown>)}
    if(loras[review.acceleratorAir]!==1)throw new Error('Draft accelerator weight changed.')
    delete loras[review.acceleratorAir]
    const profile=await checkDraftResources(key,{...p,loras})
    if(profile.acceleratorAir!==review.acceleratorAir||profile.revision!==review.revision||profile.acceleratorVersion!==review.acceleratorVersion||review.steps!==profile.steps||review.cfgScale!==1||review.sampleMethod!==profile.sampleMethod||p.steps!==profile.steps||p.cfgScale!==1||p.sampleMethod!==profile.sampleMethod||p.schedule!=='discrete'||p.seed!==review.seed||p.quantity!==review.quantity||JSON.stringify(p)!==JSON.stringify(review.input))throw new Error('Draft settings changed; preview again.')
    return null
  }catch(error){return error instanceof Error?error.message:'Draft is unavailable.'}
}
