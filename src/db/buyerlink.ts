import type { Db } from './database'

const KIND: Record<string, string> = { auction: 'auction_floor', contract: 'contractor', private: 'private' }

/**
 * Turns the free-text buyer names on existing sales into registered buyers and links the sales.
 * Names are matched ignoring case and surrounding spaces; an existing buyer of that name is reused. Safe to run repeatedly.
 */
export function adoptBuyerNames(db: Db, farmId: string): { created: number; linked: number } {
  const farm = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM farms WHERE id=?`, [farmId]); if (!farm) return { created: 0, linked: 0 }
  let created = 0, linked = 0
  db.tx(() => {
    const rows = db.all<{ id: string; buyer: string; channel: string }>(`SELECT id, trim(buyer) buyer, channel FROM sales WHERE farm_id=? AND deleted_at IS NULL AND buyer_id IS NULL AND trim(COALESCE(buyer,'')) <> '' ORDER BY sold_on, code`, [farmId])
    const ids = new Map(db.all<{ id: string; name: string }>(`SELECT id, name FROM buyers WHERE farm_id=? AND deleted_at IS NULL`, [farmId]).map(b => [b.name.toLowerCase(), b.id]))
    for (const r of rows) {
      let id = ids.get(r.buyer.toLowerCase())
      if (!id) { id = db.insert('buyers', { tenant_id: farm.tenant_id, farm_id: farmId, name: r.buyer, kind: KIND[r.channel] ?? 'other', active: 1 }); ids.set(r.buyer.toLowerCase(), id); created++ }
      db.update('sales', r.id, { buyer_id: id }); linked++
    }
  })
  return { created, linked }
}
