import { type Ctx, require, can, need, isDate, round2 } from './context'

export const SEEDBED_STATUSES = ['prepared', 'sown', 'germinating', 'growing', 'hardening', 'ready', 'depleted', 'abandoned'] as const
export type SeedbedStatus = typeof SEEDBED_STATUSES[number]

export interface Seedbed {
  id: string; season_id: string; code: string; location: string | null; variety: string | null; seed_lot: string | null
  seed_supplier: string | null; bed_length_m: number | null; bed_width_m: number | null; bed_count: number; area_m2: number | null
  prepared_on: string | null; sown_on: string | null; expected_seedlings: number | null; actual_seedlings: number | null; status: SeedbedStatus
}
export interface SeedbedMetrics extends Seedbed {
  season_label: string
  transplanted: number
  available_seedlings: number | null        // actual less transplanted
  seedlings_per_bed: number | null
  achievement_pct: number | null            // actual vs expected
  total_cost: number | null                 // null when the user lacks finance.cost.view
  cost_per_1000_seedlings: number | null
}

export type SeedbedInput = Partial<Omit<Seedbed, 'id' | 'season_id'>> & { season_id: string }

export function nextSeedbedCode(ctx: Ctx, seasonId: string): string {
  const n = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM seedbeds WHERE season_id=?`, [seasonId])!.n
  let k = n + 1, code = ''
  do { code = `SB-${String(k++).padStart(3, '0')}` } while (ctx.db.get(`SELECT 1 FROM seedbeds WHERE season_id=? AND code=?`, [seasonId, code]))
  return code
}

function validate(i: SeedbedInput) {
  need(i.bed_count == null || i.bed_count > 0, 'Number of beds must be at least 1')
  for (const k of ['bed_length_m', 'bed_width_m', 'area_m2'] as const) need(i[k] == null || (i[k] as number) > 0, 'Dimensions must be positive')
  need(!i.prepared_on || isDate(i.prepared_on), 'Invalid preparation date'); need(!i.sown_on || isDate(i.sown_on), 'Invalid sowing date')
  if (i.prepared_on && i.sown_on) need(i.sown_on >= i.prepared_on, 'Sowing cannot precede preparation')
  need(i.expected_seedlings == null || i.expected_seedlings >= 0, 'Expected seedlings cannot be negative')
  need(i.actual_seedlings == null || i.actual_seedlings >= 0, 'Actual seedlings cannot be negative')
}

const areaOf = (i: SeedbedInput) => i.area_m2 ?? (i.bed_length_m && i.bed_width_m ? round2(i.bed_length_m * i.bed_width_m * (i.bed_count ?? 1)) : null)

export function createSeedbed(ctx: Ctx, i: SeedbedInput): string {
  require(ctx, 'production.seedbed.edit'); validate(i)
  const season = ctx.db.get<{ id: string }>(`SELECT id FROM seasons WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.season_id, ctx.farmId])
  need(season, 'Select a valid season')
  const code = i.code?.trim() || nextSeedbedCode(ctx, i.season_id)
  need(!ctx.db.get(`SELECT 1 FROM seedbeds WHERE season_id=? AND code=? AND deleted_at IS NULL`, [i.season_id, code]), `Seedbed ${code} already exists this season`)
  return ctx.db.tx(() => {
    const id = ctx.db.insert('seedbeds', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: i.season_id, code, location: i.location ?? null,
      variety: i.variety ?? null, seed_lot: i.seed_lot ?? null, seed_supplier: i.seed_supplier ?? null, bed_length_m: i.bed_length_m ?? null,
      bed_width_m: i.bed_width_m ?? null, bed_count: i.bed_count ?? 1, area_m2: areaOf(i), prepared_on: i.prepared_on ?? null, sown_on: i.sown_on ?? null,
      expected_seedlings: i.expected_seedlings ?? null, actual_seedlings: i.actual_seedlings ?? null, status: i.status ?? (i.sown_on ? 'sown' : 'prepared') })
    ctx.db.audit(ctx.actor?.id ?? null, 'seedbed.create', 'seedbeds', id)
    return id
  })
}

export function updateSeedbed(ctx: Ctx, id: string, i: Omit<SeedbedInput, 'season_id'>) {
  require(ctx, 'production.seedbed.edit')
  const cur = ctx.db.get<Seedbed>(`SELECT * FROM seedbeds WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(cur, 'Seedbed not found')
  const m = { ...cur, ...i }; validate(m as SeedbedInput)
  need(m.code?.trim(), 'Code is required')
  need(!ctx.db.get(`SELECT 1 FROM seedbeds WHERE season_id=? AND code=? AND id<>? AND deleted_at IS NULL`, [cur.season_id, m.code, id]), `Seedbed ${m.code} already exists`)
  ctx.db.tx(() => {
    ctx.db.update('seedbeds', id, { code: m.code, location: m.location, variety: m.variety, seed_lot: m.seed_lot, seed_supplier: m.seed_supplier,
      bed_length_m: m.bed_length_m, bed_width_m: m.bed_width_m, bed_count: m.bed_count, area_m2: areaOf(m as SeedbedInput),
      prepared_on: m.prepared_on, sown_on: m.sown_on, expected_seedlings: m.expected_seedlings, actual_seedlings: m.actual_seedlings, status: m.status })
    ctx.db.audit(ctx.actor?.id ?? null, 'seedbed.update', 'seedbeds', id)
  })
}

export function listSeedbeds(ctx: Ctx, seasonId?: string): SeedbedMetrics[] {
  require(ctx, 'production.seedbed.view')
  const showCost = can(ctx, 'finance.cost.view')
  const rows = ctx.db.all<Seedbed & { season_label: string; cost: number; tp: number }>(
    `SELECT s.*, se.label AS season_label,
       COALESCE((SELECT SUM(qty) FROM transplants t WHERE t.seedbed_id=s.id AND t.deleted_at IS NULL),0) AS tp,
       COALESCE((SELECT SUM(amount) FROM cost_entries c WHERE c.seedbed_id=s.id AND c.deleted_at IS NULL),0) AS cost
     FROM seedbeds s JOIN seasons se ON se.id=s.season_id
     WHERE s.farm_id=? AND s.deleted_at IS NULL ${seasonId ? 'AND s.season_id=?' : ''} ORDER BY se.starts_on DESC, s.code`,
    seasonId ? [ctx.farmId, seasonId] : [ctx.farmId])
  return rows.map(({ cost, tp, ...r }) => ({
    ...r,
    transplanted: tp,
    available_seedlings: r.actual_seedlings != null ? r.actual_seedlings - tp : null,
    seedlings_per_bed: r.actual_seedlings != null ? Math.round(r.actual_seedlings / r.bed_count) : null,
    achievement_pct: r.actual_seedlings != null && r.expected_seedlings ? round2((r.actual_seedlings / r.expected_seedlings) * 100) : null,
    total_cost: showCost ? round2(cost) : null,
    cost_per_1000_seedlings: showCost && r.actual_seedlings ? round2((cost / r.actual_seedlings) * 1000) : null,
  }))
}
