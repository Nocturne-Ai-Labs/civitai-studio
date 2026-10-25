export type TrainingEcosystem = 'sdxl' | 'sd1'
// Guided presets: SD1 steps/alpha follow the recipe example; noise follows the
// documented SD1 default (the example overrides it). Resolution is descriptive,
// selected by ecosystem rather than an invented provider input parameter.
export const trainingProfiles = {
 sdxl: { label:'SDXL', model:'urn:air:sdxl:checkpoint:civitai:101055@128078', baseName:'Juggernaut XL', nativeResolution:1024, defaultSteps:2000, optimizerType:'adafactor', networkAlpha:32, noiseOffset:0.1 },
 sd1: { label:'SD1 / SD1.5', model:'urn:air:sd1:checkpoint:civitai:127227@139180', baseName:'SD1.5 default checkpoint', nativeResolution:512, defaultSteps:4000, optimizerType:'adamw8bit', networkAlpha:16, noiseOffset:0 },
} as const
export type TrainingProfile = (typeof trainingProfiles)[TrainingEcosystem]
export type TrainingItem = { id:string; name:string; size:number; mime:string; hash:string; caption:string; status:'pending'|'uploading'|'ready'|'failed'|'uncertain'|'expired'; message?:string; blobId?:string; uploadedAt?:string }
export type TrainingImageMetadata = { name:string; size:number; mime:string; hash:string; caption?:string }
export type TrainingDataset = { id:string; name:string; revision:string; createdAt:string; items:TrainingItem[]; trainingSettings?:TrainingSettings }
export type TrainingSettings = { ecosystem?:TrainingEcosystem; steps:number; triggerWord:string; prompts:string[] }
export type TrainingReview = { profile?:TrainingProfile; datasetId:string; datasetName:string; revision:string; items:{name:string;caption:string}[]; settings:TrainingSettings }
export type TrainingResult = { moderationStatus:string; epochs:{epochNumber:number; modelId:string|null; available:boolean; sampleIds:string[]}[] }
