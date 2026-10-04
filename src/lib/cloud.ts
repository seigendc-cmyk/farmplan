import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface CloudConfig { url?: string; key?: string; email?: string }
const KEY = 'farmplan.cloud'
export const loadCloudConfig = (): CloudConfig => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as CloudConfig } catch { return {} } }
export const saveCloudConfig = (c: CloudConfig) => { try { localStorage.setItem(KEY, JSON.stringify(c)) } catch { /* private mode */ } }

type Factory = (cfg: CloudConfig) => SupabaseClient
let factory: Factory = cfg => createClient(cfg.url!, cfg.key!, { auth: { persistSession: false, autoRefreshToken: false } })
/** Tests inject a fake cloud here. */
export function setCloudFactory(f: Factory | null) { factory = f ?? (cfg => createClient(cfg.url!, cfg.key!, { auth: { persistSession: false, autoRefreshToken: false } })) }

export async function connectCloud(cfg: CloudConfig, password: string, create = false): Promise<SupabaseClient> {
  if (!cfg.url || !cfg.key || !cfg.email) throw new Error('Enter the project URL, publishable key and your email.')
  const sb = factory(cfg)
  if (create) {
    const { error } = await sb.auth.signUp({ email: cfg.email, password })
    if (error) throw new Error(`Could not create the account: ${error.message}`)
  }
  const { error } = await sb.auth.signInWithPassword({ email: cfg.email, password })
  if (error) throw new Error(`Cloud sign-in failed: ${error.message}`)
  return sb
}
