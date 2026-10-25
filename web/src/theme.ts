export const defaultAccentColor = '#228be6'
export const accentStorageKey = 'civitai-studio-accent'
export const legacyThemeStorageKey = 'civitai-studio-theme'
export type HsvColor = { h: number; s: number; v: number }
type Rgb = [number, number, number]

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^#?([a-f0-9]{3}|[a-f0-9]{6})$/i.exec(value.trim())
  if (!match) return null
  const digits = match[1]!.toLowerCase()
  return `#${digits.length === 3 ? [...digits].map(char => char + char).join('') : digits}`
}
const rgb = (hex: string): Rgb => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)) as Rgb
const hex = (values: Rgb) => `#${values.map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('')}`
const mix = (color: string, target: string, amount: number) => hex(rgb(color).map((value, index) => value + (rgb(target)[index]! - value) * amount) as Rgb)
export function relativeLuminance(color: string): number {
  const channels = rgb(color).map(value => { const normalized = value / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4 })
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722
}
export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first), b = relativeLuminance(second)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}
function ensureContrast(color: string, background: string, target: string, minimum: number): string {
  if (contrastRatio(color, background) >= minimum) return color
  // Move along the chosen hue towards black/white; 1% increments keep the
  // rendered rounded sRGB values above the requested contrast threshold.
  for (let step = 1; step <= 100; step++) {
    const candidate = mix(color, target, step / 100)
    if (contrastRatio(candidate, background) >= minimum) return candidate
  }
  return target
}
export function accentPalette(value: string): Record<string, string> {
  const color = normalizeHexColor(value) ?? defaultAccentColor
  const solid = ensureContrast(color, '#ffffff', '#000000', 5)
  const foreground = ensureContrast(color, '#2c2e33', '#ffffff', 4.8)
  const visible = ensureContrast(color, '#2c2e33', '#ffffff', 3.1)
  return {
    '--accent': visible, '--accent-2': foreground, '--accent-solid': solid,
    '--accent-hover': mix(solid, '#000000', .12), '--accent-soft': `${visible}1a`,
    '--accent-border': `${visible}70`, '--accent-ring': `${foreground}40`, '--on-accent': '#ffffff',
  }
}
export function hexToHsv(value: string): HsvColor {
  const [r, g, b] = rgb(normalizeHexColor(value) ?? defaultAccentColor).map(channel => channel / 255)
  const high = Math.max(r!, g!, b!), low = Math.min(r!, g!, b!), delta = high - low
  let h = 0
  if (delta) h = high === r ? ((g! - b!) / delta) % 6 : high === g ? (b! - r!) / delta + 2 : (r! - g!) / delta + 4
  return { h: (h * 60 + 360) % 360, s: high ? delta / high * 100 : 0, v: high * 100 }
}
export function hsvToHex({ h, s, v }: HsvColor): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; v = Math.max(0, Math.min(100, v)) / 100
  const chroma = v * s, x = chroma * (1 - Math.abs((h / 60) % 2 - 1)), m = v - chroma
  const values: Rgb = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x]
  return hex(values.map(value => (value + m) * 255) as Rgb)
}
export function storedAccentColor(storage: Pick<Storage, 'getItem'>): string {
  try {
    return normalizeHexColor(storage.getItem(accentStorageKey)) ?? (storage.getItem(legacyThemeStorageKey) === 'red' ? '#fa5252' : defaultAccentColor)
  } catch { return defaultAccentColor }
}
export function readAccentColor(): string {
  try { return storedAccentColor(localStorage) } catch { return defaultAccentColor }
}
export function applyAccentColor(value: string, persist = false): string {
  const color = normalizeHexColor(value) ?? defaultAccentColor
  const root = document.documentElement
  root.dataset.theme = color === defaultAccentColor ? 'blue' : color === '#fa5252' ? 'red' : 'custom'
  root.dataset.accent = color
  for (const [property, setting] of Object.entries(accentPalette(color))) root.style.setProperty(property, setting)
  if (persist) { try { localStorage.setItem(accentStorageKey, color) } catch { /* The color remains usable when browser storage is unavailable. */ } }
  return color
}
