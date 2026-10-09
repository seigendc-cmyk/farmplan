-- Migration 0017: a farm lists the modules it uses (app schema v15). Every existing farm keeps 'tobacco'.
-- Design: module id == seasons.enterprise; the list only controls what the owner switches on, it does not tag shared tables.
-- Apply AFTER every device runs app schema v15: an older device would fail to pull farm rows carrying the new column.
-- New permission key settings.modules.manage: the Owner holds '*', so no role is granted it and nothing is back-filled.
-- RLS and the touch/lock/audit triggers on public.farms are unchanged; this adds one guard trigger.

alter table public.farms add column if not exists modules text not null default 'tobacco';
alter table public.farms drop constraint if exists farms_modules_format;
alter table public.farms add constraint farms_modules_format check (modules ~ '^[a-z][a-z_]*(,[a-z][a-z_]*)*$');

-- Whoever may manage the farm may still edit its name, area and currency, but only a holder of settings.modules.manage
-- (the Owner unless granted) may change which modules are on, on insert or on update.
create or replace function public.tg_farm_modules_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.modules is distinct from 'tobacco') or (tg_op = 'UPDATE' and new.modules is distinct from old.modules) then
    if not public.has_perm(new.tenant_id, 'settings.modules.manage') then
      raise exception 'permission denied: settings.modules.manage is needed to change farm modules' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists modules_guard on public.farms;
create trigger modules_guard before insert or update on public.farms for each row execute function public.tg_farm_modules_guard();

-- Re-issued unchanged, as every migration does (no new default grants).
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
      'resources.inventory.view','resources.inventory.manage','resources.labour.view','resources.labour.record','finance.cost.view','finance.budget.view','finance.budget.edit','resources.machinery.view','resources.machinery.record','resources.machinery.manage']
    when 'Store Clerk' then array['settings.farm.view','resources.inventory.view','resources.inventory.manage']
    when 'Field Recorder' then array[
      'settings.farm.view','production.field.view','production.seedbed.view','production.operation.view','production.operation.record',
      'production.weather.view','production.weather.record','production.transplant.view','production.transplant.record',
      'production.harvest.view','production.harvest.record','curing.barn.view','curing.cycle.view','curing.cycle.record','curing.storage.view','quality.grading.view','quality.bale.view',
      'resources.inventory.view','resources.labour.view','resources.labour.record','resources.machinery.view','resources.machinery.record','brain.note.record','brain.log.view_own']
    else array[]::text[] end
$$;
