import type { Generation } from './api'
import { Button } from './ui'
export function WorkflowCancellation({ generation, busy, onAction }: { generation: Generation; busy: boolean; onAction: (action: 'cancel' | 'reconcile') => void }) {
  if (!generation.canCancel && !generation.canReconcileCancel && !generation.cancellation) return null
  return <div className="workflow-cancellation">
    {generation.cancellation && <p className="field-help" role="status">{generation.cancellation.message}</p>}
    {(generation.canCancel || generation.canReconcileCancel) && <Button type="button" variant={generation.canReconcileCancel ? 'secondary' : 'outline'} size="sm" disabled={busy} onClick={() => onAction(generation.canReconcileCancel ? 'reconcile' : 'cancel')}>{busy ? 'Checking workflow…' : generation.canReconcileCancel ? 'Reconcile cancellation' : 'Cancel workflow'}</Button>}
    {(generation.canCancel || generation.canReconcileCancel) && <p className="field-help">Cancellation may race completion. Returned outputs are kept; refunds are not guaranteed.</p>}
  </div>
}
