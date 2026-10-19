import { graphBlocker } from './image-workflows'
import type { WorkflowOptions } from './quotes'
export type VideoSourceOperation = 'imageToVideo' | 'firstLastVideo' | 'referenceVideo' | 'videoUpscaler' | 'videoInterpolation' | 'preprocessVideo' | 'videoEdit'
export type SourceOperation = 'imageVariations' | 'imageEdit' | 'imageUpscaler' | 'imageBackgroundRemoval' | 'preprocessImage' | 'imageTo3D' | VideoSourceOperation
export const videoSourceOperations:VideoSourceOperation[]=['imageToVideo','firstLastVideo','referenceVideo','videoUpscaler','videoInterpolation','preprocessVideo','videoEdit']
export const videoInputOperations:SourceOperation[]=['videoUpscaler','videoInterpolation','preprocessVideo','videoEdit']
export function sourceRequirements(operation:SourceOperation){return {type:videoInputOperations.includes(operation)?'video' as const:'image' as const,min:operation==='firstLastVideo'?2:1,max:operation==='firstLastVideo'?2:operation==='referenceVideo'?9:1}}
export type WorkflowId = 'draft' | 'createImage' | 'textTo3D' | 'video' | 'createMusic' | 'extractMetadata' | SourceOperation
export const workflowChoices = [
  { id:'createMusic',label:'Create Music',group:'Audio' },
  { id:'createImage',label:'Create Image',group:'Image' },
  { id:'draft',label:'Draft · Studio adaptation',group:'Image' },
  { id:'createFace',label:'Create + Face Fix',group:'Image',reason:graphBlocker },
  { id:'createHires',label:'Create + Hires Fix',group:'Image',reason:graphBlocker },
  { id:'imageVariations',label:'Image Variations',group:'Image' },
  { id:'imageEdit',label:'Image to Image',group:'Image' },
  { id:'faceFix',label:'Image Face Fix',group:'Image',reason:graphBlocker },
  { id:'hiresFix',label:'Image Hires Fix',group:'Image',reason:graphBlocker },
  { id:'imageUpscaler',label:'Upscale',group:'Image' },
  { id:'imageBackgroundRemoval',label:'Remove Background',group:'Image' },
  { id:'preprocessImage',label:'Control Preprocessor',group:'Image' },
  { id:'extractMetadata',label:'Extract Metadata',group:'Image' },
  { id:'textTo3D',label:'Text to 3D',group:'3D' },
  { id:'imageTo3D',label:'Image to 3D',group:'3D' },
  { id:'video',label:'Create Video',group:'Video' },
  { id:'imageToVideo',label:'Image to Video',group:'Video' },
  { id:'firstLastVideo',label:'First / Last Frame',group:'Video' },
  { id:'referenceVideo',label:'Reference to Video',group:'Video' },
  { id:'videoUpscaler',label:'Upscale',group:'Video' },
  { id:'videoInterpolation',label:'Interpolate',group:'Video' },
  { id:'preprocessVideo',label:'Control Preprocessor',group:'Video' },
  { id:'videoEdit',label:'Edit Video',group:'Video' },
] as const
export type ImageSource = { id:string; revision:string; kind:'gallery'|'upload'; label:string; type:'image'|'video'; mime:string|null; size:number|null; width?:number; height?:number; duration?:number; status:'ready'|'uploading'|'uncertain'|'failed'|'expired'; expiresAt:string|null; message:string; recovery?:'retry'|'renew'; origin?:{generationId:string;outputId:string} }
export type FrozenImageSource = ImageSource & { identity:string }
export type SourceWorkflowRequest = { recipe:'sourceWorkflow'; operation:SourceOperation; sourceIds:string[]; settings:Record<string,unknown>; options:WorkflowOptions }
export type SourceWorkflowReview = { operation:SourceOperation; sources:ImageSource[]; settings:Record<string,unknown> }
