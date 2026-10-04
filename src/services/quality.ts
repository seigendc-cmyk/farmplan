import { type Ctx, require, can, need, isDate, round2 } from './context'
import { deviceTag } from './device'
import { addCost, assertSeasonOpen, nextCode, nonNeg, removeCostsFor } from './util'

/** Unexplained difference between graded weight and storage weight tolerated without a written explanation. */
export const GRADING_TOLERANCE_PCT = 2

// ---------------------------------------------------------------- grade catalogue (data, not code)
export interface Grade { id: string; code: string; name: string | null; sort_order: number; active: number; notes: string | null }
export type GradeInput = { code: string; name?: string | null; sort_order?: number; active?: boolean; notes?: string | null }

export function listGrades(ctx: Ctx, includeInactive = true): Grade[] {
  require(ctx, 'quality.grading.view')
  return ctx.db.all<Grade>(`SELECT id, code, name, sort_order, active, notes FROM grades WHERE farm_id=? AND deleted_at IS NULL ${includeInactive ? '' : 'AND active=1'} ORDER BY sort_order, code`, [ctx.farmId])
}
export function saveGrade(ctx: Ctx, i: GradeInput, id?: string): string {
  require(ctx, 'quality.grade.edit'); const code = i.code?.trim(); need(code, 'Grade code is required')
  need(!ctx.db.get(`SELECT 1 FROM grades WHERE farm_id=? AND code=? AND deleted_at IS NULL ${id ? 'AND id<>?' : ''}`, id ? [ctx.farmId, code, id] : [ctx.farmId, code]), `Grade ${code} already exists`)
  const d = { code, name: i.name?.trim() || null, sort_order: i.sort_order ?? 0, active: i.active === false ? 0 : 1, notes: i.notes ?? null }
  return ctx.db.tx(() => {
    if (id) { ctx.db.update('grades', id, d); ctx.db.audit(ctx.actor?.id ?? null, 'grade.update', 'grades', id); return id }
    const nid = ctx.db.insert('grades', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, ...d }); ctx.db.audit(ctx.actor?.id ?? null, 'grade.create', 'grades', nid); return nid
  })
}
export function deleteGrade(ctx: Ctx, id: string) {
  require(ctx, 'quality.grade.edit')
  need(!ctx.db.get(`SELECT 1 FROM grading_outputs WHERE grade_id=? AND deleted_at IS NULL`, [id]), 'This grade is already used in grading; deactivate it instead')
  ctx.db.tx(() => ctx.db.softDelete('grades', id))
}

// ---------------------------------------------------------------- grading lots
export interface GradingInput {
  storage_unit_id: string; graded_on: string; outputs: { grade_id: string; weight_kg: number; grader?: string; notes?: string }[]
  waste_kg?: number; grader?: string; labour_cost?: number; variance_note?: string; notes?: string
}

/** Storage unit → grading lot → weights per grade (+ waste). Unexplained variance beyond tolerance must carry a written note. */
export function createGrading(ctx: Ctx, i: GradingInput): { id: string; code: string; variance_kg: number } {
  require(ctx, 'quality.grading.record')
  need(isDate(i.graded_on), 'Valid grading date required'); need(i.outputs.length > 0, 'Enter at least one grade weight')
  nonNeg(i.waste_kg, 'Waste'); nonNeg(i.labour_cost, 'Labour cost')
  const u = ctx.db.get<{ id: string; code: string; season_id: string; status: string; weight_kg: number; opened_on: string | null }>(
    `SELECT id, code, season_id, status, weight_kg, opened_on FROM storage_units WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.storage_unit_id, ctx.farmId])
  need(u, 'Storage unit not found'); need(u.status === 'opened', `${u.code} must be opened before grading`)
  need(!ctx.db.get(`SELECT 1 FROM grading_lots WHERE storage_unit_id=? AND deleted_at IS NULL`, [u.id]), `${u.code} has already been graded`)
  need(!u.opened_on || i.graded_on >= u.opened_on, 'Grading cannot precede opening'); assertSeasonOpen(ctx, u.season_id)
  const seen = new Set<string>()
  for (const o of i.outputs) {
    need(o.weight_kg > 0, 'Each grade weight must be above zero'); need(!seen.has(o.grade_id), 'A grade was entered twice')
    seen.add(o.grade_id); need(ctx.db.get(`SELECT 1 FROM grades WHERE id=? AND farm_id=? AND deleted_at IS NULL AND active=1`, [o.grade_id, ctx.farmId]), 'Unknown or inactive grade')
  }
  const total = round2(i.outputs.reduce((s, o) => s + o.weight_kg, 0) + (i.waste_kg ?? 0)); const variance = round2(u.weight_kg - total)
  const tol = round2((u.weight_kg * GRADING_TOLERANCE_PCT) / 100)
  need(Math.abs(variance) <= tol || i.variance_note?.trim(), `Graded weight differs from ${u.code} by ${variance} kg (${round2((variance / u.weight_kg) * 100)}%). Explain the variance to continue`)
  return ctx.db.tx(() => {
    const code = nextCode(ctx, 'grading_lots', 'G')
    const id = ctx.db.insert('grading_lots', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: u.season_id, code, storage_unit_id: u.id, graded_on: i.graded_on,
      input_kg: u.weight_kg, waste_kg: i.waste_kg ?? 0, variance_kg: variance, variance_note: i.variance_note?.trim() || null, grader: i.grader ?? null, labour_cost: i.labour_cost ?? 0, notes: i.notes ?? null })
    for (const o of i.outputs) ctx.db.insert('grading_outputs', { tenant_id: ctx.tenantId, lot_id: id, grade_id: o.grade_id, weight_kg: o.weight_kg, grader: o.grader ?? i.grader ?? null, notes: o.notes ?? null })
    addCost(ctx, { seasonId: u.season_id, category: 'labour', amount: i.labour_cost ?? 0, on: i.graded_on, sourceType: 'grading_labour', sourceId: id, note: `Grading ${code}` })
    ctx.db.audit(ctx.actor?.id ?? null, 'grading.create', 'grading_lots', id, { code, unit: u.code, variance }); return { id, code, variance_kg: variance }
  })
}

export function deleteGrading(ctx: Ctx, id: string) {
  require(ctx, 'quality.grading.record')
  const lot = ctx.db.get<{ code: string; season_id: string }>(`SELECT code, season_id FROM grading_lots WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(lot, 'Grading lot not found')
  need(!ctx.db.get(`SELECT 1 FROM bales b JOIN grading_outputs o ON o.id=b.output_id WHERE o.lot_id=? AND b.deleted_at IS NULL`, [id]), `${lot.code} already has bales; delete them first`)
  assertSeasonOpen(ctx, lot.season_id)
  ctx.db.tx(() => {
    for (const o of ctx.db.all<{ id: string }>(`SELECT id FROM grading_outputs WHERE lot_id=? AND deleted_at IS NULL`, [id])) ctx.db.softDelete('grading_outputs', o.id)
    ctx.db.softDelete('grading_lots', id); removeCostsFor(ctx, [id]); ctx.db.audit(ctx.actor?.id ?? null, 'grading.delete', 'grading_lots', id)
  })
}

export interface GradingRow {
  id: string; code: string; season_id: string; season_label: string; graded_on: string; unit_code: string; input_kg: number; waste_kg: number; variance_kg: number
  variance_pct: number; variance_flag: boolean; variance_note: string | null; grader: string | null; labour_cost: number | null; baled_kg: number
  outputs: { id: string; grade_id: string; grade: string; weight_kg: number; baled_kg: number }[]
}
export function listGrading(ctx: Ctx, seasonId?: string): GradingRow[] {
  require(ctx, 'quality.grading.view')
  const money = can(ctx, 'finance.cost.view')
  const lots = ctx.db.all<Omit<GradingRow, 'outputs' | 'variance_pct' | 'variance_flag' | 'baled_kg'>>(`SELECT l.id, l.code, l.season_id, se.label season_label, l.graded_on, u.code unit_code, l.input_kg, l.waste_kg, l.variance_kg,
      l.variance_note, l.grader, l.labour_cost FROM grading_lots l JOIN storage_units u ON u.id=l.storage_unit_id JOIN seasons se ON se.id=l.season_id
    WHERE l.farm_id=? AND l.deleted_at IS NULL ${seasonId ? 'AND l.season_id=?' : ''} ORDER BY l.code DESC`, seasonId ? [ctx.farmId, seasonId] : [ctx.farmId])
  return lots.map(l => {
    const outputs = ctx.db.all<GradingRow['outputs'][number]>(`SELECT o.id, o.grade_id, g.code grade, o.weight_kg,
        COALESCE((SELECT SUM(b.weight_kg) FROM bales b WHERE b.output_id=o.id AND b.deleted_at IS NULL),0) baled_kg
      FROM grading_outputs o JOIN grades g ON g.id=o.grade_id WHERE o.lot_id=? AND o.deleted_at IS NULL ORDER BY g.sort_order, g.code`, [l.id])
    const pct = round2((l.variance_kg / l.input_kg) * 100)
    return { ...l, labour_cost: money ? l.labour_cost : null, outputs, variance_pct: pct, variance_flag: Math.abs(pct) > GRADING_TOLERANCE_PCT, baled_kg: round2(outputs.reduce((s, o) => s + o.baled_kg, 0)) }
  })
}

/** Opened storage units still waiting to be graded. */
export function ungradedUnits(ctx: Ctx) {
  require(ctx, 'quality.grading.view')
  return ctx.db.all<{ id: string; code: string; weight_kg: number; opened_on: string | null; season_id: string }>(`SELECT u.id, u.code, u.weight_kg, u.opened_on, u.season_id FROM storage_units u
    WHERE u.farm_id=? AND u.status='opened' AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM grading_lots l WHERE l.storage_unit_id=u.id AND l.deleted_at IS NULL) ORDER BY u.code`, [ctx.farmId])
}

/** Share of graded leaf by grade — e.g. "what percentage of cured tobacco became Grade A?" */
export function gradeMix(ctx: Ctx, seasonId: string) {
  require(ctx, 'quality.grading.view')
  const rows = ctx.db.all<{ grade: string; kg: number }>(`SELECT g.code grade, SUM(o.weight_kg) kg FROM grading_outputs o JOIN grades g ON g.id=o.grade_id JOIN grading_lots l ON l.id=o.lot_id
    WHERE l.season_id=? AND l.farm_id=? AND o.deleted_at IS NULL AND l.deleted_at IS NULL GROUP BY g.id ORDER BY g.sort_order, g.code`, [seasonId, ctx.farmId])
  const t = ctx.db.get<{ i: number; w: number }>(`SELECT COALESCE(SUM(input_kg),0) i, COALESCE(SUM(waste_kg),0) w FROM grading_lots WHERE season_id=? AND farm_id=? AND deleted_at IS NULL`, [seasonId, ctx.farmId])!
  return { graded_input_kg: round2(t.i), waste_kg: round2(t.w), waste_pct: t.i ? round2((t.w / t.i) * 100) : null,
    grades: rows.map(r => ({ grade: r.grade, kg: round2(r.kg), pct: t.i ? round2((r.kg / t.i) * 100) : null })) }
}

// ---------------------------------------------------------------- bales
const yy = (isoDate: string) => isoDate.slice(2, 4)

/** Creates one bale per entry in `weights`. Codes look like TB26-F04-B000123 (season year, dominant field, serial). */
export function createBales(ctx: Ctx, i: { output_id: string; baled_on: string; weights: number[]; notes?: string }): string[] {
  require(ctx, 'quality.bale.record'); need(isDate(i.baled_on), 'Valid baling date required'); need(i.weights.length > 0 && i.weights.length <= 500, 'Enter between 1 and 500 bales')
  for (const w of i.weights) need(Number.isFinite(w) && w > 0, 'Each bale weight must be above zero')
  const o = ctx.db.get<{ id: string; weight_kg: number; grade_id: string; lot_id: string; season_id: string; graded_on: string; unit_id: string }>(
    `SELECT o.id, o.weight_kg, o.grade_id, o.lot_id, l.season_id, l.graded_on, l.storage_unit_id unit_id FROM grading_outputs o JOIN grading_lots l ON l.id=o.lot_id
     WHERE o.id=? AND l.farm_id=? AND o.deleted_at IS NULL AND l.deleted_at IS NULL`, [i.output_id, ctx.farmId])
  need(o, 'Graded lot not found'); need(i.baled_on >= o.graded_on, 'Baling cannot precede grading'); assertSeasonOpen(ctx, o.season_id)
  const baled = ctx.db.get<{ w: number }>(`SELECT COALESCE(SUM(weight_kg),0) w FROM bales WHERE output_id=? AND deleted_at IS NULL`, [o.id])!.w
  const add = round2(i.weights.reduce((s, w) => s + w, 0)); const left = round2(o.weight_kg - baled)
  need(add <= left + 0.001, `Only ${left} kg of this grade is left to bale; ${add} kg entered`)
  const season = ctx.db.get<{ starts_on: string }>(`SELECT starts_on FROM seasons WHERE id=?`, [o.season_id])!
  const lin = ctx.db.get<{ field_id: string; field_no: string; variety: string | null }>(
    `SELECT h.field_id, f.field_no, h.variety FROM storage_units u JOIN cycle_batches cb ON cb.cycle_id=u.cycle_id AND cb.deleted_at IS NULL JOIN harvest_batches h ON h.id=cb.batch_id JOIN fields f ON f.id=h.field_id
     WHERE u.id=? GROUP BY h.field_id ORDER BY SUM(cb.green_weight_kg) DESC LIMIT 1`, [o.unit_id])
  const tag = (lin?.field_no ?? 'XX').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); const prefix = `TB${yy(season.starts_on)}-`
  return ctx.db.tx(() => {
    const dev = deviceTag(ctx.db)   // devices that joined through the cloud add their tag so offline serials cannot collide
    const serialRe = new RegExp(`-B${dev}(\\d{6})$`)
    let serial = ctx.db.all<{ code: string }>(`SELECT code FROM bales WHERE farm_id=? AND code LIKE ?`, [ctx.farmId, `${prefix}%`])
      .reduce((m, r) => Math.max(m, Number(serialRe.exec(r.code)?.[1]) || 0), 0)
    return i.weights.map(w => {
      const code = `${prefix}${tag}-B${dev}${String(++serial).padStart(6, '0')}`
      const id = ctx.db.insert('bales', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: o.season_id, code, output_id: o.id, grade_id: o.grade_id, weight_kg: w, baled_on: i.baled_on,
        field_id: lin?.field_id ?? null, variety: lin?.variety ?? null, status: 'baled', notes: i.notes ?? null })
      ctx.db.audit(ctx.actor?.id ?? null, 'bale.create', 'bales', id, { code }); return code
    })
  })
}

export function deleteBale(ctx: Ctx, id: string) {
  require(ctx, 'quality.bale.record')
  const b = ctx.db.get<{ code: string; status: string; season_id: string }>(`SELECT code, status, season_id FROM bales WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId])
  need(b, 'Bale not found'); need(b.status === 'baled', `${b.code} has been sold`); assertSeasonOpen(ctx, b.season_id)
  ctx.db.tx(() => { ctx.db.softDelete('bales', id); ctx.db.audit(ctx.actor?.id ?? null, 'bale.delete', 'bales', id) })
}

export interface BaleRow { id: string; code: string; season_id: string; grade: string; weight_kg: number; baled_on: string; field_no: string | null; variety: string | null; status: string; lot_code: string; sale_code: string | null }
export function listBales(ctx: Ctx, f: { seasonId?: string; status?: string; gradeId?: string } = {}): BaleRow[] {
  require(ctx, 'quality.bale.view')
  const w = ['b.farm_id=?', 'b.deleted_at IS NULL']; const p: string[] = [ctx.farmId]
  if (f.seasonId) { w.push('b.season_id=?'); p.push(f.seasonId) }; if (f.status) { w.push('b.status=?'); p.push(f.status) }; if (f.gradeId) { w.push('b.grade_id=?'); p.push(f.gradeId) }
  return ctx.db.all<BaleRow>(`SELECT b.id, b.code, b.season_id, g.code grade, b.weight_kg, b.baled_on, f.field_no, b.variety, b.status, l.code lot_code,
      (SELECT s.code FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE sl.bale_id=b.id AND sl.deleted_at IS NULL AND s.deleted_at IS NULL) sale_code
    FROM bales b JOIN grades g ON g.id=b.grade_id JOIN grading_outputs o ON o.id=b.output_id JOIN grading_lots l ON l.id=o.lot_id LEFT JOIN fields f ON f.id=b.field_id
    WHERE ${w.join(' AND ')} ORDER BY b.code DESC`, p)
}

/** Full traceability for one bale, looked up by id or by the scanned code. */
export function baleLineage(ctx: Ctx, idOrCode: string) {
  require(ctx, 'quality.bale.view')
  const b = ctx.db.get<{ id: string; code: string; weight_kg: number; baled_on: string; status: string; season_id: string; grade: string; output_id: string; variety: string | null }>(
    `SELECT b.id, b.code, b.weight_kg, b.baled_on, b.status, b.season_id, g.code grade, b.output_id, b.variety FROM bales b JOIN grades g ON g.id=b.grade_id
     WHERE (b.id=? OR b.code=?) AND b.farm_id=? AND b.deleted_at IS NULL`, [idOrCode, idOrCode.trim().toUpperCase(), ctx.farmId])
  need(b, 'No bale with that code')
  const chain = ctx.db.get<{ season: string; farm: string; lot_code: string; graded_on: string; unit_code: string; unit_kind: string; cycle_id: string; cycle_code: string; barn_code: string }>(
    `SELECT se.label season, fm.name farm, l.code lot_code, l.graded_on, u.code unit_code, u.kind unit_kind, c.id cycle_id, c.code cycle_code, br.code barn_code
     FROM grading_outputs o JOIN grading_lots l ON l.id=o.lot_id JOIN storage_units u ON u.id=l.storage_unit_id JOIN curing_cycles c ON c.id=u.cycle_id
     JOIN barns br ON br.id=c.barn_id JOIN seasons se ON se.id=l.season_id JOIN farms fm ON fm.id=l.farm_id WHERE o.id=?`, [b.output_id])!
  const harvests = ctx.db.all<{ code: string; field_no: string; variety: string | null; harvested_on: string; kg: number }>(
    `SELECT h.code, f.field_no, h.variety, h.harvested_on, cb.green_weight_kg kg FROM cycle_batches cb JOIN harvest_batches h ON h.id=cb.batch_id JOIN fields f ON f.id=h.field_id
     WHERE cb.cycle_id=? AND cb.deleted_at IS NULL ORDER BY h.code`, [chain.cycle_id])
  const sale = ctx.db.get<{ code: string; sold_on: string; buyer: string | null; buyer_id: string | null }>(`SELECT s.code, s.sold_on, s.buyer, s.buyer_id FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE sl.bale_id=? AND sl.deleted_at IS NULL AND s.deleted_at IS NULL`, [b.id]) ?? null
  return { bale: { id: b.id, code: b.code, grade: b.grade, weight_kg: b.weight_kg, baled_on: b.baled_on, status: b.status }, ...chain, harvests,
    fields: [...new Set(harvests.map(h => h.field_no))], varieties: [...new Set(harvests.map(h => h.variety).filter(Boolean) as string[])], sale }
}

/** Graded output lines that still have leaf left to bale. */
export function unbaledOutputs(ctx: Ctx) {
  require(ctx, 'quality.bale.view')
  return ctx.db.all<{ output_id: string; lot_code: string; grade: string; weight_kg: number; remaining_kg: number }>(
    `SELECT o.id output_id, l.code lot_code, g.code grade, o.weight_kg, ROUND(o.weight_kg - COALESCE((SELECT SUM(b.weight_kg) FROM bales b WHERE b.output_id=o.id AND b.deleted_at IS NULL),0),2) remaining_kg
     FROM grading_outputs o JOIN grading_lots l ON l.id=o.lot_id JOIN grades g ON g.id=o.grade_id WHERE l.farm_id=? AND o.deleted_at IS NULL AND l.deleted_at IS NULL
     AND ROUND(o.weight_kg - COALESCE((SELECT SUM(b.weight_kg) FROM bales b WHERE b.output_id=o.id AND b.deleted_at IS NULL),0),2) > 0.001 ORDER BY l.code, g.sort_order`, [ctx.farmId])
}
