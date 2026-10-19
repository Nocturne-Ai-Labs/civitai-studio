import { combinePrompts, type PromptGroup } from './composer'
import type { MediaType } from './generation-catalog'
import { workflowChoices, type WorkflowId } from './workflows'

export const promptCategories = [{ value: 'quality', label: 'Quality' }, { value: 'style', label: 'Style' }, { value: 'lora', label: 'LoRA triggers' }, { value: 'other', label: 'Other' }] as const
export type PromptCategory = typeof promptCategories[number]['value']
export type PromptSnippetInput = { name: string; category: PromptCategory; text: string }
export type PromptSnippet = PromptSnippetInput & { id: string; updatedAt: string }
export type PromptContext = { mediaType: MediaType; workflow: WorkflowId }
export type PromptDraft = { groups: PromptGroup[]; negativePrompt?: string }
export type PromptSnapshotInput = PromptDraft & { context: PromptContext }
export type PromptSnapshot = PromptSnapshotInput & { id: string; savedAt: string }
export type PromptHistoryItem = { id: string; savedAt: string; context: PromptContext; preview: string; groupCount: number; hasNegative: boolean }

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
const plainText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
export function validSnippet(value: unknown): value is PromptSnippetInput {
  return object(value) && Object.keys(value).every(key => ['name', 'category', 'text'].includes(key))
    && plainText(value.name, 80) && Boolean((value.name as string).trim())
    && promptCategories.some(category => category.value === value.category)
    && plainText(value.text, 4000) && Boolean((value.text as string).trim())
}
export function validPromptSnapshot(value: unknown): value is PromptSnapshotInput {
  if (!object(value) || Object.keys(value).some(key => !['groups', 'negativePrompt', 'context'].includes(key))) return false
  const context = value.context
  if (!object(context) || Object.keys(context).some(key => !['mediaType', 'workflow'].includes(key))
    || !['image', 'video', 'audio', 'model3d'].includes(String(context.mediaType))
    || !workflowChoices.some(choice => choice.id === context.workflow && !('reason' in choice) && choice.id !== 'extractMetadata')) return false
  const choice = workflowChoices.find(choice => choice.id === context.workflow)
  if (choice && ({Image:'image',Video:'video',Audio:'audio','3D':'model3d'} as const)[choice.group] !== context.mediaType) return false
  if (!Array.isArray(value.groups) || value.groups.length < 1 || value.groups.length > 20) return false
  if (value.groups.some(group => !object(group) || Object.keys(group).some(key => !['id', 'label', 'text'].includes(key))
    || !plainText(group.id, 100) || !(group.id as string).trim() || !plainText(group.label, 80) || !plainText(group.text, 10000))) return false
  if (new Set(value.groups.map(group => group.id)).size !== value.groups.length || combinePrompts(value.groups).length > 10000) return false
  return (value.negativePrompt === undefined || plainText(value.negativePrompt, 10000))
    && Boolean(combinePrompts(value.groups).trim() || String(value.negativePrompt ?? '').trim())
}
// IDs are UI identities; changing them alone must not create another history row.
export function promptDraftIdentity(snapshot: PromptSnapshotInput) {
  return JSON.stringify({ context: {mediaType:snapshot.context.mediaType,workflow:snapshot.context.workflow}, groups: snapshot.groups.map(({ label, text }) => ({ label, text })), ...(snapshot.negativePrompt === undefined ? {} : { negativePrompt: snapshot.negativePrompt }) })
}
