export type DesktopAppearance = { desktop: boolean; accentColor: string | null; revision: string | null }
export function desktopAccent(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null
}
