import { workflowChoices, type WorkflowId } from '../../shared/workflows'
import type { WorkflowOptions } from '../../shared/quotes'
import { Input } from './ui'
import { Select } from './controls'
import { workflowModelType } from './model-types'
import { LiveGenerationModel, type ModelSelection } from './LiveGenerationModel'
export function WorkflowPicker({value,onChange,draftReason="Select an SD1/SDXL Create Image setup first."}:{value:WorkflowId;onChange:(value:WorkflowId)=>void;draftReason?:string|null}) {
  return <div className="form-field workflow-picker"><label htmlFor="studio-workflow" className="field-label">Workflow</label><select id="studio-workflow" className="shadcn-input" value={value} onChange={event=>onChange(event.target.value as WorkflowId)}>{['Image','3D','Video','Audio'].map(group=><optgroup key={group} label={group}>{workflowChoices.filter(item=>item.group===group).map(item=><option key={item.id} value={item.id} disabled={'reason' in item || (item.id==='draft' && Boolean(draftReason))}>{item.label}{item.id==='draft'&&draftReason?' — '+draftReason:''}{'reason' in item?` — ${item.reason}`:''}</option>)}</optgroup>)}</select><details className="field-help"><summary>Unavailable site workflows</summary>{workflowChoices.filter(item=>'reason' in item).map(item=><p key={item.id}>{item.label}: {'reason' in item?item.reason:''}</p>)}</details></div>
}
export function WorkflowSelection({ value, onChange, draftReason, generationModel, accountId, connected, revision }: {
  value: WorkflowId; onChange: (value: WorkflowId) => void; draftReason?: string | null
  generationModel?: ModelSelection; accountId?:string|null; connected?:boolean; revision?:string
}) {
  const modelType = workflowModelType(value)
  return <section className={`panel-card workflow-model-selection${generationModel ? ' has-generation-model' : ''}`} aria-label="Workflow and model type">
    <WorkflowPicker value={value} onChange={onChange} draftReason={draftReason} />
    {modelType ? <div className="form-field model-type-field"><span className="field-label">Model type</span><Select label="Model type" value={modelType.value} options={[modelType]} onChange={() => {}} /><p className="field-help">Available output type for this workflow.</p></div> : <p className="field-help metadata-model-note">Read generation details from a file. No model is needed.</p>}
    {generationModel && <LiveGenerationModel workflow={value} selection={generationModel} accountId={accountId} connected={connected} revision={revision}/>}
  </section>
}
export function WorkflowOptionsFields({value,onChange}:{value:WorkflowOptions;onChange:(value:WorkflowOptions)=>void}) {
  return <div className="form-field"><label className="field-label">Generation priority</label><Select label="Generation priority" value={value.priority} onChange={priority=>onChange({...value,priority:priority as WorkflowOptions['priority']})} options={[{value:'low',label:'Low'},{value:'normal',label:'Standard'},{value:'high',label:'High'}]} /><div className="field-row">{(['creators','civitai'] as const).map(key=><div key={key}><label className="field-label" htmlFor={`workflow-tip-${key}`}>{key==='creators'?'Creator':'Civitai'} tip (%)</label><Input id={`workflow-tip-${key}`} type="number" min={0} max={200} step={1} value={Number.isFinite(value.tips[key])?Number((value.tips[key]*100).toFixed(6)):''} onChange={event=>onChange({...value,tips:{...value.tips,[key]:event.target.value===''?NaN:Number(event.target.value)/100}})} /></div>)}</div></div>
}
