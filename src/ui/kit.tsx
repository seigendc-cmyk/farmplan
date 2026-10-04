import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactElement, cloneElement, isValidElement, useEffect, useId, useRef } from 'react'
import { useToasts } from '../store/app'

export function PageHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 mb-5">
      <div className="min-w-0 basis-64 grow"><h1 className="text-xl font-semibold text-gray-900">{title}</h1>{sub && <p className="text-gray-500 mt-0.5">{sub}</p>}</div>
      <div className="flex flex-wrap items-start gap-2 [&_select]:w-auto [&_select]:max-w-full">{actions}</div>
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white border border-gray-200 rounded-lg ${className}`}>{children}</div>
}

/** `reason`: why the button is disabled. Shown under it while disabled, because a hover tooltip never appears on a phone. */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; small?: boolean; reason?: string }
export function Button({ variant = 'secondary', small, className = '', reason, ...p }: BtnProps) {
  const rid = useId()
  const v = { primary: 'bg-brand-600 text-white hover:bg-brand-700 border-transparent', secondary: 'bg-white text-gray-800 hover:bg-gray-50 border-gray-300',
    danger: 'bg-white text-red-700 hover:bg-red-50 border-red-300', ghost: 'bg-transparent hover:bg-gray-100 border-transparent text-gray-700' }[variant]
  const btn = <button {...p} aria-describedby={p.disabled && reason ? rid : p['aria-describedby']} className={`inline-flex items-center justify-center gap-1.5 border rounded-md font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${small ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5'} ${v} ${className}`} />
  if (!p.disabled || !reason) return btn
  return <span className="inline-flex flex-col items-end gap-0.5">{btn}<span id={rid} className="text-xs text-gray-600 max-w-56 text-right">{reason}</span></span>
}

/** A field with its name. The hint is the field's description (`aria-describedby`), not part of its name, so a screen reader says "Label" and then "e.g. 2026/27". */
export function Label({ text, children, hint, className = '' }: { text: string; children: ReactNode; hint?: string; className?: string }) {
  const hid = useId()
  const field = hint && isValidElement(children) ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': hid }) : children
  return <div className={`block ${className}`}><label className="block"><span className="block text-xs font-medium text-gray-600 mb-1">{text}</span>{field}</label>
    {hint && <span id={hid} className="block text-xs text-gray-500 mt-0.5">{hint}</span>}</div>
}
const inputCls = 'w-full border border-gray-300 rounded-md px-2.5 py-1.5 bg-white placeholder-gray-400 focus:border-brand-600'
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${inputCls} ${p.className ?? ''}`} />
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`${inputCls} ${p.className ?? ''}`} />
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={2} {...p} className={`${inputCls} ${p.className ?? ''}`} />

export function NumberInput({ value, onChange, ...p }: { value: number | undefined; onChange: (n: number | undefined) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <Input {...p} type="number" inputMode="decimal" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
}

export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'green' | 'amber' | 'red' | 'blue' }) {
  const t = { gray: 'bg-gray-100 text-gray-700', green: 'bg-brand-100 text-brand-800', amber: 'bg-amber-100 text-amber-800', red: 'bg-red-100 text-red-800', blue: 'bg-blue-100 text-blue-800' }[tone]
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${t}`}>{children}</span>
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
/** Open pop-ups, innermost last. Only the top one answers Escape and Tab, so closing a nested pop-up leaves its parent open. */
const openModals: object[] = []

/**
 * A pop-up that behaves like a dialog for the keyboard: focus moves in when it opens (an autoFocus field wins, otherwise the first
 * field), Tab and Shift+Tab stay inside it, Escape closes it, and focus goes back to whatever opened it.
 */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null); const body = useRef<HTMLDivElement>(null)
  const close = useRef(onClose); close.current = onClose
  const opener = useRef<Element | null | undefined>(undefined); if (opener.current === undefined) opener.current = document.activeElement   // read during the first render, before any autoFocus moves it
  useEffect(() => {
    const me = {}; openModals.push(me); const el = box.current!
    const items = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => !x.closest('[inert],[hidden]'))
    if (!el.contains(document.activeElement)) (body.current!.querySelector<HTMLElement>(FOCUSABLE) ?? items()[0] ?? el).focus()
    const key = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== me) return
      if (e.key === 'Escape') { e.preventDefault(); close.current(); return }
      if (e.key !== 'Tab') return
      const list = items(); const a = document.activeElement
      if (!list.length) { e.preventDefault(); el.focus(); return }
      if (e.shiftKey && (a === list[0] || !el.contains(a))) { e.preventDefault(); list[list.length - 1].focus() }
      else if (!e.shiftKey && (a === list[list.length - 1] || !el.contains(a))) { e.preventDefault(); list[0].focus() }
    }
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('keydown', key); openModals.splice(openModals.indexOf(me), 1)
      const back = opener.current as HTMLElement | null; if (back?.isConnected) back.focus?.()
    }
  }, [])
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center overflow-y-auto p-2 sm:p-6" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`bg-white rounded-lg shadow-xl w-full min-w-0 outline-none ${wide ? 'max-w-3xl' : 'max-w-xl'} mt-1 sm:mt-8`}>
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-gray-200"><h2 className="font-semibold text-gray-900 min-w-0">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="text-gray-500 hover:text-gray-800 text-2xl leading-none w-9 h-9 -mr-2 shrink-0 rounded">×</button></div>
        <div ref={body} className="p-4 sm:p-5">{children}</div>
      </div>
    </div>
  )
}

export function Table({ head, children, empty }: { head: (string | { label: string; right?: boolean })[]; children: ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children.length : children ? 1 : 0
  return (
    <div className="scroll-x">
      <table className="w-full min-w-full text-left">
        <thead><tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
          {head.map((h, i) => { const o = typeof h === 'string' ? { label: h } : h; return <th key={i} className={`px-3 py-2 font-medium whitespace-nowrap ${('right' in o && o.right) ? 'text-right' : ''}`}>{o.label}</th> })}
        </tr></thead>
        <tbody className="divide-y divide-gray-100">{children}</tbody>
      </table>
      {rows === 0 && <p className="text-center text-gray-500 py-10">{empty ?? 'Nothing here yet.'}</p>}
    </div>
  )
}
export const Td = ({ children, right, className = '' }: { children?: ReactNode; right?: boolean; className?: string }) => <td className={`px-3 py-2 align-top ${right ? 'text-right tabular-nums' : ''} ${className}`}>{children}</td>

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return <Card className="px-4 py-3 h-full"><div className="text-xs text-gray-500">{label}</div><div className="text-2xl font-semibold text-gray-900 mt-0.5 tabular-nums">{value}</div>{sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}</Card>
}

export function Denied({ what }: { what: string }) {
  return <Card className="p-8 text-center text-gray-500">Your role does not include access to {what}. Ask the farm owner to adjust your permissions.</Card>
}

export function Toasts() {
  const { items, dismiss } = useToasts()
  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[60] space-y-2 flex flex-col items-end" role="status" aria-live="polite">
      {items.map(t => <div key={t.id} onClick={() => dismiss(t.id)} className={`px-4 py-2.5 rounded-md shadow-lg text-sm max-w-sm cursor-pointer ${t.kind === 'ok' ? 'bg-brand-800 text-white' : 'bg-red-700 text-white'}`}>{t.text}</div>)}
    </div>
  )
}

export function Grid({ cols = 2, children }: { cols?: 1 | 2 | 3 | 4; children: ReactNode }) {
  return <div className={`grid gap-3 ${{ 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' }[cols]}`}>{children}</div>
}
