import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva, type VariantProps } from 'class-variance-authority'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { X } from 'lucide-react'

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }

const buttonStyles = cva('button shadcn-button', {
  variants: {
    variant: { default: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', outline: 'button-outline', destructive: 'button-danger' },
    size: { default: '', sm: 'button-sm', icon: 'button-icon' },
  }, defaultVariants: { variant: 'default', size: 'default' },
})
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonStyles({ variant, size }), className)} {...props} />
))
Button.displayName = 'Button'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => <input ref={ref} className={cn('input shadcn-input', className)} {...props} />)
Input.displayName = 'Input'
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => <textarea ref={ref} className={cn('textarea shadcn-input', className)} {...props} />)
Textarea.displayName = 'Textarea'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close
type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { showCloseButton?: boolean; closeDisabled?: boolean }
export const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(({ className, children, showCloseButton = true, closeDisabled = false, ...props }, ref) => (
  <DialogPortal><DialogPrimitive.Overlay className="dialog-overlay" /><DialogPrimitive.Content ref={ref} className={cn('dialog-content', showCloseButton && 'has-dialog-close', className)} {...props}>{children}{showCloseButton && <DialogPrimitive.Close asChild><Button type="button" variant="ghost" size="icon" className="dialog-close" aria-label="Close dialog" disabled={closeDisabled}><X size={18} /></Button></DialogPrimitive.Close>}</DialogPrimitive.Content></DialogPortal>
))
DialogContent.displayName = 'DialogContent'
export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description
