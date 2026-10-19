export type CollectionType = 'Image' | 'Post' | 'Model'
export type CollectionVisibility = 'Private' | 'Public' | 'Unlisted'
export type CollectionDestination = { id: number; name: string; description: string; type: CollectionType; read: CollectionVisibility; source: 'created' | 'saved'; verified: boolean }
export type PublicCollection = { id: number; name: string; description: string; type: string; read: string; creator: string; coverUrl: string | null; itemCount: number | null; url: string }
export type TransferStage = 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain'
export type CollectionTransfer = {
  batch?: { outputId:string; generationId:string; upload:TransferStage; message:string }[];
  outputId: string; generationId: string; destinationId: number; destinationName: string; destinationType: Exclude<CollectionType, 'Model'>;
  title: string; publishRequested: boolean; upload: TransferStage; post: TransferStage; membership: TransferStage;
  publication: 'not-created' | 'draft' | 'published' | 'unknown'; sitePostId: number | null; siteImageIds: number[];
  publicationAction?: 'checking' | 'dispatching' | 'uncertain' | 'draft' | 'published'; publicationMessage?: string; publicationRevision?: string; canPublish?: boolean; canReconcilePublication?: boolean;
  message: string; active: boolean; canRetry: boolean; updatedAt: string; postUrl: string | null;
}

export type SiteCollectionSave = { itemType: CollectionType; itemId: number; destinationId: number; status: 'running' | 'succeeded' | 'failed' | 'uncertain'; message: string; updatedAt: string }
export type SiteCollectionItem = { itemType: CollectionType; itemId: number; label: string; artworkId?: number }
