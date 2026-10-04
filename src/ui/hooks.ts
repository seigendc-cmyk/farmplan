import { useMemo } from 'react'
import { useApp, useToasts } from '../store/app'
import { PermissionError, can, type Ctx } from '../services/context'

export const today = () => new Date().toISOString().slice(0, 10)

export function useCtx(): Ctx { return useApp(s => s.ctx)! }
export function useCan() { const ctx = useCtx(); return (p: string) => can(ctx, p) }

/** Reads data via a service call; re-runs after any write. Returns undefined when the role lacks permission. */
export function useData<T>(fn: (ctx: Ctx) => T, deps: unknown[] = []): T | undefined {
  const ctx = useCtx(); const rev = useApp(s => s.rev)
  return useMemo(() => {
    try { return fn(ctx) } catch (e) { if (e instanceof PermissionError) return undefined; throw e }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, rev, ...deps])
}

/** Runs a write: toasts errors, refreshes data and confirms success. Resolves true on success, false on failure. */
export function useRun() {
  const bump = useApp(s => s.bump); const push = useToasts(s => s.push)
  return async (fn: () => unknown, ok?: string): Promise<boolean> => {
    try { await fn(); bump(); if (ok) push('ok', ok); return true }
    catch (e) { push('err', e instanceof Error ? e.message : String(e)); return false }
  }
}

export const fmt = {
  money: (n: number | null | undefined, cur = 'USD') => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n),
  num: (n: number | null | undefined, d = 0) => n == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: d }).format(n),
  date: (s: string | null | undefined) => s ? new Date(s + (s.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
}

/** "1 field", "3 fields". */
export const plural = (n: number, one: string, many = `${one}s`) => `${fmt.num(n)} ${n === 1 ? one : many}`
