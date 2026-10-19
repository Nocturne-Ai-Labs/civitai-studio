import type { ImageSource, VideoSourceOperation } from './workflows'
export const ltxDefaults={prompt:'',width:1280,height:720,duration:3,fps:24,steps:8,guidanceScale:1,generateAudio:false}
export function videoDefaults(operation:VideoSourceOperation):Record<string,unknown> {
  if(operation==='imageToVideo'||operation==='firstLastVideo')return {...ltxDefaults,...(operation==='firstLastVideo'?{frameGuideStrength:.7}:{})}
  if(operation==='referenceVideo')return {prompt:'',width:864,height:480,duration:4,steps:20}
  if(operation==='videoEdit')return {prompt:'',resolution:'720p',audioSetting:'auto',aspectRatio:'source'}
  if(operation==='videoUpscaler')return {scaleFactor:2}
  if(operation==='videoInterpolation')return {interpolationFactor:2}
  return {resolution:512,lowThreshold:100,highThreshold:200}
}
export type VideoNumberField={key:string;label:string;min:number;max:number;step:number}
export function videoNumbers(operation:VideoSourceOperation):VideoNumberField[] {
  const field=(key:string,label:string,min:number,max:number,step=1)=>({key,label,min,max,step})
  if(operation==='imageToVideo'||operation==='firstLastVideo')return [field('width','Width (Studio: 256–1280)',256,1280,16),field('height','Height (Studio: 256–1280)',256,1280,16),field('duration','Seconds (Studio: 3 only)',3,3),field('fps','FPS',1,60),field('steps','Steps',8,50),field('guidanceScale','Guidance',1,10,.1),...(operation==='firstLastVideo'?[field('frameGuideStrength','Frame guide strength',0,1,.05)]:[])]
  if(operation==='referenceVideo')return [field('width','Width',32,1344,32),field('height','Height',32,1344,32),field('duration','Seconds',4,15),field('steps','Steps',1,60)]
  if(operation==='videoUpscaler')return [field('scaleFactor','Scale factor',2,4)]
  if(operation==='videoInterpolation')return [field('interpolationFactor','Frame multiplier',2,3)]
  if(operation==='preprocessVideo')return [field('resolution','Shorter-edge resolution',64,4096),field('lowThreshold','Low threshold',0,255),field('highThreshold','High threshold',0,255)]
  return []
}
export const videoDescriptions:Record<VideoSourceOperation,string>={
  imageToVideo:'LTX 2.3 distilled · createVideo · one image · one video',
  firstLastVideo:'LTX 2.3 distilled · firstLastFrameToVideo · first then last image · one video',
  referenceVideo:'MiniMax H3 Comfy · referenceToVideo · 1–9 ordered images',
  videoEdit:'WAN 2.7 Fal · edit-video · MP4/MOV, 2–10 seconds, up to 100 MB',
  videoUpscaler:'FlashVSR videoUpscaler · output must fit 2560 pixels per side',
  videoInterpolation:'VFIMamba videoInterpolation · source must fit 2048 pixels per side',
  preprocessVideo:'Canny preprocessVideo · video edge map output',
}
export function normalizeVideoSettings(operation:VideoSourceOperation,s:Record<string,unknown>):Record<string,unknown> {
  const defaults=videoDefaults(operation)
  if(Object.keys(s).some(name=>!Object.prototype.hasOwnProperty.call(defaults,name))||JSON.stringify(s).length>16000)throw new Error('Unsupported video settings. Source URLs and custom graphs are not accepted.')
  const result:Record<string,unknown>={}
  if('prompt' in defaults){if(typeof s.prompt!=='string'||!s.prompt.trim()||s.prompt.length>10000)throw new Error('Enter a video prompt of 1–10000 characters (Studio limit).');result.prompt=s.prompt}
  for(const f of videoNumbers(operation)) {const value=s[f.key]===undefined?defaults[f.key]:s[f.key];if(typeof value!=='number'||!Number.isFinite(value)||value<f.min||value>f.max||(f.step>=1&&!Number.isInteger(value)))throw new Error(`${f.label}: use ${f.min}–${f.max}.`);result[f.key]=value}
  if('width' in result){const grid=operation==='referenceVideo'?32:16;if(Number(result.width)%grid||Number(result.height)%grid)throw new Error(`Dimensions must be multiples of ${grid} (Studio constraint).`)}
  if('generateAudio' in defaults){if(typeof s.generateAudio!=='boolean')throw new Error('Choose audio on or off.');result.generateAudio=s.generateAudio}
  if(operation==='preprocessVideo'&&Number(result.lowThreshold)>Number(result.highThreshold))throw new Error('Low threshold must not exceed high threshold.')
  if(operation==='videoEdit')for(const [key,choices] of Object.entries({resolution:['720p','1080p'],audioSetting:['auto','origin'],aspectRatio:['source','16:9','9:16','1:1','4:3','3:4']})){const value=s[key]??defaults[key];if(typeof value!=='string'||!choices.includes(value))throw new Error(`Choose a supported ${key}.`);result[key]=value}
  return result
}
export function videoSourceProblem(operation:VideoSourceOperation,sources:ImageSource[],settings:Record<string,unknown>):string|null {
  const source=sources[0];if(!source)return null
  if(operation==='videoUpscaler'||operation==='videoInterpolation'){
    const factor=operation==='videoUpscaler'?Number(settings.scaleFactor):1,limit=operation==='videoUpscaler'?2560:2048
    if([source.width,source.height].some(value=>typeof value==='number'&&value*factor>limit))return operation==='videoUpscaler'?'The scaled video exceeds 2560 pixels per side. Choose a smaller source or scale.':'Interpolation requires source dimensions at most 2048 pixels per side.'
  }
  if(operation==='videoEdit'){
    if(source.mime&&!['video/mp4','video/quicktime'].includes(source.mime))return 'WAN Edit Video needs MP4 or MOV. Convert this source in the gallery first.'
    if(source.duration!==undefined&&(source.duration<2||source.duration>10))return 'WAN Edit Video needs a source between 2 and 10 seconds.'
    if(source.size!==null&&source.size>100_000_000)return 'WAN Edit Video accepts sources up to 100 MB.'
  }
  return null
}
