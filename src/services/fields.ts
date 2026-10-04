import { type Ctx, require, need } from './context'

export interface Field {
  id: string; field_no: string; block_id: string | null; block_name: string | null; area_ha: number
  latitude: number | null; longitude: number | null; soil_type: string | null; soil_notes: string | null
  previous_crop: string | null; current_crop: string | null; variety: string | null
  irrigated: number; tenure: string; tenure_notes: string | null
}
export type FieldInput = Partial<Omit<Field, 'id' | 'block_name'>> & { field_no: string; area_ha: number }

export function listFields(ctx: Ctx): Field[] {
  require(ctx, 'production.field.view')
  return ctx.db.all<Field>(`SELECT f.*, b.name AS block_name FROM fields f LEFT JOIN blocks b ON b.id=f.block_id
    WHERE f.farm_id=? AND f.deleted_at IS NULL ORDER BY f.field_no`, [ctx.farmId])
}

export function listBlocks(ctx: Ctx) {
  require(ctx, 'production.field.view')
  return ctx.db.all<{ id: string; name: string }>(`SELECT id,name FROM blocks WHERE farm_id=? AND deleted_at IS NULL ORDER BY name`, [ctx.farmId])
}

export function ensureBlock(ctx: Ctx, name: string): string {
  require(ctx, 'production.field.edit')
  const n = name.trim(); need(n, 'Block name is required')
  const ex = ctx.db.get<{ id: string }>(`SELECT id FROM blocks WHERE farm_id=? AND name=? AND deleted_at IS NULL`, [ctx.farmId, n])
  return ex?.id ?? ctx.db.insert('blocks', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, name: n })
}

function validate(i: FieldInput) {
  need(i.field_no?.trim(), 'Field number is required')
  need(Number.isFinite(i.area_ha) && i.area_ha > 0, 'Area must be greater than zero')
  if (i.latitude != null) need(i.latitude >= -90 && i.latitude <= 90, 'Latitude out of range')
  if (i.longitude != null) need(i.longitude >= -180 && i.longitude <= 180, 'Longitude out of range')
}

export function createField(ctx: Ctx, i: FieldInput): string {
  require(ctx, 'production.field.edit'); validate(i)
  need(!ctx.db.get(`SELECT 1 FROM fields WHERE farm_id=? AND field_no=? AND deleted_at IS NULL`, [ctx.farmId, i.field_no.trim()]), `Field ${i.field_no} already exists`)
  return ctx.db.tx(() => {
    const id = ctx.db.insert('fields', {
      tenant_id: ctx.tenantId, farm_id: ctx.farmId, block_id: i.block_id ?? null, field_no: i.field_no.trim(), area_ha: i.area_ha,
      latitude: i.latitude ?? null, longitude: i.longitude ?? null, soil_type: i.soil_type ?? null, soil_notes: i.soil_notes ?? null,
      previous_crop: i.previous_crop ?? null, current_crop: i.current_crop ?? null, variety: i.variety ?? null,
      irrigated: i.irrigated ? 1 : 0, tenure: i.tenure ?? 'owned', tenure_notes: i.tenure_notes ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'field.create', 'fields', id)
    return id
  })
}

export function updateField(ctx: Ctx, id: string, i: FieldInput) {
  require(ctx, 'production.field.edit'); validate(i)
  need(!ctx.db.get(`SELECT 1 FROM fields WHERE farm_id=? AND field_no=? AND id<>? AND deleted_at IS NULL`, [ctx.farmId, i.field_no.trim(), id]), `Field ${i.field_no} already exists`)
  ctx.db.tx(() => {
    ctx.db.update('fields', id, {
      block_id: i.block_id ?? null, field_no: i.field_no.trim(), area_ha: i.area_ha, latitude: i.latitude ?? null, longitude: i.longitude ?? null,
      soil_type: i.soil_type ?? null, soil_notes: i.soil_notes ?? null, previous_crop: i.previous_crop ?? null, current_crop: i.current_crop ?? null,
      variety: i.variety ?? null, irrigated: i.irrigated ? 1 : 0, tenure: i.tenure ?? 'owned', tenure_notes: i.tenure_notes ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'field.update', 'fields', id)
  })
}

export function deleteField(ctx: Ctx, id: string) {
  require(ctx, 'production.field.edit')
  need(!ctx.db.get(`SELECT 1 FROM operations WHERE field_id=? AND deleted_at IS NULL`, [id]), 'Field has recorded operations and cannot be deleted')
  ctx.db.tx(() => { ctx.db.softDelete('fields', id); ctx.db.audit(ctx.actor?.id ?? null, 'field.delete', 'fields', id) })
}

/** Production history: every operation and season cost for the field, newest first. */
