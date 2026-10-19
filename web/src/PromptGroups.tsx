import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { combinePrompts, type PromptGroup } from '../../shared/composer'
import { Button, Input, Textarea } from './ui'
import { Tooltip } from './controls'
import { PromptLibrary, type PromptLibraryProps } from './PromptLibrary'
export function PromptGroups({ groups, onChange, onActive, disabled, max, limitLabel, library }: { groups: PromptGroup[]; onChange: (groups: PromptGroup[]) => void; onActive?: (id: string) => void; disabled: boolean; max: number; limitLabel: string; library?: Omit<PromptLibraryProps,'groups'|'max'|'disabled'|'checkpointVersion'> }) {
  const [checkpointVersion,setCheckpointVersion] = useState(0)
  const fields = useRef(new Map<string, HTMLTextAreaElement>())
  const pendingFocus = useRef<string | null>(null)
  useEffect(() => { if (pendingFocus.current) { fields.current.get(pendingFocus.current)?.focus(); pendingFocus.current = null } }, [groups])
  const update = (id: string, patch: Partial<PromptGroup>) => onChange(groups.map(group => group.id === id ? { ...group, ...patch } : group))
  function move(index: number, direction: number) {
    const next = [...groups]; [next[index], next[index + direction]] = [next[index + direction]!, next[index]!]
    pendingFocus.current = groups[index]!.id
    onChange(next)
  }
  const combined = combinePrompts(groups)
  return <section className="prompt-groups" aria-label="Prompt groups" onBlurCapture={event => { if(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)setCheckpointVersion(value=>value+1) }}>
    {library && <PromptLibrary {...library} groups={groups} max={max} disabled={disabled} checkpointVersion={checkpointVersion} />}
    <div className="prompt-toolbar"><span className="field-help">Build your prompt in one or more groups.</span><Button type="button" variant="ghost" size="sm" disabled={disabled || groups.length >= 20} onClick={() => { const id = crypto.randomUUID(); pendingFocus.current = id; onChange([...groups, { id, label: '', text: '' }]) }}><Plus size={14} />Add group</Button></div>
    {groups.map((group, index) => <div className="form-field prompt-group" key={group.id}>
      <div className="prompt-group-heading"><label className="field-label" htmlFor={`prompt-${group.id}`}>Prompt {index + 1}</label><Input value={group.label} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} maxLength={80} aria-label={`Label for prompt group ${index + 1}`} placeholder="Group label (optional)" disabled={disabled} onChange={event => update(group.id, { label: event.target.value })} />
        <Tooltip label="Move prompt group up"><Button type="button" variant="ghost" size="icon" aria-label={`Move prompt group ${index + 1} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></Button></Tooltip>
        <Tooltip label="Move prompt group down"><Button type="button" variant="ghost" size="icon" aria-label={`Move prompt group ${index + 1} down`} disabled={disabled || index === groups.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></Button></Tooltip>
        <Tooltip label="Remove prompt group"><Button type="button" variant="ghost" size="icon" aria-label={`Remove prompt group ${index + 1}`} disabled={disabled || groups.length === 1} onClick={() => { pendingFocus.current = groups[index === 0 ? 1 : index - 1]!.id; onChange(groups.filter(g => g.id !== group.id)) }}><Trash2 size={14} /></Button></Tooltip>
      </div>
      <Textarea id={`prompt-${group.id}`} onFocus={() => onActive?.(group.id)} ref={node => { if (node) fields.current.set(group.id, node); else fields.current.delete(group.id) }} disabled={disabled} value={group.text} onChange={event => update(group.id, { text: event.target.value })} placeholder="Describe what to create…" maxLength={10000} />
    </div>)}
    <details className="combined-prompt"><summary>Combined prompt · {combined.length.toLocaleString()} / {max.toLocaleString()} characters</summary><pre>{combined || 'Empty prompt'}</pre><p>{limitLabel}. Groups are joined with one blank line; labels are not sent.</p></details>
    {combined.length > max && <p className="composer-error" role="alert">Shorten the combined prompt before generating or saving a preset.</p>}
    {disabled && <p className="field-help">Fix the JSON input to edit prompt groups.</p>}
  </section>
}
