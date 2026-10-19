import { useState } from 'react'
import * as Slider from '@radix-ui/react-slider'
import { imageFieldError, type ImageCapability, type ImageField, type NumericCapability } from '../../shared/image-capabilities'
import { Button, Input } from './ui'

// Familiar names for the existing provider-sized presets; pixels stay unchanged.
const ratioNames: Record<string, string> = { '9:7': '4:3', '7:9': '3:4', '7:4': '16:9', '4:7': '9:16', '19:13': '3:2', '13:19': '2:3' }

function Parameter({ name, field, value, onChange, disabled }: { disabled?:boolean; name: ImageField; field: NumericCapability; value: unknown; onChange: (value: unknown) => void }) {
  const actual = value === undefined ? field.default : typeof value === 'number' ? value : NaN
  const error = imageFieldError(field, value)
  const id = `image-${name}`
  if (name === 'steps' || name === 'cfgScale') {
    const min = Math.max(field.min, field.slider?.[0] ?? field.min)
    const max = Math.min(field.max, field.slider?.[1] ?? field.max)
    const inRange = Number.isFinite(actual) && actual >= min && actual <= max && !error
    const help = `${id}-range`
    return <div className="image-parameter">
      <div className="image-parameter-heading"><label id={`${id}-label`} className="field-label" htmlFor={`${id}-value`}>{field.label}</label><Input id={`${id}-value`} disabled={disabled} type="number" min={field.min} max={field.max} step={field.integer ? field.step : 'any'} value={Number.isFinite(actual) ? actual : ''} aria-invalid={Boolean(error)} aria-describedby={`${help}${error ? ` ${id}-error` : ''}`} onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))}/></div>
      <Slider.Root className="parameter-slider" min={min} max={max} step={field.step} value={inRange ? [actual] : []} disabled={disabled || !inRange} onValueChange={values => {
        const next = values[0]
        if (!disabled && next !== undefined && next >= min && next <= max && !imageFieldError(field,next)) onChange(next)
      }}><Slider.Track className="parameter-track"><Slider.Range className="parameter-range"/></Slider.Track>{inRange && <Slider.Thumb id={id} className="parameter-thumb" aria-labelledby={`${id}-label`} aria-describedby={help}/>}</Slider.Root>
      <p id={help} className="field-help">{disabled ? 'Fixed by this workflow.' : inRange ? `Slider: ${min}–${max}` : `Saved value retained. Enter ${min}–${max} to use the slider; API range ${field.min}–${field.max}.`}</p>
      {error && <p id={`${id}-error`} role="alert" className="composer-error">{error}</p>}
    </div>
  }
  return <div className="image-parameter">
    <label className="field-label" htmlFor={id}>{field.label}</label>
    <Input disabled={disabled} id={id} type="number" min={field.min} max={field.max} step={field.integer ? field.step : 'any'} value={Number.isFinite(actual) ? actual : ''} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} title={`${field.label}: ${field.min}–${field.max}${field.multipleOf ? `; multiples of ${field.multipleOf}` : ''}`} onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))} />
    {error && <p id={`${id}-error`} role="alert" className="composer-error">{error}</p>}
  </div>
}
export function ImageParameterControls({ profile, input, onField, onSize, lockedFields=[] }: { lockedFields?: ImageField[]; profile: ImageCapability; input: Record<string, unknown>; onField: (name: string, value: unknown) => void; onSize: (width: number, height: number) => void }) {
  const [custom, setCustom] = useState(false)
  const tiers = profile.resolutionTiers ?? [{ label: profile.fields.width.default === 512 ? '512 px' : '1K', sizes: profile.sizes }]
  const width = input.width ?? profile.fields.width.default, height = input.height ?? profile.fields.height.default
  const currentTier = tiers.findIndex(tier => tier.sizes.some(([w,h]) => w === width && h === height))
  const tier = tiers[Math.max(0,currentTier)]!
  const gcd = (a: number, b: number): number => b ? gcd(b,a%b) : a
  return <section className="form-field compact-image-controls" aria-label={`${profile.name} image parameters`}>
    <div className="resolution-heading"><label className="field-label" htmlFor="resolution-tier">Size &amp; ratio</label><select id="resolution-tier" className="shadcn-input" value={currentTier < 0 ? 'custom' : currentTier} onChange={event => {
      if (event.target.value === 'custom') { setCustom(true); return }
      const sizes = tiers[Number(event.target.value)]!.sizes
      const match = sizes.find(([w,h]) => typeof width === 'number' && typeof height === 'number' && w*height === h*width) ?? sizes[0]!
      setCustom(false); onSize(...match)
    }}>{tiers.map((item,index) => <option key={item.label} value={index}>{item.label}</option>)}{currentTier < 0 && <option value="custom">Custom</option>}</select><span className="field-help">{String(width)} × {String(height)} px</span></div>
    <div className="resolution-tiles" role="group" aria-label="Aspect ratio and dimensions">{tier.sizes.map(([w,h]) => {
      const actual = `${w/gcd(w,h)}:${h/gcd(w,h)}`, label = ratioNames[actual] ?? actual, approximate = label !== actual
      return <Button type="button" variant={w === width && h === height ? 'default' : 'secondary'} key={`${w}:${h}`} aria-pressed={w === width && h === height} aria-label={`${approximate ? 'Approximately ' : ''}${label} aspect ratio, ${w} by ${h} pixels`} onClick={() => { setCustom(false); onSize(w,h) }}><span className="ratio-outline" style={{ aspectRatio: `${w}/${h}` }} /><span>{approximate ? '≈ ' : ''}{label}</span><small>{w} × {h}</small></Button>
    })}</div>
    <Button type="button" variant="ghost" size="sm" onClick={() => setCustom(value => !value)} aria-expanded={custom || currentTier < 0}>Custom dimensions</Button>
    {(custom || currentTier < 0) && <div className="image-parameter-grid">{(['width','height'] as const).map(name => <Parameter key={name} name={name} field={profile.fields[name]} value={input[name]} onChange={value => onField(name,value)} />)}</div>}
    <div className="image-parameter-grid">{(['quantity','steps','cfgScale'] as ImageField[]).map(name => <Parameter disabled={lockedFields.includes(name)} key={`${profile.name}:${name}`} name={name} field={profile.fields[name]} value={input[name]} onChange={value => onField(name,value)} />)}</div>
  </section>
}
