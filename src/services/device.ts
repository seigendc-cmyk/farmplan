import type { Db } from '../db/database'

/** A device tag (A, B … AA) is issued by the cloud when a device joins a farm. The office device has none. */
export function deviceTag(db: Db): string { return db.get<{ value: string }>(`SELECT value FROM meta WHERE key='device_tag'`)?.value ?? '' }
export function setDeviceTag(db: Db, tag: string, label?: string) {
  const upsert = (k: string, v: string) => db.run(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [k, v])
  upsert('device_tag', tag); if (label) upsert('device_label', label)
}
export const deviceLabel = (db: Db) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key='device_label'`)?.value ?? ''
