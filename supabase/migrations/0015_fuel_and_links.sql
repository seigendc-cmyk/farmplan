-- Migration 0015: Phase D. Machine fuel is drawn from inventory, and labour entries / machine logs link to the operation they were part of.
-- Design: docs/PHASE_D_DESIGN.md. Apply AFTER every device runs app schema v14 (older devices fail to pull rows with the new columns).
-- All new columns are nullable; existing rows are not rewritten (old operations keep their free-text machinery and labour values).
-- RLS, grants and the touch/lock/audit triggers on these tables are unchanged; no new permission keys.

alter table public.machines add column if not exists fuel_input_id uuid;
alter table public.machines add constraint machines_fuel_input_fk foreign key (tenant_id, fuel_input_id) references public.inputs(tenant_id, id);

alter table public.machine_logs add column if not exists input_id uuid;
alter table public.machine_logs add column if not exists fuel_txn_id uuid;
alter table public.machine_logs add column if not exists operation_id uuid;
alter table public.machine_logs add constraint machine_logs_input_fk foreign key (tenant_id, input_id) references public.inputs(tenant_id, id);
alter table public.machine_logs add constraint machine_logs_fuel_txn_fk foreign key (tenant_id, fuel_txn_id) references public.inventory_transactions(tenant_id, id);
alter table public.machine_logs add constraint machine_logs_operation_fk foreign key (tenant_id, operation_id) references public.operations(tenant_id, id);
create index if not exists machine_logs_operation_idx on public.machine_logs (tenant_id, operation_id) where operation_id is not null;

alter table public.labour_entries add column if not exists operation_id uuid;
alter table public.labour_entries add constraint labour_entries_operation_fk foreign key (tenant_id, operation_id) references public.operations(tenant_id, id);
create index if not exists labour_entries_operation_idx on public.labour_entries (tenant_id, operation_id) where operation_id is not null;

-- A log that drew fuel from the store must point at exactly that draw: a consumption of the same farm and product, of its litres,
-- produced by this log. Security definer so the check works whatever the caller may read; it only reads the one referenced row.
create or replace function public.tg_machine_fuel_consistent() returns trigger language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if new.deleted_at is not null or new.fuel_txn_id is null then return new; end if;
  select tenant_id, farm_id, input_id, kind, qty_delta, source_type, source_id into t from public.inventory_transactions where id = new.fuel_txn_id;
  if t is null or t.tenant_id <> new.tenant_id or t.farm_id <> new.farm_id or t.kind <> 'consumption' or t.input_id is distinct from new.input_id
     or t.qty_delta <> -coalesce(new.fuel_l, 0) or t.source_type is distinct from 'machine_log' or t.source_id is distinct from new.id then
    raise exception 'Machine log fuel does not match its stock movement' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists machine_fuel_consistent on public.machine_logs;
create trigger machine_fuel_consistent before insert or update on public.machine_logs for each row execute function public.tg_machine_fuel_consistent();

-- Re-issued unchanged, as every migration does. Nothing is back-filled: there are no new keys, and re-granting existing ones
-- would undo permissions an owner has deliberately removed.
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
