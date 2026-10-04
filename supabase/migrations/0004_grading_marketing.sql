-- Migration 0004: grading, bales, marketing (sales, deductions, payments).
-- Same rules as before: tenant_id everywhere, composite FKs, RLS via has_perm, soft delete + version, audit.

-- Shared default permissions now include the Phase 3 keys.
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
      'quality.grade.edit','quality.grading.view','quality.grading.record','quality.bale.view','quality.bale.record','marketing.sale.view','marketing.sale.record',
      'resources.inventory.view','resources.inventory.manage','finance.cost.view']
    when 'Store Clerk' then array['settings.farm.view','resources.inventory.view','resources.inventory.manage']
    when 'Field Recorder' then array[
      'settings.farm.view','production.field.view','production.seedbed.view','production.operation.view','production.operation.record',
      'production.weather.view','production.weather.record','production.transplant.view','production.transplant.record',
      'production.harvest.view','production.harvest.record','curing.barn.view','curing.cycle.view','curing.cycle.record','curing.storage.view','quality.grading.view','quality.bale.view',
      'resources.inventory.view']
    else array[]::text[] end
$$;

-- Existing tenants: grant the new permissions once to their built-in roles (additive).
insert into public.role_permissions(tenant_id, role_id, permission)
select r.tenant_id, r.id, p
from public.roles r, lateral unnest(public.default_role_permissions(r.name)) p
where r.is_system and p like any (array['quality.%','marketing.%'])
on conflict do nothing;

create table public.grades (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, code text not null, name text, sort_order integer not null default 0,
  active boolean not null default true, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), unique (tenant_id, farm_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);

create table public.grading_lots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, code text not null, storage_unit_id uuid not null, graded_on date not null,
  input_kg numeric(12,2) not null check (input_kg > 0), waste_kg numeric(12,2) not null default 0 check (waste_kg >= 0), variance_kg numeric(12,2) not null default 0,
  variance_note text, grader text, labour_cost numeric(14,2) not null default 0, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), unique (tenant_id, farm_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, storage_unit_id) references public.storage_units(tenant_id, id)
);
create unique index one_grading_per_unit on public.grading_lots(storage_unit_id) where deleted_at is null;

create table public.grading_outputs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, lot_id uuid not null, grade_id uuid not null, weight_kg numeric(12,2) not null check (weight_kg > 0), grader text, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, lot_id) references public.grading_lots(tenant_id, id),
  foreign key (tenant_id, grade_id) references public.grades(tenant_id, id)
);

create table public.bales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, code text not null, output_id uuid not null, grade_id uuid not null,
  weight_kg numeric(12,2) not null check (weight_kg > 0), baled_on date not null, field_id uuid, variety text,
  status text not null default 'baled' check (status in ('baled','sold')), notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), unique (tenant_id, farm_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, output_id) references public.grading_outputs(tenant_id, id),
  foreign key (tenant_id, grade_id) references public.grades(tenant_id, id),
  foreign key (tenant_id, field_id) references public.fields(tenant_id, id)
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, code text not null, sale_ref text, sold_on date not null,
  channel text not null default 'auction' check (channel in ('auction','contract','private')), buyer text, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), unique (tenant_id, farm_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id)
);

create table public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, sale_id uuid not null, bale_id uuid not null,
  weight_kg numeric(12,2) not null check (weight_kg > 0), price_per_kg numeric(14,4) not null check (price_per_kg >= 0), gross numeric(14,2) not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, sale_id) references public.sales(tenant_id, id),
  foreign key (tenant_id, bale_id) references public.bales(tenant_id, id)
);
create unique index one_sale_line_per_bale on public.sale_lines(bale_id) where deleted_at is null;

create table public.sale_deductions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, sale_id uuid not null, label text not null, amount numeric(14,2) not null check (amount >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, sale_id) references public.sales(tenant_id, id)
);

create table public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, sale_id uuid not null, paid_on date not null, amount numeric(14,2) not null check (amount > 0), method text, reference text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, sale_id) references public.sales(tenant_id, id)
);

-- Bales of one graded output can never weigh more than that output.
create or replace function public.tg_bale_limit() returns trigger language plpgsql as $$
declare cap numeric; used numeric;
begin
  if new.deleted_at is not null then return new; end if;
  select weight_kg into cap from grading_outputs where id = new.output_id and tenant_id = new.tenant_id and deleted_at is null;
  if cap is null then raise exception 'graded output not found' using errcode = 'check_violation'; end if;
  select coalesce(sum(weight_kg),0) into used from bales where output_id = new.output_id and deleted_at is null and id <> new.id;
  if used + new.weight_kg > cap + 0.001 then
    raise exception 'baled weight % exceeds graded weight %', used + new.weight_kg, cap using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger bale_limit before insert or update of weight_kg, output_id, deleted_at on public.bales for each row execute function public.tg_bale_limit();

-- A sold bale must belong to the same tenant's sale of the same season; deductions cannot exceed gross.
create or replace function public.tg_sale_deduction_limit() returns trigger language plpgsql as $$
declare g numeric; d numeric;
begin
  if new.deleted_at is not null then return new; end if;
  select coalesce(sum(gross),0) into g from sale_lines where sale_id = new.sale_id and deleted_at is null;
  select coalesce(sum(amount),0) into d from sale_deductions where sale_id = new.sale_id and deleted_at is null and id <> new.id;
  if g > 0 and d + new.amount > g + 0.005 then raise exception 'deductions exceed gross value' using errcode = 'check_violation'; end if;
  return new;
end $$;
create trigger sale_deduction_limit before insert or update of amount, deleted_at on public.sale_deductions for each row execute function public.tg_sale_deduction_limit();

do $$
declare t record;
begin
  for t in select * from (values
    ('grades','quality.grading.view','quality.grade.edit'),
    ('grading_lots','quality.grading.view','quality.grading.record'),
    ('grading_outputs','quality.grading.view','quality.grading.record'),
    ('bales','quality.bale.view','quality.bale.record'),
    ('sales','marketing.sale.view','marketing.sale.record'),
    ('sale_lines','marketing.sale.view','marketing.sale.record'),
    ('sale_deductions','marketing.sale.view','marketing.sale.record'),
    ('sale_payments','marketing.sale.view','marketing.sale.record')
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
