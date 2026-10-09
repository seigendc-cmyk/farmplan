-- Migration 0019: plan figures, budget months and budget versions (app schema v17).
-- projects gets the plan (hectares, expected yield, expected price); budgets get an optional expected month (for the monthly cash need);
-- budget_versions + budget_version_lines hold immutable snapshots of a season's budget. Version 1 is the approved baseline.
-- New permission finance.budget.approve: Owner via '*', not granted to any role by default, so nothing is back-filled. Recording a later revision needs finance.budget.edit.
-- Apply AFTER every device runs app schema v17. Each upgrading device turns its existing season budgets into version 1 and pushes them; the cloud is not back-filled in SQL.

alter table public.projects add column if not exists plan_ha numeric(12,3), add column if not exists plan_yield_kg_ha numeric(12,2), add column if not exists plan_price_kg numeric(12,4);
alter table public.projects add constraint projects_plan_ha_pos check (plan_ha is null or plan_ha > 0),
  add constraint projects_plan_yield_pos check (plan_yield_kg_ha is null or plan_yield_kg_ha > 0), add constraint projects_plan_price_nonneg check (plan_price_kg is null or plan_price_kg >= 0);
alter table public.budgets add column if not exists expected_month text;
alter table public.budgets add constraint budgets_expected_month_fmt check (expected_month is null or expected_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

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
      'projects.project.view','projects.project.edit','projects.stage.advance']
    when 'Store Clerk' then array['settings.farm.view','resources.inventory.view','resources.inventory.manage']
    when 'Field Recorder' then array[
      'settings.farm.view','production.field.view','production.seedbed.view','production.operation.view','production.operation.record',
      'production.weather.view','production.weather.record','production.transplant.view','production.transplant.record',
      'production.harvest.view','production.harvest.record','curing.barn.view','curing.cycle.view','curing.cycle.record','curing.storage.view','quality.grading.view','quality.bale.view',
      'resources.inventory.view','resources.labour.view','resources.labour.record','resources.machinery.view','resources.machinery.record','brain.note.record','brain.log.view_own']
    else array[]::text[] end
$$;

create table public.budget_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null,
  version_no integer not null check (version_no >= 1), kind text not null check (kind in ('baseline','revision')), reason text,
  approved_on date not null, approved_by text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), unique (tenant_id, season_id, version_no),
  check ((kind = 'baseline') = (version_no = 1)),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id)
);
create table public.budget_version_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, version_id uuid not null, category text not null check (btrim(category) <> ''),
  amount numeric(14,2) not null check (amount >= 0), expected_month text check (expected_month is null or expected_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, version_id) references public.budget_versions(tenant_id, id)
);
create index on public.budget_version_lines (tenant_id, version_id);

-- Which kind a version is, readable whatever the caller may see (a boolean-ish answer only; false for non-members).
create or replace function public.version_kind(p_tenant uuid, p_version uuid) returns text language sql stable security definer set search_path = public as $$
  select case when public.is_member(p_tenant) then (select kind from budget_versions where tenant_id = p_tenant and id = p_version) end $$;
grant execute on function public.version_kind(uuid, uuid) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['budget_versions','budget_version_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create trigger touch before update on public.%I for each row execute function public.tg_touch()', t);
    execute format('create trigger lock_tenant before update on public.%I for each row execute function public.tg_lock_tenant()', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.tg_audit()', t);
    execute format('create policy sel on public.%I for select using (public.has_perm(tenant_id, %L))', t, 'finance.budget.view');
    execute format('create index on public.%I (tenant_id, updated_at)', t);
  end loop;
end $$;

-- The baseline needs finance.budget.approve; a later revision needs finance.budget.edit. Baseline rows are never changed by an editor.
create policy ins on public.budget_versions for insert with check (public.has_perm(tenant_id,'finance.budget.approve') or (kind = 'revision' and public.has_perm(tenant_id,'finance.budget.edit')));
create policy upd on public.budget_versions for update using (public.has_perm(tenant_id,'finance.budget.approve') or (kind = 'revision' and public.has_perm(tenant_id,'finance.budget.edit')))
  with check (public.has_perm(tenant_id,'finance.budget.approve') or (kind = 'revision' and public.has_perm(tenant_id,'finance.budget.edit')));
create policy del on public.budget_versions for delete using (public.has_perm(tenant_id,'finance.budget.approve'));
create policy ins on public.budget_version_lines for insert with check (public.has_perm(tenant_id,'finance.budget.approve') or (public.version_kind(tenant_id, version_id) = 'revision' and public.has_perm(tenant_id,'finance.budget.edit')));
create policy upd on public.budget_version_lines for update using (public.has_perm(tenant_id,'finance.budget.approve') or (public.version_kind(tenant_id, version_id) = 'revision' and public.has_perm(tenant_id,'finance.budget.edit')))
  with check (public.has_perm(tenant_id,'finance.budget.approve') or (public.version_kind(tenant_id, version_id) = 'revision' and public.has_perm(tenant_id,'finance.budget.edit')));
create policy del on public.budget_version_lines for delete using (public.has_perm(tenant_id,'finance.budget.approve'));
