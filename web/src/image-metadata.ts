export type RecoveredMetadata = { prompt:string; negativePrompt:string; settings:Record<string,unknown>; resources:string[]; text:string }
const maxText=256*1024
const decode=(bytes:Uint8Array)=>new TextDecoder().decode(bytes).replace(/\0/g,'').slice(0,65536)
async function inflate(bytes:Uint8Array) {
  const stream=new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate')),reader=stream.getReader();const chunks:Uint8Array[]=[];let size=0
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new Error('Compressed metadata exceeds 64 KiB.')}chunks.push(value)}}finally{reader.releaseLock()}
  const output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length}return decode(output)
}
function exifText(bytes:Uint8Array,spend:(size:number)=>void,emit:(text:string)=>void):void {
  if(decode(bytes.subarray(0,6)).startsWith('Exif'))bytes=bytes.subarray(6)
  if(bytes.length<8)return
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),little=bytes[0]===73&&bytes[1]===73
  if(!little&&!(bytes[0]===77&&bytes[1]===77))return
  if(v.getUint16(2,little)!==42)return
  const visited=new Set<number>()
  function directory(offset:number,depth:number){
    if(depth>1||offset<8||offset+2>bytes.length||visited.has(offset))return
    visited.add(offset)
    const count=Math.min(64,v.getUint16(offset,little))
    for(let i=0;i<count;i++){
      const at=offset+2+i*12;if(at+12>bytes.length)break
      const tag=v.getUint16(at,little),type=v.getUint16(at+2,little),length=v.getUint32(at+4,little),pointer=v.getUint32(at+8,little)
      if(tag===0x8769){directory(pointer,depth+1);continue}
      if(![0x9286,0x10e].includes(tag)||![1,2,7].includes(type)||length>65536)continue
      const start=length<=4?at+8:pointer;if(start+length>bytes.length)continue
      // Charge the shared file budget before decoding each reference, including aliases.
      spend(length)
      const value=bytes.subarray(start,start+length)
      if(tag===0x9286&&decode(value.subarray(0,8)).startsWith('UNICODE'))emit(new TextDecoder(little?'utf-16le':'utf-16be').decode(value.subarray(8)).replace(/\0/g,''))
      else emit(decode(tag===0x9286?value.subarray(8):value))
    }
  }
  directory(v.getUint32(4,little),0)
}
export async function extractImageMetadata(file:File):Promise<RecoveredMetadata> {
  if(file.size>8*1024*1024)throw new Error('Choose an image no larger than 8 MiB.')
  const bytes=new Uint8Array(await file.arrayBuffer()),view=new DataView(bytes.buffer),entries:string[]=[];let total=0
  let decodeRemaining=maxText
  const spend=(size:number)=>{if(size>decodeRemaining)throw new Error('Embedded metadata exceeds 256 KiB.');decodeRemaining-=size}
  const add=(text:string,charged=false)=>{if(!charged)spend(text.length);total+=text.length;if(total>maxText)throw new Error('Embedded metadata exceeds 256 KiB.');entries.push(text)}
  if(bytes.length>=8&&bytes[0]===137&&decode(bytes.subarray(1,4))==='PNG') {
    for(let offset=8,count=0;offset+12<=bytes.length&&count<4096;count++){const length=view.getUint32(offset),kind=decode(bytes.subarray(offset+4,offset+8));if(offset+12+length>bytes.length)throw new Error('Invalid PNG chunk.');const data=bytes.subarray(offset+8,offset+8+length);if(['tEXt','zTXt','iTXt'].includes(kind)){if(length>65536)throw new Error('Metadata chunk exceeds 64 KiB.');const zero=data.indexOf(0);if(zero>0){const key=decode(data.subarray(0,zero));if(!['workflow','prompt'].includes(key)||kind==='tEXt'){let text='';if(kind==='tEXt')text=decode(data.subarray(zero+1));else if(kind==='zTXt'&&data[zero+1]===0)text=await inflate(data.subarray(zero+2));else if(kind==='iTXt'){const lang=data.indexOf(0,zero+3),translated=lang<0?-1:data.indexOf(0,lang+1);if(translated>=0)text=data[zero+1]===1?await inflate(data.subarray(translated+1)):decode(data.subarray(translated+1))}if(key!=='workflow')add(text)}}}offset+=12+length;if(kind==='IEND')break}
  } else if(bytes[0]===255&&bytes[1]===216) {
    let offset=2;for(let count=0;offset+4<=bytes.length&&count<4096;count++){if(bytes[offset]!==255)break;const marker=bytes[offset+1];if(marker===218||marker===217)break;const length=view.getUint16(offset+2);if(length<2||offset+2+length>bytes.length)throw new Error('Invalid JPEG segment.');const data=bytes.subarray(offset+4,offset+2+length);if(marker===254)add(decode(data));if(marker===225)exifText(data,spend,text=>add(text,true));offset+=length+2}
  } else if(decode(bytes.subarray(0,4))==='RIFF'&&decode(bytes.subarray(8,12))==='WEBP') {
    for(let offset=12,count=0;offset+8<=bytes.length&&count<4096;count++){const kind=decode(bytes.subarray(offset,offset+4)),length=view.getUint32(offset+4,true);if(offset+8+length>bytes.length)throw new Error('Invalid WebP chunk.');if(kind==='EXIF'){if(length>65536)throw new Error('Exif metadata exceeds 64 KiB.');exifText(bytes.subarray(offset+8,offset+8+length),spend,text=>add(text,true))}offset+=8+length+(length%2)}
  } else throw new Error('Metadata extraction supports PNG, JPEG comments/Exif and WebP Exif.')
  const text=entries.join('\n\n'),settings:Record<string,unknown>={},resources:string[]=[];let prompt='',negativePrompt=''
  for(const entry of entries){let obj:Record<string,unknown>|null=null;try{const candidate=JSON.parse(entry);if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate))obj=candidate}catch{/* Plain generation parameters. */}
    if(obj){if(typeof obj.prompt==='string')prompt=obj.prompt;if(typeof obj.negativePrompt==='string')negativePrompt=obj.negativePrompt;for(const name of ['width','height','steps','cfgScale','seed'])if(typeof obj[name]==='number'&&Number.isFinite(obj[name]))settings[name]=obj[name];if(typeof obj.model==='string')resources.push(obj.model);if(Array.isArray(obj.civitaiResources))for(const item of obj.civitaiResources.slice(0,24))if(item&&typeof item==='object')resources.push(JSON.stringify(item).slice(0,1000));continue}
    const split=entry.search(/(?:^|\n)Steps:\s*\d/);if(split<0)continue
    const body=entry.slice(0,split),negative=body.indexOf('Negative prompt:');prompt=(negative>=0?body.slice(0,negative):body).trim();negativePrompt=negative>=0?body.slice(negative+16).trim():''
    const params=entry.slice(split);for(const [label,name] of [['Steps','steps'],['CFG scale','cfgScale'],['Seed','seed']] as const){const match=new RegExp(`${label}:\\s*(-?[\\d.]+)`).exec(params);if(match&&Number.isFinite(Number(match[1])))settings[name]=Number(match[1])}const size=/Size:\s*(\d+)x(\d+)/.exec(params);if(size){settings.width=Number(size[1]);settings.height=Number(size[2])}for(const match of params.matchAll(/(?:Model|Model hash|Lora hashes):\s*([^\n]+)/g))resources.push(match[0].slice(0,1000))
  }
  return {prompt:prompt.slice(0,10000),negativePrompt:negativePrompt.slice(0,10000),settings,resources:resources.slice(0,24),text:text.slice(0,maxText)}
}
