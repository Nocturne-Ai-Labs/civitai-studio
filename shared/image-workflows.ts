import { parseAir } from './composer'
export const imageWorkflowRevision='329c89a23e1d5b4d6bade79f342fe6e31e15ab61'
export const graphBlocker='Awaiting public graph format, account worker access and final-output qualification.'
export const graphOperations=['createFace','faceFix','createHires','hiresFix'] as const
export type GraphOperation=typeof graphOperations[number]
export type DraftReview={revision:string;acceleratorAir:string;acceleratorVersion:number;steps:number;cfgScale:1;sampleMethod:'lcm'|'euler';quantity:number;seed:number;input:Record<string,unknown>}
export function draftProfile(input:Record<string,unknown>) {
  if(input.engine!=='sdcpp'||input.operation!=='createImage'||!['sd1','sdxl'].includes(String(input.ecosystem)))throw new Error('Draft requires an SD1 or SDXL-family SD CPP Create Image path.')
  const model=typeof input.model==='string'?parseAir(input.model):null
  if(!model||model.type!=='checkpoint')throw new Error('Select a compatible checkpoint before using Draft.')
  const sd1=input.ecosystem==='sd1'
  return {revision:imageWorkflowRevision,acceleratorVersion:sd1?424706:391999,siteAcceleratorAir:sd1?'urn:air:sd1:lora:civitai:424706@424706':'urn:air:sdxl1:lora:civitai:391999@391999',steps:sd1?6:8,cfgScale:1 as const,sampleMethod:sd1?'lcm' as const:'euler' as const}
}
export function draftProblem(input:Record<string,unknown>|null) {try{if(!input)throw new Error('Repair the input JSON first.');draftProfile(input);return null}catch(error){return error instanceof Error?error.message:'Draft is unavailable.'}}
export function normalizeDraft(input:Record<string,unknown>,allowEmptyPrompt=false) {
  const profile=draftProfile(input)
  const fields=['engine','ecosystem','operation','model','prompt','negativePrompt','width','height','quantity','seed','steps','cfgScale','sampleMethod','schedule','loras','vaeModel','embeddings','clipSkip','outputFormat']
  if(Object.keys(input).some(key=>!fields.includes(key))||JSON.stringify(input).length>24000)throw new Error('Draft supports bounded SD settings only; source media and custom graphs are unavailable.')
  const num=(key:string,fallback:number,min:number,max:number)=>{const v=input[key]??fallback;if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error(`${key}: use an integer from ${min} to ${max}.`);return v}
  for(const key of ['prompt','negativePrompt'])if(input[key]!==undefined&&(typeof input[key]!=='string'||(input[key] as string).length>10000))throw new Error('Prompts must be text up to 10,000 characters.')
  if(!allowEmptyPrompt&&(typeof input.prompt!=='string'||!input.prompt.trim()))throw new Error('Enter a prompt for Draft.')
  const width=num('width',input.ecosystem==='sd1'?512:1024,64,2048),height=num('height',input.ecosystem==='sd1'?512:1024,64,2048)
  if(width%16||height%16)throw new Error('Draft dimensions must be multiples of 16.')
  const loras=input.loras??{}
  if(!loras||typeof loras!=='object'||Array.isArray(loras)||Object.keys(loras).length>20||Object.entries(loras).some(([air,weight])=>!parseAir(air)||typeof weight!=='number'||!Number.isFinite(weight)))throw new Error('Draft requires at most 20 canonical LoRAs with finite weights.')
  if(Object.keys(loras).some(air=>parseAir(air)?.versionId===profile.acceleratorVersion))throw new Error('Remove the Draft accelerator from your custom LoRAs first; Draft adds its fixed weight explicitly.')
  if(input.embeddings!==undefined&&(!Array.isArray(input.embeddings)||input.embeddings.length>10||input.embeddings.some(air=>typeof air!=='string'||!parseAir(air))))throw new Error('Use at most 10 canonical embeddings.')
  if(input.vaeModel!==undefined&&(typeof input.vaeModel!=='string'||!parseAir(input.vaeModel)))throw new Error('Choose a canonical VAE.')
  if(input.outputFormat!==undefined&&!['jpeg','png','webP'].includes(String(input.outputFormat)))throw new Error('Choose JPEG, PNG or WebP.')
  return {engine:'sdcpp',ecosystem:input.ecosystem,operation:'createImage',model:input.model,prompt:input.prompt??'',negativePrompt:input.negativePrompt??'',width,height,quantity:num('quantity',1,1,12),...(input.seed==null?{}:{seed:num('seed',0,0,2147483647)}),steps:profile.steps,cfgScale:1,sampleMethod:profile.sampleMethod,schedule:'discrete',loras:{...loras},...(input.vaeModel?{vaeModel:input.vaeModel}:{}),...(input.embeddings?{embeddings:input.embeddings}:{}),...(input.clipSkip!==undefined?{clipSkip:num('clipSkip',2,1,12)}:{}),...(input.outputFormat?{outputFormat:input.outputFormat}:{})} as Record<string,unknown>
}
