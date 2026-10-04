import { create } from 'zustand'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Holds the signed-in cloud client for this session only (never persisted; the password is never stored). */
interface S { sb: SupabaseClient | null; email: string; set(sb: SupabaseClient | null, email?: string): void }
export const useCloudSession = create<S>(set => ({ sb: null, email: '', set: (sb, email = '') => set({ sb, email }) }))
