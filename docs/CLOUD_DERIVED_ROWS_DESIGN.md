# Design — field roles can sync the rows their work derives (cloud migration 0016)

**Status: approved and built** as `supabase/migrations/0016_derived_rows_insert_only.sql` with the app changes in `src/services/sync.ts` (branch `cloud-rls-derived-rows`). See "As built" at the end for the owner's decisions and where the build differs from this proposal.

## The gap, measured (PGlite, all migrations 0001–0015, a Field Recorder signed in)
| What the phone sends | Today | Why |
|---|---|---|
| `cost_entries` from labour, machine, harvest, transplant, operation-input, curing-fuel records | refused, quarantined on the phone | insert needs `finance.cost.edit` |
| `inventory_transactions` consumptions from operations, machine fuel, curing fuel | refused | insert needs `resources.inventory.manage` |
| `activity_log` events | refused | the app sends `INSERT … ON CONFLICT DO NOTHING`; under RLS **any** `ON CONFLICT` also needs SELECT on the table (a plain insert succeeds) |
| a consumption by a role **without** `resources.inventory.view` (e.g. a mechanic-only role) | refused as "Insufficient stock: balance 0" | the stock guard `tg_no_negative_stock` sums stock with the caller's rights and sees none |

Over the Wi-Fi hub none of this applies: the office PC syncs everything under its own account.

Two facts shape the design:
1. **No insert-only policy can work with the app's current push**, which is an upsert (`ON CONFLICT (id) DO UPDATE`). These rows must be sent as plain inserts.
2. **Requirement (d), "a source row in the same tenant", clashes with today's push order.** Stock movements are pushed before the operations, machine logs and curing logs they come from. Machine logs and curing logs also point back at their movement (`fuel_txn_id`), so the order has to change.

## Policies (insert-only; existing `sel`/`upd`/`del` and default role permissions unchanged)
Two security-definer helpers check (b) and (d). They return only a boolean, start with `is_member(p_tenant)` so they cannot be used to probe another tenant, and are executable by `authenticated` only:

```sql
create function public.derived_perm(p_table text, p_source_type text) returns text language sql immutable as $$
  select case p_table || ':' || p_source_type
    when 'cost_entries:operation_input'      then 'production.operation.record'
    when 'cost_entries:operation_labour'     then 'production.operation.record'   -- operations recorded before v14
    when 'cost_entries:operation_machinery'  then 'production.operation.record'   -- operations recorded before v14
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
  end $$;   -- anything else → null → has_perm is false → refused

-- (d) the source row exists in this tenant AND farm; (b) the derived row matches it (category, kind, product, quantity).
create function public.derived_source_ok(p_table text, p_tenant uuid, p_farm uuid, p_source_type text, p_source_id uuid,
                                         p_category text, p_input uuid, p_qty numeric) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_member(p_tenant) and case p_table || ':' || p_source_type
    when 'cost_entries:operation_input' then exists (select 1 from operation_inputs oi join operations o on o.id = oi.operation_id and o.tenant_id = oi.tenant_id
         join inputs i on i.id = oi.input_id and i.tenant_id = oi.tenant_id where oi.id = p_source_id and oi.tenant_id = p_tenant and o.farm_id = p_farm
         and p_category = case i.category when 'chemical' then 'chemicals' when 'packaging' then 'baling' when 'other' then 'overhead' else i.category end)
    when 'cost_entries:labour_entry'      then p_category = 'labour'    and exists (select 1 from labour_entries  where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:machine_log'       then exists (select 1 from machine_logs where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm
                                                       and p_category = case when kind = 'fuel' then 'fuel' else 'machinery' end)
    when 'cost_entries:machine_fuel'      then p_category = 'fuel'      and exists (select 1 from machine_logs where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm and fuel_txn_id is not null)
    when 'cost_entries:harvest_labour'    then p_category = 'labour'    and exists (select 1 from harvest_batches where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:harvest_transport' then p_category = 'transport' and exists (select 1 from harvest_batches where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:transplant_labour' then p_category = 'labour'    and exists (select 1 from transplants     where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:curing_fuel'       then p_category = 'curing'    and exists (select 1 from curing_logs l join curing_cycles c on c.id = l.cycle_id and c.tenant_id = l.tenant_id
                                                                                    where l.id = p_source_id and l.tenant_id = p_tenant and c.farm_id = p_farm)
    when 'cost_entries:cycle_load_labour'    then p_category = 'labour' and exists (select 1 from curing_cycles where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:cycle_offload_labour' then p_category = 'labour' and exists (select 1 from curing_cycles where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:grading_labour'    then p_category = 'labour'    and exists (select 1 from grading_lots    where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:operation_labour'     then p_category = 'labour'    and exists (select 1 from operations where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'cost_entries:operation_machinery'  then p_category = 'machinery' and exists (select 1 from operations where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'inventory_transactions:operation'   then exists (select 1 from operations where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm)
    when 'inventory_transactions:machine_log' then exists (select 1 from machine_logs where id = p_source_id and tenant_id = p_tenant and farm_id = p_farm
                                                           and input_id = p_input and fuel_l = -p_qty)
    when 'inventory_transactions:curing_log'  then exists (select 1 from curing_logs l join curing_cycles c on c.id = l.cycle_id and c.tenant_id = l.tenant_id
                                                           where l.id = p_source_id and l.tenant_id = p_tenant and c.farm_id = p_farm and c.fuel_input_id = p_input and l.fuel_added_kg = -p_qty)
    else false end $$;

create policy ins_derived on public.cost_entries for insert with check (
  public.has_perm(tenant_id, public.derived_perm('cost_entries', source_type))                                       -- (a), (c) active member
  and public.derived_source_ok('cost_entries', tenant_id, farm_id, source_type, source_id, category, null, null));  -- (b), (c) farm, (d)

create policy ins_derived on public.inventory_transactions for insert with check (
  kind = 'consumption' and qty_delta < 0                                                                              -- (b): never purchases, returns or adjustments
  and public.has_perm(tenant_id, public.derived_perm('inventory_transactions', source_type))                         -- (a), (c)
  and public.derived_source_ok('inventory_transactions', tenant_id, farm_id, source_type, source_id, null, input_id, qty_delta));  -- (b), (c), (d)
```

* Postgres combines permissive policies with OR, so managers keep their existing `ins` policy unchanged. A Field Recorder gains these two insert paths and nothing else: still no SELECT (cost amounts and stock values stay hidden), no UPDATE and no DELETE.
* (c) farm: the composite FK `(tenant_id, farm_id) → farms` already ties the farm to the tenant. The helper also requires the source row's farm to be the same farm.
* Not cross-checked: amount, date, field and season. The same role can already create the source record with any of those, so checking them adds no protection. Stock can still never go below zero (the stock guard).
* **Stock guard:** `tg_no_negative_stock` becomes `security definer set search_path = public`. It still only sums one product's stock to refuse a draw below zero, and it grants no rights. Without this, a role that may record machine fuel but not view inventory is always refused.
* `activity_log` needs no policy change. Its existing insert policy already allows field roles, so the fix is on the device (below).
* Migration 0016 re-issues `default_role_permissions()` unchanged and back-fills nothing.

## App changes (the device side)
1. **Push order.** A separate `PUSH_ORDER`; `SYNC_ORDER` stays as the pull and FK order:
   * Sources first: operations, then machine logs and curing logs, sent **without** `fuel_txn_id`.
   * Then `inventory_transactions`.
   * Then the rows that point at a movement: `operation_inputs` and `contract_advances`, plus a second send of those machine and curing logs, now **with** `fuel_txn_id`. This needs only update rights the role already has on those tables. The 0015 fuel trigger then checks the link.
   * Then `cost_entries`, as today.
2. **Insert-only rows.** The device sends a row as a plain `INSERT` (new `CloudClient.insert`) in two cases: every `activity_log` row, and `cost_entries` / `inventory_transactions` rows when the signed-in role lacks that table's cloud write permission (`finance.cost.edit` / `resources.inventory.manage`). A duplicate-key reply means the row is already in the cloud, so the send counts as done. Managers keep the upsert. Over the hub, `insert` falls back to the hub's upsert.
3. **Reversals stay a known limit.** If a field role later reverses one of its records (for example deletes a machine log), the soft-delete of the derived cost or stock row is an UPDATE the role may not make. That row is quarantined with the reason "a person with <permission> must apply this change". The source record itself (the deleted log) does sync. Rows quarantined before this change sync normally with **Retry** on Sync & backup.

## Tests to add when approved
* **PGlite**, for each source type: a Field Recorder can insert. The same person cannot select, update or delete. Each of these is refused:
  * wrong source type, or wrong category or kind (a purchase, an adjustment);
  * wrong quantity or product;
  * a source in another tenant or another farm;
  * a missing source;
  * a role without the originating permission;
  * a non-member calling the helper.
* **PGlite:** a mechanic-only role can draw fuel; managers are unchanged.
* **Fake cloud:** the fake cloud learns these RLS rules (no upsert for insert-only roles). A Field Recorder phone's sync then quarantines nothing, while a reversal is still quarantined with its reason.

## Decisions for the owner
1. **Reversals.** Approve the known limit above (recommended for now), or add later a narrow `reverse_derived(table, id)` function? It would only soft-delete a derived row whose source is already soft-deleted, and only for a caller with the originating permission. That is a controlled update path, which this design otherwise avoids.
2. **Stock guard as `security definer`:** approve it (recommended), or require `resources.inventory.view` for anyone who draws stock?
3. **Manager-only sources** (curing load/offload labour, grading labour): include them as above (recommended, since the rule is the originating permission, not the role name), or limit 0016 to the Field Recorder's own sources?

## As built (owner's decisions)
1. **Reversals: built the narrow cancel function.** `cancel_derived(p_table, p_tenant, p_id, p_source_type, p_source_id)` is security definer and returns nothing. It soft-deletes one `cost_entries` row or one `inventory_transactions` consumption, and only when all of these hold:
   * the caller is an active member with the originating permission (`derived_perm`);
   * the row's `source_type` and `source_id` are the ones given;
   * the source record is already soft-deleted in the same tenant and farm.

   For a stock draw by an operation, the source counts as gone when the operation is deleted, or when the operation input line that made the draw is deleted. A second call on a row already cancelled does nothing.

   Refusals name no amounts. The phone calls the function when it re-sends a deleted derived row that is already in the cloud. Section 3 of "App changes" above no longer applies to deletions.
2. **Stock guard.** `tg_no_negative_stock` is security definer. It refuses non-members and other tenants ("Not a member of this farm") before it sums anything, and it raises only "Insufficient stock", never a balance. It grants nothing else.
3. **Manager-only sources are included.** Rules follow permissions: PGlite tests a custom "Grader" role (grading labour) and the custom "Cycle Starter" role (loading labour).
4. **Activity events** are always sent as plain inserts.
5. **Added during the build: `row_sent(p_table, p_tenant, p_id) → boolean`.**
   * Why it is needed: a duplicate plain insert is reported on the `id` primary key. That error does not say whether the existing row is this tenant's own row (tested in Postgres).
   * What it does: answers "is this id a row of my tenant?" It is members only, covers the three insert-only tables, and returns no column of the row.
   * How the phone uses it: it treats a duplicate as already sent only when `row_sent` is true. Otherwise the row is quarantined.
   * An edit (not a deletion) of a derived row that is already in the cloud is quarantined with "a person with … must apply it".
6. **No permission list on the phone is needed.** When the signed-in role's permissions are passed in, the phone goes straight to plain inserts. Otherwise the first RLS refusal (42501) of an upsert switches that table to plain inserts for the rest of the sync.
7. **Re-sent logs stay pending.** Machine and curing logs whose stock movement is still in the outbox are sent once without `fuel_txn_id`. Their outbox entry stays pending until the second send, with the link, succeeds, so a dropped connection cannot lose the link.
