// AceStepAudioInput + official ACE-Step recipe, checked 2026-09-27.
export const musicLanguages=['en','ja','zh','es','de','fr','pt','ru','it','nl','pl','tr','vi','cs','fa','id','ko','uk','hu','ar','sv','ro','el'] as const
export const musicTimeSignatures=['2','3','4','6'] as const
export const musicKeys=['major','minor'].flatMap(mode=>['C','C#','Db','D','D#','Eb','E','F','F#','Gb','G','G#','Ab','A','A#','Bb','B'].map(root=>`${root} ${mode}`))
export const musicStarter=()=>({engine:'aceStepAudio',musicDescription:'',lyrics:'',instrumental:true,seed:7,duration:30,bpm:85,timeSignature:'4',language:'en',key:'A minor'})
export function musicProviderInput(value:Record<string,unknown>):Record<string,unknown> {
  const allowed=Object.keys(musicStarter())
  if(Object.keys(value).some(key=>!allowed.includes(key))||value.engine!=='aceStepAudio')throw new Error('Create Music supports ACE-Step settings only. Cover images, source media, URLs and model overrides are not supported.')
  if(typeof value.musicDescription!=='string'||!value.musicDescription.trim()||value.musicDescription.length>3000)throw new Error('Describe the music in 1–3000 characters (Studio limit).')
  if(typeof value.lyrics!=='string'||value.lyrics.length>8000)throw new Error('Lyrics must be text up to 8000 characters (Studio limit).')
  if(typeof value.instrumental!=='boolean')throw new Error('Choose instrumental or lyrics mode.')
  if(!value.instrumental&&!value.lyrics.trim())throw new Error('Enter lyrics or choose Instrumental.')
  const number=(key:string,min:number,max:number,integer=false)=>{const n=value[key];if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw new Error(`${key}: use ${min}–${max}${integer?' (whole numbers)':''}.`);return n}
  const option=(key:string,choices:readonly string[])=>{const v=value[key];if(typeof v!=='string'||!choices.includes(v))throw new Error(`Choose a supported ${key}.`);return v}
  return {musicDescription:value.musicDescription,lyrics:value.instrumental?'':value.lyrics,seed:number('seed',-2147483648,2147483647,true),duration:number('duration',1,190),bpm:number('bpm',40,200,true),timeSignature:option('timeSignature',musicTimeSignatures),language:option('language',musicLanguages),key:option('key',musicKeys),vocalWeight:value.instrumental?0:.9,instrumentalWeight:value.instrumental?1:.85,steps:8,cfg:1}
}
export function musicProviderProblem(input:Record<string,unknown>):string|null {
  try {
    const {vocalWeight,instrumentalWeight,steps,cfg,...settings}=input
    if(steps!==8||cfg!==1||!((vocalWeight===0&&instrumentalWeight===1)||(vocalWeight===.9&&instrumentalWeight===.85)))throw new Error('Use the supported default ACE-Step settings.')
    const normalized=musicProviderInput({engine:'aceStepAudio',instrumental:vocalWeight===0,...settings})
    if(vocalWeight===0&&input.lyrics!=='')throw new Error('Instrumental provider input requires empty lyrics.')
    if(Object.keys(normalized).length!==Object.keys(input).length)throw new Error('Unsupported audio fields.')
    return null
  }catch(error){return error instanceof Error?error.message:'Invalid music settings.'}
}
