-- Migration 0012: business brain, layer 1 — the append-only activity log.
-- Domains map to levels: ops → brain.log.view_ops, finance → brain.log.view_finance, admin → brain.log.view_admin.
-- "Own activity" (brain.log.view_own) is enforced on the device because the cloud cannot know a local user's id;
-- recorded_by is stamped with the signed-in cloud account that uploaded the event, so a forged actor name is visible.

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
      'brain.note.record','brain.log.view_own','brain.log.view_ops','brain.log.view_finance',
      'resources.inventory.view','resources.inventory.manage','resources.labour.view','resources.labour.record','finance.cost.view','finance.budget.view','finance.budget.edit','resources.machinery.view','resources.machinery.record','resources.machinery.manage']
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
where r.is_system and p like 'brain.%'
on conflict do nothing;

create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null,
  occurred_at timestamptz not null, actor_id text, actor_name text, device_tag text,
  kind text not null check (kind in ('action','note','voice','photo','system')), verb text not null,
  domain text not null check (domain in ('ops','finance','admin')),
  table_name text, row_id text, season_id text, field_id text,
  summary text not null check (length(summary) <= 500), body text, details jsonb, recorded_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);
create index on public.activity_log (tenant_id, updated_at);
create index on public.activity_log (tenant_id, occurred_at desc);
create index on public.activity_log (tenant_id, table_name, row_id);

create or replace function public.tg_activity_stamp() returns trigger language plpgsql as $$
begin new.recorded_by := auth.uid(); return new; end $$;
create trigger stamp before insert on public.activity_log for each row execute function public.tg_activity_stamp();

create or replace function public.tg_activity_append_only() returns trigger language plpgsql as $$
begin raise exception 'activity_log is append-only' using errcode = 'insufficient_privilege'; end $$;
create trigger append_only before update or delete on public.activity_log for each row execute function public.tg_activity_append_only();

alter table public.activity_log enable row level security;
create policy sel on public.activity_log for select using (public.has_perm(tenant_id, 'brain.log.view_' || domain));
-- Any member may append: the events describe saves they were already allowed to make. No update or delete policy exists.
create policy ins on public.activity_log for insert with check (public.is_member(tenant_id));
