import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>
/** Minimal in-memory stand-in for the cloud: just enough of the Supabase client for the sharing flows. */
export function makeFakeCloud(portalData: Record<string, Row[]> = {}) {
  const invitations: Row[] = []; const grants: Row[] = []; const tokens = new Map<string, string>()
  let n = 0; const uuid = () => { n++; const h = n.toString(16).padStart(12, '0'); return `00000000-0000-4000-8000-${h}` }
  const farm = { tenant_id: '', tenant_name: 'Home Farm' }
  const client = (email: string): SupabaseClient => {
    const rpc = async (name: string, a: Record<string, unknown>) => {
      if (name === 'create_invitation') {
        const id = uuid(); const token = (n + 1000).toString(16).padStart(40, 'a'); tokens.set(id, token); farm.tenant_id = a.p_tenant as string
        invitations.push({ id, tenant_id: a.p_tenant, invitee_email: a.p_email, purpose: a.p_purpose, permissions: a.p_permissions, access_days: a.p_access_days, expires_at: '2099-01-01T00:00:00Z', accepted_at: null, revoked_at: null, created_at: new Date().toISOString() })
        return { data: [{ invitation_id: id, token }], error: null }
      }
      if (name === 'accept_invitation') {
        const inv = invitations.find(i => i.id === a.p_invitation)
        if (!inv || tokens.get(inv.id as string) !== a.p_token) return { data: null, error: { message: 'Invalid or expired invitation' } }
        if ((inv.invitee_email as string).toLowerCase() !== email.toLowerCase()) return { data: null, error: { message: 'Invitation is for a different email' } }
        if (inv.accepted_at) return { data: null, error: { message: 'Invitation already used' } }
        inv.accepted_at = new Date().toISOString()
        grants.push({ id: uuid(), tenant_id: inv.tenant_id, grantee_email: email, purpose: inv.purpose, permissions: inv.permissions, expires_at: null, revoked_at: null, invitation_id: inv.id, created_at: inv.accepted_at })
        return { data: null, error: null }
      }
      if (name === 'my_access') return { data: grants.filter(g => g.grantee_email === email && !g.revoked_at).map(g => ({ grant_id: g.id, tenant_id: g.tenant_id, tenant_name: farm.tenant_name, farm_id: null, farm_name: null, purpose: g.purpose, permissions: g.permissions, expires_at: g.expires_at })), error: null }
      if (name === 'revoke_access') { const g = grants.find(x => x.id === a.p_grant); if (g) g.revoked_at = new Date().toISOString(); return { data: null, error: null } }
      return { data: null, error: { message: `unknown rpc ${name}` } }
    }
    const from = (table: string) => {
      const src = (): Row[] => table === 'access_invitations' ? invitations : table === 'access_grants' ? grants : portalData[table] ?? []
      let rows: Row[] | null = null; let patch: Row | null = null; let want: string | null = null
      const q: Record<string, unknown> = {
        select: () => q, eq: (_c: string, v: string) => { want = v; return q }, order: () => q,
        update: (p: Row) => { patch = p; return q },
        then: (res: (v: unknown) => unknown) => {
          rows = src().filter(r => !want || r.tenant_id === want || r.id === want)
          if (patch) { for (const r of rows) Object.assign(r, patch); return res({ data: null, error: null }) }
          return res({ data: rows.map(r => ({ ...r })), error: null })
        },
      }
      return q
    }
    return { rpc, from, auth: { signUp: async () => ({ error: null }), signInWithPassword: async () => ({ error: null }) } } as unknown as SupabaseClient
  }
  return { client, invitations, grants }
}
