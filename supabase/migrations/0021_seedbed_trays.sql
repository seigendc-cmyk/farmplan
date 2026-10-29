-- Migration 0021: float-tray seedbeds (app schema v19).
-- seedbeds gets a kind (open_bed | float_bay; existing rows stay open_bed). tray_types (a farm's tray definitions) and seedbed_trays (one tray in a bay,
-- with its own sowing, count and status) are new. operations, cost_entries and transplants get a nullable tray_id; transplants also gets crop_season_id
-- (the season the seedlings are planted for). All links are composite (tenant_id, id) foreign keys so a row can never point at another tenant.
-- No new permissions: read needs production.seedbed.view (Field Recorder has it), write needs production.seedbed.edit (Owner, Farm Manager).
-- default_role_permissions() is re-issued unchanged in content; nothing is back-filled.
-- Apply AFTER every device runs app schema v19.

alter table public.seedbeds add column if not exists kind text not null default 'open_bed';
alter table public.seedbeds add constraint seedbeds_kind_check check (kind in ('open_bed','float_bay'));

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

create table public.tray_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null,
  name text not null check (btrim(name) <> ''), cells integer not null check (cells > 0),
  length_mm numeric(8,2), width_mm numeric(8,2), media text, note text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, farm_id, name),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);

create table public.seedbed_trays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, seedbed_id uuid not null, tray_type_id uuid not null,
  code text not null check (btrim(code) <> ''), variety text, sown_on date,
  expected_seedlings integer check (expected_seedlings >= 0), actual_seedlings integer check (actual_seedlings >= 0),
  status text not null default 'sown' check (status in ('sown','germinating','growing','hardening','ready','depleted','abandoned')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  unique (tenant_id, seedbed_id, code),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, seedbed_id) references public.seedbeds(tenant_id, id),
  foreign key (tenant_id, tray_type_id) references public.tray_types(tenant_id, id)
);
create index on public.seedbed_trays (tenant_id, seedbed_id);

alter table public.operations add column if not exists tray_id uuid;
alter table public.cost_entries add column if not exists tray_id uuid;
alter table public.transplants add column if not exists tray_id uuid, add column if not exists crop_season_id uuid;
alter table public.operations add constraint operations_tray_fk foreign key (tenant_id, tray_id) references public.seedbed_trays(tenant_id, id);
alter table public.cost_entries add constraint cost_entries_tray_fk foreign key (tenant_id, tray_id) references public.seedbed_trays(tenant_id, id);
alter table public.transplants add constraint transplants_tray_fk foreign key (tenant_id, tray_id) references public.seedbed_trays(tenant_id, id),
  add constraint transplants_crop_season_fk foreign key (tenant_id, crop_season_id) references public.seasons(tenant_id, id);

do $$
declare t text;
begin
  foreach t in array array['tray_types','seedbed_trays'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create trigger touch before update on public.%I for each row execute function public.tg_touch()', t);
    execute format('create trigger lock_tenant before update on public.%I for each row execute function public.tg_lock_tenant()', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.tg_audit()', t);
    execute format('create policy sel on public.%I for select using (public.has_perm(tenant_id, %L))', t, 'production.seedbed.view');
    execute format('create policy ins on public.%I for insert with check (public.has_perm(tenant_id, %L))', t, 'production.seedbed.edit');
    execute format('create policy upd on public.%I for update using (public.has_perm(tenant_id, %L)) with check (public.has_perm(tenant_id, %L))', t, 'production.seedbed.edit', 'production.seedbed.edit');
    execute format('create policy del on public.%I for delete using (public.has_perm(tenant_id, %L))', t, 'production.seedbed.edit');
    execute format('create index on public.%I (tenant_id, updated_at)', t);
  end loop;
end $$;
