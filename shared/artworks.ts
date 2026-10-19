export const artworkSorts = ['Newest', 'Oldest', 'Most Reactions', 'Most Comments', 'Most Collected', 'Random'] as const
export const artworkPeriods = ['AllTime', 'Year', 'Month', 'Week', 'Day'] as const
export type ArtworkScope = { modelId?: number; modelVersionId?: number; label?: string }
export type ArtworkLink = { imageId?: number; postId?: number; siteHost?: 'civitai.com' | 'civitai.red' }
export function parseArtworkLink(value: string): ArtworkLink {
  const invalid = () => new Error('Use one HTTPS Civitai image/video link (/images/ID) or post link (/posts/ID).')
  const source = value.trim()
  if (!source || source.length > 2048 || /[\s\\]/.test(source)) throw invalid()
  let url: URL
  try { url = new URL(source) } catch { throw invalid() }
  if (url.protocol !== 'https:' || !['civitai.com', 'www.civitai.com', 'civitai.red', 'www.civitai.red'].includes(url.hostname) || url.username || url.password || url.port) throw invalid()
  const match = /^\/(images|posts)\/([1-9]\d*)\/?$/.exec(url.pathname)
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw invalid()
  // Ignore only tracking/share decorations; selectors or embedded URLs are ambiguous.
  if ([...url.searchParams.keys()].some(key => !/^(utm_[a-z_]+|ref|share)$/i.test(key)))
    throw new Error('Remove query parameters other than tracking/share parameters and paste the direct artwork or post link.')
  const siteHost = url.hostname.endsWith('.red') ? 'civitai.red' as const : 'civitai.com' as const
  return match[1] === 'images' ? { imageId: Number(match[2]), siteHost } : { postId: Number(match[2]), siteHost }
}
export type ArtworkFilters = ArtworkScope & ArtworkLink & { type: 'image' | 'video'; sort: string; period: string; cursor?: string }
export type ArtworkResource = { versionId: number; typeHint?: string; weight?: number }
export type Artwork = {
  rating: import('./browsing').ContentRating;
  id: number; postId: number | null; url: string | null; siteUrl: string; type: 'image' | 'video'; creator: string; createdAt: string;
  prompt: string; negativePrompt: string; parameters: Record<string, string | number | boolean>;
  resources: ArtworkResource[]; resourcesTruncated: boolean; hasMetadata: boolean
}
export type ArtworkPage = { items: Artwork[]; nextCursor: string | null }
