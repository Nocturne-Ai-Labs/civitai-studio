import { useEffect, useRef, useState } from 'react'
import { accentStorageKey, applyAccentColor, defaultAccentColor, legacyThemeStorageKey, normalizeHexColor, readAccentColor } from './theme'
import { createDesktopAccent } from './desktop-accent'
import { studioApi } from './api'

export function useAccentColor(sessionReady = false) {
  const [accentColor, setColor] = useState(() => normalizeHexColor(document.documentElement.dataset.accent) ?? readAccentColor())
  const [persistence, setPersistence] = useState({ busy: true, error: '' })
  const colorRef = useRef(accentColor), readyRef = useRef(sessionReady), sync = useRef<ReturnType<typeof createDesktopAccent> | null>(null)
  readyRef.current = sessionReady
  function setAccentColor(value: string) {
    const color = normalizeHexColor(value)
    if (color) { colorRef.current = color; setColor(applyAccentColor(color, true)); sync.current?.choose(color) }
  }
  useEffect(() => {
    const queue = createDesktopAccent(colorRef.current, {
      read: signal => studioApi.desktopAppearance(signal),
      write: (color, revision, signal) => studioApi.saveDesktopAppearance(color, revision, signal),
    }, color => { colorRef.current = color; setColor(applyAccentColor(color, true)) }, setPersistence)
    sync.current = queue; queue.ready(readyRef.current); void queue.load()
    const storage = (event: StorageEvent) => {
      if (!queue.isDesktop() && (event.key === accentStorageKey || event.key === legacyThemeStorageKey || event.key === null)) {
        const color = applyAccentColor(readAccentColor()); colorRef.current = color; setColor(color)
      }
    }
    window.addEventListener('storage', storage)
    return () => { queue.dispose(); if (sync.current === queue) sync.current = null; window.removeEventListener('storage', storage) }
  }, [])
  useEffect(() => { sync.current?.ready(sessionReady) }, [sessionReady])
  return { accentColor: accentColor || defaultAccentColor, setAccentColor, accentSaving: persistence.busy, accentError: persistence.error, retryAccentSave: () => sync.current?.retry() }
}
