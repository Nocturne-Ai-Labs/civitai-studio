import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { type ReactNode } from 'react'

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={250}><TooltipPrimitive.Root><TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger><TooltipPrimitive.Portal><TooltipPrimitive.Content className="studio-tooltip" sideOffset={6}>{label}<TooltipPrimitive.Arrow /></TooltipPrimitive.Content></TooltipPrimitive.Portal></TooltipPrimitive.Root></TooltipPrimitive.Provider>
}
export function Select({ value, onChange, label, options, disabled }: { value: string; onChange: (value: string) => void; label: string; options: { value: string; label: string }[]; disabled?: boolean }) {
  return <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}><SelectPrimitive.Trigger className="input shadcn-input studio-select" aria-label={label}><SelectPrimitive.Value /><SelectPrimitive.Icon><ChevronDown size={14} /></SelectPrimitive.Icon></SelectPrimitive.Trigger><SelectPrimitive.Portal><SelectPrimitive.Content className="studio-select-menu" position="popper" sideOffset={4}><SelectPrimitive.ScrollUpButton>↑</SelectPrimitive.ScrollUpButton><SelectPrimitive.Viewport>{options.map(option => <SelectPrimitive.Item className="studio-select-option" key={option.value} value={option.value}><SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator><Check size={13} /></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>)}</SelectPrimitive.Viewport><SelectPrimitive.ScrollDownButton>↓</SelectPrimitive.ScrollDownButton></SelectPrimitive.Content></SelectPrimitive.Portal></SelectPrimitive.Root>
}
