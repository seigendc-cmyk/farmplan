# Seedbed operations: open beds and float tray bays, granular costing, Brain lookups

Status: DRAFT v2 for owner review (owner answers of 28 Oct 2026 folded in). Nothing here is built. Source: owner requirement (Oct 2026) recorded in CLAUDE.md and docs/NEXT_PHASES.md.

## Intent (as understood)
Operations in the tobacco workflow must cover both open-field seedbeds and float tray seedbeds. A granular operations model must capture every cost from events (never retyped) and the Brain lookups must be built from it. Owner decisions so far:
- A float bay (pond) is tracked for shared costs, and the trays in it are tracked for seedling counts.
- Shared bay costs are split across trays by **actual seedlings**, giving a cost per seedling. Seedlings carry that cost into the field at transplant.
- Both seedbed kinds feed the same transplant record.

## What exists today (verified from source, Oct 2026)
- `seedbeds` (conventional beds: length, width, count, area, `actual_seedlings`, status flow prepared..depleted) and `operations` (`target_type` seedbed|field, `phase` seedbed|land_prep|field, `op_type` text from `OPERATION_TYPES` in `src/services/operations.ts`).
- `cost_entries` already has `seedbed_id` and `field_id`; `addCost` records costs from events.
- `recordTransplant` (`src/services/transplants.ts`) moves seedlings seedbed -> field, requires `actual_seedlings`, caps at what remains, and records only transplant labour as a cost.
- **Seedbed costs are not attributed to fields anywhere today** (no match for seedbed/seedling in `allocation.ts` or `analytics.ts`). Field cost reports therefore exclude seedbed spend.
- No trays, cells, float bay, float-water inputs or tray operations exist.

## Design
1. **Kinds.** `seedbeds.kind` = `open_bed` (default, all existing rows) | `float_bay`. A float bay is the pond/bay and carries shared costs.
2. **Tray types (configurable).** New synced table `tray_types`, owner-configured: name, cells per tray, tray size (length and width, mm), media type, and an optional note. Nothing is hard-coded; a few suggested starters can be edited or removed. A tray picks a type, and expected seedlings default to cells x trays, editable.
   **Trays.** New synced table `seedbed_trays` (bay `seedbed_id`, `tray_type_id`, `code`, `variety`, `sown_on`, `actual_seedlings`, status). Seedling counts for a float bay live on trays; the bay's `actual_seedlings` is derived from its trays. Open beds keep their own count.
3. **Operations.** Same `operations` table. New nullable `tray_id`; `target_type` gains `tray`. Float tray operation types are data in `OPERATION_TYPES` (e.g. Tray filling, Seed placement, Float water top-up, Float water fertilizer, Water quality check, Clipping, Tray hardening, Tray cleaning). Inputs, labour, machinery and fuel use the existing mechanisms; costs stay derived from events. Exact type list to be confirmed with the owner.
4. **Cost flow (new behavior, additive).**
   - Costs on a bay (no tray) are split across its trays in proportion to `actual_seedlings`. Tray costs stay on the tray. Open-bed costs stay on the bed and are divided by its seedlings.
   - Cost per seedling = unit total cost / actual seedlings. Costs recorded before counts exist are **pending** and are split once counts are entered; the Brain says "pending", never guesses.
   - At transplant, the field is attributed (seedlings planted x cost per seedling of the source tray/bed). Dead or unplanted seedlings leave their cost as a seedbed loss line.
   - **Season totals do not change**: attribution is a derived report, not a second cost entry, so nothing is double counted. **Owner decision:** the attributed seedling cost is **included in the field cost total** (closest to actual cost of growing that field), and also shown as its own "seedling cost" line so it can be seen separately. Field cost, profitability and budget-versus-actual reports use it. Season-level totals are unchanged, so the sum of field costs plus seedbed loss equals the season's seedbed spend.
   **Accuracy rules (nearest to actual):** split is by actual seedlings (not cells or trays); amounts are allocated with exact rounding (cents sum to the original, remainder to the largest share); a tray's cost uses events dated up to the transplant, later seedbed spend goes to the loss line or the remaining seedlings; gap-fill transplants draw cost at the source's current cost per seedling; mortality recorded at transplant is part of that field's cost.
5. **Brain.** New fixed catalogue lookups, no model-written SQL: seedbed cost by bay or tray, cost per seedling, seedling survival by tray, float bay operations. Numbers come only from fixed queries; event sentences carry no prices.
6. **Rules kept.** The app records what was applied and never prescribes chemical rates. Float-water fertilizer is recorded as an input used, not a recommended rate.

## Permissions and visibility
**Owner decision:** cost per seedling is visible at every level (float bay, tray, open bed, field), and who sees it is driven by role and menu access, the same model as every other screen. Planned: tray types and trays follow `production.seedbed.view/edit`; cost figures on those screens, on field pages and in the Brain are shown only to roles holding `finance.cost.view`, and hidden (not blank or zero) otherwise. If a separate seedbed-cost menu key is wanted, it is added with the usual CLAUDE.md permission checklist (group, per-phase grants, `grantOnce`, schema bump, test assertion). **Assumption to confirm:** "all levels" means all record levels, not all users; field roles without finance access still see counts but not money.

## Migration
Schema bump (next version after v18, with the usual in-place upgrade in `runMigrations`). Existing seedbeds become `open_bed`; no data is rewritten. Cloud migration `0021_seedbed_trays.sql` (tray types and trays) with RLS, composite tenant FKs, touch/lock/audit triggers, and a PGlite block in `tests/migration.test.mjs`. `tray_types` then `seedbed_trays` are added to `SYNC_ORDER` after `seedbeds` and its hub write/read policy is decided in the plan.

## Edge cases
- Tray seedling count edited after costs were split: the split is recomputed; derived, not stored.
- Transplant before counts are entered: already refused (existing rule), kept.
- Deleting a tray that has operations or transplants: refused.
- Mixed bay with trays of different varieties: allowed; variety lives on the tray.
- Season closed: existing `assertSeasonOpen` applies.

## Testing
Service tests for the split (including pending, rounding that sums exactly, zero-seedling trays), transplant attribution, deletion rules and permissions; migration test block; jsdom UI test for creating a bay, adding trays and recording a tray operation; browser walk-through at 1280 and 390 px; full `tsc`, vitest, migration test and build before any claim of done.

## Decisions (owner, 28 Oct 2026)
1. Seedling cost is part of the field cost total, calculated as near to actual as possible (rules above).
2. Tray types are configurable and chosen per tray.
3. Cost per seedling is shown at all levels, with access driven by role and menu permissions.

## Still open
- Starter tray types to ship as editable suggestions (names and cells only; the owner can edit all).
- Whether a separate seedbed-cost menu permission is wanted, or `finance.cost.view` is enough.

## Not in scope
Pack shed, Horticulture and Orchards seedbeds; any chemical rate advice; changing how existing tobacco season totals are computed.
