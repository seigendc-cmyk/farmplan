import { type ReactNode, useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { can } from '../services/context'
import { RECORDS, locate, recordHref, type RecKind } from '../services/links'
import { useCtx, useData } from './hooks'

/** A record code that opens the record's page. Plain text when there is no code or the reader may not open that page. */
export function RecLink({ kind, code, children, className = '' }: { kind: RecKind; code: string | null | undefined; children?: ReactNode; className?: string }) {
  const ctx = useCtx()
  if (!code) return <>{children ?? '—'}</>
  if (!can(ctx, RECORDS[kind].perm)) return <>{children ?? code}</>
  return <Link to={recordHref(kind, code)} className={`text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-700 ${className}`}>{children ?? code}</Link>
}

/** On a list page: the record named in `?focus=`, the season it belongs to (so the season picker can jump there), and row props that highlight it. */
export function useFocus(kind: RecKind) {
  const [params, setParams] = useSearchParams()
  const focus = params.get('focus') ?? ''; const season = params.get('season') ?? undefined
  const hit = useData(c => (focus ? locate(c, kind, focus, season) : null), [focus, kind, season])
  const domId = (code: string) => `rec-${kind}-${code.replace(/[^A-Za-z0-9_-]/g, '_')}`
  const scrolled = useRef('')
  useEffect(() => {   // once per target, as soon as its row exists (it can arrive a render late, after the season switch)
    const el = focus && scrolled.current !== focus ? document.getElementById(domId(focus)) : null
    if (el) { scrolled.current = focus; el.scrollIntoView?.({ block: 'center' }) }
  })
  const isFocus = (code: string | null | undefined) => !!focus && !!code && (RECORDS[kind].nocase ? code.toLowerCase() === focus.toLowerCase() : code === focus)
  return {
    focus, id: hit?.id, seasonId: hit ? hit.season_id ?? season : undefined,
    /** Spread on the record's <tr>: an anchor id, plus a highlight while it is the focus. */
    row: (code: string | null | undefined, className = 'hover:bg-gray-50') => ({
      id: code ? domId(code) : undefined, 'aria-current': isFocus(code) ? ('true' as const) : undefined,
      className: isFocus(code) ? `${className} bg-amber-50 outline outline-2 -outline-offset-2 outline-amber-400` : className }),
    /** Drop `?focus=` once its modal is closed, so the page does not reopen it. */
    clear: () => setParams(p => { p.delete('focus'); p.delete('season'); return p }, { replace: true }),
  }
}
