import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync } from 'node:fs'
import assert from 'node:assert'

const db = new PGlite({ extensions: { pgcrypto } })
await db.exec(`
  create schema auth;
  create table auth.users(id uuid primary key);
  create role authenticated; create role anon;
  create or replace function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''), '{}')::jsonb $$;
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
`)
await db.exec(readFileSync('supabase/migrations/0001_foundation.sql','utf8'))
console.log('migration applied')

const A='00000000-0000-0000-0000-00000000000a', B='00000000-0000-0000-0000-00000000000b', C='00000000-0000-0000-0000-00000000000c'
await db.exec(`insert into auth.users values ('${A}'),('${B}'),('${C}')`)
const as = (u)=>db.exec(`select set_config('request.jwt.claim.sub','${u}',false)`)

await as(A); const ta=(await db.query(`select create_farm_tenant('A Farms','Farm A') id`)).rows[0].id
await as(B); const tb=(await db.query(`select create_farm_tenant('B Farms','Farm B') id`)).rows[0].id
console.log('tenants created')

// RLS tests run as non-superuser
await db.exec(`grant usage on schema public, auth to authenticated; grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
await db.exec(`set role authenticated`)

await as(A)
const farmsA=(await db.query(`select * from farms`)).rows
assert.equal(farmsA.length,1); assert.equal(farmsA[0].tenant_id,ta)
await as(B)
assert.equal((await db.query(`select * from farms`)).rows[0].tenant_id,tb)

// B cannot insert into A's tenant
await assert.rejects(()=>db.query(`insert into inputs(tenant_id,name,category,unit) values ('${ta}','x','fertilizer','kg')`))

// stock: purchase then over-consume rejected
await as(A)
const farm=(await db.query(`select id from farms`)).rows[0].id
const inp=(await db.query(`insert into inputs(tenant_id,name,category,unit) values ('${ta}','Compound D','fertilizer','kg') returning id`)).rows[0].id
await db.query(`insert into inventory_transactions(tenant_id,farm_id,input_id,kind,qty_delta,unit_cost,occurred_on) values ('${ta}','${farm}','${inp}','purchase',500,1.2,'2026-10-01')`)
await assert.rejects(()=>db.query(`insert into inventory_transactions(tenant_id,farm_id,input_id,kind,qty_delta,occurred_on) values ('${ta}','${farm}','${inp}','consumption',-501,'2026-10-02')`), /Insufficient stock/)
await db.query(`insert into inventory_transactions(tenant_id,farm_id,input_id,kind,qty_delta,occurred_on) values ('${ta}','${farm}','${inp}','consumption',-100,'2026-10-02')`)
const st=(await db.query(`select on_hand from input_stock`)).rows[0]; assert.equal(Number(st.on_hand),400)

// cross-tenant FK: B cannot reference A's input in B's tenant
await as(B)
const fb=(await db.query(`select id from farms`)).rows[0].id
await assert.rejects(()=>db.query(`insert into inventory_transactions(tenant_id,farm_id,input_id,kind,qty_delta,occurred_on) values ('${tb}','${fb}','${inp}','purchase',5,'2026-10-02')`))

// extension officer grant: sees fields, not costs
await db.exec(`reset role`)
await db.exec(`insert into access_grants(tenant_id,grantee_user,purpose,permissions) values ('${ta}','${C}','extension',array['production.field.view','production.operation.view'])`)
await db.exec(`set role authenticated`); await as(C)
assert.equal((await db.query(`select * from cost_entries`)).rows.length,0)
assert.equal((await db.query(`select * from inputs`)).rows.length,0)
await assert.rejects(()=>db.query(`insert into fields(tenant_id,farm_id,field_no,area_ha) values ('${ta}','${farm}','F1',2)`))
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0002_claim_tenant.sql','utf8'))
await db.exec(`set role authenticated`); await as(C)
const T='11111111-1111-1111-1111-111111111111'
assert.equal((await db.query(`select claim_tenant('${T}','Local Farms') id`)).rows[0].id, T)
assert.equal((await db.query(`select claim_tenant('${T}','Local Farms') id`)).rows[0].id, T) // idempotent for owner
await as(A); await assert.rejects(()=>db.query(`select claim_tenant('${T}','Hijack')`), /already claimed/)
await as(C)
const fid='22222222-2222-2222-2222-222222222222'
await db.query(`insert into farms(id,tenant_id,name) values ('${fid}','${T}','Local Farm')`)
assert.equal((await db.query(`select * from farms where tenant_id='${T}'`)).rows.length,1)

// ---- 0003: curing chain ----
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0003_curing_chain.sql','utf8'))
// backfill gave tenant A's Farm Manager the new permissions; Owner unaffected
const fm = (await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${ta}' and r.name='Farm Manager' and rp.permission='curing.cycle.close'`)).rows[0].n
assert.equal(fm,1)
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
await db.exec(`set role authenticated`); await as(A)
const seas=(await db.query(`insert into seasons(tenant_id,farm_id,label,starts_on,ends_on) values ('${ta}','${farm}','2026/27','2026-09-01','2027-08-31') returning id`)).rows[0].id
const fld=(await db.query(`insert into fields(tenant_id,farm_id,field_no,area_ha) values ('${ta}','${farm}','F-04',5) returning id`)).rows[0].id
const sb=(await db.query(`insert into seedbeds(tenant_id,farm_id,season_id,code,actual_seedlings) values ('${ta}','${farm}','${seas}','SB-001',1000) returning id`)).rows[0].id
await db.query(`insert into transplants(tenant_id,farm_id,season_id,seedbed_id,field_id,occurred_on,qty) values ('${ta}','${farm}','${seas}','${sb}','${fld}','2026-11-10',600)`)
await assert.rejects(()=>db.query(`insert into transplants(tenant_id,farm_id,season_id,seedbed_id,field_id,occurred_on,qty) values ('${ta}','${farm}','${seas}','${sb}','${fld}','2026-11-11',401)`), /exceeds the 1000 produced/)
const barn=(await db.query(`insert into barns(tenant_id,farm_id,code,capacity_kg) values ('${ta}','${farm}','B-01',6000) returning id`)).rows[0].id
const cyc=(await db.query(`insert into curing_cycles(tenant_id,farm_id,season_id,barn_id,code) values ('${ta}','${farm}','${seas}','${barn}','C-00001') returning id`)).rows[0].id
await assert.rejects(()=>db.query(`insert into curing_cycles(tenant_id,farm_id,season_id,barn_id,code) values ('${ta}','${farm}','${seas}','${barn}','C-00002')`), /one_open_cycle_per_barn/)
await db.query(`update curing_cycles set status='curing', green_weight_kg=4860 where id='${cyc}'`)
await assert.rejects(()=>db.query(`update curing_cycles set cured_weight_kg=5000 where id='${cyc}'`), /check/)
await assert.rejects(()=>db.query(`insert into storage_units(tenant_id,farm_id,season_id,cycle_id,code,kind,weight_kg,created_on,maturity_start,expected_open_on) values ('${ta}','${farm}','${seas}','${cyc}','SP-00001','slate_pack',100,'2027-02-01','2027-02-01','2027-05-01')`), /not completed/)
await db.query(`update curing_cycles set status='completed', cured_weight_kg=1580 where id='${cyc}'`)
await db.query(`insert into storage_units(tenant_id,farm_id,season_id,cycle_id,code,kind,weight_kg,created_on,maturity_start,expected_open_on) values ('${ta}','${farm}','${seas}','${cyc}','SP-00001','slate_pack',320,'2027-02-01','2027-02-01','2027-05-01')`)
await assert.rejects(()=>db.query(`insert into storage_units(tenant_id,farm_id,season_id,cycle_id,code,kind,weight_kg,created_on,maturity_start,expected_open_on) values ('${ta}','${farm}','${seas}','${cyc}','P-00001','pile',1261,'2027-02-01','2027-02-01','2027-05-01')`), /exceeds cured/)
await assert.rejects(()=>db.query(`update curing_cycles set status='curing' where id='${cyc}'`), /cycle is completed/)
// tenant B cannot see or reference A's curing data
await as(B)
assert.equal((await db.query(`select * from curing_cycles`)).rows.length,0)
await assert.rejects(()=>db.query(`insert into curing_logs(tenant_id,cycle_id,logged_at) values ('${tb}','${cyc}','2027-01-22T12:00')`))
// field recorder (member of A with Field Recorder role) can log readings but not close cycles
await db.exec(`reset role`)
const fr=(await db.query(`select id from roles where tenant_id='${ta}' and name='Field Recorder'`)).rows[0].id
const D='00000000-0000-0000-0000-00000000000d'
await db.exec(`insert into auth.users values ('${D}'); insert into tenant_members(tenant_id,user_id,role_id) values ('${ta}','${D}','${fr}')`)
const cyc2=(await db.query(`insert into curing_cycles(tenant_id,farm_id,season_id,barn_id,code,status,green_weight_kg) values ('${ta}','${farm}','${seas}','${barn}','C-00003','curing',100) returning id`)).rows[0].id
await db.exec(`set role authenticated`); await as(D)
await db.query(`insert into curing_logs(tenant_id,cycle_id,logged_at,temperature_c) values ('${ta}','${cyc2}','2027-01-22T12:00',41)`)
// Field Recorder lacks curing.cycle.create → RLS filters the row: nothing updated
const upd=await db.query(`update curing_cycles set status='completed', cured_weight_kg=50 where id='${cyc2}' returning id`)
assert.equal(upd.rows.length,0)
await db.exec(`reset role`)
assert.equal((await db.query(`select status from curing_cycles where id='${cyc2}'`)).rows[0].status,'curing')
// a role with create but WITHOUT close reaches the trigger, which refuses completion
const E='00000000-0000-0000-0000-00000000000e'
const nc=(await db.query(`insert into roles(tenant_id,name,is_system) values ('${ta}','Cycle Starter',false) returning id`)).rows[0].id
await db.exec(`insert into role_permissions(tenant_id,role_id,permission) values ('${ta}','${nc}','curing.cycle.view'),('${ta}','${nc}','curing.cycle.create'); insert into auth.users values ('${E}'); insert into tenant_members(tenant_id,user_id,role_id) values ('${ta}','${E}','${nc}')`)
await db.exec(`set role authenticated`); await as(E)
await assert.rejects(()=>db.query(`update curing_cycles set status='completed', cured_weight_kg=50 where id='${cyc2}'`), /curing.cycle.close/)
// new tenants get the shared defaults
await db.exec(`reset role`)
await as(C); await db.exec(`set role authenticated`)
const nt=(await db.query(`select create_farm_tenant('C Farms','Farm C') id`)).rows[0].id
await db.exec(`reset role`)
assert.equal((await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${nt}' and r.name='Field Recorder'`)).rows[0].n, 16)

// ---- 0004: grading, bales, marketing ----
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0004_grading_marketing.sql','utf8'))
const q4=(u,sql)=>db.query(sql)
assert.equal((await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${ta}' and r.name='Field Recorder' and (rp.permission like 'quality.%' or rp.permission like 'marketing.%')`)).rows[0].n, 2)
assert.equal((await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${ta}' and r.name='Farm Manager' and (rp.permission like 'quality.%' or rp.permission like 'marketing.%')`)).rows[0].n, 7)
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
await db.exec(`set role authenticated`); await as(A)
const gA=(await db.query(`insert into grades(tenant_id,farm_id,code,sort_order) values ('${ta}','${farm}','A',1) returning id`)).rows[0].id
const gB=(await db.query(`insert into grades(tenant_id,farm_id,code,sort_order) values ('${ta}','${farm}','B',2) returning id`)).rows[0].id
await assert.rejects(()=>db.query(`insert into grades(tenant_id,farm_id,code) values ('${ta}','${farm}','A')`), /duplicate/)
const su=(await db.query(`select id from storage_units where code='SP-00001'`)).rows[0].id
const lot=(await db.query(`insert into grading_lots(tenant_id,farm_id,season_id,code,storage_unit_id,graded_on,input_kg) values ('${ta}','${farm}','${seas}','G-00001','${su}','2027-03-06',320) returning id`)).rows[0].id
await assert.rejects(()=>db.query(`insert into grading_lots(tenant_id,farm_id,season_id,code,storage_unit_id,graded_on,input_kg) values ('${ta}','${farm}','${seas}','G-00002','${su}','2027-03-06',320)`), /one_grading_per_unit/)
const outA=(await db.query(`insert into grading_outputs(tenant_id,lot_id,grade_id,weight_kg) values ('${ta}','${lot}','${gA}',200) returning id`)).rows[0].id
await db.query(`insert into bales(tenant_id,farm_id,season_id,code,output_id,grade_id,weight_kg,baled_on,field_id) values ('${ta}','${farm}','${seas}','TB26-F04-B000001','${outA}','${gA}',100,'2027-03-08','${fld}')`)
const bale2=(await db.query(`insert into bales(tenant_id,farm_id,season_id,code,output_id,grade_id,weight_kg,baled_on) values ('${ta}','${farm}','${seas}','TB26-F04-B000002','${outA}','${gA}',100,'2027-03-08') returning id`)).rows[0].id
await assert.rejects(()=>db.query(`insert into bales(tenant_id,farm_id,season_id,code,output_id,grade_id,weight_kg,baled_on) values ('${ta}','${farm}','${seas}','TB26-F04-B000003','${outA}','${gA}',1,'2027-03-08')`), /exceeds graded weight/)
// sale: one active line per bale, deductions capped at gross
const sale=(await db.query(`insert into sales(tenant_id,farm_id,season_id,code,sold_on) values ('${ta}','${farm}','${seas}','ML-00001','2027-03-10') returning id`)).rows[0].id
await db.query(`insert into sale_lines(tenant_id,sale_id,bale_id,weight_kg,price_per_kg,gross) values ('${ta}','${sale}','${bale2}',100,4,400)`)
await assert.rejects(()=>db.query(`insert into sale_lines(tenant_id,sale_id,bale_id,weight_kg,price_per_kg,gross) values ('${ta}','${sale}','${bale2}',100,4,400)`), /one_sale_line_per_bale/)
await db.query(`insert into sale_deductions(tenant_id,sale_id,label,amount) values ('${ta}','${sale}','Levy',20)`)
await assert.rejects(()=>db.query(`insert into sale_deductions(tenant_id,sale_id,label,amount) values ('${ta}','${sale}','Huge',9999)`), /deductions exceed/)
await db.query(`insert into sale_payments(tenant_id,sale_id,paid_on,amount) values ('${ta}','${sale}','2027-03-12',380)`)
const outB=(await db.query(`insert into grading_outputs(tenant_id,lot_id,grade_id,weight_kg) values ('${ta}','${lot}','${gB}',50) returning id`)).rows[0].id
// tenant B sees and references nothing of A's
await as(B)
for (const t of ['grades','grading_lots','grading_outputs','bales','sales','sale_lines','sale_payments']) assert.equal((await db.query(`select * from ${t}`)).rows.length,0, t)
await assert.rejects(()=>db.query(`insert into sale_lines(tenant_id,sale_id,bale_id,weight_kg,price_per_kg,gross) values ('${tb}','${sale}','${bale2}',1,1,1)`))
// field recorder: can view grading + bales, cannot grade, bale or see revenue
await as(D)
assert.equal((await db.query(`select * from bales`)).rows.length,2)
assert.equal((await db.query(`select * from sales`)).rows.length,0)
await assert.rejects(()=>db.query(`insert into grades(tenant_id,farm_id,code) values ('${ta}','${farm}','Z')`), /row-level security/)
await assert.rejects(()=>db.query(`insert into bales(tenant_id,farm_id,season_id,code,output_id,grade_id,weight_kg,baled_on) values ('${ta}','${farm}','${seas}','X','${outB}','${gB}',1,'2027-03-08')`), /row-level security/)
// new tenants pick up the Phase 3 defaults
await db.exec(`reset role`); await as(C); await db.exec(`set role authenticated`)
const nt2=(await db.query(`select create_farm_tenant('D Farms','Farm D') id`)).rows[0].id
await db.exec(`reset role`)
assert.equal((await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${nt2}' and r.name='Field Recorder'`)).rows[0].n, 18)

// ---- 0005: contract programmes ----
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0005_contracts.sql','utf8'))
assert.equal((await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${ta}' and r.name='Farm Manager' and rp.permission like 'contracts.%'`)).rows[0].n, 2)
assert.equal((await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${ta}' and r.name='Field Recorder' and rp.permission like 'contracts.%'`)).rows[0].n, 0)
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
const fmRole=(await db.query(`select id from roles where tenant_id='${ta}' and name='Farm Manager'`)).rows[0].id
const M='00000000-0000-0000-0000-0000000000f1'
await db.exec(`insert into auth.users values ('${M}'); insert into tenant_members(tenant_id,user_id,role_id) values ('${ta}','${M}','${fmRole}')`)
await db.exec(`set role authenticated`); await as(A)
const ctr=(await db.query(`insert into contractors(tenant_id,farm_id,name) values ('${ta}','${farm}','Acme Leaf') returning id`)).rows[0].id
const ct=(await db.query(`insert into contracts(tenant_id,farm_id,season_id,code,contractor_id,status,target_kg) values ('${ta}','${farm}','${seas}','CT-00001','${ctr}','active',400) returning id`)).rows[0].id
await db.query(`insert into contract_fields(tenant_id,contract_id,field_id) values ('${ta}','${ct}','${fld}')`)
await assert.rejects(()=>db.query(`insert into contract_fields(tenant_id,contract_id,field_id) values ('${ta}','${ct}','${fld}')`), /one_field_per_contract/)
await db.query(`insert into contract_advances(tenant_id,contract_id,kind,description,value,advanced_on) values ('${ta}','${ct}','cash','Float',200,'2026-11-05')`)
await db.query(`insert into contract_obligations(tenant_id,contract_id,kind,description,due_on) values ('${ta}','${ct}','production','Transplant','2026-11-30')`)
await db.query(`update sales set contract_id='${ct}' where id='${sale}'`)
// settlement arithmetic is enforced in the row itself
await assert.rejects(()=>db.query(`insert into contract_settlements(tenant_id,contract_id,settled_on,delivered_kg,delivered_gross,advances_total,advances_recovered,net_payable) values ('${ta}','${ct}','2027-03-01',100,400,200,250,0)`), /check/)
// farm manager can edit contracts but cannot settle them (trigger) nor write settlements (RLS)
await as(M)
await db.query(`update contracts set target_kg=450 where id='${ct}'`)
await assert.rejects(()=>db.query(`update contracts set status='settled' where id='${ct}'`), /contracts.contract.settle/)
await assert.rejects(()=>db.query(`insert into contract_settlements(tenant_id,contract_id,settled_on,delivered_kg,delivered_gross,advances_total,advances_recovered,net_payable) values ('${ta}','${ct}','2027-03-01',100,400,200,200,200)`), /row-level security/)
await as(A)
await db.query(`insert into contract_settlements(tenant_id,contract_id,settled_on,delivered_kg,delivered_gross,advances_total,advances_recovered,net_payable,shortfall) values ('${ta}','${ct}','2027-03-01',100,400,200,200,200,0)`)
await db.query(`update contracts set status='settled' where id='${ct}'`)
await assert.rejects(()=>db.query(`insert into contract_settlements(tenant_id,contract_id,settled_on,delivered_kg,delivered_gross,advances_total,advances_recovered,net_payable) values ('${ta}','${ct}','2027-03-02',100,400,200,200,200)`), /one_settlement_per_contract/)
// field recorder and tenant B see nothing; B cannot reference A's contract from a sale
await as(D); assert.equal((await db.query(`select * from contracts`)).rows.length,0)
await as(B)
for (const t of ['contractors','contracts','contract_fields','contract_advances','contract_obligations','contract_settlements']) assert.equal((await db.query(`select * from ${t}`)).rows.length,0,t)
await assert.rejects(()=>db.query(`insert into sales(tenant_id,farm_id,season_id,code,sold_on,contract_id) values ('${tb}','${farm}','${seas}','X','2027-03-01','${ct}')`))

// ---- 0006: sharing (contractor / extension officer) ----
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0006_sharing.sql','utf8'))
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
const X='00000000-0000-0000-0000-0000000000c1', E2='00000000-0000-0000-0000-0000000000e1'
await db.exec(`insert into auth.users values ('${X}'),('${E2}')`)
const claims=(u,email)=>db.exec(`select set_config('request.jwt.claim.sub','${u}',false); select set_config('request.jwt.claims','${JSON.stringify({sub:u,email})}',false)`)
await db.exec(`set role authenticated`); await claims(A,'owner@a.test')
// the farmer invites a contractor: view-only, production-side permissions
await assert.rejects(()=>db.query(`select * from create_invitation('${ta}','acme@x.test','contractor',array['production.field.edit'])`), /cannot be shared/)
await assert.rejects(()=>db.query(`select * from create_invitation('${ta}','acme@x.test','contractor',array['settings.users.manage'])`), /cannot be shared/)
await assert.rejects(()=>db.query(`select * from create_invitation('${ta}','acme@x.test','contractor',array[]::text[])`), /at least one/)
await assert.rejects(()=>db.query(`select * from create_invitation('${ta}','nope','contractor',array['production.field.view'])`), /valid email/)
const inv=(await db.query(`select * from create_invitation('${ta}','Acme@X.test','contractor',array['production.field.view','production.operation.view','curing.cycle.view'], 30)`)).rows[0]
assert.equal(inv.token.length, 48)
assert.notEqual((await db.query(`select token_hash from access_invitations where id='${inv.invitation_id}'`)).rows[0].token_hash, inv.token) // only the hash is stored
// direct writes cannot smuggle edit rights either
await assert.rejects(()=>db.query(`insert into access_invitations(tenant_id,invitee_email,purpose,permissions,token_hash) values ('${ta}','z@x.test','other',array['production.field.edit'],'h')`), /cannot be shared/)
// field recorder (no settings.access.manage) cannot invite
await claims(D,'rec@a.test'); await assert.rejects(()=>db.query(`select * from create_invitation('${ta}','a@b.test','extension',array['production.field.view'])`), /settings.access.manage/)
// before acceptance the contractor sees nothing
await claims(X,'acme@x.test')
assert.equal((await db.query(`select * from fields`)).rows.length,0); assert.equal((await db.query(`select * from my_access()`)).rows.length,0)
// wrong token / wrong email / right both
await assert.rejects(()=>db.query(`select accept_invitation('${inv.invitation_id}','bad')`), /invalid or expired/)
await claims(E2,'someone@else.test'); await assert.rejects(()=>db.query(`select accept_invitation('${inv.invitation_id}','${inv.token}')`), /different email/)
await claims(X,'acme@x.test'); await db.query(`select accept_invitation('${inv.invitation_id}','${inv.token}')`)
await assert.rejects(()=>db.query(`select accept_invitation('${inv.invitation_id}','${inv.token}')`), /invalid or expired/) // single use
const ma=(await db.query(`select * from my_access()`)).rows; assert.equal(ma.length,1); assert.equal(ma[0].tenant_name,'A Farms'); assert.equal(ma[0].purpose,'contractor'); assert.ok(ma[0].expires_at)
// the contractor reads exactly what was shared, through cost-free portal views…
assert.ok((await db.query(`select * from portal_fields`)).rows.length>=1)
assert.ok((await db.query(`select * from portal_cycles`)).rows.length>=1)
// …never the base tables (so cost columns are unreachable), and nothing outside the shared menus
for (const t of ['fields','operations','curing_cycles','cost_entries','sales','contracts','bales','harvest_batches','tenant_members','access_invitations']) assert.equal((await db.query(`select * from ${t}`)).rows.length,0,t)
await assert.rejects(()=>db.query(`select labour_cost from portal_operations`), /column .*labour_cost/)
await assert.rejects(()=>db.query(`select labour_cost from portal_cycles`), /column .*labour_cost/)
for (const v of ['portal_costs','portal_sales','portal_contracts','portal_bales','portal_harvests','portal_weather','portal_storage','portal_grading']) assert.equal((await db.query(`select * from ${v}`)).rows.length,0,v)
await assert.rejects(()=>db.query(`insert into fields(tenant_id,farm_id,field_no,area_ha) values ('${ta}','${farm}','HACK',1)`), /row-level security/)
assert.equal((await db.query(`update fields set area_ha=99`)).rows.length,0)
await assert.rejects(()=>db.query(`insert into portal_fields(tenant_id,farm_id,field_no,area_ha) values ('${ta}','${farm}','HACK',1)`), /read-only/)
await assert.rejects(()=>db.query(`update portal_fields set area_ha=99`), /read-only/)
await assert.rejects(()=>db.query(`delete from portal_fields`), /read-only/)
await assert.rejects(()=>db.query(`select * from create_invitation('${ta}','a@b.test','extension',array['production.field.view'])`), /settings.access.manage/)
await assert.rejects(()=>db.query(`select revoke_access('${ma[0].grant_id}')`), /settings.access.manage/)
// farmer revokes: access ends immediately
await claims(A,'owner@a.test'); await db.query(`select revoke_access('${ma[0].grant_id}')`)
await claims(X,'acme@x.test')
assert.equal((await db.query(`select * from portal_fields`)).rows.length,0); assert.equal((await db.query(`select * from my_access()`)).rows.length,0)
// extension officer with an explicitly shared financial view sees costs; expiry also ends access
await claims(A,'owner@a.test')
await db.query(`insert into cost_entries(tenant_id,farm_id,season_id,category,amount,occurred_on,source_type) values ('${ta}','${farm}','${seas}','labour',50,'2027-01-01','manual')`)
const inv2=(await db.query(`select * from create_invitation('${ta}','officer@gov.test','extension',array['production.field.view','finance.cost.view'])`)).rows[0]
await claims(E2,'officer@gov.test'); await db.query(`select accept_invitation('${inv2.invitation_id}','${inv2.token}')`)
assert.ok((await db.query(`select * from portal_fields`)).rows.length>=1)
assert.ok((await db.query(`select * from portal_costs`)).rows.length>=1)
assert.equal((await db.query(`select * from portal_operations`)).rows.length,0) // not shared to this officer
await db.exec(`reset role`); await db.exec(`update access_grants set expires_at = now() - interval '1 minute' where grantee_user='${E2}'`); await db.exec(`set role authenticated`); await claims(E2,'officer@gov.test')
assert.equal((await db.query(`select * from portal_fields`)).rows.length,0)

// ---- 0007: field devices, labour, enrolment ----
await db.exec(`reset role`)
await db.exec(`alter table auth.users add column email text; update auth.users set email='owner@a.test' where id='${A}'; update auth.users set email='rec@a.test' where id='${D}'; update auth.users set email='newhand@a.test' where id='${E2}'; update auth.users set email='owner@b.test' where id='${B}'`)
await db.exec(readFileSync('supabase/migrations/0007_field_devices.sql','utf8'))
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
await db.exec(`set role authenticated`); await claims(A,'owner@a.test')
assert.equal((await db.query(`select device_tag(1) a, device_tag(26) z, device_tag(27) aa, device_tag(52) az, device_tag(53) ba`)).rows[0].aa,'AA')
// existing tenants were backfilled with the labour permissions
await claims(D,'rec@a.test'); assert.equal((await db.query(`select * from my_farms()`)).rows[0].role_name,'Field Recorder')
// enrolment: owner adds an existing account as Field Recorder; recorders cannot; unknown email / role are refused
await assert.rejects(()=>db.query(`select add_member('${ta}','newhand@a.test','Field Recorder')`), /settings.users.manage/)
await claims(A,'owner@a.test')
await assert.rejects(()=>db.query(`select add_member('${ta}','ghost@a.test','Field Recorder')`), /No account exists/)
await assert.rejects(()=>db.query(`select add_member('${ta}','newhand@a.test','Wizard')`), /Unknown role/)
await db.query(`select add_member('${ta}','NewHand@a.test','Field Recorder')`)
const mem=(await db.query(`select * from list_members('${ta}')`)).rows; assert.ok(mem.some(m=>m.email==='newhand@a.test'&&m.role_name==='Field Recorder'))
await claims(D,'rec@a.test'); await assert.rejects(()=>db.query(`select * from list_members('${ta}')`), /settings.users.manage/)
// the new member sees only their farm, joins it, and gets a unique device tag (idempotent per label)
await claims(E2,'newhand@a.test')
const jf=(await db.query(`select * from my_farms()`)).rows; assert.equal(jf.length,1); assert.equal(jf[0].tenant_id,ta)
const t1=(await db.query(`select register_device('${ta}','Phone 1') t`)).rows[0].t
assert.equal((await db.query(`select register_device('${ta}','Phone 1') t`)).rows[0].t,t1)
const t2=(await db.query(`select register_device('${ta}','Phone 2') t`)).rows[0].t
assert.notEqual(t1,t2); assert.match(t1,/^[A-Z]+$/)
await claims(D,'rec@a.test'); const t3=(await db.query(`select register_device('${ta}','Phone 1') t`)).rows[0].t; assert.ok(![t1,t2].includes(t3))
await claims(B,'owner@b.test'); await assert.rejects(()=>db.query(`select register_device('${ta}','Intruder')`), /not a member/)
assert.equal((await db.query(`select * from devices`)).rows.length,0)
// labour: recorder can record and read; other tenant cannot; negative pay refused
await claims(E2,'newhand@a.test')
await db.query(`insert into labour_entries(tenant_id,farm_id,season_id,worked_on,worker_name,task,hours,pay_amount) values ('${ta}','${farm}','${seas}','2027-01-10','Tendai','Weeding',8,5)`)
assert.equal((await db.query(`select * from labour_entries`)).rows.length,1)
await assert.rejects(()=>db.query(`insert into labour_entries(tenant_id,farm_id,season_id,worked_on,worker_name,task,pay_amount) values ('${ta}','${farm}','${seas}','2027-01-10','X','Y',-1)`))
await claims(B,'owner@b.test'); assert.equal((await db.query(`select * from labour_entries`)).rows.length,0)
await assert.rejects(()=>db.query(`insert into labour_entries(tenant_id,farm_id,season_id,worked_on,worker_name,task) values ('${ta}','${farm}','${seas}','2027-01-10','X','Y')`), /row-level security/)
// deactivated members lose access at once
await claims(A,'owner@a.test'); await db.query(`select set_member_active('${ta}','${E2}',false)`)
await claims(E2,'newhand@a.test'); assert.equal((await db.query(`select * from labour_entries`)).rows.length,0); assert.equal((await db.query(`select * from my_farms()`)).rows.length,0)

// ---- 0008: budgets ----
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0008_budgets.sql','utf8'))
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
await db.exec(`set role authenticated`); await claims(A,'owner@a.test')
await db.query(`insert into budgets(tenant_id,farm_id,season_id,category,amount) values ('${ta}','${farm}','${seas}','fertilizer',1500)`)
await assert.rejects(()=>db.query(`insert into budgets(tenant_id,farm_id,season_id,category,amount) values ('${ta}','${farm}','${seas}','fertilizer',10)`), /duplicate|unique/)
await assert.rejects(()=>db.query(`insert into budgets(tenant_id,farm_id,season_id,category,amount) values ('${ta}','${farm}','${seas}','labour',-5)`))
await claims(D,'rec@a.test'); assert.equal((await db.query(`select * from budgets`)).rows.length,0) // Field Recorder: no budget access
await assert.rejects(()=>db.query(`insert into budgets(tenant_id,farm_id,season_id,category,amount) values ('${ta}','${farm}','${seas}','labour',5)`), /row-level security/)
await claims(B,'owner@b.test'); assert.equal((await db.query(`select * from budgets`)).rows.length,0)

// ---- 0009: machinery ----
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0009_machinery.sql','utf8'))
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
await db.exec(`set role authenticated`); await claims(A,'owner@a.test')
const mach=(await db.query(`insert into machines(tenant_id,farm_id,name,kind,hourly_rate,service_interval_hours) values ('${ta}','${farm}','MF 275','tractor',12,250) returning id`)).rows[0].id
await db.query(`insert into machine_logs(tenant_id,farm_id,season_id,machine_id,kind,logged_on,hours,cost) values ('${ta}','${farm}','${seas}','${mach}','use','2027-01-05',6,72)`)
await assert.rejects(()=>db.query(`insert into machine_logs(tenant_id,farm_id,season_id,machine_id,kind,logged_on) values ('${ta}','${farm}','${seas}','${mach}','use','2027-01-05')`)) // use needs hours
await assert.rejects(()=>db.query(`insert into machine_logs(tenant_id,farm_id,season_id,machine_id,kind,logged_on,cost) values ('${ta}','${farm}','${seas}','${mach}','fuel','2027-01-05',-1)`))
// a Field Recorder (backfilled) can log use but not register machines; tenant B sees nothing
await claims(D,'rec@a.test')
assert.equal((await db.query(`select * from machines`)).rows.length,1)
await db.query(`insert into machine_logs(tenant_id,farm_id,season_id,machine_id,kind,logged_on,hours,fuel_l) values ('${ta}','${farm}','${seas}','${mach}','fuel','2027-01-06',null,40)`)
await assert.rejects(()=>db.query(`insert into machines(tenant_id,farm_id,name) values ('${ta}','${farm}','Rogue')`), /row-level security/)
await claims(B,'owner@b.test'); assert.equal((await db.query(`select * from machines`)).rows.length,0); assert.equal((await db.query(`select * from machine_logs`)).rows.length,0)

// ---- 0010: allocation rules ----
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0010_allocation.sql','utf8'))
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
await db.exec(`set role authenticated`); await claims(A,'owner@a.test')
await db.query(`insert into allocation_rules(tenant_id,farm_id,category,basis) values ('${ta}','${farm}','curing','green_kg')`)
await assert.rejects(()=>db.query(`insert into allocation_rules(tenant_id,farm_id,category,basis) values ('${ta}','${farm}','curing','area')`), /duplicate|unique/)
await assert.rejects(()=>db.query(`insert into allocation_rules(tenant_id,farm_id,category,basis) values ('${ta}','${farm}','grading','weight')`))
await claims(D,'rec@a.test'); assert.equal((await db.query(`select * from allocation_rules`)).rows.length,0)
await claims(B,'owner@b.test'); assert.equal((await db.query(`select * from allocation_rules`)).rows.length,0)

// ---- 0011: buyers ----
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0011_buyers.sql','utf8'))
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
await db.exec(`set role authenticated`); await claims(A,'owner@a.test')
const buyer=(await db.query(`insert into buyers(tenant_id,farm_id,name,kind,payment_terms_days,credit_limit) values ('${ta}','${farm}','Boka','auction_floor',7,500) returning id`)).rows[0].id
await assert.rejects(()=>db.query(`insert into buyers(tenant_id,farm_id,name) values ('${ta}','${farm}','BOKA')`), /duplicate|unique/)   // names unique ignoring case
await assert.rejects(()=>db.query(`insert into buyers(tenant_id,farm_id,name,kind) values ('${ta}','${farm}','X','alien')`))
await assert.rejects(()=>db.query(`insert into buyers(tenant_id,farm_id,name,credit_limit) values ('${ta}','${farm}','Y',-1)`))
await db.query(`insert into buyer_deductions(tenant_id,buyer_id,label,kind,value) values ('${ta}','${buyer}','Levy','percent',2.5)`)
await assert.rejects(()=>db.query(`insert into buyer_deductions(tenant_id,buyer_id,label,kind,value) values ('${ta}','${buyer}','Bad','percent',150)`))
await db.query(`update sales set buyer_id='${buyer}' where id='${sale}'`)
await assert.rejects(()=>db.query(`update sales set buyer_id='00000000-0000-4000-8000-0000000000aa' where id='${sale}'`), /foreign key/)   // must be a real buyer of the same tenant
// Farm Manager (backfilled) can manage buyers; Field Recorder cannot even read them; tenant B sees nothing
await claims(M,'fm@a.test'); assert.equal((await db.query(`select * from buyers`)).rows.length,1); await db.query(`update buyers set phone='+263 77 000' where id='${buyer}'`)
await claims(D,'rec@a.test'); assert.equal((await db.query(`select * from buyers`)).rows.length,0); assert.equal((await db.query(`select * from buyer_deductions`)).rows.length,0)
await assert.rejects(()=>db.query(`insert into buyers(tenant_id,farm_id,name) values ('${ta}','${farm}','Rogue')`), /row-level security/)
await claims(B,'owner@b.test'); assert.equal((await db.query(`select * from buyers`)).rows.length,0)
await assert.rejects(()=>db.query(`insert into sales(tenant_id,farm_id,season_id,code,sold_on,buyer_id) values ('${tb}','${farm}','${seas}','Z','2027-03-01','${buyer}')`))   // cannot point at another tenant's buyer

// ---- 0012: activity log ----
await db.exec(`reset role`)
await db.exec(readFileSync('supabase/migrations/0012_activity_log.sql','utf8'))
await db.exec(`grant all on all tables in schema public to authenticated; grant execute on all functions in schema public to authenticated;`)
await db.exec(`set role authenticated`); await claims(A,'owner@a.test')
const ev=(who,dom,sum,t=ta)=>db.query(`insert into activity_log(tenant_id,farm_id,occurred_at,kind,verb,domain,summary,actor_name) values ('${t}','${farm}','2027-01-20T08:00:00Z','action','x.create','${dom}','${sum}','${who}') returning id,recorded_by`)
const e1=(await ev('Lovemore','ops','Recorded harvest')).rows[0]; assert.equal(e1.recorded_by, A)       // stamped with the uploading account
await ev('Lovemore','finance','Recorded sale'); await ev('Lovemore','admin','Created user')
assert.equal((await db.query(`select * from activity_log`)).rows.length,3)                              // Owner sees every domain
// no update/delete policy exists, so RLS makes these touch zero rows; the trigger is the backstop for the table owner
await db.query(`update activity_log set summary='edited' where id='${e1.id}'`); await db.query(`delete from activity_log where id='${e1.id}'`)
assert.equal((await db.query(`select summary from activity_log where id='${e1.id}'`)).rows[0].summary,'Recorded harvest')
await db.exec(`reset role`); await assert.rejects(()=>db.query(`update activity_log set summary='edited' where id='${e1.id}'`), /append-only/); await assert.rejects(()=>db.query(`delete from activity_log where id='${e1.id}'`), /append-only/)
await db.exec(`set role authenticated`); await claims(A,'owner@a.test')
await assert.rejects(()=>db.query(`insert into activity_log(tenant_id,farm_id,occurred_at,kind,verb,domain,summary) values ('${ta}','${farm}',now(),'action','x','secret','s')`))   // unknown domain
await claims(M,'fm@a.test'); assert.deepEqual((await db.query(`select domain from activity_log order by domain`)).rows.map(r=>r.domain), ['finance','ops'])   // Farm Manager: management level, no admin
await claims(D,'rec@a.test'); assert.equal((await db.query(`select * from activity_log`)).rows.length,0)   // Field Recorder: own-only is a device rule, nothing readable from the cloud
await db.query(`insert into activity_log(tenant_id,farm_id,occurred_at,kind,verb,domain,summary) values ('${ta}','${farm}',now(),'note','note.add','ops','Recorded rain')`)   // no RETURNING: it would need select rights                                                                 // but may append events for what they record
await claims(B,'owner@b.test'); assert.equal((await db.query(`select * from activity_log`)).rows.length,0)
await assert.rejects(()=>ev('Mallory','ops','Forged into another farm',ta), /row-level security/)         // cannot append to a farm they are not in
await db.exec(`reset role`)
assert.equal((await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${ta}' and r.name='Field Recorder' and rp.permission like 'brain.%'`)).rows[0].n, 2)
assert.equal((await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${ta}' and r.name='Farm Manager' and rp.permission like 'brain.%'`)).rows[0].n, 4)

// ---- 0013: brain chat permissions ----
await db.exec(readFileSync('supabase/migrations/0013_brain_chat_perms.sql','utf8'))
const bp=async n=>(await db.query(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id where r.tenant_id='${ta}' and r.name='${n}' and rp.permission like 'brain.chat.%'`)).rows[0].n
assert.equal(await bp('Farm Manager'),1); assert.equal(await bp('Field Recorder'),0)      // managers may ask the brain; sending questions to Claude is an explicit grant

// ---- 0014: reorder level ----
await db.exec(`reset role`)
const grantsBefore=(await db.query(`select count(*)::int n from role_permissions`)).rows[0].n
await db.exec(readFileSync('supabase/migrations/0014_reorder_level.sql','utf8'))
assert.equal((await db.query(`select count(*)::int n from role_permissions`)).rows[0].n, grantsBefore)   // nothing re-granted
await db.exec(`set role authenticated`); await as(A)
await db.query(`update inputs set reorder_level=100 where id='${inp}'`)
assert.equal(Number((await db.query(`select reorder_level from inputs where id='${inp}'`)).rows[0].reorder_level),100)
await assert.rejects(()=>db.query(`update inputs set reorder_level=-1 where id='${inp}'`), /inputs_reorder_level_nonneg/)
await as(D); assert.equal((await db.query(`update inputs set reorder_level=5 where id='${inp}' returning id`)).rows.length,0)   // Field Recorder can view stock, not manage it
await as(B); assert.equal((await db.query(`update inputs set reorder_level=5 where id='${inp}' returning id`)).rows.length,0)   // another tenant cannot touch it
await db.exec(`reset role`); assert.equal(Number((await db.query(`select reorder_level from inputs where id='${inp}'`)).rows[0].reorder_level),100)

// ---- 0015: machine fuel from inventory; labour and machine logs linked to operations ----
const grants15=(await db.query(`select count(*)::int n from role_permissions`)).rows[0].n
await db.exec(readFileSync('supabase/migrations/0015_fuel_and_links.sql','utf8'))
assert.equal((await db.query(`select count(*)::int n from role_permissions`)).rows[0].n, grants15)   // nothing re-granted
await db.exec(`set role authenticated`); await as(A)
const diesel=(await db.query(`insert into inputs(tenant_id,name,category,unit) values ('${ta}','Diesel','fuel','L') returning id`)).rows[0].id
await db.query(`insert into inventory_transactions(tenant_id,farm_id,input_id,kind,qty_delta,unit_cost,occurred_on) values ('${ta}','${farm}','${diesel}','purchase',100,1.5,'2027-01-01')`)
const tractor=(await db.query(`insert into machines(tenant_id,farm_id,name,fuel_input_id) values ('${ta}','${farm}','MF 375','${diesel}') returning id`)).rows[0].id
const op15=(await db.query(`insert into operations(tenant_id,farm_id,season_id,target_type,field_id,op_type,occurred_on) values ('${ta}','${farm}','${seas}','field','${fld}','Ploughing','2027-01-05') returning id`)).rows[0].id
const log15='00000000-0000-0000-0000-0000000000a1', txn15=(await db.query(`insert into inventory_transactions(tenant_id,farm_id,input_id,kind,qty_delta,unit_cost,occurred_on,source_type,source_id)
  values ('${ta}','${farm}','${diesel}','consumption',-20,1.5,'2027-01-05','machine_log','${log15}') returning id`)).rows[0].id
await db.query(`insert into machine_logs(id,tenant_id,farm_id,season_id,machine_id,field_id,kind,logged_on,hours,fuel_l,input_id,fuel_txn_id,operation_id)
  values ('${log15}','${ta}','${farm}','${seas}','${tractor}','${fld}','use','2027-01-05',3,20,'${diesel}','${txn15}','${op15}')`)
await assert.rejects(()=>db.query(`update machine_logs set fuel_l=25 where id='${log15}'`), /does not match its stock movement/)   // litres must equal the draw
await assert.rejects(()=>db.query(`insert into machine_logs(tenant_id,farm_id,season_id,machine_id,kind,logged_on,fuel_l,input_id,fuel_txn_id)
  values ('${ta}','${farm}','${seas}','${tractor}','fuel','2027-01-06',20,'${diesel}','${txn15}')`), /does not match its stock movement/)   // a draw belongs to one log only
await db.query(`insert into labour_entries(tenant_id,farm_id,season_id,worked_on,worker_name,task,operation_id) values ('${ta}','${farm}','${seas}','2027-01-05','Tendai','Ploughing','${op15}')`)
await as(B)
await assert.rejects(()=>db.query(`insert into machines(tenant_id,farm_id,name,fuel_input_id) values ('${tb}','${fb}','Stolen fuel','${diesel}')`))   // composite FK: another tenant's fuel
await assert.rejects(()=>db.query(`insert into labour_entries(tenant_id,farm_id,season_id,worked_on,worker_name,task,operation_id) values ('${tb}','${fb}','${seas}','2027-01-05','X','Y','${op15}')`))
assert.equal((await db.query(`select * from machine_logs`)).rows.length,0)   // RLS unchanged: B sees none of A's logs
await db.exec(`reset role`)
console.log('ALL MIGRATION TESTS PASSED')
