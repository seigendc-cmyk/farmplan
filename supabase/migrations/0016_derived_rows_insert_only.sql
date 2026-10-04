-- Migration 0016: field roles can sync the cost and stock rows their own records derive, insert-only.
-- Design: docs/CLOUD_DERIVED_ROWS_DESIGN.md. Apply AFTER 0015, together with an app build that pushes these rows as plain inserts
-- (older builds keep sending upserts, which these policies do not allow: their rows stay quarantined until the phone is updated).
-- Adds: two insert-only policies, a narrow cancel path for reversals, a "was this row already sent" check, and a stock guard that
-- works whatever the caller may read. No new select, update or delete policies; default role permissions unchanged, nothing back-filled.

-- (a) Which permission a derived row needs: the permission of the record it comes from. Anything unknown → null → refused.
create or replace function public.derived_perm(p_table text, p_source_type text) returns text language sql immutable set search_path = public as $$
  select case p_table || ':' || p_source_type
    when 'cost_entries:operation_input'      then 'production.operation.record'
    when 'cost_entries:operation_labour'     then 'production.operation.record'   -- operations recorded before app v14
    when 'cost_entries:operation_machinery'  then 'production.operation.record'   -- operations recorded before app v14
    when 'cost_entries:labour_entry'         then 'resources.labour.record'
    when 'cost_entries:machine_log'          then 'resources.machinery.record'
    when 'cost_entries:machine_fuel'         then 'resources.machinery.record'
    when 'cost_entries:harvest_labour'       then 'production.harvest.record'
    when 'cost_entries:harvest_transport'    then 'production.harvest.record'
    when 'cost_entries:transplant_labour'    then 'production.transplant.record'
    when 'cost_entries:curing_fuel'          then 'curing.cycle.record'
    when 'cost_entries:cycle_load_labour'    then 'curing.cycle.create'
    when 'cost_entries:cycle_offload_labour' then 'curing.cycle.close'
    when 'cost_entries:grading_labour'       then 'quality.grading.record'
    when 'inventory_transactions:operation'   then 'production.operation.record'
    when 'inventory_transactions:machine_log' then 'resources.machinery.record'
    when 'inventory_transactions:curing_log'  then 'curing.cycle.record'
  end $$;

-- (b) + (d): the source row exists in this tenant AND farm, and the derived row matches it (category, product, quantity).
-- Security definer so it can see the source whatever the caller may read; returns only a boolean, and false for non-members.
create or replace function public.derived_source_ok(p_table text, p_tenant uuid, p_farm uuid, p_source_type text, p_source_id uuid,
                                                    p_category text, p_input uuid, p_qty numeric) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_member(p_tenant) and coalesce(case p_table || ':' || p_source_type
    when 'cost_entries:operation_input' then exists (select 1 from operation_inputs oi join operations o on o.id = oi.operation_id and o.tenant_id = oi.tenant_id
         join inputs i on i.id = oi.input_id and i.tenant_id = oi.tenant_id where oi.id = p_source_id and oi.tenant_id = p_tenant and o.farm_id = p_farm
         and p_category = case i.category when 'chemical' then 'chemicals' when 'packaging' then 'baling' when 'other' then 'overhead' else i.category end)
    when 'cost_entries:operation_labour'     then p_category = 'labour'    and exists (select 1 from operations where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:operation_machinery'  then p_category = 'machinery' and exists (select 1 from operations where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:labour_entry'      then p_category = 'labour'    and exists (select 1 from labour_entries  where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:machine_log'       then exists (select 1 from machine_logs where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm
                                                       and p_category = case when kind = 'fuel' then 'fuel' else 'machinery' end)
    when 'cost_entries:machine_fuel'      then p_category = 'fuel'      and exists (select 1 from machine_logs where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and input_id is not null)
    when 'cost_entries:harvest_labour'    then p_category = 'labour'    and exists (select 1 from harvest_batches where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:harvest_transport' then p_category = 'transport' and exists (select 1 from harvest_batches where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:transplant_labour' then p_category = 'labour'    and exists (select 1 from transplants     where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:curing_fuel'       then p_category = 'curing'    and exists (select 1 from curing_logs l join curing_cycles c on c.id = l.cycle_id and c.tenant_id = l.tenant_id
                                                                                    where l.id = p_source_id and l.tenant_id = p_tenant and c.farm_id = p_farm)
    when 'cost_entries:cycle_load_labour'    then p_category = 'labour' and exists (select 1 from curing_cycles where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:cycle_offload_labour' then p_category = 'labour' and exists (select 1 from curing_cycles where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:grading_labour'    then p_category = 'labour'    and exists (select 1 from grading_lots    where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'inventory_transactions:operation'   then exists (select 1 from operations where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'inventory_transactions:machine_log' then exists (select 1 from machine_logs where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm
                                                           and input_id = p_input and fuel_l = -p_qty)
    when 'inventory_transactions:curing_log'  then exists (select 1 from curing_logs l join curing_cycles c on c.id = l.cycle_id and c.tenant_id = l.tenant_id
                                                           where l.id = p_source_id and l.tenant_id = p_tenant and c.farm_id = p_farm and c.fuel_input_id = p_input and l.fuel_added_kg = -p_qty)
    else false end, false) $$;

-- Permissive policies are OR-ed with the existing `ins`, so roles holding finance.cost.edit / resources.inventory.manage are unchanged.
drop policy if exists ins_derived on public.cost_entries;
create policy ins_derived on public.cost_entries for insert with check (
  public.has_perm(tenant_id, public.derived_perm('cost_entries', source_type))                                        -- (a) + (c) active member
  and public.derived_source_ok('cost_entries', tenant_id, farm_id, source_type, source_id, category, null, null));   -- (b), (c) farm, (d)
drop policy if exists ins_derived on public.inventory_transactions;
create policy ins_derived on public.inventory_transactions for insert with check (
  kind = 'consumption' and qty_delta < 0                                                                               -- never purchases, returns or adjustments
  and public.has_perm(tenant_id, public.derived_perm('inventory_transactions', source_type))
  and public.derived_source_ok('inventory_transactions', tenant_id, farm_id, source_type, source_id, null, input_id, qty_delta));

-- The source record of a derived row has been soft-deleted (same tenant and farm). Internal to cancel_derived; users cannot call it.
create or replace function public.derived_source_gone(p_table text, p_tenant uuid, p_farm uuid, p_source_type text, p_source_id uuid, p_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(case p_table || ':' || p_source_type
    when 'cost_entries:operation_input' then exists (select 1 from operation_inputs oi join operations o on o.id = oi.operation_id and o.tenant_id = oi.tenant_id
                                                     where oi.id = p_source_id and oi.tenant_id = p_tenant and o.farm_id = p_farm and oi.deleted_at is not null)
    when 'cost_entries:operation_labour'     then exists (select 1 from operations      where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:operation_machinery'  then exists (select 1 from operations      where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:labour_entry'         then exists (select 1 from labour_entries  where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:machine_log'          then exists (select 1 from machine_logs    where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:machine_fuel'         then exists (select 1 from machine_logs    where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:harvest_labour'       then exists (select 1 from harvest_batches where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:harvest_transport'    then exists (select 1 from harvest_batches where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:transplant_labour'    then exists (select 1 from transplants     where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:curing_fuel'          then exists (select 1 from curing_logs l join curing_cycles c on c.id = l.cycle_id and c.tenant_id = l.tenant_id
                                                          where l.id = p_source_id and l.tenant_id = p_tenant and c.farm_id = p_farm and l.deleted_at is not null)
    when 'cost_entries:cycle_load_labour'    then exists (select 1 from curing_cycles   where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:cycle_offload_labour' then exists (select 1 from curing_cycles   where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'cost_entries:grading_labour'       then exists (select 1 from grading_lots    where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    -- a stock draw by an operation goes when the operation goes, or when the input line that made this draw is removed
    when 'inventory_transactions:operation'   then exists (select 1 from operations where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
                                                 or exists (select 1 from operation_inputs oi where oi.tenant_id = p_tenant and oi.operation_id = p_source_id and oi.inventory_txn_id = p_id and oi.deleted_at is not null)
    when 'inventory_transactions:machine_log' then exists (select 1 from machine_logs where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and deleted_at is not null)
    when 'inventory_transactions:curing_log'  then exists (select 1 from curing_logs l join curing_cycles c on c.id = l.cycle_id and c.tenant_id = l.tenant_id
                                                           where l.id = p_source_id and l.tenant_id = p_tenant and c.farm_id = p_farm and l.deleted_at is not null)
    else false end, false) $$;

-- Reversal of a derived row by someone who may not update the ledger: soft-deletes ONE cost or stock row, and only when
--   the caller is an active member holding the originating permission, the row's source_type/source_id are the ones given,
--   and that source record is already soft-deleted in the same tenant and farm. Returns nothing; refusals name no amounts.
create or replace function public.cancel_derived(p_table text, p_tenant uuid, p_id uuid, p_source_type text, p_source_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare v_farm uuid; v_deleted timestamptz;
begin
  if p_table is null or p_table not in ('cost_entries', 'inventory_transactions') then
    raise exception 'cancel_derived: only derived cost and stock rows can be cancelled' using errcode = 'insufficient_privilege';
  end if;
  if not public.has_perm(p_tenant, public.derived_perm(p_table, p_source_type)) then
    raise exception 'cancel_derived: permission denied' using errcode = 'insufficient_privilege';
  end if;
  if p_table = 'cost_entries' then
    select farm_id, deleted_at into v_farm, v_deleted from cost_entries
     where id = p_id and tenant_id = p_tenant and source_type = p_source_type and source_id = p_source_id;
  else
    select farm_id, deleted_at into v_farm, v_deleted from inventory_transactions
     where id = p_id and tenant_id = p_tenant and source_type = p_source_type and source_id = p_source_id and kind = 'consumption';
  end if;
  if v_farm is null then raise exception 'cancel_derived: no matching derived row'; end if;
  if v_deleted is not null then return; end if;   -- already cancelled: a re-send after a lost reply is harmless
  if not public.derived_source_gone(p_table, p_tenant, v_farm, p_source_type, p_source_id, p_id) then
    raise exception 'cancel_derived: the source record is still live';
  end if;
  if p_table = 'cost_entries' then update cost_entries set deleted_at = now() where id = p_id and tenant_id = p_tenant;
  else update inventory_transactions set deleted_at = now() where id = p_id and tenant_id = p_tenant; end if;
end $$;

-- Insert-only rows cannot be upserted, so a re-send after a lost reply meets a duplicate key on `id`, which does not say whose row
-- it is. The device then asks: is this id already a row of MY tenant? Members only; returns a boolean and no column of the row.
create or replace function public.row_sent(p_table text, p_tenant uuid, p_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_member(p_tenant) and coalesce(case p_table
    when 'cost_entries'           then exists (select 1 from cost_entries           where id = p_id and tenant_id = p_tenant)
    when 'inventory_transactions' then exists (select 1 from inventory_transactions where id = p_id and tenant_id = p_tenant)
    when 'activity_log'           then exists (select 1 from activity_log           where id = p_id and tenant_id = p_tenant)
    else false end, false) $$;

-- Stock guard: sums one product's stock whatever the caller may read (a mechanic who may draw fuel but not view the store),
-- refuses non-members and other tenants first, and never reveals a quantity. It grants nothing: RLS still decides the write.
create or replace function public.tg_no_negative_stock() returns trigger language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  if new.deleted_at is not null then return new; end if;
  if auth.uid() is not null and not public.is_member(new.tenant_id) then
    raise exception 'Not a member of this farm' using errcode = 'insufficient_privilege';
  end if;
  select coalesce(sum(qty_delta), 0) into bal from inventory_transactions
   where tenant_id = new.tenant_id and farm_id = new.farm_id and input_id = new.input_id and deleted_at is null and id <> new.id;
  if bal + new.qty_delta < 0 then raise exception 'Insufficient stock' using errcode = 'check_violation'; end if;
  return new;
end $$;

revoke all on function public.derived_perm(text, text), public.derived_source_ok(text, uuid, uuid, text, uuid, text, uuid, numeric),
  public.derived_source_gone(text, uuid, uuid, text, uuid, uuid), public.cancel_derived(text, uuid, uuid, text, uuid), public.row_sent(text, uuid, uuid) from public, anon;
revoke all on function public.derived_source_gone(text, uuid, uuid, text, uuid, uuid) from authenticated;
grant execute on function public.derived_perm(text, text), public.derived_source_ok(text, uuid, uuid, text, uuid, text, uuid, numeric),
  public.cancel_derived(text, uuid, uuid, text, uuid), public.row_sent(text, uuid, uuid) to authenticated;

-- Re-issued unchanged, as every migration does. Nothing is back-filled.
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
