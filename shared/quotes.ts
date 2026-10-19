import type { TrainingReview } from './training'
import type { MediaType } from './generation-catalog'
export type GenerationPolicy = { currencies?: ('blue' | 'green' | 'yellow')[]; allowMatureContent?: boolean; upgradeMode?: 'manual' | 'automatic' }
export type WorkflowOptions = { tips: { creators: number; civitai: number }; priority: 'low' | 'normal' | 'high' }
export type CostReview = {
  total: number | null; base: number | null; variable: boolean | null;
  tips: { creators: number | null; civitai: number | null };
  fixed: { name: string; amount: number }[] | null;
  factors: { name: string; value: number }[] | null;
  fees: { resource: string; amount: number }[] | null;
  transactions: { accountType: string; amount: number; type: 'debit' | 'credit' }[] | null;
  insufficientBuzz: boolean | null;
  warnings: { step: number; code: string; message: string; deprecatedAt: string | null; retiresAt: string | null; replacement: string | null }[];
}
export type GenerationPreview = { imageGraph?: ImageGraphReview; draft?: import('./image-workflows').DraftReview; music?: Record<string,unknown>; workflow?: import('./workflows').SourceWorkflowReview; id: string; expiresAt: string; mediaType: MediaType | 'training'; training?: TrainingReview; engine: string; options?: WorkflowOptions; policy: GenerationPolicy; review: CostReview; source?: { generationId: string; outputId: string; operation?: 'imageUpscaler' | 'imageBackgroundRemoval' | 'imageEdit' | 'imageAnimation' | 'imageTo3D' | 'transcode' | 'videoUpscaler' | 'videoInterpolation'; targetWidth?: number; containerFormat?: 'mp4' | 'webM'; prompt?: string; shouldTexture?: boolean; duration?: '5' | '10'; aspectRatio?: '16:9' | '9:16' | '1:1'; format?: 'png' | 'webp'; scaleFactor?: number; interpolationFactor?: number; width?: number | null; height?: number | null; numberOfRepeats?: number; model?: string | null } }

export type ImageGraphReview = { operation: import('./image-workflows').GraphOperation; revision:string; wireFormat:'public-comfy-node-v1'; digest:string; templateDigest:string; settings:Record<string,unknown>; sources:import('./workflows').ImageSource[]; expectedFinalNode:number; outputMappingQualified:false }
