-- Migration 0003: transplanting, harvest batches, barns, curing cycles, starking.
-- Same rules as 0001: tenant_id everywhere, composite FKs, RLS, soft delete + version for sync, audit.

-- ---------------------------------------------------------------------------
-- Default permissions per built-in role, defined once and reused
-- ---------------------------------------------------------------------------
create or replace function public.default_role_permissions(p_role text)
returns text[] language sql immutable as $$
  select case p_role
    when 'Owner' then array['*']
    when 'Farm Manager' then array[
      'settings.farm.view','settings.season.view','settings.season.manage',
      'production.field.view','production.field.edit','production.seedbed.view','production.seedbed.edit',
      'production.operation.view','production.operation.record','production.weather.view','production.weather.record',
      'production.transplant.view','production.transplant.record','production.harvest.view','production.harvest.record',
      'curing.barn.view','curing.barn.edit','curing.cycle.view','curing.cycle.create','curing.cycle.record','curing.cycle.close',
      'curing.storage.view','curing.storage.edit',
      'resources.inventory.view','resources.inventory.manage','finance.cost.view']
    when 'Store Clerk' then array['settings.farm.view','resources.inventory.view','resources.inventory.manage']
    when 'Field Recorder' then array[
      'settings.farm.view','production.field.view','production.seedbed.view','production.operation.view','production.operation.record',
      'production.weather.view','production.weather.record','production.transplant.view','production.transplant.record',
      'production.harvest.view','production.harvest.record','curing.barn.view','curing.cycle.view','curing.cycle.record','curing.storage.view',
      'resources.inventory.view']
    else array[]::text[] end
$$;

-- Existing tenants: grant the new permissions once to their built-in roles (additive, never removes).
insert into public.role_permissions(tenant_id, role_id, permission)
select r.tenant_id, r.id, p
from public.roles r, lateral unnest(public.default_role_permissions(r.name)) p
where r.is_system and p like any (array['production.transplant.%','production.harvest.%','curing.%'])
on conflict do nothing;

-- New tenants (both onboarding paths) use the shared definition.
create or replace function public.seed_system_roles(p_tenant uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_role uuid; v_owner uuid; r text;
begin
  foreach r in array array['Owner','Farm Manager','Store Clerk','Field Recorder'] loop
    insert into roles(tenant_id, name, is_system) values (p_tenant, r, true) returning id into v_role;
    insert into role_permissions(tenant_id, role_id, permission) select p_tenant, v_role, p from unnest(public.default_role_permissions(r)) p;
    if r = 'Owner' then v_owner := v_role; end if;
  end loop;
  return v_owner;
end $$;
revoke all on function public.seed_system_roles(uuid) from public, anon, authenticated;

create or replace function public.claim_tenant(p_tenant uuid, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if exists (select 1 from tenants where id = p_tenant) then
    if public.is_member(p_tenant) then return p_tenant; end if;
    raise exception 'tenant already claimed';
  end if;
  insert into tenants(id, name, kind) values (p_tenant, p_name, 'farm');
  v_owner := public.seed_system_roles(p_tenant);
  insert into tenant_members(tenant_id, user_id, role_id) values (p_tenant, auth.uid(), v_owner);
  return p_tenant;
end $$;

create or replace function public.create_farm_tenant(p_name text, p_farm_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := gen_random_uuid(); v_owner uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  insert into tenants(id, name, kind) values (v_tenant, p_name, 'farm');
  v_owner := public.seed_system_roles(v_tenant);
  insert into tenant_members(tenant_id, user_id, role_id) values (v_tenant, auth.uid(), v_owner);
  insert into farms(tenant_id, name) values (v_tenant, p_farm_name);
  return v_tenant;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.transplants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, seedbed_id uuid not null, field_id uuid not null,
  kind text not null default 'transplant' check (kind in ('transplant','gap_fill')),
  occurred_on date not null,
  qty integer not null check (qty > 0),
  mortality integer not null default 0 check (mortality >= 0 and mortality <= qty),
  spacing_row_m numeric(6,2), spacing_plant_m numeric(6,2),
  labour_workers integer, labour_cost numeric(14,2) not null default 0,
  weather text, soil_condition text, remarks text, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, seedbed_id) references public.seedbeds(tenant_id, id),
  foreign key (tenant_id, field_id) references public.fields(tenant_id, id)
);
create index on public.transplants (tenant_id, seedbed_id) where deleted_at is null;

create table public.harvest_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, field_id uuid not null,
  code text not null, variety text, harvested_on date not null, priming integer, leaf_position text,
  labour_workers integer, labour_cost numeric(14,2) not null default 0,
  green_weight_kg numeric(12,2) not null check (green_weight_kg > 0), bundles integer,
  transport_cost numeric(14,2) not null default 0, barn_destination text,
  status text not null default 'harvested' check (status in ('harvested','loaded')),
  remarks text, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), unique (tenant_id, farm_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, field_id) references public.fields(tenant_id, id)
);

create table public.barns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, code text not null, location text,
  capacity_kg numeric(12,2) check (capacity_kg > 0), barn_type text, condition text, furnace text, flues text,
  ventilation text, sensors text, fuel_type text, notes text, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), unique (tenant_id, farm_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);

create table public.curing_cycles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, barn_id uuid not null, code text not null,
  status text not null default 'preparing' check (status in ('preparing','ready','curing','completed','aborted')),
  loaded_at text, green_weight_kg numeric(12,2), slates integer, labour_workers integer,
  labour_cost numeric(14,2) not null default 0, operator text, fuel_input_id uuid, fuel_opening_kg numeric(12,2),
  offloaded_at text, cured_weight_kg numeric(12,2), offload_labour_cost numeric(14,2) not null default 0,
  condition text, losses_note text, remarks text, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version integer not null default 1,
  check (cured_weight_kg is null or green_weight_kg is null or cured_weight_kg <= green_weight_kg),
  unique (tenant_id, id), unique (tenant_id, farm_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, barn_id) references public.barns(tenant_id, id),
  foreign key (tenant_id, fuel_input_id) references public.inputs(tenant_id, id)
);
-- one open cycle per barn, enforced by the database
create unique index one_open_cycle_per_barn on public.curing_cycles (barn_id)
  where deleted_at is null and status in ('preparing','ready','curing');

create table public.curing_cycle_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, cycle_id uuid not null, item text not null, done boolean not null default false,
  done_on text, done_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), unique (cycle_id, item),
  foreign key (tenant_id, cycle_id) references public.curing_cycles(tenant_id, id)
);

create table public.cycle_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, cycle_id uuid not null, batch_id uuid not null,
  green_weight_kg numeric(12,2) not null check (green_weight_kg > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, cycle_id) references public.curing_cycles(tenant_id, id),
  foreign key (tenant_id, batch_id) references public.harvest_batches(tenant_id, id)
);
-- a harvest batch can sit in only one live cycle
create unique index one_cycle_per_batch on public.cycle_batches (batch_id) where deleted_at is null;

create table public.curing_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, cycle_id uuid not null, logged_at text not null,
  temperature_c numeric(5,2) check (temperature_c between -10 and 120),
  ventilation text, fuel_added_kg numeric(12,2) check (fuel_added_kg >= 0), fuel_txn_id uuid, operator text, remarks text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, cycle_id) references public.curing_cycles(tenant_id, id),
  foreign key (tenant_id, fuel_txn_id) references public.inventory_transactions(tenant_id, id)
);
create index on public.curing_logs (tenant_id, cycle_id, logged_at) where deleted_at is null;

create table public.storage_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, cycle_id uuid not null,
  code text not null, kind text not null check (kind in ('slate_pack','pile')),
  weight_kg numeric(12,2) not null check (weight_kg > 0), location text, created_on date not null, condition text,
  maturity_start date not null, expected_open_on date not null,
  status text not null default 'maturing' check (status in ('maturing','opened')), opened_on date, remarks text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version integer not null default 1,
  check (expected_open_on >= maturity_start),
  unique (tenant_id, id), unique (tenant_id, farm_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, cycle_id) references public.curing_cycles(tenant_id, id)
);

-- cost entries can now belong to a curing cycle
alter table public.cost_entries add column cycle_id uuid;
alter table public.cost_entries add foreign key (tenant_id, cycle_id) references public.curing_cycles(tenant_id, id);
create index on public.cost_entries (tenant_id, cycle_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Cross-row invariants enforced in the database
-- ---------------------------------------------------------------------------
create or replace function public.tg_transplant_limit() returns trigger language plpgsql as $$
declare produced integer; used integer;
begin
  if new.deleted_at is not null then return new; end if;
  select actual_seedlings into produced from seedbeds where id = new.seedbed_id and tenant_id = new.tenant_id;
  if produced is null then raise exception 'seedbed has no recorded seedling output' using errcode = 'check_violation'; end if;
  select coalesce(sum(qty),0) into used from transplants where seedbed_id = new.seedbed_id and deleted_at is null and id <> new.id;
  if used + new.qty > produced then
    raise exception 'transplanting % seedlings exceeds the % produced by the seedbed', used + new.qty, produced using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger transplant_limit before insert or update of qty, seedbed_id, deleted_at on public.transplants
  for each row execute function public.tg_transplant_limit();

create or replace function public.tg_storage_limit() returns trigger language plpgsql as $$
declare cured numeric; used numeric;
begin
  if new.deleted_at is not null then return new; end if;
  select cured_weight_kg into cured from curing_cycles where id = new.cycle_id and tenant_id = new.tenant_id and status = 'completed';
  if cured is null then raise exception 'cycle is not completed' using errcode = 'check_violation'; end if;
  select coalesce(sum(weight_kg),0) into used from storage_units where cycle_id = new.cycle_id and deleted_at is null and id <> new.id;
  if used + new.weight_kg > cured + 0.001 then
    raise exception 'stored weight % exceeds cured weight %', used + new.weight_kg, cured using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger storage_limit before insert or update of weight_kg, cycle_id, deleted_at on public.storage_units
  for each row execute function public.tg_storage_limit();

-- ---------------------------------------------------------------------------
-- Triggers + RLS
-- ---------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in select * from (values
    ('transplants','production.transplant.view','production.transplant.record'),
    ('harvest_batches','production.harvest.view','production.harvest.record'),
    ('barns','curing.barn.view','curing.barn.edit'),
    ('curing_cycles','curing.cycle.view','curing.cycle.create'),
    ('curing_cycle_checks','curing.cycle.view','curing.cycle.create'),
    ('cycle_batches','curing.cycle.view','curing.cycle.create'),
    ('curing_logs','curing.cycle.view','curing.cycle.record'),
    ('storage_units','curing.storage.view','curing.storage.edit')
  ) as v(tbl, view_perm, write_perm)
  loop
    execute format('alter table public.%I enable row level security', t.tbl);
    execute format('create trigger touch before update on public.%I for each row execute function public.tg_touch()', t.tbl);
    execute format('create trigger lock_tenant before update on public.%I for each row execute function public.tg_lock_tenant()', t.tbl);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.tg_audit()', t.tbl);
    execute format('create policy sel on public.%I for select using (public.has_perm(tenant_id, %L))', t.tbl, t.view_perm);
    execute format('create policy ins on public.%I for insert with check (public.has_perm(tenant_id, %L))', t.tbl, t.write_perm);
    execute format('create policy upd on public.%I for update using (public.has_perm(tenant_id, %L)) with check (public.has_perm(tenant_id, %L))', t.tbl, t.write_perm, t.write_perm);
    execute format('create policy del on public.%I for delete using (public.has_perm(tenant_id, %L))', t.tbl, t.write_perm);
    execute format('create index on public.%I (tenant_id, updated_at)', t.tbl);
  end loop;
end $$;

-- Closing a cycle is a distinct permission from recording readings: only holders may move status to completed.
create or replace function public.tg_cycle_transitions() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'completed' and not public.has_perm(new.tenant_id, 'curing.cycle.close') then
      raise exception 'permission denied: curing.cycle.close' using errcode = 'insufficient_privilege';
    end if;
    if old.status in ('completed','aborted') then raise exception 'cycle is %', old.status using errcode = 'check_violation'; end if;
  end if;
  return new;
end $$;
create trigger cycle_transitions before update on public.curing_cycles for each row execute function public.tg_cycle_transitions();
