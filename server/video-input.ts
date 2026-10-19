import snapshot from './video-input-schema.json'
import { parseAir } from '../shared/composer'

// Security allowlist, separate from provider capability validation. New provider
// fields stay closed until reviewed, even if added to the pinned schema snapshot.
const scalarFields=new Set(('engine prompt negativePrompt model diffusionModel operation provider version aspectRatio resolution duration seed width height steps cfgScale guidanceScale fps frameRate quantity cameraMovement mode style movementAmplitude interpolatorModel sampler scheduler shift numInferenceSteps enableAudio enableBackgroundMusic enablePromptEnhancer enablePromptExpansion enableSafetyChecker generateAudio expandPrompt fast fastMode turbo useDistill useFastWan usePrime usePro useTurbo multiShots keepAudio watermark draft').split(' '))
const structuredFields=new Set(['loras','cameraControl','multiPrompt'])
type Schema={ $ref?:string; allOf?:Schema[]; properties?:Record<string,Schema>; required?:string[]; discriminator?:{propertyName:string;mapping:Record<string,string>}; type?:string|string[]; enum?:unknown[]; default?:unknown; readOnly?:boolean; items?:Schema; additionalProperties?:boolean|Schema; minimum?:number; maximum?:number; minLength?:number; maxLength?:number; minItems?:number; maxItems?:number }
const schemas=snapshot.schemas as Record<string,Schema>
const own=(object:object,key:string)=>Object.prototype.hasOwnProperty.call(object,key)
const fail=()=>{throw new Error('Video JSON accepts reviewed source-free settings only. Use the workflow menu for owned images, videos and frame references.')}
const cache=new Map<string,Schema>()
function flatten(schema:Schema):Schema {
  if(schema.$ref){const name=schema.$ref.split('/').at(-1)!;if(!own(schemas,name))return fail();if(!cache.has(name))cache.set(name,flatten(schemas[name]!));return cache.get(name)!}
  let result:Schema={properties:{},required:[]}
  for(const part of [...(schema.allOf??[]),{...schema,allOf:undefined}]){
    const next=part.allOf||part.$ref?flatten(part):part
    result={...result,...next,properties:{...result.properties,...next.properties},required:[...new Set([...(result.required??[]),...(next.required??[])])]}
  }
  return result
}
function selectedSchema(input:Record<string,unknown>):{schema:Schema;selectors:Record<string,string>} {
  let name='VideoGenInput'
  const seen=new Set<string>()
  const selectors:Record<string,string>=Object.create(null)
  for(let depth=0;depth<8;depth++){
    if(seen.has(name))return fail();seen.add(name)
    const schema=flatten({$ref:`#/components/schemas/${name}`}),d=schema.discriminator
    if(!d)return {schema,selectors}
    const value=input[d.propertyName]??selectors[d.propertyName]??schema.properties?.[d.propertyName]?.default
    if(typeof value!=='string'||!own(d.mapping,value))return fail()
    selectors[d.propertyName]=value
    const next=d.mapping[value]!.split('/').at(-1)!
    // Leaf schemas inherit their parent's discriminator pointing to themselves.
    if(next===name)return {schema,selectors}
    name=next
  }
  return fail()
}
export function locatorText(value:string):boolean {
  let text=value
  for(let n=0;n<4;n++){
    // JSON escapes are decoded by readBody; normalize additional escaped and
    // percent-encoded locators too. Whitespace cannot hide a scheme.
    const plain=text.replace(/\\u([\da-f]{4})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))).replace(/\\\//g,'/').replace(/[\s\u0000-\u001f\u007f]/g,'')
    if(/(?:[a-z][a-z\d+.-]*:\/\/|(?:data|blob|file|javascript|ipfs|ipns):|\/\/|www\.)/i.test(plain))return true
    try {const decoded=decodeURIComponent(plain);if(decoded===text)break;text=decoded}catch{break}
  }
  return false
}
function scanStrings(input:unknown) {
  const pending:[unknown,number,string][]=[[input,0,'']];let count=0
  while(pending.length){const [value,depth,path]=pending.pop()!;if(++count>2000||depth>12)return fail();if(typeof value==='string'){
    // These schema-typed fields are ordinary bounded prose, not media inputs.
    const prose=path==='prompt'||path==='negativePrompt'||/^multiPrompt\.\d+\.prompt$/.test(path)
    if(!prose&&locatorText(value))return fail()
  }else if(value&&typeof value==='object'){for(const [key,item] of Object.entries(value)){if(locatorText(key)||['__proto__','prototype','constructor'].includes(key))return fail();pending.push([item,depth+1,path?`${path}.${key}`:key])}}}
}
function checkValue(value:unknown,raw:Schema,depth=0):void {
  if(depth>8)return fail()
  const s=flatten(raw),types=Array.isArray(s.type)?s.type:[s.type]
  if(s.readOnly||s.enum&&!s.enum.includes(value))return fail()
  if(value===null){if(!types.includes('null'))return fail();return}
  if(typeof value==='string'){if(!types.includes('string')||value.length<(s.minLength??0)||value.length>(s.maxLength??10000))return fail();return}
  if(typeof value==='number'){if(!Number.isFinite(value)||(!types.includes('number')&&!(types.includes('integer')&&Number.isInteger(value)))||value<(s.minimum??-Infinity)||value>(s.maximum??Infinity))return fail();return}
  if(typeof value==='boolean'){if(!types.includes('boolean'))return fail();return}
  if(Array.isArray(value)){if(!types.includes('array')||!s.items||value.length<(s.minItems??0)||value.length>Math.min(s.maxItems??20,20))return fail();for(const item of value)checkValue(item,s.items,depth+1);return}
  if(value&&typeof value==='object'&&types.includes('object')){
    const object=value as Record<string,unknown>;if(Object.keys(object).length>40)return fail()
    for(const name of s.required??[])if(!own(object,name))return fail()
    for(const [name,item] of Object.entries(object)){
      const property=own(s.properties??{},name)?s.properties![name]:typeof s.additionalProperties==='object'?s.additionalProperties:undefined
      if(!property)return fail();checkValue(item,property,depth+1)
    }
    return
  }
  return fail()
}
export function validateSourceFreeVideo(input:Record<string,unknown>):void {
  if(JSON.stringify(input).length>12000)return fail()
  scanStrings(input)
  const {schema,selectors}=selectedSchema(input)
  const operation=input.operation??selectors.operation??schema.properties?.operation?.default
  if(operation!==undefined&&operation!==null&&!['createVideo','textToVideo','text-to-video'].includes(String(operation))&&!(input.engine==='minimax-h3-comfy'&&operation==='imageToVideo'))return fail()
  for(const name of schema.required??[]){
    if(schema.properties?.[name]&&flatten(schema.properties[name]!).readOnly)continue
    if(!scalarFields.has(name)&&!structuredFields.has(name))return fail()
    // Provider schemas mark discriminator/defaulted inputs required; selection
    // above handles defaults. Other required settings must be supplied.
    if(!own(input,name)&&!['engine','operation','version','provider'].includes(name)&&schema.properties?.[name]?.default===undefined)return fail()
  }
  for(const [name,value] of Object.entries(input)){
    if((!scalarFields.has(name)&&!structuredFields.has(name))||!own(schema.properties??{},name))return fail()
    checkValue(value,schema.properties![name]!)
    if(name==='diffusionModel'||name==='model'&&['wan','hunyuan'].includes(String(input.engine))){if(value!==null&&(typeof value!=='string'||!parseAir(value)||!['checkpoint','diffusionmodel','unet'].includes(parseAir(value)!.type.toLowerCase())))return fail()}
    if(name==='loras'&&value!==null){
      const airs=Array.isArray(value)?value.map(item=>(item as Record<string,unknown>).air):Object.keys(value as object)
      if(airs.length>20||airs.some(air=>typeof air!=='string'||parseAir(air)?.type.toLowerCase()!=='lora'))return fail()
    }
  }
}

export function sourceFreeVideoProblem(input:Record<string,unknown>):string|null {
  try {validateSourceFreeVideo(input);return null}catch{return 'Video JSON must use reviewed source-free settings. Choose owned media through the workflow menu; URLs/data/blob strings are not allowed in non-prompt settings.'}
}
