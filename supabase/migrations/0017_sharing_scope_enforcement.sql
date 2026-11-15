-- 0017: Enforce tenant, farm and season scope for shared portal access.
-- Existing three-argument has_share is retained but no longer executable
-- by authenticated users. Portal views use the new four-argument helper.

-- A season must always be attached to a farm.
alter table public.access_invitations
  add constraint access_invitations_season_requires_farm
  check (season_id is null or farm_id is not null) not valid;

alter table public.access_grants
  add constraint access_grants_season_requires_farm
  check (season_id is null or farm_id is not null) not valid;

alter table public.access_invitations
  validate constraint access_invitations_season_requires_farm;

alter table public.access_grants
  validate constraint access_grants_season_requires_farm;

-- Replace the old six-argument RPC. The first six parameters retain their
-- original order and defaults, so existing positional callers remain valid.
drop function if exists public.create_invitation(uuid,text,text,text[],integer,integer);

create function public.create_invitation(
  p_tenant uuid,
  p_email text,
  p_purpose text,
  p_permissions text[],
  p_access_days integer default null,
  p_valid_days integer default 14,
  p_farm uuid default null,
  p_season uuid default null
)
returns table(invitation_id uuid, token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := encode(gen_random_bytes(24), 'hex');
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not public.has_perm(p_tenant, 'settings.access.manage') then
    raise exception 'permission denied: settings.access.manage'
      using errcode = 'insufficient_privilege';
  end if;

  if p_email is null or p_email !~ '^\S+@\S+\.\S+$' then
    raise exception 'enter a valid email address';
  end if;

  if p_purpose not in ('contractor','extension','other') then
    raise exception 'invalid purpose';
  end if;

  if p_season is not null and p_farm is null then
    raise exception 'a season-specific invitation must belong to a farm';
  end if;

  if p_farm is not null and not exists (
    select 1
    from public.farms f
    where f.id = p_farm
      and f.tenant_id = p_tenant
  ) then
    raise exception 'selected farm does not belong to this business';
  end if;

  if p_season is not null and not exists (
    select 1
    from public.seasons s
    where s.id = p_season
      and s.tenant_id = p_tenant
      and s.farm_id = p_farm
  ) then
    raise exception 'selected season does not belong to the selected farm';
  end if;

  insert into public.access_invitations(
    tenant_id, invitee_email, purpose, permissions,
    farm_id, season_id, token_hash, expires_at, access_days, created_by
  )
  values (
    p_tenant, lower(trim(p_email)), p_purpose, p_permissions,
    p_farm, p_season,
    encode(digest(v_token, 'sha256'), 'hex'),
    now() + make_interval(days => greatest(1, least(coalesce(p_valid_days,14), 60))),
    p_access_days,
    auth.uid()
  )
  returning id into v_id;

  return query select v_id, v_token;
end
$$;

revoke all on function public.create_invitation(uuid,text,text,text[],integer,integer,uuid,uuid)
  from public, anon;
grant execute on function public.create_invitation(uuid,text,text,text[],integer,integer,uuid,uuid)
  to authenticated;

-- Include season_id in the invitee's access summary.
drop function if exists public.my_access();

create function public.my_access()
returns table(
  grant_id uuid,
  tenant_id uuid,
  tenant_name text,
  farm_id uuid,
  farm_name text,
  season_id uuid,
  purpose text,
  permissions text[],
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    g.id,
    g.tenant_id,
    t.name,
    g.farm_id,
    (
      select f.name
      from public.farms f
      where f.tenant_id = g.tenant_id
        and (g.farm_id is null or f.id = g.farm_id)
        and f.deleted_at is null
      order by f.created_at
      limit 1
    ),
    g.season_id,
    g.purpose,
    g.permissions,
    g.expires_at
  from public.access_grants g
  join public.tenants t on t.id = g.tenant_id
  where g.grantee_user = auth.uid()
    and g.revoked_at is null
    and (g.expires_at is null or g.expires_at > now())
  order by t.name
$$;

revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;

-- Exact scope matching:
-- tenant grant:       farm_id NULL, season_id NULL
-- farm grant:         exact farm, season_id NULL
-- season grant:       exact farm and exact season
-- A season grant cannot see farm-level records without a season context.
create or replace function public.has_share(
  p_tenant uuid,
  p_perm text,
  p_farm uuid,
  p_season uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.access_grants g
    where g.tenant_id = p_tenant
      and g.grantee_user = auth.uid()
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > now())
      and p_perm = any(g.permissions)
      and (
        (g.farm_id is null and g.season_id is null)
        or
        (g.farm_id = p_farm and g.season_id is null and p_farm is not null)
        or
        (g.farm_id = p_farm and g.season_id = p_season
          and p_farm is not null and p_season is not null)
      )
  );
$$;

revoke all on function public.has_share(uuid,text,uuid,uuid) from public, anon;
grant execute on function public.has_share(uuid,text,uuid,uuid) to authenticated;

-- Disable direct use of the old helper. The updated portal views below use
-- only the four-argument scope-aware helper.
revoke all on function public.has_share(uuid,text,uuid) from public, anon, authenticated;

-- Portal views retain their existing column lists and read-only triggers.
create or replace view public.portal_fields with (security_invoker = false) as
  select id, tenant_id, farm_id, field_no, area_ha, latitude, longitude, soil_type,
         previous_crop, current_crop, variety, irrigated, tenure
  from public.fields
  where deleted_at is null
    and public.has_share(tenant_id, 'production.field.view', farm_id, null::uuid);

create or replace view public.portal_seedbeds with (security_invoker = false) as
  select id, tenant_id, farm_id, season_id, code, location, variety, seed_lot,
         bed_count, area_m2, prepared_on, sown_on, expected_seedlings, actual_seedlings, status
  from public.seedbeds
  where deleted_at is null
    and public.has_share(tenant_id, 'production.seedbed.view', farm_id, season_id);

create or replace view public.portal_operations with (security_invoker = false) as
  select id, tenant_id, farm_id, season_id, target_type, seedbed_id, field_id, op_type,
         phase, occurred_on, area_ha, labour_workers, labour_hours, machinery_asset,
         machinery_hours, operator, weather, remarks
  from public.operations
  where deleted_at is null
    and public.has_share(tenant_id, 'production.operation.view', farm_id, season_id);

create or replace view public.portal_operation_inputs with (security_invoker = false) as
  select oi.id, oi.tenant_id, oi.operation_id, i.name as input_name,
         i.category as input_category, i.unit, oi.qty, oi.rate_note
  from public.operation_inputs oi
  join public.operations o
    on o.id = oi.operation_id
   and o.tenant_id = oi.tenant_id
   and o.deleted_at is null
  join public.inputs i
    on i.id = oi.input_id
   and i.tenant_id = oi.tenant_id
  where oi.deleted_at is null
    and public.has_share(oi.tenant_id, 'production.operation.view', o.farm_id, o.season_id);

create or replace view public.portal_weather with (security_invoker = false) as
  select id, tenant_id, farm_id, season_id, field_id, recorded_on, rainfall_mm,
         temp_min_c, temp_max_c, wind_kmh, event, observation
  from public.weather_records
  where deleted_at is null
    and public.has_share(tenant_id, 'production.weather.view', farm_id, season_id);

create or replace view public.portal_transplants with (security_invoker = false) as
  select id, tenant_id, farm_id, season_id, seedbed_id, field_id, kind, occurred_on,
         qty, mortality, spacing_row_m, spacing_plant_m, weather, soil_condition, remarks
  from public.transplants
  where deleted_at is null
    and public.has_share(tenant_id, 'production.transplant.view', farm_id, season_id);

create or replace view public.portal_harvests with (security_invoker = false) as
  select id, tenant_id, farm_id, season_id, field_id, code, variety, harvested_on,
         priming, leaf_position, green_weight_kg, bundles, barn_destination, status
  from public.harvest_batches
  where deleted_at is null
    and public.has_share(tenant_id, 'production.harvest.view', farm_id, season_id);

create or replace view public.portal_barns with (security_invoker = false) as
  select id, tenant_id, farm_id, code, location, capacity_kg, barn_type, condition,
         furnace, fuel_type, active
  from public.barns
  where deleted_at is null
    and public.has_share(tenant_id, 'curing.barn.view', farm_id, null::uuid);

create or replace view public.portal_cycles with (security_invoker = false) as
  select id, tenant_id, farm_id, season_id, barn_id, code, status, loaded_at,
         green_weight_kg, slates, operator, offloaded_at, cured_weight_kg, condition, losses_note
  from public.curing_cycles
  where deleted_at is null
    and public.has_share(tenant_id, 'curing.cycle.view', farm_id, season_id);

create or replace view public.portal_curing_logs with (security_invoker = false) as
  select l.id, l.tenant_id, l.cycle_id, l.logged_at, l.temperature_c, l.ventilation,
         l.fuel_added_kg, l.operator, l.remarks
  from public.curing_logs l
  join public.curing_cycles c
    on c.id = l.cycle_id
   and c.tenant_id = l.tenant_id
  where l.deleted_at is null
    and public.has_share(l.tenant_id, 'curing.cycle.view', c.farm_id, c.season_id);

create or replace view public.portal_storage with (security_invoker = false) as
  select id, tenant_id, farm_id, season_id, cycle_id, code, kind, weight_kg, location,
         created_on, expected_open_on, status, opened_on
  from public.storage_units
  where deleted_at is null
    and public.has_share(tenant_id, 'curing.storage.view', farm_id, season_id);

create or replace view public.portal_grading with (security_invoker = false) as
  select id, tenant_id, farm_id, season_id, code, storage_unit_id, graded_on,
         input_kg, waste_kg, variance_kg, grader
  from public.grading_lots
  where deleted_at is null
    and public.has_share(tenant_id, 'quality.grading.view', farm_id, season_id);

create or replace view public.portal_grading_outputs with (security_invoker = false) as
  select o.id, o.tenant_id, o.lot_id, g.code as grade, o.weight_kg
  from public.grading_outputs o
  join public.grading_lots l
    on l.id = o.lot_id
   and l.tenant_id = o.tenant_id
  join public.grades g
    on g.id = o.grade_id
   and g.tenant_id = o.tenant_id
  where o.deleted_at is null
    and public.has_share(o.tenant_id, 'quality.grading.view', l.farm_id, l.season_id);

create or replace view public.portal_bales with (security_invoker = false) as
  select b.id, b.tenant_id, b.farm_id, b.season_id, b.code, g.code as grade,
         b.weight_kg, b.baled_on, b.field_id, b.variety, b.status
  from public.bales b
  join public.grades g
    on g.id = b.grade_id
   and g.tenant_id = b.tenant_id
  where b.deleted_at is null
    and public.has_share(b.tenant_id, 'quality.bale.view', b.farm_id, b.season_id);

create or replace view public.portal_costs with (security_invoker = false) as
  select id, tenant_id, farm_id, season_id, category, amount, occurred_on, field_id,
         seedbed_id, cycle_id, note
  from public.cost_entries
  where deleted_at is null
    and public.has_share(tenant_id, 'finance.cost.view', farm_id, season_id);

create or replace view public.portal_sales with (security_invoker = false) as
  select s.id, s.tenant_id, s.farm_id, s.season_id, s.code, s.sold_on, s.channel,
         s.buyer, s.contract_id,
         coalesce((
           select sum(l.weight_kg)
           from public.sale_lines l
           where l.sale_id = s.id and l.deleted_at is null
         ),0) as weight_kg,
         coalesce((
           select sum(l.gross)
           from public.sale_lines l
           where l.sale_id = s.id and l.deleted_at is null
         ),0) as gross,
         coalesce((
           select sum(d.amount)
           from public.sale_deductions d
           where d.sale_id = s.id and d.deleted_at is null
         ),0) as deductions
  from public.sales s
  where s.deleted_at is null
    and public.has_share(s.tenant_id, 'marketing.sale.view', s.farm_id, s.season_id);

create or replace view public.portal_contracts with (security_invoker = false) as
  select k.id, k.tenant_id, k.farm_id, k.season_id, k.code, k.contract_no,
         c.name as contractor, k.status, k.variety, k.area_ha, k.target_kg,
         k.signed_on, k.delivery_deadline
  from public.contracts k
  join public.contractors c
    on c.id = k.contractor_id
   and c.tenant_id = k.tenant_id
  where k.deleted_at is null
    and public.has_share(k.tenant_id, 'contracts.contract.view', k.farm_id, k.season_id);

-- Keep SELECT-only access and explicitly retain the read-only trigger on every view.
do $$
declare
  v text;
begin
  foreach v in array array[
    'portal_fields','portal_seedbeds','portal_operations','portal_operation_inputs',
    'portal_weather','portal_transplants','portal_harvests','portal_barns',
    'portal_cycles','portal_curing_logs','portal_storage','portal_grading',
    'portal_grading_outputs','portal_bales','portal_costs','portal_sales',
    'portal_contracts'
  ] loop
    execute format('revoke all on public.%I from public, anon, authenticated', v);
    execute format('grant select on public.%I to authenticated', v);
  end loop;
end
$$;