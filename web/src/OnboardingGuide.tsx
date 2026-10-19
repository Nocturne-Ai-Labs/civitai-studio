import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, ExternalLink, KeyRound, UserRound, Wallet, WandSparkles } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from './ui'
import './onboarding.css'

const accountSettings = 'https://civitai.com/user/account/security#api-keys'
const steps = [{ label: 'Account', title: 'Start with your Civitai account', icon: UserRound }, { label: 'API key', title: 'Create a key for Studio', icon: KeyRound }, { label: 'Buzz', title: 'Understand your Buzz', icon: Wallet }, { label: 'Ready', title: 'Connect, then create at your own pace', icon: WandSparkles }]

function OfficialLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="button shadcn-button button-secondary onboarding-external" href={href} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={14} aria-hidden="true" /><span className="onboarding-sr-only"> (opens externally)</span></a>
}

export function BuzzExplainer() {
  return <div className="buzz-explainer">
    <p>Buzz is Civitai's credit for generation. Safe-for-work content is abbreviated SFW.</p>
    <dl className="onboarding-buzz-pools">
      <div className="onboarding-buzz-blue"><dt><span aria-hidden="true" />Blue Buzz</dt><dd><strong>SFW only</strong><p>Free or earned credits for SFW generation.</p></dd></div>
      <div className="onboarding-buzz-green"><dt><span aria-hidden="true" />Green Buzz</dt><dd><strong>SFW only</strong><p>Purchased credits for SFW generation.</p></dd></div>
      <div className="onboarding-buzz-yellow"><dt><span aria-hidden="true" />Yellow Buzz</dt><dd><strong>NSFW enabled</strong><p>Supports SFW and mature/NSFW generation where Civitai permits it.</p></dd></div>
    </dl>
    <p className="onboarding-buzz-note">These are separate balances. Which Buzz can fund a job depends on its workflow, provider, your account and Civitai's rules. Check the cost review before confirming.</p>
    <details className="onboarding-sources"><summary>Official Buzz information</summary><p><a href="https://civitai.green/articles/22350" target="_blank" rel="noopener noreferrer">Civitai's Buzz explanation<ExternalLink size={12} aria-hidden="true" /></a><a href="https://github.com/civitai/civitai/blob/main/docs/features/buzz-accounts.md" target="_blank" rel="noopener noreferrer">Civitai's account documentation<ExternalLink size={12} aria-hidden="true" /></a></p></details>
  </div>
}

export function OnboardingWelcome({ onStart, onDismiss }: { onStart: () => void; onDismiss: () => void }) {
  return <section className="onboarding-welcome" aria-label="Getting started with Civitai Studio">
    <BookOpen size={20} aria-hidden="true" /><div><strong>New to Civitai Studio?</strong><p>A short guide to your account, API key and Buzz.</p></div>
    <div className="onboarding-welcome-actions"><Button type="button" variant="secondary" size="sm" onClick={onStart}>Get started</Button><Button type="button" variant="ghost" size="sm" onClick={onDismiss}>Skip for now</Button></div>
  </section>
}

export function OnboardingGuide({ open, onOpenChange, startAt = 0, connected, onConnect, onWorkspace }: { open: boolean; onOpenChange: (open: boolean) => void; startAt?: number; connected: boolean; onConnect: () => void; onWorkspace: () => void }) {
  const [step, setStep] = useState(startAt)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (open) setStep(Math.min(steps.length - 1, Math.max(0, startAt))) }, [open, startAt])
  useEffect(() => { if (open) heading.current?.focus() }, [step, open])
  const Icon = steps[step]!.icon
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="onboarding-dialog">
    <DialogTitle>Getting started with Studio</DialogTitle><DialogDescription>A quick, optional walkthrough. You can close it any time and reopen it from Settings or Account.</DialogDescription>
    <nav aria-label="Getting started steps"><ol className="onboarding-steps">{steps.map((item, index) => <li key={item.label}><Button type="button" variant="ghost" aria-current={index === step ? 'step' : undefined} onClick={() => setStep(index)}><span aria-hidden="true">{index + 1}</span>{item.label}</Button></li>)}</ol></nav>
    <section className="onboarding-step-body" aria-labelledby="onboarding-step-title">
      <span className="onboarding-step-count">Step {step + 1} of {steps.length}</span><h3 id="onboarding-step-title" ref={heading} tabIndex={-1}><Icon size={22} aria-hidden="true" />{steps[step]!.title}</h3>
      {step === 0 && <><p>Civitai hosts the models, generation services and Buzz balance you use in Studio.</p><ol className="onboarding-instructions"><li>Open Civitai and create an account, or sign in to the one you already use.</li><li>Complete any account setup Civitai asks for.</li><li>Return here when you're ready to connect that account to Studio.</li></ol><OfficialLink href="https://civitai.com">Open Civitai to sign in or join</OfficialLink>{connected && <p className="onboarding-connected"><CheckCircle2 size={15} aria-hidden="true" />Your account is already connected to Studio.</p>}</>}
      {step === 1 && <><p>On Civitai, open <strong>Account settings → Security &amp; Apps → API keys</strong>.</p><ol className="onboarding-instructions"><li>Add an API key and give it a name such as <strong>Civitai Studio</strong>.</li><li>The <strong>AI Services</strong> permission preset covers connection, Buzz balance and generation. Model browsing also needs <strong>Models → read</strong>.</li><li>Copy the key, return to Studio and paste it into the connection form.</li></ol><details className="onboarding-permissions"><summary>Permissions for model browsing and generation</summary><p>Use Custom permissions to include these together:</p><ul><li><strong>Profile &amp; Settings → read</strong> to connect your account.</li><li><strong>AI Services → read and write</strong> for generation.</li><li><strong>Buzz → read</strong> to show your balance.</li><li><strong>Models → read</strong> to browse models.</li></ul></details><OfficialLink href={accountSettings}>Open Civitai API key settings</OfficialLink><p className="onboarding-key-note">Treat the key like a password. Studio's connection panel shows how it is stored on your server. You can remove the key later in Civitai's settings.</p></>}
      {step === 2 && <BuzzExplainer />}
      {step === 3 && <><p>{connected ? 'Your connection is ready. Start in Generate when you want to work on a prompt.' : 'Open the connection form and paste your key. Studio will validate it and show your connection status.'}</p><ol className="onboarding-instructions"><li>Choose a workflow and a compatible generation model.</li><li>Write your prompt. Prompt presets and History help you reuse and refine text.</li><li>Review the Buzz estimate, then confirm only when you're ready to spend it.</li></ol><p className="onboarding-ready-note">Generation starts after your explicit confirmation. You can explore the workspace before connecting.</p><div className="onboarding-primary-actions">{!connected && <Button type="button" onClick={onConnect}><KeyRound size={15} aria-hidden="true" />Open connection form</Button>}<Button type="button" variant={connected ? 'default' : 'secondary'} onClick={onWorkspace}>{connected ? 'Go to Generate' : 'Explore the workspace'}</Button></div></>}
    </section>
    <footer className="onboarding-footer"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Skip / close guide</Button><div><Button type="button" variant="secondary" disabled={step === 0} onClick={() => setStep(value => value - 1)}><ArrowLeft size={14} aria-hidden="true" />Back</Button>{step < steps.length - 1 && <Button type="button" onClick={() => setStep(value => value + 1)}>Next<ArrowRight size={14} aria-hidden="true" /></Button>}</div></footer>
  </DialogContent></Dialog>
}
