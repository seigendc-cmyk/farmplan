-- Migration 0018: the project pipeline (app schema v16). One project per season; the module is the season's enterprise.
-- Adds public.projects (current stage, notes) and public.project_stage_history (every move: create, advance, back, override, with the reason).
-- New permissions: projects.project.view / projects.project.edit / projects.stage.advance (Farm Manager, back-filled) and
-- projects.stage.override (Owner only via '*', never granted by default). Field roles see no projects.
-- Apply AFTER every device runs app schema v16: each device creates its tobacco projects when it upgrades and pushes them; an older device would fail to pull the new tables.
-- Cloud rows are not back-filled here: the stage of an existing season comes from that season's records, which the upgrading device reads.

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

insert into public.role_permissions(tenant_id, role_id, permission)
select r.tenant_id, r.id, p
from public.roles r, lateral unnest(public.default_role_permissions(r.name)) p
where r.is_system and p like 'projects.%'
on conflict do nothing;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null,
  stage text not null check (btrim(stage) <> ''), notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id)
);
create unique index one_project_per_season on public.projects(tenant_id, season_id) where deleted_at is null;

create table public.project_stage_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, project_id uuid not null, from_stage text, to_stage text not null check (btrim(to_stage) <> ''),
  kind text not null check (kind in ('create','advance','back','override')), reason text, changed_on date not null, actor_name text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references public.projects(tenant_id, id)
);
create index on public.project_stage_history (tenant_id, project_id);

do $$
declare t text;
begin
  foreach t in array array['projects','project_stage_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create trigger touch before update on public.%I for each row execute function public.tg_touch()', t);
    execute format('create trigger lock_tenant before update on public.%I for each row execute function public.tg_lock_tenant()', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.tg_audit()', t);
    execute format('create policy sel on public.%I for select using (public.has_perm(tenant_id, %L))', t, 'projects.project.view');
    execute format('create index on public.%I (tenant_id, updated_at)', t);
  end loop;
end $$;

-- A project is created when a season is (settings.season.manage) or edited by those who run projects; stage moves need projects.stage.advance.
create policy ins on public.projects for insert with check (public.has_perm(tenant_id,'settings.season.manage') or public.has_perm(tenant_id,'projects.project.edit') or public.has_perm(tenant_id,'projects.stage.advance'));
create policy upd on public.projects for update using (public.has_perm(tenant_id,'projects.project.edit') or public.has_perm(tenant_id,'projects.stage.advance'))
  with check (public.has_perm(tenant_id,'projects.project.edit') or public.has_perm(tenant_id,'projects.stage.advance'));
create policy del on public.projects for delete using (public.has_perm(tenant_id,'projects.project.edit'));
-- History is written by the move itself, or by season creation (only the first, 'create' row). The app never edits it; update and delete stay with the advance right only so a re-sent row (an upsert) is accepted.
create policy ins on public.project_stage_history for insert with check (public.has_perm(tenant_id,'projects.stage.advance') or (kind = 'create' and public.has_perm(tenant_id,'settings.season.manage')));
create policy upd on public.project_stage_history for update using (public.has_perm(tenant_id,'projects.stage.advance')) with check (public.has_perm(tenant_id,'projects.stage.advance'));
create policy del on public.project_stage_history for delete using (public.has_perm(tenant_id,'projects.stage.advance'));

