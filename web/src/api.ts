import type { TrainingDataset, TrainingImageMetadata, TrainingResult, TrainingSettings } from '../../shared/training'
import type { GenerationServices } from '../../shared/generation-services'
import type { BrowsingMode, BrowsingPreference, ContentRating } from '../../shared/browsing'
import type { ImageSource, SourceWorkflowRequest } from '../../shared/workflows'
import type { GenerationPolicy, GenerationPreview, WorkflowOptions } from '../../shared/quotes'
import type { ArtworkFilters, ArtworkPage } from '../../shared/artworks'
import type { CollectionDestination, CollectionTransfer, PublicCollection, CollectionType, SiteCollectionSave, CollectionFollow, CollectionMutation } from '../../shared/collections'
import type { LibraryState } from '../../shared/library'
import type { DesktopUpdateAction, DesktopUpdatesSnapshot } from '../../shared/desktop-updates'
import type { DesktopAppearance } from '../../shared/desktop-appearance'
import type { ComposerConfig, Preset, ModelVersion } from '../../shared/composer'
import type { PromptSnippet, PromptSnippetInput, PromptSnapshot, PromptSnapshotInput, PromptHistoryItem } from '../../shared/prompt-library'
export type DownloadItem = { category: import('../../shared/output-folders').OutputCategory; outputId: string; status: string; filename: string | null; dateFolder: string | null; error: string | null; contentUrl?: string; metadata?: Record<string, unknown> }
export type AppSession = { connected: boolean; user: { id: string; displayName: string } | null; csrfToken: string; credentialStorage?: { mode: 'encrypted' | 'memory'; persistent: boolean }; oauth?: { configured: boolean; enabled: boolean; status: string; requestedScopes: number; message: string }; credential?: { kind: "api_key" | "oauth"; grantedScopes: number | null; status: string } | null }
export type BuzzBalance = { blue: number; green: number; yellow: number; total: number; updatedAt: string }

import type { MediaType } from '../../shared/generation-catalog'

export type GenerationOutput = { id: string; kind?: MediaType | 'checkpoint'; role?: string; url: string | null; previewUrl?: string | null; mimeType: string | null; createdAt: string | null; metadata: Record<string, unknown> }
export type Generation = {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired'
  provider: 'civitai'
  providerWorkflowId?: string | null
  mediaType?: MediaType | 'training'
  trainingResult?: TrainingResult
  createdAt: string
  updatedAt: string
  completedAt?: string | null
  canRetry?: boolean
  legacyRecovery?: {state:'blocked'|'reconciled';externalId:string;message:string}
  canCancel?: boolean
  canReconcileCancel?: boolean
  cancellation?: { state: 'requesting' | 'uncertain' | 'confirmed' | 'reconciled' | 'rejected'; requestedAt?: string; updatedAt: string; message: string }
  input: { prompt: string; negativePrompt?: string; model?: string; engine?: string; parameters?: Record<string, unknown> }
  outputs: GenerationOutput[]
  cost: { amount: number; unit: 'buzz'; estimated: boolean } | null
  error: string | null
}

export type GenerationRequest = { recipe: 'workflow' | 'draft'; mediaType: MediaType; input: Record<string, unknown>; options?: WorkflowOptions; policy?: GenerationPolicy }
export type ModelSearchResult = { id: number; rating: ContentRating; supportsGeneration:boolean|null; mature: boolean; name: string; type: string; creator: string; description: string; url: string; images: { url: string; rating: ContentRating; type: 'image' | 'video' }[]; versions: { id: number; rating:ContentRating; supportsGeneration:boolean|null; name: string; baseModel: string; trainedWords: string[]; images: { url: string; rating: ContentRating; type: 'image' | 'video' }[] }[] }
export type FavoriteState = { favorited:boolean|null; writeAllowed:boolean; reason:string; status:string; message:string; pendingSetTo:boolean|null }
export type ModelFilters = { query: string; type: string; baseModel: string; sort: string; favorites?: string; supportsGeneration?:string; cursor?: string }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly recoveryGenerationId?: string) { super(message); this.name = 'ApiError' }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    let code: string | undefined
    let recoveryGenerationId: string | undefined
    try {
      const body = await response.json() as { error?: string | { code?: string; message?: string; generationId?: string }; message?: string }
      if (typeof body.error === 'string') message = body.error
      else if (body.error) { message = body.error.message ?? message; code = body.error.code; recoveryGenerationId = typeof body.error.generationId === 'string' ? body.error.generationId : undefined }
      else message = body.message ?? message
    } catch { /* keep generic response */ }
    throw new ApiError(message, response.status, code, recoveryGenerationId)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const base = '/api/studio/v1'
let csrfToken = ''
export function setCsrfToken(token: string) { csrfToken = token }
const browsingRevisions = new Map<string,string>()
export function setActiveBrowsing(accountId: string, revision: string | null) {
  if (revision) browsingRevisions.set(accountId,revision)
  else browsingRevisions.delete(accountId)
}
async function discovery<T>(path: string, accountId: string, signal?: AbortSignal): Promise<T> {
  const revision = browsingRevisions.get(accountId)
  if (!revision) throw new ApiError('Load your browsing preference in Settings first.',409,'browsing_changed')
  try {
    const value = await api<T>(path,{ signal, headers: { 'X-Studio-Account': accountId, 'X-Studio-Browsing': revision } })
    if (signal?.aborted || browsingRevisions.get(accountId) !== revision) throw new DOMException('Browsing preference changed.','AbortError')
    return value
  } catch (error) {
    if (error instanceof ApiError && error.code === 'browsing_changed') window.dispatchEvent(new CustomEvent('studio-browsing-changed',{ detail: accountId }))
    throw error
  }
}
export const studioApi = {
  desktopAppearance: (signal?: AbortSignal) => api<DesktopAppearance>(`${base}/desktop-appearance`, { signal }),
  saveDesktopAppearance: (accentColor: string, revision: string, signal?: AbortSignal) => api<DesktopAppearance>(`${base}/desktop-appearance`, { method: 'PATCH', signal, headers: { 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ accentColor, revision }) }),
  desktopUpdates: (signal?: AbortSignal) => api<DesktopUpdatesSnapshot>(`${base}/desktop-updates`, { signal }),
  desktopUpdateAction: (action: DesktopUpdateAction, signal?: AbortSignal) => api<DesktopUpdatesSnapshot>(`${base}/desktop-updates`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ action }) }),
  library: (accountId:string,signal?:AbortSignal) => api<LibraryState>(`${base}/library`,{signal,headers:{'X-Studio-Account':accountId}}),
  createLibraryFolder: (accountId:string,revision:string,name:string,signal?:AbortSignal) => api<LibraryState>(`${base}/library/folders`,{method:'POST',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify({revision,name})}),
  renameLibraryFolder: (accountId:string,revision:string,id:string,name:string,signal?:AbortSignal) => api<LibraryState>(`${base}/library/folders/${encodeURIComponent(id)}`,{method:'PATCH',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify({revision,name})}),
  deleteLibraryFolder: (accountId:string,revision:string,id:string,signal?:AbortSignal) => api<LibraryState>(`${base}/library/folders/${encodeURIComponent(id)}`,{method:'DELETE',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify({revision})}),
  moveLibraryOutputs: (accountId:string,revision:string,folderId:string|null,outputIds:string[],signal?:AbortSignal) => api<LibraryState>(`${base}/library/memberships`,{method:'PUT',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify({revision,folderId,outputIds})}),
  imageSources: (accountId:string,signal?:AbortSignal) => api<{items:ImageSource[];gallery:{generationId:string;outputId:string;type:'image'|'video';label:string}[]}>(`${base}/image-sources`,{signal,headers:{'X-Studio-Account':accountId}}),
  selectImageSource: (accountId:string,generationId:string,outputId:string,signal?:AbortSignal) => api<{source:ImageSource}>(`${base}/image-sources`,{method:'POST',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify({generationId,outputId})}),
  uploadImageSource: (accountId:string,file:File,signal?:AbortSignal,recovery?:{id:string;revision:string;action:'retry'|'renew'}) => api<{source:ImageSource}>(`${base}/image-sources/uploads`,{method:'POST',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken,'Content-Type':file.type,...(recovery?{'X-Source-Id':recovery.id,'X-Source-Revision':recovery.revision,'X-Source-Recovery':recovery.action}:{})},body:file}),
  previewSourceWorkflow: (accountId:string,request:SourceWorkflowRequest,signal?:AbortSignal) => api<{preview:GenerationPreview}>(`${base}/generation-previews`,{method:'POST',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify(request)}),
  browsingPreference: (accountId: string, signal?: AbortSignal) => api<BrowsingPreference>(`${base}/browsing-preference`,{ signal, headers: { 'X-Studio-Account': accountId } }),
  setBrowsingPreference: (accountId: string, mode: BrowsingMode) => api<BrowsingPreference>(`${base}/browsing-preference`,{ method: 'PUT', headers: { 'X-Studio-Account': accountId, 'X-CSRF-Token': csrfToken }, body: JSON.stringify({mode}) }),
  setAutoSave: (accountId: string, enabled: boolean) => api<import('../../shared/local-storage').LocalStorageSettings>(`${base}/local-storage/auto-save`, { method:'PUT', headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify({enabled}) }),
  retryAutoSave: (accountId: string, generationId: string) => api<import('../../shared/local-storage').LocalStorageSettings>(`${base}/local-storage/retry`, { method:'POST', headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify({generationId}) }),
  localStorage: (accountId: string, signal?: AbortSignal) => api<import('../../shared/local-storage').LocalStorageSettings>(`${base}/local-storage`, { signal, headers: { 'X-Studio-Account': accountId } }),
  configureLocalStorage: (accountId: string, path: string) => api<import('../../shared/local-storage').LocalStorageSettings>(`${base}/local-storage`, { method: 'PUT', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify({ path }) }),
  saveLocal: (accountId: string, outputIds: string[]) => api<{ job: import('../../shared/local-storage').LocalSaveJob }>(`${base}/local-storage/saves`, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify({ outputIds }) }),
  trainingDatasets: (accountId:string,signal?:AbortSignal) => api<{items:TrainingDataset[]}>(`${base}/training/datasets`,{signal,headers:{'X-Studio-Account':accountId}}),
  createTrainingDataset: (accountId:string,body:unknown,signal?:AbortSignal) => api<{dataset:TrainingDataset}>(`${base}/training/datasets`,{method:'POST',signal,headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify(body)}),
  saveTrainingDataset: (accountId:string,dataset:TrainingDataset,signal?:AbortSignal) => api<{dataset:TrainingDataset}>(`${base}/training/datasets/${dataset.id}`,{method:'PATCH',signal,headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify({revision:dataset.revision,name:dataset.name,items:dataset.items.map(x=>({id:x.id,caption:x.caption})),...(dataset.trainingSettings?{trainingSettings:dataset.trainingSettings}:{})})}),
  appendTrainingDatasetImages: (accountId:string,dataset:TrainingDataset,items:TrainingImageMetadata[],signal?:AbortSignal) => api<{dataset:TrainingDataset}>(`${base}/training/datasets/${dataset.id}/items`,{method:'POST',signal,headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify({revision:dataset.revision,items})}),
  deleteTrainingDataset: (accountId:string,dataset:TrainingDataset,signal?:AbortSignal) => api<{deleted:true}>(`${base}/training/datasets/${dataset.id}`,{method:'DELETE',signal,headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify({revision:dataset.revision})}),
  uploadTrainingImage: (accountId:string,datasetId:string,itemId:string,file:File,signal?:AbortSignal,renewalRevision?:string) => api<{dataset:TrainingDataset}>(`${base}/training/datasets/${datasetId}/items/${itemId}/upload`,{method:'POST',signal,headers:{'Content-Type':file.type,'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId,...(renewalRevision?{'X-Training-Renew':'true','X-Training-Revision':renewalRevision}:{})},body:file}),
  previewTraining: (accountId:string,dataset:TrainingDataset,settings:TrainingSettings,signal?:AbortSignal) => api<{preview:GenerationPreview}>(`${base}/generation-previews`,{method:'POST',signal,headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify({recipe:'training',datasetId:dataset.id,revision:dataset.revision,settings})}),
  session: () => api<AppSession>(`${base}/session`),
  buzz: () => api<{ balance: BuzzBalance }>(`${base}/buzz`),
  disconnect: () => api<void>(`${base}/civitai/key`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } }),
  generations: (cursor?: string) => api<{ items: Generation[]; nextCursor: string | null }>(`${base}/generations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  generation: (id: string) => api<{ generation: Generation }>(`${base}/generations/${encodeURIComponent(id)}`),
  cancelGeneration: (id: string, accountId: string, action: 'cancel' | 'reconcile', signal?: AbortSignal) => api<{ generation: Generation }>(`${base}/generations/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify({ action }) }),
  retryGeneration: (id: string, accountId: string) => api<{ generation: Generation }>(`${base}/generations/${encodeURIComponent(id)}/retry`, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId } }),
  discardPreview: (id: string, accountId: string) => api<void>(`${base}/generation-previews/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId } }),
  previewTranscode: (request: { recipe: 'transcode'; sourceGenerationId: string; sourceOutputId: string; width: number; containerFormat: 'mp4' | 'webM' }, accountId: string, signal?: AbortSignal) => api<{ preview: GenerationPreview }>(`${base}/generation-previews`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(request) }),
  previewImageTo3D: (request: { options?: WorkflowOptions; recipe: 'imageTo3D'; sourceGenerationId: string; sourceOutputId: string; shouldTexture: boolean }, accountId: string, signal?: AbortSignal) => api<{ preview: GenerationPreview }>(`${base}/generation-previews`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(request) }),
  previewImageAnimation: (request: { recipe: 'imageAnimation'; sourceGenerationId: string; sourceOutputId: string; prompt: string; duration: '5' | '10'; aspectRatio: '16:9' | '9:16' | '1:1' }, accountId: string, signal?: AbortSignal) => api<{ preview: GenerationPreview }>(`${base}/generation-previews`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(request) }),
  previewImageEdit: (request: { options?: WorkflowOptions; recipe: 'imageEdit'; sourceGenerationId: string; sourceOutputId: string; prompt: string }, accountId: string, signal?: AbortSignal) => api<{ preview: GenerationPreview }>(`${base}/generation-previews`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(request) }),
  previewBackgroundRemoval: (request: { options?: WorkflowOptions; recipe: 'imageBackgroundRemoval'; sourceGenerationId: string; sourceOutputId: string; format: 'png' | 'webp' }, accountId: string, signal?: AbortSignal) => api<{ preview: GenerationPreview }>(`${base}/generation-previews`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(request) }),
  previewVideoFinishing: (request: { recipe: 'videoUpscaler' | 'videoInterpolation'; sourceGenerationId: string; sourceOutputId: string; scaleFactor?:number; interpolationFactor?:number }, accountId: string, signal?: AbortSignal) => api<{ preview: GenerationPreview }>(`${base}/generation-previews`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(request) }),
  previewUpscale: (request: { options?: WorkflowOptions; recipe: 'imageUpscaler'; sourceGenerationId: string; sourceOutputId: string; numberOfRepeats: number; model?: string }, accountId: string, signal?: AbortSignal) => api<{ preview: GenerationPreview }>(`${base}/generation-previews`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(request) }),
  draftAvailability: (input:Record<string,unknown>,accountId:string,signal?:AbortSignal) => api<{available:boolean;reason?:string;acceleratorAir?:string}>(`${base}/draft-availability`,{method:'POST',signal,headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify({input})}),
  preview: (request: GenerationRequest, accountId: string, signal?: AbortSignal) => api<{ preview: GenerationPreview }>(`${base}/generation-previews`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(request) }),
  submit: (previewId: string, accountId: string) => api<{ generation: Generation }>(`${base}/generations`, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify({ previewId }) }),
  modelFavorite: (accountId:string,modelId:number,signal?:AbortSignal) => api<FavoriteState>(`${base}/models/${modelId}/favorite`,{signal,headers:{'X-Studio-Account':accountId}}),
  setModelFavorite: (accountId:string,modelId:number,setTo:boolean,requestId:string,signal?:AbortSignal) => api<FavoriteState>(`${base}/models/${modelId}/favorite`,{method:'PUT',signal,headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify({setTo,requestId})}),
  generationServices: (accountId:string,refresh=false,signal?:AbortSignal) => discovery<GenerationServices>(`${base}/generation-services${refresh?'?refresh=true':''}`,accountId,signal),
  searchModels: (accountId: string, filters: ModelFilters, signal?: AbortSignal) => discovery<{ items: ModelSearchResult[]; nextCursor: string | null }>(`${base}/models?${new URLSearchParams(Object.entries(filters).filter(([,value]) => Boolean(value)) as [string,string][]).toString()}`, accountId, signal),
  model: (accountId: string, id: number, signal?: AbortSignal) => discovery<{ model: ModelSearchResult }>(`${base}/models/${id}`, accountId, signal),
  modelVersion: (accountId: string, id: number, signal?: AbortSignal) => discovery<ModelVersion>(`${base}/model-versions/${id}`, accountId, signal),
  artworks: (accountId: string, filters: ArtworkFilters, signal?: AbortSignal) => discovery<ArtworkPage>(`${base}/artworks?${new URLSearchParams(Object.entries(filters).filter(([name, value]) => name !== 'label' && value !== undefined).map(([name, value]) => [name, String(value)]))}`, accountId, signal),
  presets: (accountId: string, signal?: AbortSignal) => api<{ items: Preset[] }>(`${base}/presets`, { signal, headers: { 'X-Studio-Account': accountId } }),
  promptSnippets: (accountId:string,signal?:AbortSignal) => api<{items:PromptSnippet[]}>(`${base}/prompt-library/snippets`,{signal,headers:{'X-Studio-Account':accountId}}),
  savePromptSnippet: (accountId:string,id:string|null,value:PromptSnippetInput,signal?:AbortSignal) => api<{item:PromptSnippet}>(`${base}/prompt-library/snippets${id?'/'+encodeURIComponent(id):''}`,{method:id?'PUT':'POST',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify(value)}),
  deletePromptSnippet: (accountId:string,id:string,signal?:AbortSignal) => api<void>(`${base}/prompt-library/snippets/${encodeURIComponent(id)}`,{method:'DELETE',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken}}),
  promptHistory: (accountId:string,signal?:AbortSignal) => api<{items:PromptHistoryItem[]}>(`${base}/prompt-library/history`,{signal,headers:{'X-Studio-Account':accountId}}),
  promptSnapshot: (accountId:string,id:string,signal?:AbortSignal) => api<{item:PromptSnapshot}>(`${base}/prompt-library/history/${encodeURIComponent(id)}`,{signal,headers:{'X-Studio-Account':accountId}}),
  checkpointPrompt: (accountId:string,value:PromptSnapshotInput,signal?:AbortSignal) => api<{item:PromptSnapshot}>(`${base}/prompt-library/history`,{method:'POST',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify(value)}),
  deletePromptHistory: (accountId:string,id:string|null,signal?:AbortSignal) => api<void>(`${base}/prompt-library/history${id?'/'+encodeURIComponent(id):''}`,{method:'DELETE',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken}}),
  savePreset: (accountId: string, name: string, config: ComposerConfig, id?: string) => api<{ preset: Preset }>(`${base}/presets${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify({ name, config }) }),
  deletePreset: (accountId: string, id: string) => api<void>(`${base}/presets/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId } }),

  siteCollectionSave: (accountId: string, itemType: CollectionType, itemId: number, destinationId: number, signal?: AbortSignal) => api<{ save: SiteCollectionSave | null }>(`${base}/collections/site-saves?${new URLSearchParams({ itemType, itemId: String(itemId), destinationId: String(destinationId) })}`, { signal, headers: { 'X-Studio-Account': accountId } }),
  saveSiteItem: (accountId: string, body: { itemType: CollectionType; itemId: number; destinationId: number; artworkId?: number; confirm: true }, signal?: AbortSignal) => api<{ save: SiteCollectionSave }>(`${base}/collections/site-saves`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(body) }),
  publicCollections: (accountId: string, query: string, cursor?: number, signal?: AbortSignal, sort:'Newest'|'Most Followers'='Newest') => discovery<{ items: PublicCollection[]; nextCursor: number | null }>(`${base}/collections/public?${new URLSearchParams({ query, sort, ...(cursor ? { cursor: String(cursor) } : {}) })}`,accountId,signal),
  publicCollection: (accountId: string, id: number, signal?: AbortSignal) => discovery<{ collection: PublicCollection }>(`${base}/collections/public/${id}`,accountId,signal),
  collectionFollow: (accountId:string,id:number,signal?:AbortSignal) => api<{follow:CollectionFollow}>(`${base}/collections/follows/${id}`,{signal,headers:{'X-Studio-Account':accountId}}),
  setCollectionFollow: (accountId:string,id:number,revision:string,following:boolean,signal?:AbortSignal) => api<{follow:CollectionFollow}>(`${base}/collections/follows/${id}`,{method:'POST',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify({revision,following,confirm:true})}),
  collectionBatches: (accountId:string,signal?:AbortSignal) => api<{items:CollectionTransfer[]}>(`${base}/collections/batches`,{signal,headers:{'X-Studio-Account':accountId}}),
  collectionBatch: (accountId:string,id:string,signal?:AbortSignal) => api<{transfer:CollectionTransfer}>(`${base}/collections/batches/${encodeURIComponent(id)}`,{signal,headers:{'X-Studio-Account':accountId}}),
  startCollectionBatch: (accountId:string,body:unknown,signal?:AbortSignal) => api<{transfer:CollectionTransfer}>(`${base}/collections/batches`,{method:'POST',signal,headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify(body)}),
  batchAction: (accountId:string,id:string,action:'retry'|'publication',body:unknown,signal?:AbortSignal) => api<{transfer:CollectionTransfer}>(`${base}/collections/batches/${encodeURIComponent(id)}/${action}`,{method:'POST',signal,headers:{'X-CSRF-Token':csrfToken,'X-Studio-Account':accountId},body:JSON.stringify(body)}),
  collectionDestinations: (accountId: string, signal?: AbortSignal) => api<{ items: CollectionDestination[]; pendingActions?:CollectionMutation[] }>(`${base}/collections/destinations`, { signal, headers: { 'X-Studio-Account': accountId } }),
  labelCollectionDestination: (accountId:string,item:CollectionDestination,label:string,signal?:AbortSignal) => api<{destination:CollectionDestination}>(`${base}/collections/destinations/${item.id}`,{method:'PATCH',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify({revision:item.revision,label})}),
  forgetCollectionDestination: (accountId:string,item:CollectionDestination,signal?:AbortSignal) => api<{deleted:true}>(`${base}/collections/destinations/${item.id}`,{method:'DELETE',signal,headers:{'X-Studio-Account':accountId,'X-CSRF-Token':csrfToken},body:JSON.stringify({revision:item.revision})}),
  saveCollectionDestination: (accountId: string, body: Record<string, unknown>, updateId?: number, signal?: AbortSignal) => api<{ destination: CollectionDestination }>(`${base}/collections/destinations${updateId ? `/${updateId}` : ''}`, { signal, method: updateId ? 'PUT' : 'POST', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(body) }),
  collectionTransfer: (accountId: string, outputId: string, signal?: AbortSignal) => api<{ transfer: CollectionTransfer | null }>(`${base}/collections/transfers/${encodeURIComponent(outputId)}`, { signal, headers: { 'X-Studio-Account': accountId } }),
  startCollectionTransfer: (accountId: string, body: { outputId: string; destinationId: number; title: string; publish: boolean; confirm: boolean }) => api<{ transfer: CollectionTransfer }>(`${base}/collections/transfers`, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify(body) }),
  publishSavedDraft: (accountId: string, outputId: string, action: 'publish' | 'reconcile', revision: string, signal?: AbortSignal) => api<{ transfer: CollectionTransfer }>(`${base}/collections/transfers/${encodeURIComponent(outputId)}/publication`, { method: 'POST', signal, headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify({ action, revision, ...(action === 'publish' ? { confirm: true } : {}) }) }),
  retryCollectionTransfer: (accountId: string, outputId: string) => api<{ transfer: CollectionTransfer }>(`${base}/collections/transfers/${encodeURIComponent(outputId)}/retry`, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'X-Studio-Account': accountId }, body: JSON.stringify({ confirm: true }) }),
  collectionPreview: async (accountId: string, outputId: string, signal: AbortSignal) => {
    const response = await fetch(`${base}/collections/transfers/${encodeURIComponent(outputId)}/preview`, { credentials: 'same-origin', signal, headers: { 'X-Studio-Account': accountId } })
    if (!response.ok) { const error = await response.json().catch(() => null); throw new Error(error?.error?.message ?? 'Original preview could not be loaded.') }
    return response.blob()
  },

  download: (outputIds: string[], mode: 'files' | 'zip' = 'zip', signal?: AbortSignal) => api<{ download: { id: string; status: string; archiveUrl: string | null; items: DownloadItem[] } }>(`${base}/downloads`, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, signal, body: JSON.stringify({ outputIds, mode, dateBasis: 'utc' }) }),
  downloadStatus: (id: string) => api<{ download: { id: string; status: string; items: { outputId: string; status: string; filename: string | null; dateFolder: string | null; error: string | null }[]; archiveUrl: string | null } }>(`${base}/downloads/${encodeURIComponent(id)}`),
}
