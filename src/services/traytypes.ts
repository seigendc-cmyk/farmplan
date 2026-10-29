import { type Ctx, require, need } from './context'

/** A float-tray or seedling-tray size the farm uses. Configured by the farm; nothing is seeded. */
export interface TrayType { id: string; name: string; cells: number; length_mm: number | null; width_mm: number | null; media: string | null; note: string | null }
export type TrayTypeInput = Omit<TrayType, 'id'> & { id?: string }

const COLS = `id, name, cells, length_mm, width_mm, media, note`
const blank = (s: string | null | undefined) => s?.trim() || null

export function listTrayTypes(ctx: Ctx): TrayType[] {
  require(ctx, 'production.seedbed.view')
  return ctx.db.all<TrayType>(`SELECT ${COLS} FROM tray_types WHERE farm_id=? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE`, [ctx.farmId])
}

/** Creates (no id) or edits (id) a tray type; trays keep pointing at the same id. Returns the id. */
export function saveTrayType(ctx: Ctx, i: TrayTypeInput): string {
  require(ctx, 'production.seedbed.edit')
  const name = (i.name ?? '').trim(); need(name, 'Give the tray type a name')
  need(Number.isInteger(i.cells) && i.cells > 0, 'Cells per tray must be a whole number above zero')
  for (const [v, w] of [[i.length_mm, 'Length'], [i.width_mm, 'Width']] as const) need(v == null || (Number.isFinite(v) && v > 0), `${w} must be positive when given`)
  if (i.id) need(ctx.db.get(`SELECT 1 FROM tray_types WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.id, ctx.farmId]), 'Tray type not found')
  // Names are unique per farm, including removed ones (the table keeps them), so say so rather than failing on the constraint.
  const clash = ctx.db.get<{ deleted_at: string | null }>(`SELECT deleted_at FROM tray_types WHERE farm_id=? AND LOWER(name)=LOWER(?) AND id<>?`, [ctx.farmId, name, i.id ?? ''])
  need(!clash, clash?.deleted_at ? `A tray type called "${name}" already exists (it was removed earlier); use another name` : `A tray type called "${name}" already exists`)
  const row = { name, cells: i.cells, length_mm: i.length_mm ?? null, width_mm: i.width_mm ?? null, media: blank(i.media), note: blank(i.note) }
  return ctx.db.tx(() => {
    if (i.id) { ctx.db.update('tray_types', i.id, row); ctx.db.audit(ctx.actor?.id ?? null, 'traytype.update', 'tray_types', i.id); return i.id }
    const id = ctx.db.insert('tray_types', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, ...row })
    ctx.db.audit(ctx.actor?.id ?? null, 'traytype.create', 'tray_types', id); return id
  })
}

export function deleteTrayType(ctx: Ctx, id: string): void {
  require(ctx, 'production.seedbed.edit')
  const t = ctx.db.get<{ name: string }>(`SELECT name FROM tray_types WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(t, 'Tray type not found')
  const n = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM seedbed_trays WHERE tray_type_id=? AND deleted_at IS NULL`, [id])!.n
  need(n === 0, `"${t.name}" is in use by ${n} tray${n === 1 ? '' : 's'}; remove or change those trays first`)
  ctx.db.tx(() => { ctx.db.softDelete('tray_types', id); ctx.db.audit(ctx.actor?.id ?? null, 'traytype.delete', 'tray_types', id) })
}
