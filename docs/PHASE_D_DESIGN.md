# Phase D design — fuel from inventory; labour and machine logs linked to operations

**Status: proposal, awaiting the owner's approval. No code, schema or migration has been written.**

## The problem today (from the code)
| Event | Stock | Cost booked | Gap |
|---|---|---|---|
| Diesel bought (`recordPurchase`) | + litres | none (cost is booked when used) | — |
| Diesel as an operation input line | − litres | `fuel`, avg cost × litres | correct |
| Machine log, kind `fuel` (`logMachine`, also the field-terminal *Machine* tile) | **unchanged** | `fuel`, the amount typed | stock overstated; if the same diesel is also an input line, **cost counted twice** |
| Operation form "Fuel used (L)" | unchanged | none | litres invisible to fuel stats |
| Operation "Labour cost" + a Labour entry for the same work | — | `labour` twice (`operation_labour` + `labour_entry`) | **double labour** |
| Operation "Machinery cost / Machine hours" + a machine `use` log | — | `machinery` twice | **double machinery**; operation hours never count towards *service due* |

Curing already does fuel right (`logCuring`: consumption at average cost, cost linked to the log). The design reuses that pattern.

## Rules
1. **Every litre leaves stock once, and every cost is booked once**, by the event that used the stock or did the work. Costs stay derived, never retyped.
2. **Detail lives in one place:** labour in `labour_entries`, machine use and fuel in `machine_logs`. An operation is the parent that groups them; it no longer carries its own labour or machinery cost.

## Schema (SQLite schema v14 + cloud `0015_fuel_and_links.sql`; v13/0014 went to reorder levels)
| Table | New column | References | Meaning |
|---|---|---|---|
| `machines` | `fuel_input_id` | `inputs` | default fuel product for this machine (set once in the office) |
| `machine_logs` | `input_id` | `inputs` | fuel product drawn for this log (defaults to the machine's) |
| `machine_logs` | `fuel_txn_id` | `inventory_transactions` | the stock movement it created (like `curing_logs.fuel_txn_id`) |
| `machine_logs` | `operation_id` | `operations` | the operation it was part of, if any |
| `labour_entries` | `operation_id` | `operations` | the operation it was part of, if any |

* All new columns are nullable; no new tables, permission keys or booleans (`BOOL_COLS` unchanged). Stock moves use the existing `consumption` kind with `source_type='machine_log'`.
* **Sync order:** already correct. `inputs`, `inventory_transactions` and `operations` precede `labour_entries`, `machines` and `machine_logs` in `SYNC_ORDER`. `HUB_WRITE_TABLES` already allows phones to write `machine_logs`, `labour_entries`, `inventory_transactions` and `cost_entries`; `machines` stays office-only.
* **Cloud `0015`:**
  * `alter table … add column` for the five columns, with composite foreign keys `(tenant_id, x_id) → (tenant_id, id)`. The four referenced tables already have `unique (tenant_id, id)`.
  * RLS, `touch`/`lock_tenant`/`audit` triggers and grants are unchanged, because the tables already exist.
  * New trigger `tg_machine_fuel_consistent`: a log with `fuel_txn_id` must point at a consumption of the same farm, the same `input_id` and `qty_delta = -fuel_l`.
  * The existing `no_negative_stock` trigger guards the cloud side.
  * Following the convention, `default_role_permissions()` is reissued unchanged and back-filled; there are no new keys.
  * A PGlite block goes in `tests/migration.test.mjs`.
* **Upgrade order:** office PC first, then phones. An office still on v13 would reject (and quarantine) phone rows carrying the new columns, because the hub validates column names.

## Behaviour
* **Fuel:**
  * When a fuel product is chosen (by default the machine's), a fuel log, or a use log that gives litres, draws stock in the same transaction: a consumption at the current average cost, plus a `fuel` cost of litres × average cost. The device checks stock, with the same "Insufficient stock" message operations give.
  * Without a fuel product (for example "bought at the pump"), today's behaviour stays: typed cost, no stock movement. The log is labelled "not from the store".
  * Deleting a log reverses its stock movement and its cost.
* **Operations:** the Record operation form replaces its free-text labour and machinery fields with two short lists:
  * Workers (worker, hours, pay) become `labour_entries` linked by `operation_id`.
  * Machines (machine, hours, litres) become `use` logs costed hours × rate, and draw fuel when litres are given.
  * Everything is written in the same database transaction as the operation, with field, season and date copied from it. Deleting an operation reverses its linked entries, logs, stock movements and costs.
  * Labour and Machinery rows link back to their operation, and the field page shows them together.
* **No double counting, enforced in the service and tested:**
  1. New operations never write `operation_labour` or `operation_machinery` costs.
  2. An operation with machine litres may not also have a fuel-category input line (diesel goes on the machine line). An operation with no machine lines may still use fuel as an input, for example a pump that isn't registered.
  3. Each fuel stock movement has exactly one cost row.
* **Field terminal:** unchanged for now. Its Labour and Machine tiles still create standalone entries, but the Machine tile now draws fuel from stock. Offline phones check stock locally; a draw the cloud refuses is quarantined with its reason, the existing behaviour (README Phase 2).

## Existing rows (no rewriting of history)
* **Old operations:** they keep `labour_*` / `machinery_*` values and their cost rows exactly as they are, so season totals, profitability and allocation don't move.
  * I won't convert them into entries or logs: there are no worker names, and `machinery_asset` is free text.
  * They show read-only on the operation as "recorded before machine logs (not counted in machine hours)".
* **Old fuel logs:** they keep their typed cost and are not drawn from stock retroactively, which would make past stock balances wrong. They are labelled "not from the store".
* **Backfill:** none. The new columns start null, and `machines.fuel_input_id` stays empty until the owner picks a product; the Machinery page will prompt for it.

## Old free-text machinery fields
* `operations.machinery_asset`, `machinery_hours`, `machinery_fuel_l`, `machinery_cost`, `labour_workers`, `labour_hours` and `labour_cost` stay in the database: they hold history, older devices still sync them, and the contractor-portal view `portal_operations` reads `labour_*` / `machinery_asset` / `machinery_hours`.
* They come off the form. The service rejects new values for them (one clear error naming the lists to use instead).
* A later migration can drop them once every device is on v14 and `portal_operations` has been replaced.
* `bi_operations` doesn't expose them, so the brain and BI are unaffected.

## Tests to add when approved
Stock and cost per log (with and without a fuel product), reversal on delete, the three no-double-counting rules, linked delete from an operation, old operations unchanged after upgrade, hub sync of a fuel log, the cloud trigger and RLS in PGlite, and a jsdom flow for Record operation with a worker line and a machine line.

## Decisions for the owner
1. **Fuel input lines:** block them only when the operation has machine litres (recommended), or block them always?
2. **Old operations:** leave them untouched (recommended), or try to match `machinery_asset` text to machine names and convert them?
3. **Fuel product:** a default per machine with a per-log override (recommended), or pick it on every log?
4. **Phones:** should field-terminal Labour and Machine entries be attachable to an operation? Recommended later, as a separate small phase.
