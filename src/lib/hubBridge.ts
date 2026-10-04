import type { Db } from '../db/database'
import { hubHandle, isHubEnabled, setHubEnabled } from '../services/hub'

export const DEFAULT_HUB_PORT = 7878
export const hubSupported = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export interface HubStatus { port: number; addresses: string[] }

let unlisten: (() => void) | null = null
let running: HubStatus | null = null
export const hubStatus = () => running

/** Starts the Rust listener and answers each request with the TypeScript hub (src/services/hub.ts). Desktop app only. */
export async function startHub(db: Db, port = DEFAULT_HUB_PORT): Promise<HubStatus> {
  if (!hubSupported()) throw new Error('The Wi-Fi hub runs in the desktop app on the office computer.')
  const { invoke } = await import('@tauri-apps/api/core'); const { listen } = await import('@tauri-apps/api/event')
  if (!unlisten) unlisten = await listen<{ id: number; method: string; path: string; auth: string | null; body: string }>('hub-request', async e => {
    const r = e.payload; let status = 400; let out: unknown = { error: 'Bad request' }
    try { const res = await hubHandle(db, { method: r.method, path: r.path, auth: r.auth, body: r.body ? JSON.parse(r.body) : undefined }); status = res.status; out = res.body }
    catch (err) { status = 500; out = { error: err instanceof Error ? err.message : String(err) } }
    await invoke('hub_reply', { id: r.id, status, body: JSON.stringify(out) })
  })
  setHubEnabled(db, true)
  try { running = await invoke<HubStatus>('hub_start', { port }); return running } catch (e) { setHubEnabled(db, false); throw new Error(String(e)) }
}

/** The database remembers that the hub was on; after an app restart nothing is listening until this runs. */
export async function resumeHub(db: Db) { if (hubSupported() && isHubEnabled(db) && !running) { try { await startHub(db) } catch { /* surfaced in Users & access → Wi-Fi hub */ } } }

export async function stopHub(db: Db) {
  setHubEnabled(db, false); running = null
  if (hubSupported()) { const { invoke } = await import('@tauri-apps/api/core'); await invoke('hub_stop') }
}
