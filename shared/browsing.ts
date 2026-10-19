export const browsingModes = ['safe', 'pg13', 'mature'] as const
export type BrowsingMode = typeof browsingModes[number]
export type BrowsingPreference = { mode: BrowsingMode; revision: string }
export const browsingLabels: Record<BrowsingMode, string> = { safe: 'Safe · PG only', pg13: 'Include PG-13', mature: 'Include mature · 18+' }
export const browsingMask = (mode: BrowsingMode): 1 | 3 | 31 => mode === 'mature' ? 31 : mode === 'pg13' ? 3 : 1
export type ContentRating = { level: number | null; label: string }
// Image browsingLevel is authoritative. Legacy X spans both explicit tiers.
// Unknown/missing/Blocked ratings never become a safe preview by inference.
export function contentRating(raw: Record<string, unknown> | null | undefined): ContentRating {
  const legacy: Record<string, number> = { None: 1, Soft: 2, Mature: 4, X: 24, PG: 1, PG13: 2, R: 4, XXX: 16, Blocked: 32 }
  const value = raw?.browsingLevel ?? raw?.nsfwLevel ?? (typeof raw?.nsfw === 'string' ? raw.nsfw : undefined)
  const candidate = typeof value === 'string' && Object.prototype.hasOwnProperty.call(legacy,value) ? legacy[value] : value
  const level = typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0 && candidate <= 63 ? candidate : null
  return { level, label: level === null ? 'Unrated' : [1,2,4,8,16,32].filter(bit => (level & bit) !== 0).map(bit => ({ 1:'PG',2:'PG-13',4:'R',8:'X',16:'XXX',32:'Blocked' })[bit]).join(' / ') }
}
export function ratingAllowed(rating: ContentRating, mode: BrowsingMode) {
  return typeof rating.level === 'number' && Number.isInteger(rating.level) && rating.level > 0 && rating.level <= 63 && (rating.level & ~browsingMask(mode)) === 0
}

// Model/version levels describe an aggregate allowed-content mask, not the
// rating of a particular preview. 31 includes PG; it is not intrinsically 18+.
export function resourceRating(raw:Record<string,unknown>|null|undefined):ContentRating {
  const rating=contentRating({nsfwLevel:raw?.nsfwLevel})
  return {...rating,label:rating.level===null?'Content range not supplied':`Content range: ${rating.label}`}
}
export function resourceAllowed(raw:Record<string,unknown>|null|undefined,mode:BrowsingMode,parent?:Record<string,unknown>|null):boolean {
  if(!raw)return false
  if(raw.mode==='TakenDown'||raw.mode==='Archived'||parent?.mode==='TakenDown'||parent?.mode==='Archived')return false
  if(mode!=='mature'&&(raw.nsfw===true||parent?.nsfw===true))return false
  const rating=resourceRating(raw)
  if(rating.level!==null)return (rating.level&32)===0&&(rating.level&browsingMask(mode))!==0
  if(raw.nsfwLevel!==undefined&&raw.nsfwLevel!==null)return false
  // Legacy models may have only the explicit mature boolean. Version masks
  // omitted in list responses inherit the already-filtered parent's policy.
  return parent?resourceAllowed(parent,mode):raw.nsfw===false||(mode==='mature'&&raw.nsfw===true)
}
