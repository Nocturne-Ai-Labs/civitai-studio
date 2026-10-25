import type { DesktopAppearance } from '../../shared/desktop-appearance'
import { desktopAccent } from '../../shared/desktop-appearance'

type Adapter = { read: (signal: AbortSignal) => Promise<DesktopAppearance>; write: (color: string, revision: string, signal: AbortSignal) => Promise<DesktopAppearance> }
type Status = { busy: boolean; error: string }
// This queue is only for the desktop accent. It never carries account data.
export function createDesktopAccent(initialColor: string, api: Adapter, onColor: (color: string) => void, onStatus: (state: Status) => void, delay = 200) {
  let desktop: boolean | null = null, revision: string | null = null, persisted: string | null = null, wanted: string | null = null
  let chosen = 0, ready = false, loading = false, saving = false, disposed = false, error = '', conflicts = 0
  let timer: ReturnType<typeof setTimeout> | null = null, request: AbortController | null = null
  const status = () => { if (!disposed) onStatus({ busy: desktop !== false && (loading || saving || wanted !== null || desktop === null), error }) }
  const validate = (value: DesktopAppearance) => {
    if (typeof value.desktop !== 'boolean' || value.desktop && (typeof value.revision !== 'string' || !value.revision || value.revision.length > 80 || value.accentColor !== null && !desktopAccent(value.accentColor))) throw new Error('The saved accent color could not be loaded.')
    return value
  }
  function schedule() {
    status()
    if (disposed || !desktop || !ready || !revision || !wanted || loading || saving || error || timer) return
    timer = setTimeout(() => { timer = null; void save() }, delay)
  }
  async function save() {
    if (disposed || !desktop || !ready || !revision || !wanted || saving || loading) return
    if (wanted === persisted) { wanted = null; status(); return }
    const color = wanted, epoch = chosen, expected = revision, controller = new AbortController()
    request = controller; saving = true; status()
    try {
      const result = validate(await api.write(color, expected, controller.signal))
      if (disposed || controller.signal.aborted) return
      if (!result.desktop || !result.revision || !result.accentColor) throw new Error('The accent color could not be saved.')
      revision = result.revision; persisted = result.accentColor; conflicts = 0
      if (chosen === epoch && wanted === color) wanted = null
    } catch (failure) {
      if (disposed || controller.signal.aborted) return
      if ((failure as { status?: number })?.status === 409 && conflicts < 1) {
        conflicts++
        try {
          const current = validate(await api.read(controller.signal))
          if (disposed || controller.signal.aborted) return
          if (!current.desktop || !current.revision) throw new Error('Desktop appearance is unavailable.')
          revision = current.revision; persisted = current.accentColor
          if (wanted === persisted) wanted = null
        } catch { if (!disposed) error = 'Your color has not been saved yet. Retry before restarting.' }
      } else error = 'Your color has not been saved yet. Retry before restarting.'
    } finally {
      saving = false
      if (!disposed) { status(); schedule() }
    }
  }
  async function load() {
    if (loading || disposed) return
    request?.abort(); const controller = new AbortController(); request = controller; loading = true; error = ''; status()
    try {
      const result = validate(await api.read(controller.signal))
      if (disposed || controller.signal.aborted) return
      desktop = result.desktop; revision = result.revision; persisted = result.accentColor
      if (!desktop) wanted = null
      else if (!chosen && persisted) onColor(persisted)
      else if (!wanted && persisted === null) wanted = initialColor
    } catch { if (!disposed && !controller.signal.aborted) error = 'Your saved color could not be loaded. Retry before restarting.' }
    finally { loading = false; if (!disposed) schedule() }
  }
  return {
    load,
    choose(color: string) {
      if (!desktopAccent(color) || disposed) return
      chosen++; conflicts = 0; error = ''
      wanted = desktop === false || color === persisted && !saving ? null : color
      if (timer) { clearTimeout(timer); timer = null }
      if (desktop !== false && (desktop === null || revision === null) && !loading) { void load(); return }
      schedule()
    },
    ready(value: boolean) { ready = value; schedule() },
    retry() { error = ''; conflicts = 0; if (desktop === null || revision === null) void load(); else schedule() },
    isDesktop: () => desktop === true,
    dispose() { disposed = true; if (timer) clearTimeout(timer); request?.abort() },
  }
}
