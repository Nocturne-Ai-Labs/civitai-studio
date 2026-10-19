import { parseAir } from '../shared/composer'
import { sourceRequirements,videoSourceOperations,type SourceOperation,type VideoSourceOperation,type FrozenImageSource } from '../shared/workflows'
import { normalizeVideoSettings,videoSourceProblem } from '../shared/video-workflows'
import { normalizeWorkflowOptions, type PreparedGeneration } from './quotes'

const operations:SourceOperation[]=['imageVariations','imageEdit','imageUpscaler','imageBackgroundRemoval','preprocessImage','imageTo3D',...videoSourceOperations]
export class SourceWorkflowError extends Error {}
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Choose valid workflow settings.');return value as Record<string,unknown>}
export function sourceSettings(operation:SourceOperation,value:unknown):Record<string,unknown> {
  if(videoSourceOperations.includes(operation as VideoSourceOperation))return normalizeVideoSettings(operation as VideoSourceOperation,object(value))
  const s=object(value),allowed=operation==='imageVariations'?['prompt','negativePrompt','model','loras','vaeModel','steps','cfgScale','width','height','quantity','seed','strength','outputFormat']:operation==='imageEdit'?['prompt']:operation==='imageUpscaler'?['numberOfRepeats','model']:operation==='imageBackgroundRemoval'?['format']:operation==='preprocessImage'?['resolution','lowThreshold','highThreshold']:['shouldTexture']
  if(Object.keys(s).some(key=>!allowed.includes(key))||JSON.stringify(s).length>16000)throw new Error('Unsupported workflow settings. Source URLs and embedded workflows are not accepted.')
  const n=(key:string,def:number,min:number,max:number,integer=false)=>{const x=s[key]===undefined?def:s[key];if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max||(integer&&!Number.isInteger(x)))throw new Error(`${key}: use ${min}–${max}${integer?' (whole numbers)':''}.`);return x}
  const prompt=(max:number,required=true)=>{if(typeof s.prompt!=='string'||(required&&!s.prompt.trim())||s.prompt.length>max)throw new Error(`Enter a prompt of ${required?1:0}–${max} characters.`);return s.prompt}
  if(operation==='imageVariations') {
    if(typeof s.model!=='string'||!parseAir(s.model))throw new Error('Select a compatible SDXL checkpoint.')
    const loras=s.loras===undefined?{}:object(s.loras)
    if(Object.entries(loras).length>20||Object.entries(loras).some(([air,weight])=>!parseAir(air)||typeof weight!=='number'||!Number.isFinite(weight)))throw new Error('Use canonical LoRA AIRs with finite weights.')
    if(s.vaeModel!==undefined&&(typeof s.vaeModel!=='string'||!parseAir(s.vaeModel)))throw new Error('Use a canonical VAE AIR.')
    if(s.outputFormat!==undefined&&(typeof s.outputFormat!=='string'||!['jpeg','png','webP'].includes(s.outputFormat)))throw new Error('Choose JPEG, PNG or WebP.')
    if(s.negativePrompt!==undefined&&(typeof s.negativePrompt!=='string'||s.negativePrompt.length>10000))throw new Error('Negative prompt exceeds 10000 characters.')
    const width=n('width',1024,64,2048,true),height=n('height',1024,64,2048,true)
    if(width%16||height%16)throw new Error('SD CPP dimensions must be multiples of 16.')
    return {prompt:prompt(10000,false),negativePrompt:s.negativePrompt??'',model:s.model,loras,...(s.vaeModel?{vaeModel:s.vaeModel}:{}),steps:n('steps',20,1,150,true),cfgScale:n('cfgScale',7,0,30),width,height,quantity:n('quantity',1,1,12,true),strength:n('strength',.7,0,1),...(s.seed==null?{}:{seed:n('seed',0,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,true)}),...(s.outputFormat?{outputFormat:s.outputFormat}:{})}
  }
  if(operation==='imageEdit')return {prompt:prompt(1000)}
  if(operation==='imageUpscaler'){const model=typeof s.model==='string'?s.model.trim():'';if(s.model!==undefined&&typeof s.model!=='string')throw new Error('Choose an upscaler AIR.');if(model&&(!parseAir(model)||parseAir(model)!.type!=='upscaler'))throw new Error('Choose a version-pinned upscaler AIR.');return {numberOfRepeats:n('numberOfRepeats',1,1,3,true),...(model?{model}:{})}}
  if(operation==='imageBackgroundRemoval'){if(s.format!==undefined&&(typeof s.format!=='string'||!['png','webp'].includes(s.format)))throw new Error('Choose PNG or WebP.');return {format:s.format??'png'}}
  if(operation==='preprocessImage'){const lowThreshold=n('lowThreshold',100,0,255,true),highThreshold=n('highThreshold',200,0,255,true);if(lowThreshold>highThreshold)throw new Error('Low threshold must not exceed high threshold.');return {resolution:n('resolution',512,64,4096,true),lowThreshold,highThreshold}}
  if(typeof s.shouldTexture!=='boolean')throw new Error('Choose whether to generate textures.')
  return {shouldTexture:s.shouldTexture}
}
export function sourceStep(operation:SourceOperation,settings:Record<string,unknown>,urls:string[]) {
  const url=urls[0]!
  if(operation==='imageToVideo'||operation==='firstLastVideo')return {$type:'videoGen',input:{engine:'ltx2.3',model:'22b-distilled',operation:operation==='imageToVideo'?'createVideo':'firstLastFrameToVideo',...settings,quantity:1,...(operation==='imageToVideo'?{images:[url]}:{firstFrame:url,lastFrame:urls[1]})}}
  if(operation==='referenceVideo')return {$type:'videoGen',input:{engine:'minimax-h3-comfy',operation:'referenceToVideo',...settings,images:urls}}
  if(operation==='videoEdit'){const {aspectRatio,...rest}=settings;return {$type:'videoGen',input:{engine:'wan',version:'v2.7',provider:'fal',operation:'edit-video',cfgScale:4,...rest,...(aspectRatio==='source'?{}:{aspectRatio}),videoUrl:url}}}
  if(operation==='preprocessVideo')return {$type:operation,input:{kind:'canny',...settings,video:url}}
  if(operation==='videoUpscaler'||operation==='videoInterpolation')return {$type:operation,input:{...settings,...(operation==='videoInterpolation'?{model:'VFIMamba'}:{}),video:url}}
  if(operation==='imageVariations')return {$type:'imageGen',input:{engine:'sdcpp',ecosystem:'sdxl',operation:'createVariant',...settings,image:url}}
  if(operation==='imageEdit')return {$type:'imageGen',input:{engine:'flux1-kontext',model:'pro',...settings,quantity:1,aspectRatio:'1:1',guidanceScale:3.5,images:[url]}}
  if(operation==='imageTo3D')return {$type:'polyGen',input:{engine:'fal',model:'meshy',version:'v6',operation:'imageTo3D',...settings,targetPolycount:30000,topology:'triangle',symmetryMode:'auto',shouldRemesh:true,enablePbr:false,enableRigging:false,enableAnimation:false,imageUrl:url}}
  if(operation==='preprocessImage')return {$type:operation,input:{kind:'canny',...settings,image:url}}
  return {$type:operation,input:{...settings,image:url}}
}
export function prepareSourceWorkflow(body:Record<string,unknown>,resolved:{source:FrozenImageSource;url:string}[]):PreparedGeneration {
  const {operation,settings,options}=validateSourceWorkflowBody(body)
  const sources=resolved.map(item=>item.source)
  const requirement=sourceRequirements(operation)
  if(sources.length<requirement.min||sources.length>requirement.max||sources.some(source=>source.type!==requirement.type))throw new SourceWorkflowError(`Choose ${requirement.min===requirement.max?requirement.min:`${requirement.min}–${requirement.max}`} owned ${requirement.type} sources in order.`)
  if(videoSourceOperations.includes(operation as VideoSourceOperation)){const problem=videoSourceProblem(operation as VideoSourceOperation,sources,settings);if(problem)throw new SourceWorkflowError(problem)}
  const step=sourceStep(operation,settings,resolved.map(item=>item.url))
  const mediaType=operation==='imageTo3D'?'model3d':videoSourceOperations.includes(operation as VideoSourceOperation)?'video':'image',engine=String((step.input as Record<string,unknown>).engine??operation)
  const references=sources.map(({id,revision,kind,label,type,mime,size,width,height,duration,expiresAt,origin})=>({id,revision,kind,label,type,mime,size,width,height,duration,expiresAt,origin}))
  return {mediaType,providerInput:step.input,storedInput:{prompt:typeof settings.prompt==='string'?settings.prompt:operation,engine,model:(step.input as any).model,parameters:{...settings,operation,sources:references,options}},policy:{},fingerprint:JSON.stringify({operation,settings,sources:sources.map(({id,revision,identity})=>({id,revision,identity})),options}),sourceWorkflow:{operation,settings,sources},workflowRequest:{tips:options.tips,metadata:{studioSourceWorkflow:{operation,sources:references}},steps:[{...step,priority:options.priority}]}}
}
export function validateSourceWorkflowBody(body:Record<string,unknown>) {
  if(Object.keys(body).some(key=>!['recipe','operation','sourceIds','settings','options'].includes(key))||!operations.includes(body.operation as SourceOperation))throw new Error('Choose a supported source workflow.')
  const operation=body.operation as SourceOperation
  const required=sourceRequirements(operation)
  if(!Array.isArray(body.sourceIds)||body.sourceIds.length<required.min||body.sourceIds.length>required.max||body.sourceIds.some(id=>typeof id!=='string'||!/^src_[a-f0-9-]{36}$/.test(id)))throw new Error(`Choose ${required.min}–${required.max} owned ${required.type} sources in order.`)
  return {operation,settings:sourceSettings(operation,body.settings),options:normalizeWorkflowOptions(body.options)}
}
