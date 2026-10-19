import { starterInput } from '../../shared/generation-catalog'
import { serviceMatchesInput, type GenerationService } from '../../shared/generation-services'
import type { WorkflowId } from '../../shared/workflows'
import { generationModelChoices, workflowModelType } from './model-types'

const sourceAdapters:Partial<Record<WorkflowId,{step:string;input:Record<string,unknown>}>> = {
  imageVariations:{step:'imageGen',input:{engine:'sdcpp',ecosystem:'sdxl',operation:'createVariant'}},
  imageEdit:{step:'imageGen',input:{engine:'flux1-kontext',model:'pro'}},
  imageTo3D:{step:'polyGen',input:{engine:'fal',model:'meshy',version:'v6',operation:'imageTo3D'}},
  imageToVideo:{step:'videoGen',input:{engine:'ltx2.3',operation:'createVideo',model:'22b-distilled'}},
  firstLastVideo:{step:'videoGen',input:{engine:'ltx2.3',operation:'firstLastFrameToVideo',model:'22b-distilled'}},
  referenceVideo:{step:'videoGen',input:{engine:'minimax-h3-comfy',operation:'referenceToVideo'}},
  videoEdit:{step:'videoGen',input:{engine:'wan',version:'v2.7',provider:'fal',operation:'edit-video'}},
  imageUpscaler:{step:'imageUpscaler',input:{}}, imageBackgroundRemoval:{step:'imageBackgroundRemoval',input:{}},
  preprocessImage:{step:'preprocessImage',input:{kind:'canny'}}, preprocessVideo:{step:'preprocessVideo',input:{kind:'canny'}},
  videoUpscaler:{step:'videoUpscaler',input:{}},videoInterpolation:{step:'videoInterpolation',input:{model:'VFIMamba'}},
}
const aliases:Partial<Record<WorkflowId,string[]>> = {
  createImage:['createImage','text-to-image'],draft:['createImage','text-to-image'],video:['createVideo','textToVideo','text-to-video'],
  textTo3D:['textTo3D'],imageVariations:['createVariant'],imageEdit:['editImage','image-to-image'],
  imageTo3D:['imageTo3D'],imageToVideo:['createVideo','imageToVideo','image-to-video'],firstLastVideo:['firstLastFrameToVideo','keyframesToVideo'],
  referenceVideo:['referenceToVideo','reference-to-video'],videoEdit:['editVideo','edit-video','videoToVideo'],
}
export function servicesForWorkflow(items:GenerationService[],workflow:WorkflowId):GenerationService[] {
  const media=workflowModelType(workflow)?.value
  if(!media)return []
  const output=media==='model3d'?'3d':media
  const expectedStep=sourceAdapters[workflow]?.step ?? (media==='image'?'imageGen':media==='video'?'videoGen':media==='model3d'?'polyGen':'aceStepAudio')
  return items.filter(service=> {
    if(service.category!==output || (media==='audio'?!['aceStepAudio','miniMaxMusic3','yuE2'].includes(service.step??''):service.step!==expectedStep) || service.outputs.length>0&&!service.outputs.includes(output))return false
    const operation=service.parameters.operation, allowed=aliases[workflow]
    if(operation&&allowed&&!allowed.includes(operation))return false
    if(['createImage','draft','video','textTo3D','createMusic'].includes(workflow) && service.inputs.length && !service.inputs.includes('text'))return false
    if(sourceAdapters[workflow] && service.inputs.length && !service.inputs.includes(['videoEdit','videoUpscaler','videoInterpolation','preprocessVideo'].includes(workflow)?'video':'image'))return false
    return true
  }).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id))
}
export function serviceChoice(service:GenerationService,workflow:WorkflowId):string|null {
  const media=workflowModelType(workflow)?.value
  // Missing modalities are visible, but cannot certify a new selectable path.
  if(!media||!service.inputs.length||!service.outputs.includes(media==='model3d'?'3d':media))return null
  if(workflow==='createMusic')return service.step==='aceStepAudio'&&Object.keys(service.parameters).length===0?'aceStepAudio:':null
  const adapter=sourceAdapters[workflow]
  if(adapter) return Object.keys(service.parameters).length ? serviceMatchesInput(service,adapter.input)?workflow:null : service.step===adapter.step?workflow:null
  return generationModelChoices(media,workflow==='draft').find(choice=>serviceMatchesInput(service,starterInput(media,choice.engine,choice.variant,choice.model)))?.value??null
}
