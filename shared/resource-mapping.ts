import {resourceProfiles} from './resource-profiles'
// Reviewed consumer AIR slots + official civitai-shared basemodel definitions.
// Canonical AIR is still resolved per account; platform coverage is not permission.
export const resourceSlots=['model','diffuserModel','diffusionModel','checkpointModel','vaeModel','loras','embeddings'] as const
export type ResourceSlot=typeof resourceSlots[number]
export type ResourceVersion={id:number;modelId:number;air:string;type:string;baseModel:string;canGenerate:boolean}
export function canonicalAir(air:string) {
  const match=/^urn:air:([^:]+):([^:]+):civitai:([1-9]\d*)@([1-9]\d*)(?:\+([1-9]\d*))?$/.exec(air)
  if(!match)return null
  const modelId=Number(match[3]),versionId=Number(match[4]),fileId=match[5]?Number(match[5]):undefined
  return Number.isSafeInteger(modelId)&&Number.isSafeInteger(versionId)&&(fileId===undefined||Number.isSafeInteger(fileId))?{ecosystem:match[1]!,type:match[2]!,modelId,versionId,...(fileId?{fileId}:{})}:null
}
// Exact published Site routing, not checkpoint-name heuristics.
// https://github.com/civitai/civitai/blob/main/src/shared/form-graph/generation/image/krea2.graph.ts
export function officialKreaVariant(version:ResourceVersion):'medium'|'large'|'raw'|'turbo'|null {
  const air=canonicalAir(version.air)
  if(version.baseModel!=='Krea 2'||version.type.toLowerCase()!=='checkpoint'||!air||air.modelId!==version.modelId||air.versionId!==version.id||!['checkpoint','diffusionmodel','unet'].includes(air.type))return null
  const variants:Record<number,'medium'|'large'|'raw'|'turbo'>={2983023:'medium',2983022:'large',3072329:'raw',3072332:'turbo'}
  return variants[version.id]??null
}
export function resourceProfile(media:string,input:Record<string,unknown>) {return resourceProfiles.find(p=>p.media===media&&Object.entries(p.selectors).every(([key,value])=>(input[key]??p.defaults[key])===value))}
// Exact Site baseModel establishes architecture; the server resolves canonical AIR verbatim.
// Never derive compatibility from a guessed AIR alias or shared parent (Klein 4B/9B).
function familyRule(media:string,input:Record<string,unknown>):{bases:string[]}|null {
  if(media==='image'&&['sdcpp','comfy'].includes(String(input.engine))) {
    switch(input.ecosystem) {
      case 'sd1':return {bases:['SD 1.4','SD 1.5','SD 1.5 LCM']}
      case 'sdxl':return {bases:['SDXL 1.0','SDXL 0.9','SDXL 1.0 LCM','Pony','Illustrious','NoobAI']}
      case 'flux1':return {bases:['Flux.1 D','Flux.1 S','Flux.1 Krea']}
      case 'anima':return {bases:['Anima']}
      case 'zImage':return input.model==='base'?{bases:['ZImageBase']} : input.model==='turbo'?{bases:['ZImageTurbo']}:null
      case 'chroma':return {bases:['Chroma']}
      case 'krea2':return {bases:['Krea 2']}
      case 'qwen':return (input.model??'20b')==='20b'?{bases:['Qwen']} : input.model==='2.1'?{bases:['Qwen 2.1']}:null
      case 'flux2Dev':return {bases:['Flux.2 D']}
      case 'flux2Klein': {
        const names:Record<string,string>={'4b':'Flux.2 Klein 4B','4b-base':'Flux.2 Klein 4B-base','9b':'Flux.2 Klein 9B','9b-base':'Flux.2 Klein 9B-base'}
        const name=names[String(input.modelVersion??'4b')];return name?{bases:[name]}:null
      }
    }
  }
  if(media==='video'&&['ltx2','ltx2.3','ltx2.5'].includes(String(input.engine))) {
    const names:Record<string,string>={'ltx2':'LTXV2','ltx2.3':'LTXV 2.3','ltx2.5':'LTXV 2.5'}
    return {bases:[names[String(input.engine)]!]}
  }
  if(media==='video'&&input.engine==='wan'&&input.version==='v2.2'&&input.provider==='comfy'&&input.operation===undefined) {
    const source=Boolean(input.sourceImage)||(Array.isArray(input.images)&&input.images.length>0)
    return {bases:[source?'Wan Video 2.2 I2V-A14B':'Wan Video 2.2 T2V-A14B']}
  }
  return null
}
// Browser selection requires this map. Schema-backed advanced inputs can still
// reach provider whatif when no reviewed architecture rule is available.
export function hasReviewedResourceFamily(media:string,input:Record<string,unknown>):boolean {
  return familyRule(media,input)!==null
}
export function compatibleBaseModels(media:string,input:Record<string,unknown>):string[] {
  return familyRule(media,input)?.bases??[]
}
export function resourceMapping(media:string,input:Record<string,unknown>,version:ResourceVersion):{slot?:ResourceSlot;reason:string} {
  if(!version.canGenerate)return {reason:'Unavailable for this account according to Civitai.'}
  const air=canonicalAir(version.air),profile=resourceProfile(media,input),rule=familyRule(media,input)
  if(!air||air.modelId!==version.modelId||air.versionId!==version.id)return {reason:'The canonical Civitai AIR does not match this version.'}
  const kreaVariant=officialKreaVariant(version)
  if(kreaVariant==='medium'||kreaVariant==='large')return {reason:'This official Krea version uses its hosted size tier.'}
  if(kreaVariant&&(input.engine!=='comfy'||input.ecosystem!=='krea2'||(input.model!==kreaVariant&&!(input.model==='edit'&&input.operation==='editImage'))))return {reason:`This official Krea version uses the ${kreaVariant} model.`}
  if(!profile||!rule)return {reason:'This engine branch has no reviewed resource-family mapping.'}
  if(!rule.bases.includes(version.baseModel))return {reason:`${version.baseModel || air.ecosystem} does not match this composer path.`}
  const type=version.type.toLowerCase()
  const slot:ResourceSlot|undefined=type==='checkpoint'&&['checkpoint','diffusionmodel','unet'].includes(air.type)?(['diffuserModel','diffusionModel','checkpointModel','model'] as const).find(slot=>profile.fields[slot]==='air') : type==='lora'&&air.type==='lora'&&['weights','weightedArray'].includes(profile.fields.loras??'')?'loras' : type==='vae'&&air.type==='vae'&&profile.fields.vaeModel==='air'?'vaeModel':type==='textualinversion'&&air.type==='embedding'&&profile.fields.embeddings==='airs'&&input.engine!=='comfy'?'embeddings':undefined
  return slot?{slot,reason:`Use the documented ${slot} resource field.`}:{reason:type==='checkpoint'?'This path uses a provider-selected model; it has no checkpoint AIR override.':`This path has no supported ${type} resource field.`}
}

// Only complete existing starters are offered for an explicit reviewed switch.
export const modelSwitchPaths: {label:string;media:'image'|'video';engine:string;variant:string;overrides?:Record<string,unknown>}[]=[
  {label:'Anima · SD CPP',media:'image',engine:'sdcpp',variant:'anima'},
  {label:'Anima · Comfy',media:'image',engine:'comfy',variant:'anima'},
  {label:'SDXL · SD CPP',media:'image',engine:'sdcpp',variant:'sdxl'},
  {label:'SD1 · SD CPP',media:'image',engine:'sdcpp',variant:'sd1'},
  {label:'Z Image Turbo · SD CPP',media:'image',engine:'sdcpp',variant:'zImage'},
  {label:'Z Image Base · SD CPP',media:'image',engine:'sdcpp',variant:'zImage',overrides:{model:'base',steps:20,cfgScale:4}},
  {label:'Chroma · Comfy',media:'image',engine:'comfy',variant:'chroma'},
  {label:'Qwen 2.1 · Comfy',media:'image',engine:'comfy',variant:'qwen'},
  {label:'Qwen 20B · SD CPP',media:'image',engine:'sdcpp',variant:'qwen'},
  ...['4b','4b-base','9b','9b-base'].map(modelVersion=>({label:'Flux 2 Klein '+modelVersion+' · SD CPP',media:'image' as const,engine:'sdcpp',variant:'flux2Klein',overrides:{modelVersion}})),
  {label:'Krea 2 · Comfy',media:'image',engine:'comfy',variant:'krea2'},
  {label:'Krea 2 Turbo · Comfy',media:'image',engine:'comfy',variant:'krea2',overrides:{model:'turbo',steps:8,cfgScale:1}},
  {label:'LTX 2.3',media:'video',engine:'ltx2.3',variant:''},
] as const
