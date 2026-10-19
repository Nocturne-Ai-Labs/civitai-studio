import type { VideoSourceOperation } from '../../shared/workflows'
import { videoNumbers } from '../../shared/video-workflows'
import { Button,Input } from './ui'
import { Select } from './controls'
export function VideoWorkflowControls({operation,settings,onField}:{operation:VideoSourceOperation;settings:Record<string,unknown>;onField:(key:string,value:unknown)=>void}) {
  return <><div className="image-parameter-grid">{videoNumbers(operation).map(f=><div key={f.key}><label className="field-label" htmlFor={`video-setting-${f.key}`}>{f.label}</label><Input id={`video-setting-${f.key}`} type="number" min={f.min} max={f.max} step={f.step} value={typeof settings[f.key]==='number'?Number(settings[f.key]):''} onChange={e=>onField(f.key,e.target.value===''?null:Number(e.target.value))}/></div>)}</div>
    {(operation==='imageToVideo'||operation==='firstLastVideo')&&<><Button type="button" variant="secondary" role="switch" aria-checked={settings.generateAudio===true} onClick={()=>onField('generateAudio',!settings.generateAudio)}>Generated audio: {settings.generateAudio?'On':'Off'}</Button><p className="field-help">One video, 3 seconds. Studio dimensions: 256–1280 in multiples of 16. Exact cost comes from your preview.</p></>}
    {operation==='referenceVideo'&&<p className="field-help">1–9 ordered images. Dimensions use multiples of 32. Provider availability and cost are checked at preview.</p>}
    {operation==='videoEdit'&&<><Select label="Output resolution" value={String(settings.resolution)} onChange={value=>onField('resolution',value)} options={['720p','1080p'].map(value=>({value,label:value}))}/><Select label="Audio" value={String(settings.audioSetting)} onChange={value=>onField('audioSetting',value)} options={[{value:'auto',label:'Automatic'},{value:'origin',label:'Keep original audio'}]}/><Select label="Output aspect ratio" value={String(settings.aspectRatio)} onChange={value=>onField('aspectRatio',value)} options={['source','16:9','9:16','1:1','4:3','3:4'].map(value=>({value,label:value==='source'?'Keep source ratio':value}))}/></>}
  </>
}
