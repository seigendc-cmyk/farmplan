-- farmPLAN Tobacco — Zimbabwe
-- Migration 0001: multi-tenant foundation, RBAC, access grants, sync plumbing
-- Principles: tenant_id on every row, composite FKs prevent cross-tenant references,
-- RLS enforces boundaries at the database layer, soft-delete + versioning for sync.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'farm' check (kind in ('farm','contractor','extension')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

-- Menu-driven permissions: one row per (role, permission key), e.g. 'production.field.create'
create table public.role_permissions (
  tenant_id   uuid not null,
  role_id     uuid not null,
  permission  text not null,
  primary key (role_id, permission),
  foreign key (tenant_id, role_id) references public.roles(tenant_id, id) on delete cascade
);

create table public.tenant_members (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role_id     uuid not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, user_id),
  foreign key (tenant_id, role_id) references public.roles(tenant_id, id)
);

-- Invite-based access for contractors and extension officers.
-- The farm tenant chooses exactly which permission keys are shared, optionally scoped to a farm/season.
create table public.access_invitations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  invitee_email text not null,
  purpose       text not null check (purpose in ('contractor','extension','other')),
  permissions   text[] not null,
  farm_id       uuid,
  season_id     uuid,
  token_hash    text not null,
  expires_at    timestamptz not null default (now() + interval '14 days'),
  accepted_by   uuid references auth.users(id),
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

create table public.access_grants (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  grantee_user  uuid not null references auth.users(id) on delete cascade,
  purpose       text not null check (purpose in ('contractor','extension','other')),
  permissions   text[] not null,
  farm_id       uuid,
  season_id     uuid,
  invitation_id uuid references public.access_invitations(id),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (tenant_id, grantee_user, purpose)
);

-- ---------------------------------------------------------------------------
-- Authorization helpers (security definer, stable, search_path pinned)
-- ---------------------------------------------------------------------------
create or replace function public.has_perm(p_tenant uuid, p_perm text, p_farm uuid default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from tenant_members m
    join role_permissions rp on rp.role_id = m.role_id
    where m.tenant_id = p_tenant and m.user_id = auth.uid() and m.active
      and (rp.permission = p_perm or rp.permission = '*')
  )
  or exists (
    select 1 from access_grants g
    where g.tenant_id = p_tenant and g.grantee_user = auth.uid()
      and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
      and p_perm = any (g.permissions)
      and (g.farm_id is null or p_farm is null or g.farm_id = p_farm)
  );
$$;

create or replace function public.is_member(p_tenant uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tenant_members where tenant_id = p_tenant and user_id = auth.uid() and active);
$$;

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create or replace function public.tg_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.version := coalesce(old.version, 0) + 1;
  return new;
end $$;

create or replace function public.tg_lock_tenant() returns trigger language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id is immutable';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Farm structure: farm > season ; farm > block > field
-- ---------------------------------------------------------------------------
create table public.farms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  location text,
  total_area_ha numeric(12,3),
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id)
);

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  farm_id uuid not null,
  enterprise text not null default 'tobacco',   -- tobacco is the first enterprise module, not a limit
  label text not null,                           -- e.g. 2026/27
  starts_on date not null,
  ends_on date not null,
  status text not null default 'planned' check (status in ('planned','active','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  check (ends_on > starts_on),
  unique (tenant_id, id),
  unique (tenant_id, farm_id, enterprise, label),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);

create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  farm_id uuid not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, farm_id, name),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);

create table public.fields (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  farm_id uuid not null,
  block_id uuid,
  field_no text not null,
  area_ha numeric(12,3) not null check (area_ha > 0),
  latitude numeric(9,6),
  longitude numeric(9,6),
  soil_type text,
  soil_notes text,
  previous_crop text,
  current_crop text,
  variety text,
  irrigated boolean not null default false,
  tenure text not null default 'owned' check (tenure in ('owned','leased','communal','other')),
  tenure_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, farm_id, field_no),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, block_id) references public.blocks(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Inputs, inventory ledger
-- ---------------------------------------------------------------------------
create table public.inputs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  category text not null check (category in ('seed','fertilizer','chemical','fuel','packaging','other')),
  unit text not null,                       -- kg, L, bag, ...
  supplier text,
  default_unit_cost numeric(14,4) not null default 0,
  application_notes text,                   -- from product label / approved protocols; never prescribed by the app
  safety_notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  farm_id uuid not null,
  input_id uuid not null,
  kind text not null check (kind in ('purchase','consumption','adjustment','return')),
  qty_delta numeric(14,4) not null,         -- + stock in, - stock out
  unit_cost numeric(14,4) not null default 0,
  batch_ref text,
  expiry_date date,
  occurred_on date not null,
  source_type text,                          -- 'operation' when produced by an operation
  source_id uuid,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, input_id) references public.inputs(tenant_id, id),
  check ((kind in ('purchase','return') and qty_delta > 0) or (kind = 'consumption' and qty_delta < 0) or kind = 'adjustment')
);
create index on public.inventory_transactions (tenant_id, farm_id, input_id) where deleted_at is null;

create view public.input_stock with (security_invoker = true) as
  select tenant_id, farm_id, input_id, sum(qty_delta) as on_hand,
         case when sum(qty_delta) filter (where qty_delta > 0) > 0
              then sum(qty_delta * unit_cost) filter (where qty_delta > 0) / sum(qty_delta) filter (where qty_delta > 0)
              else 0 end as avg_cost
  from public.inventory_transactions where deleted_at is null
  group by tenant_id, farm_id, input_id;

create or replace function public.tg_no_negative_stock() returns trigger language plpgsql as $$
declare bal numeric;
begin
  select coalesce(sum(qty_delta),0) into bal from inventory_transactions
   where tenant_id = new.tenant_id and farm_id = new.farm_id and input_id = new.input_id
     and deleted_at is null and id <> new.id;
  if new.deleted_at is null and bal + new.qty_delta < 0 then
    raise exception 'Insufficient stock: balance % would become %', bal, bal + new.qty_delta
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger no_negative_stock before insert or update on public.inventory_transactions
  for each row execute function public.tg_no_negative_stock();

-- ---------------------------------------------------------------------------
-- Seedbeds
-- ---------------------------------------------------------------------------
create table public.seedbeds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  farm_id uuid not null,
  season_id uuid not null,
  code text not null,                        -- SB-001
  location text,
  variety text,
  seed_lot text,
  seed_supplier text,
  bed_length_m numeric(10,2),
  bed_width_m numeric(10,2),
  bed_count integer not null default 1 check (bed_count > 0),
  area_m2 numeric(12,2),
  prepared_on date,
  sown_on date,
  expected_seedlings integer check (expected_seedlings >= 0),
  actual_seedlings integer check (actual_seedlings >= 0),
  status text not null default 'prepared' check (status in ('prepared','sown','germinating','growing','hardening','ready','depleted','abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, season_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Operations diary (seedbeds and fields share one transactional diary)
-- ---------------------------------------------------------------------------
create table public.operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  farm_id uuid not null,
  season_id uuid not null,
  target_type text not null check (target_type in ('seedbed','field')),
  seedbed_id uuid,
  field_id uuid,
  op_type text not null,                     -- configurable in app: sowing, fertilizer, ploughing, ...
  phase text not null default 'field' check (phase in ('seedbed','land_prep','field')),
  occurred_on date not null,
  area_ha numeric(12,4),
  labour_workers integer,
  labour_hours numeric(10,2),
  labour_cost numeric(14,2) not null default 0,
  machinery_asset text,
  machinery_hours numeric(10,2),
  machinery_fuel_l numeric(10,2),
  machinery_cost numeric(14,2) not null default 0,
  operator text,
  weather text,
  remarks text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, seedbed_id) references public.seedbeds(tenant_id, id),
  foreign key (tenant_id, field_id) references public.fields(tenant_id, id),
  check ((target_type = 'seedbed' and seedbed_id is not null and field_id is null)
      or (target_type = 'field' and field_id is not null and seedbed_id is null))
);
create index on public.operations (tenant_id, season_id, occurred_on) where deleted_at is null;

-- Inputs used by an operation. Creates inventory consumption + cost in the app/sync layer.
create table public.operation_inputs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  operation_id uuid not null,
  input_id uuid not null,
  qty numeric(14,4) not null check (qty > 0),
  rate_note text,
  unit_cost numeric(14,4) not null default 0,
  inventory_txn_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, operation_id) references public.operations(tenant_id, id),
  foreign key (tenant_id, input_id) references public.inputs(tenant_id, id),
  foreign key (tenant_id, inventory_txn_id) references public.inventory_transactions(tenant_id, id)
);

-- Cost ledger: every cost is derived from an event. Hidden from roles without finance.cost.view.
create table public.cost_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  farm_id uuid not null,
  season_id uuid not null,
  category text not null check (category in
    ('seed','fertilizer','chemicals','labour','machinery','fuel','irrigation','transport','curing','storage','grading','baling','marketing','overhead')),
  amount numeric(14,2) not null,
  occurred_on date not null,
  seedbed_id uuid,
  field_id uuid,
  source_type text not null,                 -- 'operation_input','operation_labour','operation_machinery','manual'
  source_id uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, seedbed_id) references public.seedbeds(tenant_id, id),
  foreign key (tenant_id, field_id) references public.fields(tenant_id, id)
);

create table public.weather_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  farm_id uuid not null,
  season_id uuid,
  field_id uuid,
  recorded_on date not null,
  rainfall_mm numeric(8,2) check (rainfall_mm >= 0),
  temp_min_c numeric(5,2),
  temp_max_c numeric(5,2),
  wind_kmh numeric(6,2),
  event text check (event in ('hail','frost','drought','none')),
  observation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, field_id) references public.fields(tenant_id, id)
);

-- Audit trail
create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  table_name text not null,
  row_id uuid,
  action text not null,
  actor uuid default auth.uid(),
  at timestamptz not null default now(),
  diff jsonb
);

create or replace function public.tg_audit() returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  r := coalesce(new, old);
  insert into audit_log(tenant_id, table_name, row_id, action, diff)
  values (r.tenant_id, tg_table_name, r.id, tg_op,
          case when tg_op = 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
               when tg_op = 'INSERT' then to_jsonb(new) else to_jsonb(old) end);
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------------
-- Attach triggers + RLS to every business table
-- ---------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in select * from (values
    ('farms','settings.farm.view','settings.farm.manage'),
    ('seasons','settings.season.view','settings.season.manage'),
    ('blocks','production.field.view','production.field.edit'),
    ('fields','production.field.view','production.field.edit'),
    ('seedbeds','production.seedbed.view','production.seedbed.edit'),
    ('operations','production.operation.view','production.operation.record'),
    ('operation_inputs','production.operation.view','production.operation.record'),
    ('weather_records','production.weather.view','production.weather.record'),
    ('inputs','resources.inventory.view','resources.inventory.manage'),
    ('inventory_transactions','resources.inventory.view','resources.inventory.manage'),
    ('cost_entries','finance.cost.view','finance.cost.edit')
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

-- Foundation tables
alter table public.tenants enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.tenant_members enable row level security;
alter table public.access_invitations enable row level security;
alter table public.access_grants enable row level security;
alter table public.audit_log enable row level security;

create policy sel on public.tenants for select using (public.is_member(id));
create policy sel on public.roles for select using (public.is_member(tenant_id));
create policy sel on public.role_permissions for select using (public.is_member(tenant_id));
create policy sel on public.tenant_members for select using (public.is_member(tenant_id));
create policy mut on public.roles for all using (public.has_perm(tenant_id,'settings.roles.manage')) with check (public.has_perm(tenant_id,'settings.roles.manage'));
create policy mut on public.role_permissions for all using (public.has_perm(tenant_id,'settings.roles.manage')) with check (public.has_perm(tenant_id,'settings.roles.manage'));
create policy mut on public.tenant_members for all using (public.has_perm(tenant_id,'settings.users.manage')) with check (public.has_perm(tenant_id,'settings.users.manage'));
create policy sel on public.access_invitations for select using (public.has_perm(tenant_id,'settings.access.manage'));
create policy mut on public.access_invitations for all using (public.has_perm(tenant_id,'settings.access.manage')) with check (public.has_perm(tenant_id,'settings.access.manage'));
create policy sel on public.access_grants for select using (public.has_perm(tenant_id,'settings.access.manage') or grantee_user = auth.uid());
create policy mut on public.access_grants for all using (public.has_perm(tenant_id,'settings.access.manage')) with check (public.has_perm(tenant_id,'settings.access.manage'));
create policy sel on public.audit_log for select using (public.has_perm(tenant_id,'settings.audit.view'));

-- ---------------------------------------------------------------------------
-- Onboarding: create a farm tenant with the system roles. Caller becomes Owner.
-- ---------------------------------------------------------------------------
create or replace function public.create_farm_tenant(p_name text, p_farm_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_owner uuid; v_manager uuid; v_clerk uuid; v_field uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  insert into tenants(name, kind) values (p_name, 'farm') returning id into v_tenant;

  insert into roles(tenant_id, name, is_system) values (v_tenant,'Owner',true) returning id into v_owner;
  insert into roles(tenant_id, name, is_system) values (v_tenant,'Farm Manager',true) returning id into v_manager;
  insert into roles(tenant_id, name, is_system) values (v_tenant,'Store Clerk',true) returning id into v_clerk;
  insert into roles(tenant_id, name, is_system) values (v_tenant,'Field Recorder',true) returning id into v_field;

  insert into role_permissions(tenant_id, role_id, permission) values (v_tenant, v_owner, '*');

  insert into role_permissions(tenant_id, role_id, permission)
  select v_tenant, v_manager, p from unnest(array[
    'settings.farm.view','settings.season.view','settings.season.manage',
    'production.field.view','production.field.edit','production.seedbed.view','production.seedbed.edit',
    'production.operation.view','production.operation.record','production.weather.view','production.weather.record',
    'resources.inventory.view','resources.inventory.manage','finance.cost.view']) p;

  insert into role_permissions(tenant_id, role_id, permission)
  select v_tenant, v_clerk, p from unnest(array['settings.farm.view','resources.inventory.view','resources.inventory.manage']) p;

  insert into role_permissions(tenant_id, role_id, permission)
  select v_tenant, v_field, p from unnest(array[
    'settings.farm.view','production.field.view','production.seedbed.view',
    'production.operation.view','production.operation.record','production.weather.view','production.weather.record',
    'resources.inventory.view']) p;

  insert into tenant_members(tenant_id, user_id, role_id) values (v_tenant, auth.uid(), v_owner);
  insert into farms(tenant_id, name) values (v_tenant, p_farm_name);
  return v_tenant;
end $$;
revoke all on function public.create_farm_tenant(text,text) from public, anon;
grant execute on function public.create_farm_tenant(text,text) to authenticated;

-- Accepting an invitation converts it into a scoped grant (token is compared by hash).
create or replace function public.accept_invitation(p_invitation uuid, p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv access_invitations; g uuid;
begin
  select * into inv from access_invitations where id = p_invitation for update;
  if not found or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at < now()
     or inv.token_hash <> encode(digest(p_token, 'sha256'), 'hex') then
    raise exception 'invalid or expired invitation';
  end if;
  insert into access_grants(tenant_id, grantee_user, purpose, permissions, farm_id, season_id, invitation_id)
  values (inv.tenant_id, auth.uid(), inv.purpose, inv.permissions, inv.farm_id, inv.season_id, inv.id)
  on conflict (tenant_id, grantee_user, purpose)
  do update set permissions = excluded.permissions, farm_id = excluded.farm_id, season_id = excluded.season_id, revoked_at = null
  returning id into g;
  update access_invitations set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  return g;
end $$;
revoke all on function public.accept_invitation(uuid,text) from public, anon;
grant execute on function public.accept_invitation(uuid,text) to authenticated;
