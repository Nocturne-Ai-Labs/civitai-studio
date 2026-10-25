import { useEffect, useState } from 'react'
import { accentStorageKey, applyAccentColor, defaultAccentColor, legacyThemeStorageKey, normalizeHexColor, readAccentColor } from './theme'

export function useAccentColor() {
  const [accentColor, setColor] = useState(() => normalizeHexColor(document.documentElement.dataset.accent) ?? readAccentColor())
  function setAccentColor(value: string) {
    const color = normalizeHexColor(value)
    if (color) setColor(applyAccentColor(color, true))
  }
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === accentStorageKey || event.key === legacyThemeStorageKey || event.key === null) setColor(applyAccentColor(readAccentColor()))
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  return { accentColor: accentColor || defaultAccentColor, setAccentColor }
}
