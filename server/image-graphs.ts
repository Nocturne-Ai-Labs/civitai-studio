import {createHash} from 'node:crypto'
import templates from './image-graph-templates.json'
import {graphBlocker,graphOperations,imageWorkflowRevision,type GraphOperation} from '../shared/image-workflows'
import type {FrozenImageSource} from '../shared/workflows'
import {parseAir} from '../shared/composer'
import {validateGenerationResources,resolveModelVersion} from './models'
import type {BearerLease} from './connection'
import {normalizeWorkflowOptions,type PreparedGeneration} from './quotes'

// Server-owned templates extracted from civitai/civitai, comfy.types.ts at the
// pinned revision. Placeholder values are assigned, NEVER interpolated as JSON.
// Public candidate wire format is ComfyNode.classType/meta with numeric links.
// No environment variable or browser flag can open this qualification gate.
export function requireImageGraphQualification():never {throw new Error(graphBlocker)}
type Node={classType:string;meta:{title:string};inputs:Record<string,string|number|boolean|[number,number]>}
const mapping={createFace:'txt2img-facefix',faceFix:'img2img-facefix',createHires:'txt2img-hires',hiresFix:'img2img-hires'} as const
const finalNodes={createFace:55,faceFix:58,createHires:12,hiresFix:12} as const
const allowedClasses=new Set(['smZ CLIPTextEncode','SAMLoader','UltralyticsDetectorProvider','FaceDetailer','CheckpointLoaderSimple','LoadImage','SaveImage','KSampler','EmptyLatentImage','VAEDecode','ImageUpscaleWithModel','UpscaleModelLoader','VAEEncode','ImageScale','LoraLoader','VAELoader'])
export type GraphCandidate=PreparedGeneration & {imageGraph:{operation:GraphOperation;revision:string;wireFormat:'public-comfy-node-v1';digest:string;templateDigest:string;settings:Record<string,unknown>;sources:FrozenImageSource[];expectedFinalNode:number;outputMappingQualified:false}}

// Foundation for future qualification only. This function is not exposed by a
// route. Runtime preview and paid dispatch both reject all graph candidates.
export async function buildImageGraphCandidate(key:BearerLease,body:Record<string,unknown>,resolved:{source:FrozenImageSource;url:string}[]):Promise<GraphCandidate> {
  if(Object.keys(body).some(k=>!['recipe','operation','settings','sourceIds','options'].includes(k))||!graphOperations.includes(body.operation as GraphOperation))throw new Error('Choose a fixed image graph workflow.')
  const operation=body.operation as GraphOperation,usesImage=operation==='faceFix'||operation==='hiresFix',hires=operation==='createHires'||operation==='hiresFix'
  const s=body.settings
  if(!s||typeof s!=='object'||Array.isArray(s))throw new Error('Image graph settings are required.')
  const input=s as Record<string,unknown>
  if(Object.keys(input).some(k=>!['prompt','negativePrompt','model','loras','vaeModel','seed','steps','cfgScale','width','height','quantity','denoise','outputFormat'].includes(k))||JSON.stringify(input).length>24000)throw new Error('Only bounded image settings are accepted; custom graphs and media URLs are forbidden.')
  if(!Array.isArray(body.sourceIds)||body.sourceIds.length!==(usesImage?1:0)||resolved.length!==body.sourceIds.length||resolved.some((item,i)=>item.source.id!==(body.sourceIds as unknown[])[i]||!/^src_[a-f0-9-]{36}$/.test(item.source.id)||item.source.type!=='image'||item.source.status!=='ready'||!item.source.revision||!item.source.identity))throw new Error('Choose one ready owned image for an image fix, or no source for a create workflow.')
  const number=(name:string,fallback:number,min:number,max:number,integer=true)=>{const n=input[name]??fallback;if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isSafeInteger(n)))throw new Error(`Invalid ${name}.`);return n}
  const text=(name:string)=>{const value=input[name]??'';if(typeof value!=='string'||value.length>10000)throw new Error('Prompt exceeds 10000 characters.');return value}
  if(typeof input.model!=='string'||parseAir(input.model)?.type!=='checkpoint')throw new Error('Select one SDXL checkpoint.')
  const loras=input.loras??{}
  if(!loras||typeof loras!=='object'||Array.isArray(loras)||Object.keys(loras).length>8||Object.entries(loras).some(([air,weight])=>parseAir(air)?.type!=='lora'||typeof weight!=='number'||!Number.isFinite(weight)||weight < -2 || weight>2))throw new Error('Use at most eight canonical LoRAs with weights -2 to 2.')
  if(input.vaeModel!==undefined&&(typeof input.vaeModel!=='string'||parseAir(input.vaeModel)?.type!=='vae'))throw new Error('Select a canonical SDXL VAE.')
  const resources={engine:'sdcpp',ecosystem:'sdxl',operation:'createImage',model:input.model,loras,...(input.vaeModel?{vaeModel:input.vaeModel}:{})}
  const resourceProblem=await validateGenerationResources(key,'image',resources);if(resourceProblem)throw new Error(resourceProblem)
  for(const air of [input.model,...Object.keys(loras),...(input.vaeModel?[String(input.vaeModel)]:[])])if(!['sdxl','sdxl1'].includes(parseAir(air)!.ecosystem))throw new Error('Graph foundation currently accepts SDXL resources only.')
  if(hires){const upscaler=await resolveModelVersion(key,164821);if(upscaler.air!=='urn:air:other:upscaler:civitai:147759@164821'||!upscaler.canGenerate||upscaler.type.toLowerCase()!=='upscaler')throw new Error('Pinned HiRes upscaler unavailable.')}
  // Worker-only SAM/detector AIR availability cannot be established through Site
  // ModelVersion resolution. The closed gate also covers these auxiliaries.
  const width=usesImage?resolved[0]!.source.width:number('width',1024,64,2048),height=usesImage?resolved[0]!.source.height:number('height',1024,64,2048)
  if(typeof width!=='number'||typeof height!=='number'||!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>4096||height>4096||(!usesImage&&(width%16||height%16)))throw new Error('Known supported dimensions are required.')
  if(input.seed===undefined)throw new Error('A fixed seed is required for image graph candidates.')
  const ratio=Math.min(1.5,4096/Math.max(width,height)),upscaleWidth=Math.max(64,Math.floor(width*ratio/8)*8),upscaleHeight=Math.max(64,Math.floor(height*ratio/8)*8)
  const format=input.outputFormat??'jpeg';if(!['jpeg','png','webp'].includes(String(format)))throw new Error('Choose a supported output format.')
  const settings={...resources,prompt:text('prompt'),negativePrompt:text('negativePrompt'),seed:number('seed',0,0,2147483647),steps:number('steps',25,1,50),cfgScale:number('cfgScale',7,0,20,false),width,height,quantity:number('quantity',1,1,4),denoise:number('denoise',.75,0,1,false),outputFormat:format,upscaleWidth,upscaleHeight,sampler:'euler',scheduler:'normal'}
  if(usesImage){const url=new URL(resolved[0]!.url);if(url.protocol!=='https:'||url.username||url.password||!['orchestration.civitai.com','orchestration-new.civitai.com','image.civitai.com'].includes(url.hostname))throw new Error('Invalid server-resolved source URL.')}
  const values:Record<string,unknown>={...settings,...(usesImage?{image:resolved[0]!.url}:{})},graph:Record<string,Node>={}
  const template=templates[mapping[operation]]
  for(const [id,raw] of Object.entries(template)) {
    if(!allowedClasses.has(raw.class_type))throw new Error('Unreviewed template node.')
    const inputs:Node['inputs']={}
    for(const [name,v] of Object.entries(raw.inputs)) {
      if(Array.isArray(v)){if(v.length!==2||!Number.isSafeInteger(Number(v[0]))||!Number.isSafeInteger(v[1]))throw new Error('Invalid template link.');inputs[name]=[Number(v[0]),v[1] as number];continue}
      const match=typeof v==='string'?/^\{\{(\w+)\}\}$/.exec(v):null,value=match?values[match[1]!]:v
      if(!['string','number','boolean'].includes(typeof value))throw new Error('Unresolved template input.')
      inputs[name]=value as string|number|boolean
    }
    graph[id]={classType:raw.class_type,meta:{title:raw._meta.title},inputs}
  }
  const checkpoint=hires?'101':'54';graph[checkpoint]!.inputs.ckpt_name=input.model
  let modelLink:[number,number]=[Number(checkpoint),0],clipLink:[number,number]=[Number(checkpoint),1],vaeLink:[number,number]=[Number(checkpoint),2],nextId=200
  for(const [air,weight] of Object.entries(loras)) {const id=nextId++;graph[id]={classType:'LoraLoader',meta:{title:'Pinned LoRA'},inputs:{model:modelLink,clip:clipLink,lora_name:air,strength_model:weight as number,strength_clip:weight as number}};modelLink=[id,0];clipLink=[id,1]}
  if(input.vaeModel){const id=nextId++;graph[id]={classType:'VAELoader',meta:{title:'Pinned VAE'},inputs:{vae_name:String(input.vaeModel)}};vaeLink=[id,0]}
  for(const [id,node] of Object.entries(graph))if(Number(id)<200)for(const [name,value] of Object.entries(node.inputs))if(Array.isArray(value)&&value[0]===Number(checkpoint))node.inputs[name]=value[1]===0?modelLink:value[1]===1?clipLink:vaeLink
  for(const node of Object.values(graph))for(const value of Object.values(node.inputs))if(Array.isArray(value)&&!graph[value[0]])throw new Error('Missing template node.')
  const digest=createHash('sha256').update(JSON.stringify(graph)).digest('hex'),templateDigest=createHash('sha256').update(JSON.stringify(template)).digest('hex'),sources=resolved.map(item=>item.source),options=normalizeWorkflowOptions(body.options)
  const imageGraph={operation,revision:imageWorkflowRevision,wireFormat:'public-comfy-node-v1' as const,digest,templateDigest,settings,sources,expectedFinalNode:finalNodes[operation],outputMappingQualified:false as const}
  const references=sources.map(({identity,...source})=>source)
  const providerInput={quantity:settings.quantity,comfyWorkflow:graph,imageMetadata:JSON.stringify({studioWorkflow:operation,revision:imageWorkflowRevision,digest}),useSpineComfy:null}
  return {mediaType:'image',imageGraph,providerInput,storedInput:{prompt:settings.prompt,negativePrompt:settings.negativePrompt,model:settings.model,engine:'comfy',parameters:{...settings,studioWorkflow:operation,graphDigest:digest,templateRevision:imageWorkflowRevision,sources:references}},policy:{},fingerprint:JSON.stringify({operation,settings,revision:imageWorkflowRevision,digest,templateDigest,sources:sources.map(({id,revision,identity})=>({id,revision,identity})),options}),workflowRequest:{tips:options.tips,steps:[{$type:'comfy',priority:options.priority,input:providerInput}]}}
}
