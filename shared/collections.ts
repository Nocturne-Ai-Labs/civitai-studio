export type CollectionType = 'Image' | 'Post' | 'Model' | 'Article'
export type CollectionVisibility = 'Private' | 'Public' | 'Unlisted'
export type CollectionContribution = 'Private' | 'Public' | 'Review'
export type CollectionDestination = { id: number; name: string; description: string; type: CollectionType; read: CollectionVisibility; source: 'created' | 'saved'; verified: boolean; revision?:string; label?:string; write?:CollectionContribution; nsfw?:boolean; coverUrl?:string|null; itemCount?:number|null; rating?:import('./browsing').ContentRating }
export type PublicCollection = { id: number; name: string; description: string; type: string; read: string; creator: string; coverUrl: string | null; itemCount: number | null; url: string; rating?:import('./browsing').ContentRating }
export type CollectionFollow = { collectionId:number; revision:string; state:'unknown'|'running'|'confirmed'|'failed'|'uncertain'; following:boolean|null; requestedFollowing:boolean|null; message:string; updatedAt:string }
export type CollectionMutation = { collectionId:number|null; name:string; state:'running'|'uncertain'; message:string }
export type TransferStage = 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain'
export type CollectionTransfer = {
  batch?: { outputId:string; generationId:string; upload:TransferStage; message:string }[];
  outputId: string; generationId: string; destinationId: number; destinationName: string; destinationType: 'Image' | 'Post';
  title: string; publishRequested: boolean; upload: TransferStage; post: TransferStage; membership: TransferStage;
  publication: 'not-created' | 'draft' | 'published' | 'unknown'; sitePostId: number | null; siteImageIds: number[];
  publicationAction?: 'checking' | 'dispatching' | 'uncertain' | 'draft' | 'published'; publicationMessage?: string; publicationRevision?: string; canPublish?: boolean; canReconcilePublication?: boolean;
  message: string; active: boolean; canRetry: boolean; updatedAt: string; postUrl: string | null;
}

export type SiteCollectionSave = { itemType: CollectionType; itemId: number; destinationId: number; status: 'running' | 'succeeded' | 'failed' | 'uncertain'; message: string; updatedAt: string }
export type SiteCollectionItem = { itemType: CollectionType; itemId: number; label: string; artworkId?: number }
