-- Migration 0009: machinery register and usage / fuel / service log.
-- Costs from machine logs are written on the device into cost_entries (category machinery or fuel); the cloud only stores the records.

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
      'contracts.contract.view','contracts.contract.edit',
      'quality.grade.edit','quality.grading.view','quality.grading.record','quality.bale.view','quality.bale.record','marketing.sale.view','marketing.sale.record',
      'resources.inventory.view','resources.inventory.manage','resources.labour.view','resources.labour.record','finance.cost.view','finance.budget.view','finance.budget.edit','resources.machinery.view','resources.machinery.record','resources.machinery.manage']
    when 'Store Clerk' then array['settings.farm.view','resources.inventory.view','resources.inventory.manage']
    when 'Field Recorder' then array[
      'settings.farm.view','production.field.view','production.seedbed.view','production.operation.view','production.operation.record',
      'production.weather.view','production.weather.record','production.transplant.view','production.transplant.record',
      'production.harvest.view','production.harvest.record','curing.barn.view','curing.cycle.view','curing.cycle.record','curing.storage.view','quality.grading.view','quality.bale.view',
      'resources.inventory.view','resources.labour.view','resources.labour.record','resources.machinery.view','resources.machinery.record']
    else array[]::text[] end
$$;

insert into public.role_permissions(tenant_id, role_id, permission)
select r.tenant_id, r.id, p
from public.roles r, lateral unnest(public.default_role_permissions(r.name)) p
where r.is_system and p like 'resources.machinery.%'
on conflict do nothing;

create table public.machines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, name text not null,
  kind text not null default 'tractor' check (kind in ('tractor','implement','vehicle','pump','generator','other')),
  make_model text, reg_no text, purchased_on date, purchase_cost numeric(14,2) check (purchase_cost >= 0),
  hourly_rate numeric(10,2) not null default 0 check (hourly_rate >= 0), service_interval_hours numeric(8,1) check (service_interval_hours > 0),
  active boolean not null default true, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);
create table public.machine_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, machine_id uuid not null, field_id uuid,
  kind text not null check (kind in ('use','fuel','service','repair')), logged_on date not null,
  hours numeric(8,2) check (hours >= 0), fuel_l numeric(10,2) check (fuel_l >= 0), cost numeric(14,2) not null default 0 check (cost >= 0),
  description text, operator text, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, machine_id) references public.machines(tenant_id, id),
  foreign key (tenant_id, field_id) references public.fields(tenant_id, id),
  check (kind <> 'use' or hours is not null), check (kind <> 'fuel' or fuel_l is not null)
);

do $$
declare t record;
begin
  for t in select * from (values
    ('machines','resources.machinery.view','resources.machinery.manage'),
    ('machine_logs','resources.machinery.view','resources.machinery.record')
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
