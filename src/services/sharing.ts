import type { SupabaseClient } from '@supabase/supabase-js'

// ------------------------------------------------------------------ what a farmer may share (view-only; mirrors the cloud trigger)
export interface ShareMenu { key: string; label: string; sensitive?: boolean }
export const SHARE_MENUS: ShareMenu[] = [
  { key: 'production.field.view', label: 'Fields' }, { key: 'production.seedbed.view', label: 'Seedbeds' },
  { key: 'production.operation.view', label: 'Field operations and input usage' }, { key: 'production.weather.view', label: 'Weather and observations' },
  { key: 'production.transplant.view', label: 'Transplanting' }, { key: 'production.harvest.view', label: 'Harvest batches' },
  { key: 'curing.barn.view', label: 'Barns' }, { key: 'curing.cycle.view', label: 'Curing cycles and temperature logs' }, { key: 'curing.storage.view', label: 'Starking / storage' },
  { key: 'quality.grading.view', label: 'Grading' }, { key: 'quality.bale.view', label: 'Bales' },
  { key: 'finance.cost.view', label: 'Costs', sensitive: true }, { key: 'marketing.sale.view', label: 'Sales and revenue', sensitive: true }, { key: 'contracts.contract.view', label: 'Contract programmes', sensitive: true },
]
export type SharePurpose = 'contractor' | 'extension' | 'other'
export const SHARE_PRESETS: Record<'contractor' | 'extension', string[]> = {
  contractor: ['production.field.view', 'production.seedbed.view', 'production.operation.view', 'production.transplant.view', 'production.harvest.view', 'curing.barn.view', 'curing.cycle.view', 'curing.storage.view', 'quality.grading.view', 'quality.bale.view'],
  extension: ['production.field.view', 'production.seedbed.view', 'production.operation.view', 'production.weather.view', 'production.transplant.view', 'production.harvest.view'],
}
const SHAREABLE = /^(production|curing|quality|marketing|contracts|finance)\.[a-z_]+\.view$/
export function validateShare(email: string, permissions: string[]): string | null {
  if (!/^\S+@\S+\.\S+$/.test(email.trim())) return 'Enter a valid email address'
  if (!permissions.length) return 'Choose at least one thing to share'
  const bad = permissions.find(p => !SHAREABLE.test(p)); return bad ? `${bad} cannot be shared` : null
}

// ------------------------------------------------------------------ farmer side
export interface Invitation { id: string; invitee_email: string; purpose: SharePurpose; permissions: string[]; expires_at: string; accepted_at: string | null; revoked_at: string | null; access_days: number | null; created_at: string }
export interface Grant { id: string; purpose: SharePurpose; permissions: string[]; expires_at: string | null; revoked_at: string | null; invitation_id: string | null; created_at: string }

const unwrap = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return (r.data ?? ([] as unknown)) as T }

/** The code is `<invitation id>.<secret token>`. The secret is shown once; only its hash is stored in the cloud. */
export async function createInvitation(sb: SupabaseClient, tenantId: string, i: { email: string; purpose: SharePurpose; permissions: string[]; access_days?: number | null }): Promise<{ id: string; code: string }> {
  const err = validateShare(i.email, i.permissions); if (err) throw new Error(err)
  const rows = unwrap(await sb.rpc('create_invitation', { p_tenant: tenantId, p_email: i.email.trim(), p_purpose: i.purpose, p_permissions: i.permissions, p_access_days: i.access_days ?? null }), 'Invitation') as { invitation_id: string; token: string }[]
  const r = Array.isArray(rows) ? rows[0] : (rows as unknown as { invitation_id: string; token: string })
  if (!r?.invitation_id) throw new Error('Invitation was not created')
  return { id: r.invitation_id, code: `${r.invitation_id}.${r.token}` }
}
export async function listInvitations(sb: SupabaseClient, tenantId: string): Promise<Invitation[]> {
  return unwrap(await sb.from('access_invitations').select('id,invitee_email,purpose,permissions,expires_at,accepted_at,revoked_at,access_days,created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }), 'Invitations') as Invitation[]
}
export async function listGrants(sb: SupabaseClient, tenantId: string): Promise<Grant[]> {
  return unwrap(await sb.from('access_grants').select('id,purpose,permissions,expires_at,revoked_at,invitation_id,created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }), 'Access') as Grant[]
}
export async function revokeGrant(sb: SupabaseClient, grantId: string) { unwrap(await sb.rpc('revoke_access', { p_grant: grantId }), 'Revoke') }
export async function revokeInvitation(sb: SupabaseClient, id: string) { unwrap(await sb.from('access_invitations').update({ revoked_at: new Date().toISOString() }).eq('id', id), 'Revoke') }

export const labelFor = (perm: string) => SHARE_MENUS.find(m => m.key === perm)?.label ?? perm
export function invitationState(i: Invitation, now = new Date()): 'accepted' | 'revoked' | 'expired' | 'pending' {
  return i.revoked_at ? 'revoked' : i.accepted_at ? 'accepted' : Date.parse(i.expires_at) < now.getTime() ? 'expired' : 'pending'
}

// ------------------------------------------------------------------ invitee / portal side
export interface Access { grant_id: string; tenant_id: string; tenant_name: string; farm_id: string | null; farm_name: string | null; purpose: SharePurpose; permissions: string[]; expires_at: string | null }
export async function myAccess(sb: SupabaseClient): Promise<Access[]> { return unwrap(await sb.rpc('my_access'), 'Access') as Access[] }
export function parseInviteCode(code: string): { id: string; token: string } {
  const m = /^\s*([0-9a-fA-F-]{36})\.([0-9a-fA-F]{20,})\s*$/.exec(code); if (!m) throw new Error('That does not look like an invitation code'); return { id: m[1], token: m[2] }
}
export async function acceptInvitation(sb: SupabaseClient, code: string) { const c = parseInviteCode(code); unwrap(await sb.rpc('accept_invitation', { p_invitation: c.id, p_token: c.token }), 'Invitation') }

export interface PortalCol { k: string; label: string; fmt?: 'date' | 'num' | 'money' | 'bool' | 'lookup' }
export interface PortalView { key: string; perm: string; label: string; view: string; order: string; cols: PortalCol[]; group: string }
const d = (k: string, label: string): PortalCol => ({ k, label, fmt: 'date' }), n = (k: string, label: string): PortalCol => ({ k, label, fmt: 'num' })
export const PORTAL_VIEWS: PortalView[] = [
  { key: 'fields', group: 'Production', perm: 'production.field.view', label: 'Fields', view: 'portal_fields', order: 'field_no', cols: [{ k: 'field_no', label: 'Field' }, n('area_ha', 'Area ha'), { k: 'variety', label: 'Variety' }, { k: 'soil_type', label: 'Soil' }, { k: 'previous_crop', label: 'Previous crop' }, { k: 'current_crop', label: 'Current crop' }, { k: 'irrigated', label: 'Irrigated', fmt: 'bool' }, { k: 'tenure', label: 'Tenure' }] },
  { key: 'seedbeds', group: 'Production', perm: 'production.seedbed.view', label: 'Seedbeds', view: 'portal_seedbeds', order: 'code', cols: [{ k: 'code', label: 'Bed' }, { k: 'variety', label: 'Variety' }, d('sown_on', 'Sown'), n('expected_seedlings', 'Expected'), n('actual_seedlings', 'Actual'), { k: 'status', label: 'Status' }] },
  { key: 'operations', group: 'Production', perm: 'production.operation.view', label: 'Operations', view: 'portal_operations', order: 'occurred_on', cols: [d('occurred_on', 'Date'), { k: 'op_type', label: 'Operation' }, { k: 'field_id', label: 'Field', fmt: 'lookup' }, { k: 'seedbed_id', label: 'Seedbed', fmt: 'lookup' }, n('area_ha', 'Area ha'), { k: 'operator', label: 'Operator' }, { k: 'weather', label: 'Weather' }, { k: 'remarks', label: 'Remarks' }] },
  { key: 'inputs', group: 'Production', perm: 'production.operation.view', label: 'Input usage', view: 'portal_operation_inputs', order: 'input_name', cols: [{ k: 'input_name', label: 'Input' }, { k: 'input_category', label: 'Type' }, n('qty', 'Quantity'), { k: 'unit', label: 'Unit' }, { k: 'rate_note', label: 'Rate / label note' }] },
  { key: 'weather', group: 'Production', perm: 'production.weather.view', label: 'Weather', view: 'portal_weather', order: 'recorded_on', cols: [d('recorded_on', 'Date'), { k: 'field_id', label: 'Field', fmt: 'lookup' }, n('rainfall_mm', 'Rain mm'), n('temp_min_c', 'Min °C'), n('temp_max_c', 'Max °C'), { k: 'event', label: 'Event' }, { k: 'observation', label: 'Observation' }] },
  { key: 'transplants', group: 'Production', perm: 'production.transplant.view', label: 'Transplanting', view: 'portal_transplants', order: 'occurred_on', cols: [d('occurred_on', 'Date'), { k: 'kind', label: 'Type' }, { k: 'seedbed_id', label: 'Seedbed', fmt: 'lookup' }, { k: 'field_id', label: 'Field', fmt: 'lookup' }, n('qty', 'Planted'), n('mortality', 'Mortality'), { k: 'soil_condition', label: 'Soil' }] },
  { key: 'harvests', group: 'Production', perm: 'production.harvest.view', label: 'Harvest', view: 'portal_harvests', order: 'harvested_on', cols: [{ k: 'code', label: 'Batch' }, d('harvested_on', 'Date'), { k: 'field_id', label: 'Field', fmt: 'lookup' }, { k: 'variety', label: 'Variety' }, n('priming', 'Priming'), { k: 'leaf_position', label: 'Position' }, n('green_weight_kg', 'Green kg'), { k: 'status', label: 'Status' }] },
  { key: 'barns', group: 'Curing', perm: 'curing.barn.view', label: 'Barns', view: 'portal_barns', order: 'code', cols: [{ k: 'code', label: 'Barn' }, { k: 'barn_type', label: 'Type' }, n('capacity_kg', 'Capacity kg'), { k: 'furnace', label: 'Furnace' }, { k: 'fuel_type', label: 'Fuel' }, { k: 'condition', label: 'Condition' }] },
  { key: 'cycles', group: 'Curing', perm: 'curing.cycle.view', label: 'Curing cycles', view: 'portal_cycles', order: 'code', cols: [{ k: 'code', label: 'Cycle' }, { k: 'barn_id', label: 'Barn', fmt: 'lookup' }, { k: 'status', label: 'Status' }, { k: 'loaded_at', label: 'Loaded' }, n('green_weight_kg', 'Green kg'), { k: 'offloaded_at', label: 'Offloaded' }, n('cured_weight_kg', 'Cured kg'), { k: 'condition', label: 'Condition' }] },
  { key: 'curing_logs', group: 'Curing', perm: 'curing.cycle.view', label: 'Temperature logs', view: 'portal_curing_logs', order: 'logged_at', cols: [{ k: 'cycle_id', label: 'Cycle', fmt: 'lookup' }, { k: 'logged_at', label: 'Time' }, n('temperature_c', '°C'), { k: 'ventilation', label: 'Ventilation' }, n('fuel_added_kg', 'Fuel added'), { k: 'operator', label: 'Operator' }] },
  { key: 'storage', group: 'Curing', perm: 'curing.storage.view', label: 'Storage', view: 'portal_storage', order: 'code', cols: [{ k: 'code', label: 'Unit' }, { k: 'kind', label: 'Type' }, { k: 'cycle_id', label: 'Cycle', fmt: 'lookup' }, n('weight_kg', 'kg'), d('created_on', 'Stored'), d('expected_open_on', 'Opens'), { k: 'status', label: 'Status' }] },
  { key: 'grading', group: 'Quality', perm: 'quality.grading.view', label: 'Grading', view: 'portal_grading', order: 'code', cols: [{ k: 'code', label: 'Lot' }, d('graded_on', 'Date'), n('input_kg', 'Input kg'), n('waste_kg', 'Waste kg'), n('variance_kg', 'Variance kg'), { k: 'grader', label: 'Grader' }] },
  { key: 'bales', group: 'Quality', perm: 'quality.bale.view', label: 'Bales', view: 'portal_bales', order: 'code', cols: [{ k: 'code', label: 'Bale' }, { k: 'grade', label: 'Grade' }, n('weight_kg', 'kg'), d('baled_on', 'Baled'), { k: 'field_id', label: 'Field', fmt: 'lookup' }, { k: 'variety', label: 'Variety' }, { k: 'status', label: 'Status' }] },
  { key: 'costs', group: 'Financial', perm: 'finance.cost.view', label: 'Costs', view: 'portal_costs', order: 'occurred_on', cols: [d('occurred_on', 'Date'), { k: 'category', label: 'Category' }, { k: 'amount', label: 'Amount', fmt: 'money' }, { k: 'field_id', label: 'Field', fmt: 'lookup' }, { k: 'note', label: 'Note' }] },
  { key: 'sales', group: 'Financial', perm: 'marketing.sale.view', label: 'Sales', view: 'portal_sales', order: 'sold_on', cols: [{ k: 'code', label: 'Lot' }, d('sold_on', 'Date'), { k: 'channel', label: 'Channel' }, { k: 'buyer', label: 'Buyer' }, n('weight_kg', 'kg'), { k: 'gross', label: 'Gross', fmt: 'money' }, { k: 'deductions', label: 'Deductions', fmt: 'money' }] },
  { key: 'contracts', group: 'Financial', perm: 'contracts.contract.view', label: 'Contracts', view: 'portal_contracts', order: 'code', cols: [{ k: 'code', label: 'Contract' }, { k: 'contract_no', label: 'Ref' }, { k: 'contractor', label: 'Contractor' }, { k: 'status', label: 'Status' }, n('area_ha', 'Area ha'), n('target_kg', 'Target kg'), d('delivery_deadline', 'Deadline')] },
]
export const viewsFor = (permissions: string[]) => PORTAL_VIEWS.filter(v => permissions.includes(v.perm))

export type PortalRow = Record<string, unknown>
export async function fetchPortal(sb: SupabaseClient, v: PortalView, tenantId: string): Promise<PortalRow[]> {
  const r = await sb.from(v.view).select('*').eq('tenant_id', tenantId).order(v.order, { ascending: true })
  return unwrap(r, v.label) as PortalRow[]
}
/** id → short human code for lookup columns (field, seedbed, cycle, barn), loaded only for what the invitee may see. */
export async function fetchLookups(sb: SupabaseClient, tenantId: string, permissions: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const src: [string, string, string, string][] = [['production.field.view', 'portal_fields', 'id', 'field_no'], ['production.seedbed.view', 'portal_seedbeds', 'id', 'code'], ['curing.cycle.view', 'portal_cycles', 'id', 'code'], ['curing.barn.view', 'portal_barns', 'id', 'code']]
  for (const [perm, view, idk, labelk] of src) {
    if (!permissions.includes(perm)) continue
    try { const rows = unwrap(await sb.from(view).select('*').eq('tenant_id', tenantId).order(labelk, { ascending: true }), view) as PortalRow[]; for (const r of rows) out[String(r[idk])] = String(r[labelk]) } catch { /* lookups are best-effort */ }
  }
  return out
}
