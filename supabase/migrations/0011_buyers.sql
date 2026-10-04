-- Migration 0011: buyers register (contact, payment terms, credit limit, default deductions, settlement details) and sales.buyer_id.
-- Permissions: marketing.buyer.view / marketing.buyer.manage. Bank details are stored in the same row, so anyone allowed to view buyers can read them;
-- the app hides them from people without manage, but the database does not enforce column-level secrecy.

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
      'quality.grade.edit','quality.grading.view','quality.grading.record','quality.bale.view','quality.bale.record','marketing.sale.view','marketing.sale.record','marketing.buyer.view','marketing.buyer.manage',
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
where r.is_system and p like 'marketing.buyer.%'
on conflict do nothing;

create table public.buyers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, name text not null check (btrim(name) <> ''),
  kind text not null default 'merchant' check (kind in ('auction_floor','merchant','contractor','private','other')),
  contact_person text, phone text, email text, address text,
  payment_terms_days integer check (payment_terms_days >= 0), credit_limit numeric(14,2) check (credit_limit >= 0),
  bank_name text, account_name text, account_no text, settlement_notes text, notes text, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);
create unique index one_buyer_name on public.buyers(tenant_id, farm_id, lower(name)) where deleted_at is null;

create table public.buyer_deductions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, buyer_id uuid not null, label text not null check (btrim(label) <> ''),
  kind text not null check (kind in ('percent','fixed')), value numeric(12,4) not null check (value >= 0 and (kind <> 'percent' or value <= 100)),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, buyer_id) references public.buyers(tenant_id, id)
);

-- Sales point at a buyer; the typed name stays as history. Deleting is soft, so the reference never dangles.
alter table public.sales add column buyer_id uuid;
alter table public.sales add constraint sales_buyer_fk foreign key (tenant_id, buyer_id) references public.buyers(tenant_id, id);
create index on public.sales (tenant_id, buyer_id);

do $$
declare t record;
begin
  for t in select * from (values
    ('buyers','marketing.buyer.view','marketing.buyer.manage'),
    ('buyer_deductions','marketing.buyer.view','marketing.buyer.manage')
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
