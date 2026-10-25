import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import * as Slider from '@radix-ui/react-slider'
import { RotateCcw } from 'lucide-react'
import { Button, Input } from './ui'
import { defaultAccentColor, hexToHsv, hsvToHex, normalizeHexColor, type HsvColor } from './theme'
import './appearance.css'

const swatches = [
  { name: 'Civitai blue', color: defaultAccentColor }, { name: 'Civitai red', color: '#fa5252' },
  { name: 'Violet', color: '#a855f7' }, { name: 'Pink', color: '#ec4899' },
  { name: 'Teal', color: '#14b8a6' }, { name: 'Amber', color: '#f59e0b' },
]
function ColorSlider({ label, value, gradient, onChange }: { label: string; value: number; gradient: string; onChange: (value: number) => void }) {
  return <div className="accent-slider-field"><div><label>{label}</label><output>{Math.round(value)}%</output></div><Slider.Root className="accent-slider" min={0} max={100} step={1} value={[Math.round(value)]} onValueChange={values => onChange(values[0]!)}><Slider.Track className="accent-slider-track" style={{ background: gradient }}><Slider.Range className="accent-slider-range" /></Slider.Track><Slider.Thumb className="accent-slider-thumb" aria-label={`Accent ${label.toLowerCase()}`} aria-valuetext={`${Math.round(value)} percent`} /></Slider.Root></div>
}
export type AccentPersistence = { saving: boolean; error: string; retry: () => void }
export function AccentColorPicker({ color, onChange, persistence }: { color: string; onChange: (color: string) => void; persistence?: AccentPersistence }) {
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(color))
  const [hexInput, setHexInput] = useState(color), [hexError, setHexError] = useState('')
  const lastEmitted = useRef(color)
  useEffect(() => {
    if (color !== lastEmitted.current) { setHsv(hexToHsv(color)); lastEmitted.current = color }
    setHexInput(color); setHexError('')
  }, [color])
  function commit(next: HsvColor) {
    const chosen = hsvToHex(next)
    setHsv(next); lastEmitted.current = chosen; setHexInput(chosen); setHexError(''); onChange(chosen)
  }
  function chooseHex(value: string) {
    const chosen = normalizeHexColor(value)
    if (!chosen) { setHexError('Enter a 3- or 6-digit hex color, such as #228be6.'); return }
    setHsv(hexToHsv(chosen)); lastEmitted.current = chosen; setHexInput(chosen); setHexError(''); onChange(chosen)
  }
  function hueAt(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect(), x = event.clientX - bounds.left - bounds.width / 2, y = event.clientY - bounds.top - bounds.height / 2
    if (Math.hypot(x, y) < bounds.width * .28) return
    commit({ ...hsv, h: (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360 })
  }
  function hueKey(event: KeyboardEvent<HTMLDivElement>) {
    const jump = event.shiftKey ? 10 : 1
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 359 : ['ArrowUp', 'ArrowRight'].includes(event.key) ? hsv.h + jump : ['ArrowDown', 'ArrowLeft'].includes(event.key) ? hsv.h - jump : null
    if (next === null) return
    event.preventDefault(); commit({ ...hsv, h: (next + 360) % 360 })
  }
  const radians = hsv.h * Math.PI / 180
  return <div className="accent-picker">
    <p>Choose your accent color. Buttons and highlights update as you adjust it.</p>
    <div className="accent-wheel-row"><div className="accent-wheel" role="slider" tabIndex={0} aria-label="Accent hue" aria-valuemin={0} aria-valuemax={359} aria-valuenow={Math.round(hsv.h) % 360} aria-valuetext={`${Math.round(hsv.h) % 360} degrees`} aria-describedby="accent-wheel-help" onKeyDown={hueKey} onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); hueAt(event) }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) hueAt(event) }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}><span className="accent-wheel-center"><span style={{ backgroundColor: color }} /><small>{color.toUpperCase()}</small></span><span className="accent-wheel-thumb" style={{ left: `${50 + Math.sin(radians) * 42}%`, top: `${50 - Math.cos(radians) * 42}%`, backgroundColor: hsvToHex({ h: hsv.h, s: 100, v: 100 }) }} /></div></div>
    <p id="accent-wheel-help" className="field-help accent-wheel-help">Drag around the wheel, or focus it and use the arrow keys. Shift adjusts hue in larger steps.</p>
    <ColorSlider label="Saturation" value={hsv.s} gradient={`linear-gradient(to right, ${hsvToHex({ ...hsv, s: 0 })}, ${hsvToHex({ ...hsv, s: 100 })})`} onChange={s => commit({ ...hsv, s })} />
    <ColorSlider label="Brightness" value={hsv.v} gradient={`linear-gradient(to right, #000000, ${hsvToHex({ ...hsv, v: 100 })})`} onChange={v => commit({ ...hsv, v })} />
    <form className="accent-hex-form" onSubmit={event => { event.preventDefault(); chooseHex(hexInput) }}><label className="field-label" htmlFor="accent-hex">Hex color</label><div><Input id="accent-hex" value={hexInput} maxLength={7} autoComplete="off" spellCheck={false} aria-invalid={!!hexError} aria-describedby={hexError ? 'accent-hex-error' : undefined} onChange={event => { setHexInput(event.target.value); setHexError('') }} /><Button type="submit" variant="secondary">Apply</Button></div>{hexError && <p id="accent-hex-error" className="error-box" role="alert">{hexError}</p>}</form>
    <div className="accent-swatches" role="group" aria-label="Accent color presets">{swatches.map(swatch => <Button type="button" key={swatch.color} variant="ghost" size="icon" className="accent-swatch" aria-label={swatch.name} aria-pressed={color === swatch.color} title={swatch.name} onClick={() => chooseHex(swatch.color)}><span style={{ backgroundColor: swatch.color }} /></Button>)}</div>
    <div className="accent-preview" aria-label="Current accent preview"><span className="accent-preview-action">Button preview</span><span className="accent-preview-link">Highlight preview</span></div>
    <Button type="button" variant="ghost" size="sm" onClick={() => chooseHex(defaultAccentColor)}><RotateCcw size={13} />Reset to Civitai blue</Button>
    <p className="field-help">Saved on this device. Studio adjusts button and text shades to keep them readable. Buzz and status colors stay consistent.</p>
    {persistence?.error ? <div className="error-box" role="alert">{persistence.error}<Button type="button" variant="ghost" size="sm" onClick={persistence.retry}>Retry saving color</Button></div> : persistence?.saving ? <p className="field-help" role="status">Saving your accent color…</p> : null}
  </div>
}
