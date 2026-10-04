-- Migration 0005: contract programmes (contractors, contracts, advances, obligations, settlements).
-- The farm tenant's own view of the programmes it participates in. Contractor/extension invitations (access_invitations/access_grants) are unchanged.

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
      'resources.inventory.view','resources.inventory.manage','finance.cost.view']
    when 'Store Clerk' then array['settings.farm.view','resources.inventory.view','resources.inventory.manage']
    when 'Field Recorder' then array[
      'settings.farm.view','production.field.view','production.seedbed.view','production.operation.view','production.operation.record',
      'production.weather.view','production.weather.record','production.transplant.view','production.transplant.record',
      'production.harvest.view','production.harvest.record','curing.barn.view','curing.cycle.view','curing.cycle.record','curing.storage.view','quality.grading.view','quality.bale.view',
      'resources.inventory.view']
    else array[]::text[] end
$$;

insert into public.role_permissions(tenant_id, role_id, permission)
select r.tenant_id, r.id, p
from public.roles r, lateral unnest(public.default_role_permissions(r.name)) p
where r.is_system and p like 'contracts.%'
on conflict do nothing;

create table public.contractors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, name text not null, contact_person text, phone text, email text, notes text, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, code text not null, contract_no text, contractor_id uuid not null,
  status text not null default 'draft' check (status in ('draft','active','settled','cancelled')),
  crop text not null default 'tobacco', variety text, area_ha numeric(10,2) check (area_ha > 0), target_kg numeric(12,2) check (target_kg > 0),
  signed_on date, delivery_deadline date, extension_services text, production_obligations text, delivery_requirements text, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), unique (tenant_id, farm_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, contractor_id) references public.contractors(tenant_id, id)
);

create table public.contract_fields (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, contract_id uuid not null, field_id uuid not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references public.contracts(tenant_id, id),
  foreign key (tenant_id, field_id) references public.fields(tenant_id, id)
);
create unique index one_field_per_contract on public.contract_fields(contract_id, field_id) where deleted_at is null;

create table public.contract_advances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, contract_id uuid not null, kind text not null check (kind in ('input','cash','service')), description text not null,
  input_id uuid, qty numeric(14,3), value numeric(14,2) not null check (value >= 0), advanced_on date not null, inventory_txn_id uuid, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references public.contracts(tenant_id, id),
  foreign key (tenant_id, input_id) references public.inputs(tenant_id, id),
  foreign key (tenant_id, inventory_txn_id) references public.inventory_transactions(tenant_id, id)
);

create table public.contract_obligations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, contract_id uuid not null, kind text not null check (kind in ('production','delivery','extension','other')), description text not null,
  due_on date, done boolean not null default false, done_on date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, contract_id) references public.contracts(tenant_id, id)
);

-- Self-contained arithmetic checks: no cross-row triggers, so offline devices can sync in any interleaving.
create table public.contract_settlements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, contract_id uuid not null, settled_on date not null,
  delivered_kg numeric(12,2) not null, delivered_gross numeric(14,2) not null, sale_deductions numeric(14,2) not null default 0, advances_total numeric(14,2) not null,
  advances_recovered numeric(14,2) not null check (advances_recovered >= 0), other_deductions numeric(14,2) not null default 0 check (other_deductions >= 0),
  net_payable numeric(14,2) not null check (net_payable >= 0), shortfall numeric(14,2) not null default 0, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  check (advances_recovered <= advances_total + 0.005),
  unique (tenant_id, id), foreign key (tenant_id, contract_id) references public.contracts(tenant_id, id)
);
create unique index one_settlement_per_contract on public.contract_settlements(contract_id) where deleted_at is null;

alter table public.sales add column contract_id uuid;
alter table public.sales add foreign key (tenant_id, contract_id) references public.contracts(tenant_id, id);

-- Settling (and reopening) a contract is its own permission, separate from editing it. Cancelled contracts are final.
create or replace function public.tg_contract_transitions() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if (new.status = 'settled' or old.status = 'settled') and not public.has_perm(new.tenant_id, 'contracts.contract.settle') then
      raise exception 'permission denied: contracts.contract.settle' using errcode = 'insufficient_privilege';
    end if;
    if old.status = 'cancelled' then raise exception 'contract is cancelled' using errcode = 'check_violation'; end if;
  end if;
  return new;
end $$;
create trigger contract_transitions before update on public.contracts for each row execute function public.tg_contract_transitions();

do $$
declare t record;
begin
  for t in select * from (values
    ('contractors','contracts.contract.view','contracts.contract.edit'),
    ('contracts','contracts.contract.view','contracts.contract.edit'),
    ('contract_fields','contracts.contract.view','contracts.contract.edit'),
    ('contract_advances','contracts.contract.view','contracts.contract.edit'),
    ('contract_obligations','contracts.contract.view','contracts.contract.edit'),
    ('contract_settlements','contracts.contract.view','contracts.contract.settle')
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
