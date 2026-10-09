-- Migration 0020: project funding (app schema v18).
-- projects gets the contractor and contract link plus two flags (independent, no funding needed); funding_requests holds one request per funder;
-- funding_events holds the money that actually moved (disbursements, with inputs going into stock, and repayments).
-- Contractor advances are NOT copied here: the app reads them from contract_advances, so an advance exists once.
-- New permissions: projects.funding.view / projects.funding.edit, granted to Farm Manager (back-filled). Field roles see no funding.
-- Apply AFTER every device runs app schema v18.

alter table public.projects add column if not exists contractor_id uuid, add column if not exists contract_id uuid,
  add column if not exists independent boolean not null default false, add column if not exists funding_not_needed boolean not null default false;
alter table public.projects add constraint projects_contractor_fk foreign key (tenant_id, contractor_id) references public.contractors(tenant_id, id),
  add constraint projects_contract_fk foreign key (tenant_id, contract_id) references public.contracts(tenant_id, id),
  add constraint projects_link_or_independent check (not (independent and contract_id is not null));

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
      'brain.note.record','brain.log.view_own','brain.log.view_ops','brain.log.view_finance','brain.chat.ask',
      'resources.inventory.view','resources.inventory.manage','resources.labour.view','resources.labour.record','finance.cost.view','finance.budget.view','finance.budget.edit','resources.machinery.view','resources.machinery.record','resources.machinery.manage',
      'projects.project.view','projects.project.edit','projects.stage.advance','projects.funding.view','projects.funding.edit']
    when 'Store Clerk' then array['settings.farm.view','resources.inventory.view','resources.inventory.manage']
    when 'Field Recorder' then array[
      'settings.farm.view','production.field.view','production.seedbed.view','production.operation.view','production.operation.record',
      'production.weather.view','production.weather.record','production.transplant.view','production.transplant.record',
      'production.harvest.view','production.harvest.record','curing.barn.view','curing.cycle.view','curing.cycle.record','curing.storage.view','quality.grading.view','quality.bale.view',
      'resources.inventory.view','resources.labour.view','resources.labour.record','resources.machinery.view','resources.machinery.record','brain.note.record','brain.log.view_own']
    else array[]::text[] end
$$;

insert into public.role_permissions(tenant_id, role_id, permission)
select r.tenant_id, r.id, p
from public.roles r, lateral unnest(public.default_role_permissions(r.name)) p
where r.is_system and p like 'projects.funding.%'
on conflict do nothing;

create table public.funding_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, project_id uuid not null,
  funder_kind text not null check (funder_kind in ('contractor','lender','investor','other')), funder_name text not null check (btrim(funder_name) <> ''), purpose text not null check (btrim(purpose) <> ''),
  amount_requested numeric(14,2) not null check (amount_requested > 0), needed_by date, repayment_source text, repayment_due date,
  interest_pct numeric(7,3) not null default 0 check (interest_pct >= 0), terms text, covers text,
  status text not null default 'draft' check (status in ('draft','submitted','approved','disbursed','repaid','declined','withdrawn')),
  amount_approved numeric(14,2) check (amount_approved is null or amount_approved >= 0), decided_on date, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, project_id) references public.projects(tenant_id, id)
);
create index on public.funding_requests (tenant_id, project_id);

create table public.funding_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, request_id uuid not null, kind text not null check (kind in ('disbursement','repayment')), form text check (form is null or form in ('cash','inputs')),
  amount numeric(14,2) not null check (amount > 0), occurred_on date not null, input_id uuid, qty numeric(14,3), inventory_txn_id uuid, note text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  check ((kind = 'repayment' and form is null) or (kind = 'disbursement' and form is not null)),
  check (form is distinct from 'inputs' or (input_id is not null and qty > 0)),
  foreign key (tenant_id, request_id) references public.funding_requests(tenant_id, id),
  foreign key (tenant_id, input_id) references public.inputs(tenant_id, id),
  foreign key (tenant_id, inventory_txn_id) references public.inventory_transactions(tenant_id, id)
);
create index on public.funding_events (tenant_id, request_id);

do $$
declare t text;
begin
  foreach t in array array['funding_requests','funding_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create trigger touch before update on public.%I for each row execute function public.tg_touch()', t);
    execute format('create trigger lock_tenant before update on public.%I for each row execute function public.tg_lock_tenant()', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.tg_audit()', t);
    execute format('create policy sel on public.%I for select using (public.has_perm(tenant_id, %L))', t, 'projects.funding.view');
    execute format('create policy ins on public.%I for insert with check (public.has_perm(tenant_id, %L))', t, 'projects.funding.edit');
    execute format('create policy upd on public.%I for update using (public.has_perm(tenant_id, %L)) with check (public.has_perm(tenant_id, %L))', t, 'projects.funding.edit', 'projects.funding.edit');
    execute format('create policy del on public.%I for delete using (public.has_perm(tenant_id, %L))', t, 'projects.funding.edit');
    execute format('create index on public.%I (tenant_id, updated_at)', t);
  end loop;
end $$;
