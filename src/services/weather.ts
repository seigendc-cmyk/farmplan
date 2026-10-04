import { type Ctx, require, need, isDate } from './context'
import { assertSeasonOpen, nonNeg } from './util'

export const WEATHER_EVENTS = ['none', 'hail', 'frost', 'drought'] as const
export interface WeatherInput { season_id?: string | null; field_id?: string | null; recorded_on: string; rainfall_mm?: number | null; temp_min_c?: number | null; temp_max_c?: number | null; event?: (typeof WEATHER_EVENTS)[number]; observation?: string }

/** Rainfall, temperature and field observations (scouting notes, hail, frost). At least one measurement or note is required. */
export function recordWeather(ctx: Ctx, i: WeatherInput): string {
  require(ctx, 'production.weather.record')
  need(isDate(i.recorded_on), 'Valid date required'); nonNeg(i.rainfall_mm, 'Rainfall')
  need(i.rainfall_mm != null || i.temp_min_c != null || i.temp_max_c != null || (i.event && i.event !== 'none') || i.observation?.trim(), 'Enter a rainfall, temperature, event or note')
  need(i.temp_min_c == null || i.temp_max_c == null || i.temp_min_c <= i.temp_max_c, 'Minimum temperature cannot exceed maximum')
  if (i.field_id) need(ctx.db.get(`SELECT 1 FROM fields WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.field_id, ctx.farmId]), 'Field not found')
  if (i.season_id) assertSeasonOpen(ctx, i.season_id)
  return ctx.db.tx(() => {
    const id = ctx.db.insert('weather_records', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: i.season_id ?? null, field_id: i.field_id ?? null, recorded_on: i.recorded_on,
      rainfall_mm: i.rainfall_mm ?? null, temp_min_c: i.temp_min_c ?? null, temp_max_c: i.temp_max_c ?? null, event: i.event ?? 'none', observation: i.observation?.trim() || null })
    ctx.db.audit(ctx.actor?.id ?? null, 'weather.record', 'weather_records', id)
    return id
  })
}

export interface WeatherRow { id: string; recorded_on: string; field_no: string | null; rainfall_mm: number | null; temp_min_c: number | null; temp_max_c: number | null; event: string | null; observation: string | null }
export function listWeather(ctx: Ctx, limit = 100): WeatherRow[] {
  require(ctx, 'production.weather.view')
  return ctx.db.all<WeatherRow>(`SELECT w.id, w.recorded_on, f.field_no, w.rainfall_mm, w.temp_min_c, w.temp_max_c, w.event, w.observation FROM weather_records w LEFT JOIN fields f ON f.id=w.field_id
    WHERE w.farm_id=? AND w.deleted_at IS NULL ORDER BY w.recorded_on DESC, w.created_at DESC LIMIT ${Math.min(limit, 500)}`, [ctx.farmId])
}
