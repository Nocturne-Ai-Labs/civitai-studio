import { Download, FlaskConical, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Generation } from './api'
import { folderSavingSupported } from './folder-save'
import { Select } from './controls'
import { Button } from './ui'
import { WorkflowCancellation } from './WorkflowCancellation'

export type TrainingRunsProps = {
  active?: boolean; runsLoading?: boolean; runsError?: string;
  runs: Generation[]; onRefresh: () => void; onCancel: (id: string, action: 'cancel' | 'reconcile') => void;
  onRetry: (id: string) => void; cancelingIds: Set<string>; hasMore: boolean; onLoadMore: () => void;
  onSaveLocal?: (ids: string[]) => void; onSaveFolder: (ids: string[]) => void; onZip: (ids: string[]) => void; saveBusy: boolean;
}
const statusLabel: Record<Generation['status'], string> = { queued: 'Queued', running: 'Training', succeeded: 'Completed', failed: 'Failed', canceled: 'Canceled', expired: 'Expired' }
export function TrainingRuns({ active = true, runs, runsLoading = false, runsError = '', onRefresh, onCancel, onRetry, cancelingIds, hasMore, onLoadMore, onSaveLocal, onSaveFolder, onZip, saveBusy }: TrainingRunsProps) {
  const [filter, setFilter] = useState('all')
  useEffect(() => { if (active) setFilter('all') }, [active])
  const filtered = runs.filter(run => filter === 'all' || (filter === 'active' ? ['queued', 'running'].includes(run.status) : filter === 'attention' ? !!run.canRetry || ['failed', 'expired'].includes(run.status) : run.status === 'succeeded'))
  return <section className="training-runs-section" aria-labelledby="training-runs-title">
    <div className="training-section-heading"><div><h3 id="training-runs-title">Training runs</h3><p>Review progress, recover a submission, and download your checkpoints.</p></div><Button variant="secondary" onClick={onRefresh}><RefreshCw size={14} />Refresh runs</Button></div>
    <div className="training-run-toolbar"><Select label="Filter training runs" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All loaded runs' }, { value: 'active', label: 'In progress' }, { value: 'completed', label: 'Completed' }, { value: 'attention', label: 'Needs attention' }]} /><span>{filtered.length} of {runs.length} loaded</span></div>
    {runsLoading && <p className="training-feedback" role="status">Loading training runs…</p>}
    {runsError && <div className="error-box" role="alert"><p>{runsError}</p><Button variant="secondary" disabled={runsLoading} onClick={onRefresh}>Retry loading runs</Button></div>}
    {!runsLoading && !runsError && !filtered.length && <div className="training-empty panel-card"><FlaskConical size={26} /><h4>{runs.length ? 'No runs match this filter' : 'Your first LoRA starts here'}</h4><p>{runs.length ? 'Choose another filter to see your loaded runs.' : 'Prepare a dataset, review the cost, then explicitly confirm training. Your runs and checkpoints will appear here.'}</p></div>}
    <div className="training-runs-list">{filtered.map(run => {
      const artifacts = run.outputs.filter(output => output.metadata?.available === true && ['checkpoint', 'training-sample'].includes(output.role ?? '')).slice(0, 50).map(output => output.id)
      return <article key={run.id} id={`training-run-${run.id}`} tabIndex={-1} className="panel-card training-run">
        <div className="training-section-heading"><div><h4>{run.input.prompt || 'LoRA training'}</h4><p>{new Date(run.createdAt).toLocaleString()} · {run.input.parameters?.ecosystem === 'sd1' ? 'SD1 / SD1.5' : run.input.parameters?.ecosystem === 'sdxl' ? 'SDXL' : 'Ecosystem not supplied'}</p></div><span className={`training-status training-status-${run.status}`}>{statusLabel[run.status]}</span></div>
        <div className="training-run-summary"><span>{run.cost ? `${run.cost.estimated ? 'Estimated ' : ''}${run.cost.amount.toLocaleString()} Buzz` : 'Cost not supplied'}</span><span>{run.trainingResult?.epochs.length ?? 0} checkpoints reported</span><span>Moderation: {run.trainingResult?.moderationStatus ?? 'Not supplied'}</span></div>
        {run.error && <p className="error-box">{run.error}</p>}
        {run.canRetry && <Button onClick={() => onRetry(run.id)}>Recover original training</Button>}
        <WorkflowCancellation generation={run} busy={cancelingIds.has(run.id)} onAction={action => onCancel(run.id, action)} />
        {!!artifacts.length && <div className="training-artifact-actions"><div className="training-actions">{onSaveLocal && <Button variant="secondary" disabled={saveBusy} onClick={() => onSaveLocal(artifacts)}>Save to configured folder</Button>}{folderSavingSupported() && <Button variant="secondary" disabled={saveBusy} onClick={() => onSaveFolder(artifacts)}>Choose download folder</Button>}<Button variant="secondary" disabled={saveBusy} onClick={() => onZip(artifacts)}><Download size={14} />Download artifacts ZIP</Button></div><p className="field-help">First 50 available artifacts per batch. Folder saves support checkpoints up to 1 GiB; ZIP downloads are limited to 150 MiB. Individual downloads are below.</p></div>}
        {!!run.trainingResult?.epochs.length && <div className="training-epochs">{run.trainingResult.epochs.map(epoch => <details key={epoch.epochNumber} className="training-epoch"><summary><span>Checkpoint {epoch.epochNumber}</span><span>{epoch.available ? 'Available' : 'Unavailable'} · {epoch.sampleIds.length} samples</span></summary><div className="training-epoch-content">
          <div className="training-actions">{epoch.available && epoch.modelId && onSaveLocal && <Button variant="secondary" size="sm" disabled={saveBusy} onClick={() => onSaveLocal([epoch.modelId!])}>Save checkpoint to configured folder</Button>}{epoch.available && epoch.modelId ? <a className="training-download-link" href={`/api/studio/v1/generations/${encodeURIComponent(run.id)}/outputs/${encodeURIComponent(epoch.modelId)}/content`} download><Download size={14} />Download .safetensors</a> : <p className="field-help">Checkpoint is not available from Civitai.</p>}</div>
          <div className="columns is-multiline training-samples">{epoch.sampleIds.map(id => <div className="column is-4" key={id}>{run.outputs.find(output => output.id === id)?.kind === 'video' ? <video controls preload="metadata" src={`/api/studio/v1/generations/${encodeURIComponent(run.id)}/outputs/${encodeURIComponent(id)}/content`} aria-label={`Training video sample from checkpoint ${epoch.epochNumber}`} /> : <img loading="lazy" src={`/api/studio/v1/generations/${encodeURIComponent(run.id)}/outputs/${encodeURIComponent(id)}/content`} alt={`Training sample from checkpoint ${epoch.epochNumber}`} />}<div className="training-actions">{onSaveLocal && <Button variant="ghost" size="sm" disabled={saveBusy} onClick={() => onSaveLocal([id])}>Save sample</Button>}<a href={`/api/studio/v1/generations/${encodeURIComponent(run.id)}/outputs/${encodeURIComponent(id)}/content`} download>Download sample</a></div></div>)}</div>
        </div></details>)}</div>}
        <details className="training-run-details"><summary>Run details and saved settings</summary><p>Workflow: {run.providerWorkflowId ?? 'Awaiting workflow ID'}</p><p>Base checkpoint: {run.input.model ?? 'Not supplied'}</p><p>Dataset: {String(run.input.parameters?.datasetId ?? 'Not supplied')}</p><pre>{JSON.stringify(run.input.parameters, null, 2)}</pre></details>
      </article>
    })}</div>
    {hasMore && <Button variant="secondary" onClick={onLoadMore}>Load older runs</Button>}
  </section>
}
