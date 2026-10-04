import { describe, it, expect } from 'vitest'
import { validateShare, createInvitation, parseInviteCode, invitationState, viewsFor, SHARE_PRESETS, SHARE_MENUS, acceptInvitation, myAccess, listGrants, revokeGrant, fetchPortal, PORTAL_VIEWS } from './services/sharing'
import { makeFakeCloud } from './testing/fakeCloud'

describe('sharing service', () => {
  it('validates email and permissions, view-only', () => {
    expect(validateShare('bad', ['production.field.view'])).toMatch(/email/)
    expect(validateShare('a@b.co', [])).toMatch(/at least one/)
    expect(validateShare('a@b.co', ['production.field.edit'])).toMatch(/cannot be shared/)
    expect(validateShare('a@b.co', ['settings.access.manage'])).toMatch(/cannot be shared/)
    expect(validateShare('a@b.co', SHARE_PRESETS.contractor)).toBeNull()
  })
  it('every shareable menu has a portal view and presets exclude sensitive menus', () => {
    for (const m of SHARE_MENUS) expect(PORTAL_VIEWS.some(v => v.perm === m.key), m.key).toBe(true)
    const sens = SHARE_MENUS.filter(m => m.sensitive).map(m => m.key)
    for (const p of Object.values(SHARE_PRESETS)) for (const s of sens) expect(p).not.toContain(s)
  })
  it('viewsFor only returns what was granted', () => {
    expect(viewsFor(['production.field.view']).map(v => v.key)).toEqual(['fields'])
    expect(viewsFor(['production.operation.view']).map(v => v.key)).toEqual(['operations', 'inputs'])
    expect(viewsFor([])).toEqual([])
  })
  it('invite → accept → portal → revoke through the cloud API', async () => {
    const cloud = makeFakeCloud({ portal_fields: [{ id: 'f1', tenant_id: 'T1', field_no: 'F-01' }, { id: 'f2', tenant_id: 'OTHER', field_no: 'X' }] })
    const farmer = cloud.client('farmer@x.co'), con = cloud.client('con@x.co')
    const { code, id } = await createInvitation(farmer, 'T1', { email: 'con@x.co', purpose: 'contractor', permissions: ['production.field.view'], access_days: 30 })
    expect(code.startsWith(id + '.')).toBe(true); expect(parseInviteCode(code).id).toBe(id)
    expect(() => parseInviteCode('nonsense')).toThrow(/invitation code/)
    await expect(acceptInvitation(cloud.client('other@x.co'), code)).rejects.toThrow(/different email/)
    await acceptInvitation(con, code)
    await expect(acceptInvitation(con, code)).rejects.toThrow(/already used/)
    const acc = await myAccess(con); expect(acc).toHaveLength(1); expect(acc[0].permissions).toEqual(['production.field.view'])
    const rows = await fetchPortal(con, PORTAL_VIEWS[0], 'T1'); expect(rows.map(r => r.field_no)).toEqual(['F-01'])
    const [g] = await listGrants(farmer, 'T1'); await revokeGrant(farmer, g.id)
    expect(await myAccess(con)).toHaveLength(0)
  })
  it('classifies invitation state', () => {
    const base = { id: 'i', invitee_email: 'a@b.co', purpose: 'contractor' as const, permissions: [], expires_at: '2099-01-01', accepted_at: null, revoked_at: null, access_days: null, created_at: '' }
    expect(invitationState(base)).toBe('pending')
    expect(invitationState({ ...base, expires_at: '2000-01-01' })).toBe('expired')
    expect(invitationState({ ...base, accepted_at: 'x' })).toBe('accepted')
    expect(invitationState({ ...base, accepted_at: 'x', revoked_at: 'y' })).toBe('revoked')
  })
})
