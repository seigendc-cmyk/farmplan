# Seedbed Module, Float Tray Bays and Seedling Costing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Seedbed enterprise (module) with open beds and float tray bays, configurable tray types, granular tray operations, seedling costing carried into crop field costs, and Brain lookups.

**Architecture:** `seedbed` becomes a module (its id is `seasons.enterprise`), with its own seasons, project pipeline and budget. Trays hang off a `float_bay` seedbed. Seedling cost is **derived, never stored twice**: shared bay costs are split by actual seedlings with the existing `splitByWeight`, and a transplant attributes `qty x cost per seedling` to the receiving field in the crop season. Farms that do not switch the module on behave exactly as today.

**Tech Stack:** TypeScript, React 19, sql.js (SQLite) local schema v18 -> v19, Postgres migration `0021` tested in PGlite, vitest, Playwright (Chromium) for the browser check.

**Spec:** `docs/superpowers/specs/2026-10-28-seedbed-operations-design.md` (approved v4; defaults kept: one editable example tray type, `finance.cost.view` for cost visibility).

## Global Constraints
- Branch `seedbed-module` created from `platform-step-3`; push that branch only, never `main`. Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01GLt7VTVEsFk4vnnV84jbsf`.
- Every service function takes `Ctx`, calls `require(ctx,'perm')`, mutates inside `db.tx`, and writes through `db.insert/update/softDelete`. Costs come from events via `addCost`, never retyped.
- Activity event sentences contain no prices. The app records what was applied and never prescribes chemical rates.
- New synced tables: DDL, `SYNC_ORDER` (FK order, checked by `sync.test.ts`), cloud migration with RLS and touch/lock/audit triggers, `HUB_WRITE_TABLES`/`HUB_NO_READ` decision. Every cloud migration re-issues `default_role_permissions()` and gets a PGlite block in `tests/migration.test.mjs`.
- `SCHEMA_VERSION` becomes `19`; update the `schema_version` assertions in `src/services/phase2.test.ts`, `modules.test.ts`, `projects.test.ts` to `'19'`.
- Cost figures are returned as `null` (not 0) without `finance.cost.view`. Counts stay visible with `production.seedbed.view`.
- Before any "done": `npx tsc --noEmit`, `npx vitest run`, `node tests/migration.test.mjs`, `npm run build` all pass.
- Report evidence per CLAUDE.md protocol (VERIFIED / UNVERIFIED), never claim beyond what was run.

## Owner instructions for execution (29 Oct 2026)
- **Test before wiring:** in every task the service logic and its tests must pass before any UI is written; the UI step then wires to that tested service and gets its own jsdom test. Do not start a UI step while the service tests fail.
- **Module docs:** `docs/modules/tobacco.md` and `docs/modules/seedbed.md` are written in Task 12, one per built module, each stating only what was built and verified.
- **Scope:** float tray seedbeds are delivered through the Seedbed module, used by tobacco (approved spec). Tobacco's existing seedbeds stay untouched.

## Review Focus
- A float bay whose trays all have zero or unset `actual_seedlings`: cost split must return pending (null per seedling), never divide by zero or show 0.
- `actual_seedlings` edited after costs were recorded or after a transplant: splits recompute; a count below what was already transplanted is refused.
- Transplant from a bay without choosing a tray, or more than a tray holds: refused with a clear message.
- Transplant when the seedbed season or the receiving crop season is closed, or the crop season belongs to the Seedbed module: refused.
- A farm without the Seedbed module, with seedbeds already in tobacco seasons: transplant, costs and every existing report give identical numbers to before.

## File Structure
- Create `src/services/traytypes.ts`, `src/services/trays.ts`, `src/services/seedlingcost.ts` and their `*.test.ts`.
- Create `src/pages/TrayTypes.tsx`; modify `src/pages/Seedbeds.tsx`, `Operations.tsx`, `Transplanting.tsx`, `Fields.tsx` (cost display), `src/App.tsx` (routes and nav).
- Modify `src/modules/registry.ts`, `src/modules/stages.ts`, `src/services/modules.ts`, `src/services/projects.ts`, `src/services/seedbeds.ts`, `src/services/operations.ts`, `src/services/transplants.ts`, `src/services/analytics.ts`, `src/brain/catalogue.ts`, `src/brain/evalset.ts`, `src/db/schema.ts`, `src/db/migrations.ts`, `src/db/database.ts`, `src/db/activity.ts`, `src/services/hub.ts`.
- Create `supabase/migrations/0021_seedbed_trays.sql`; modify `tests/migration.test.mjs`, README, CLAUDE.md, `docs/NEXT_PHASES.md`.

## Deviation from the spec (flagged)
The spec says `operations.target_type` gains `tray`. SQLite cannot change a CHECK constraint without rebuilding the table, which is risky for synced data. Instead a tray operation keeps `target_type='seedbed'` with a new nullable `operations.tray_id`. Behavior is identical. The cloud migration may widen nothing. Owner review of this deviation is requested with the plan.

---

# Part 1: the Seedbed module and tray structure (pushable on its own)

### Task 1: Seedbed module, stages, access and nav

**Files:** Modify `src/modules/registry.ts`, `src/modules/stages.ts`, `src/services/modules.ts`, `src/services/projects.ts`, `src/App.tsx`; Test `src/services/seedbedmodule.test.ts`.

**Interfaces:**
- Produces: module id `'seedbed'` in `MODULES` (`available: true`, label `Seedbeds`, blurb "Seedbeds and float tray bays: seedlings with full costing, supplied to crop modules."); `STAGES.seedbed` = idea, planning, budget, funding, sowing, growing, hardening, dispatched, closed; `MODULE_ACCESS.seedbed = ['production.seedbed']`; `LEAVE.seedbed` gates.

- [ ] **Step 1: Write failing tests** in `seedbedmodule.test.ts`: (a) `stagesOf('seedbed').map(s=>s.id)` equals the nine ids above in order; (b) enabling `['tobacco','seedbed']` then `createSeason(ctx,{label:'S1',enterprise:'seedbed',...})` creates a project at stage `idea`; (c) activating a seedbed season leaves the active tobacco season active; (d) `accessibleModules` includes `seedbed` for a role holding `production.seedbed.view` and excludes it for Field Recorder-less roles lacking it; (e) gates: leaving `budget` and `funding` match tobacco text; leaving `sowing` needs "Record at least one seedbed or bay"; leaving `growing` needs "Record a sowing date on a seedbed"; leaving `hardening` needs none; leaving `dispatched` needs "Record at least one transplant from this season's seedbeds".
- [ ] **Step 2: Run** `npx vitest run src/services/seedbedmodule.test.ts` -> FAIL.
- [ ] **Step 3: Implement.** Add the module and stages as data; add `LEAVE.seedbed` in `projects.ts` using the same `has(db,table,season)` helper and `budget_versions`/`funding_requests` checks as tobacco (reuse the tobacco functions for `budget` and `funding`); add `MODULE_ACCESS.seedbed`; add NAV group `{ group: 'Seedbeds', module: 'seedbed', items: Seedbeds, Tray types, Operations, Transplanting }` in `App.tsx` using existing `perm` keys (`production.seedbed.view`, `production.operation.view`, `production.transplant.view`). Keep the existing Tobacco Production group unchanged.
- [ ] **Step 4: Run** the new test and `npx vitest run src/services/projects.test.ts src/services/modules.test.ts` -> PASS.
- [ ] **Step 5: Commit** `feat: Seedbed module, stage list and menu`.

### Task 2: Schema v19 (local) and in-place upgrade

**Files:** Modify `src/db/schema.ts`, `src/db/migrations.ts`, `src/db/database.ts`, `src/services/hub.ts`, `src/db/activity.ts`, the three version assertions; Test `src/services/seedbedschema.test.ts`.

**Interfaces:**
- Produces tables and columns:
  - `tray_types(id, tenant_id, farm_id, name TEXT NOT NULL, cells INTEGER NOT NULL CHECK(cells>0), length_mm REAL, width_mm REAL, media TEXT, note TEXT, common, UNIQUE(tenant_id,farm_id,name))`
  - `seedbed_trays(id, tenant_id, farm_id, seedbed_id REFERENCES seedbeds(id), tray_type_id REFERENCES tray_types(id), code TEXT NOT NULL, variety TEXT, sown_on TEXT, expected_seedlings INTEGER CHECK>=0, actual_seedlings INTEGER CHECK>=0, status TEXT NOT NULL DEFAULT 'sown' CHECK IN ('sown','germinating','growing','hardening','ready','depleted','abandoned'), common, UNIQUE(tenant_id,seedbed_id,code))`
  - `seedbeds.kind TEXT NOT NULL DEFAULT 'open_bed' CHECK(kind IN ('open_bed','float_bay'))`
  - `operations.tray_id`, `cost_entries.tray_id`, `transplants.tray_id` (each nullable, REFERENCES seedbed_trays), `transplants.crop_season_id TEXT REFERENCES seasons(id)` (nullable; null means same season as the seedbed).
- `SYNC_ORDER`: `tray_types` and `seedbed_trays` after `seedbeds`. Hub: `tray_types` and `seedbed_trays` carry no money, so field devices may READ them (NOT in `HUB_NO_READ`, needed so a field operation on a tray can resolve it) but they are not in `HUB_WRITE_TABLES`; record this decision in the README. (Ruling R1, plan preflight.)

- [ ] **Step 1: Write failing tests:** fresh DB has the tables and columns; an upgrade from a v18 database (build one by running v18 DDL, as `phase2.test.ts` does for earlier versions) keeps every seedbed with `kind='open_bed'` and every transplant with `crop_season_id` null; `SCHEMA_VERSION` is `'19'`; `sync.test.ts` still passes (order).
- [ ] **Step 2: Run** `npx vitest run src/services/seedbedschema.test.ts src/services/sync.test.ts` -> FAIL.
- [ ] **Step 3: Implement** DDL, the `if (from < 19)` block (PRAGMA guard per column, as the v18 block does), `SYNC_ORDER`, activity `LABEL` entries (events name the record, no money), and bump `SCHEMA_VERSION`.
- [ ] **Step 4: Run** the full `npx vitest run` -> PASS (versions updated).
- [ ] **Step 5: Commit** `feat: schema v19 - tray types, trays, seedbed kind, tray links, crop season on transplants`.

### Task 3: Cloud migration 0021 and PGlite tests

**Files:** Create `supabase/migrations/0021_seedbed_trays.sql`; Modify `tests/migration.test.mjs`, README apply list.

**Interfaces:** Consumes the Task 2 column and table definitions. Follow `0020_funding.sql` and `0017` for structure.

- [ ] **Step 1: Write the failing 0021 block** in `tests/migration.test.mjs` (use unique variable names such as `tt21`, `bay21`; earlier collisions with `ct`, `fr`, `ev` happened): Farm Manager can insert and update `tray_types` and `seedbed_trays`; Field Recorder can read trays but not write them; viewer role without `production.seedbed.view` sees none; another tenant sees none; composite FK rejects a tray pointing at another tenant's seedbed; `seedbeds.kind` check rejects `'pond'`; `cells=0` rejected; duplicate tray code in one bay rejected; `transplants.crop_season_id` accepts a season of the same tenant and rejects another tenant's.
- [ ] **Step 2: Run** `node tests/migration.test.mjs` -> FAIL (file missing).
- [ ] **Step 3: Write `0021_seedbed_trays.sql`:** the two tables with RLS keyed on `production.seedbed.view`/`edit` via `has_perm`, composite `(tenant_id,id)` FKs, touch/lock_tenant/audit triggers, the added columns with checks, and the re-issued `default_role_permissions()` (no new keys). Header comment: apply after every device runs v19.
- [ ] **Step 4: Run** `node tests/migration.test.mjs` -> `ALL MIGRATION TESTS PASSED`.
- [ ] **Step 5: Commit** `feat: cloud 0021 tray types and trays with RLS`.

### Task 4: Tray types service and screen

**Files:** Create `src/services/traytypes.ts`, `src/pages/TrayTypes.tsx`; Modify `src/App.tsx` (route `/tray-types`); Test `src/services/traytypes.test.ts`, `src/ui.traytypes.test.tsx` (pattern: `src/ui.funding.test.tsx`).

**Interfaces:**
- Produces: `interface TrayType { id: string; name: string; cells: number; length_mm: number|null; width_mm: number|null; media: string|null; note: string|null }`; `listTrayTypes(ctx): TrayType[]` (`production.seedbed.view`); `saveTrayType(ctx, i: Omit<TrayType,'id'> & { id?: string }): string` (`production.seedbed.edit`; name required and unique, cells whole number > 0, dimensions positive when given); `deleteTrayType(ctx, id: string): void` (refuses when any non-deleted tray uses it).

- [ ] **Step 1: Write failing service tests:** create and list; duplicate name refused; cells 0 and 1.5 refused; edit keeps trays attached; delete refused while a tray uses it and allowed after; Field Recorder cannot save (PermissionError).
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement** the service (one editable example type is created only by the UI "Add example" button, not seeded in data). **Step 4: Run** -> PASS.
- [ ] **Step 5: Write failing UI test:** open Tray types, empty state text "No tray types yet", add one through the form, row appears, delete is blocked with a visible reason while in use. Then implement `TrayTypes.tsx` using `PageHeader`, `Table`, modal form like `Funding.tsx`; wire form submit -> `saveTrayType` -> list refresh via `useData`; errors shown via toast.
- [ ] **Step 6: Run** both test files -> PASS. **Step 7: Commit** `feat: configurable tray types`.

### Task 5: Float bays and trays (service and Seedbeds screen)

**Files:** Modify `src/services/seedbeds.ts`, `src/pages/Seedbeds.tsx`; Create `src/services/trays.ts`; Test `src/services/trays.test.ts`, `src/ui.trays.test.tsx`.

**Interfaces:**
- Consumes: `listTrayTypes`, schema from Task 2.
- Produces: `SeedbedInput` gains `kind?: 'open_bed'|'float_bay'`; `Seedbed`/`SeedbedMetrics` gain `kind`; for a `float_bay`, `actual_seedlings` and `expected_seedlings` are derived sums of its trays (null when no tray has a count) and `bed_*` fields stay null; `interface Tray { id: string; seedbed_id: string; tray_type_id: string; tray_type: string; code: string; variety: string|null; sown_on: string|null; expected_seedlings: number|null; actual_seedlings: number|null; status: string; transplanted: number; available: number|null }`; `createTray(ctx, i: { seedbed_id: string; tray_type_id: string; code?: string; variety?: string; sown_on?: string; expected_seedlings?: number; actual_seedlings?: number }): string` (bay must be `float_bay`; code defaults to `T-001` next free in the bay; `expected_seedlings` defaults to the type's `cells`); `updateTray(ctx, id: string, i: Partial<Omit<Parameters<typeof createTray>[1],'seedbed_id'>> & { status?: string }): void` (an `actual_seedlings` below the tray's transplanted count is refused); `deleteTray(ctx, id: string): void` (refused when operations, costs or transplants reference it); `listTrays(ctx, seedbedId: string): Tray[]`.

- [ ] **Step 1: Write failing tests:** creating a bay with `kind:'float_bay'`; a tray defaults expected seedlings to the type's cells; adding a tray to an open bed is refused; the bay's `actual_seedlings` equals the sum of tray counts and is null when none counted; duplicate code refused; count below transplanted refused; delete refused with an operation present; existing open beds unchanged (kind default and metrics identical to a snapshot taken from the current `listSeedbeds` output in the test).
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement** using `ctx.db.insert('seedbed_trays',...)`, audit events `tray.create/update/delete`.
- [ ] **Step 4: Run** -> PASS.
- [ ] **Step 5: UI test then screen:** Seedbeds page gains a "Kind" choice in the add form (Open bed / Float bay), a float bay row opens a detail dialog listing trays with "Add tray" (tray type select, code, variety, sown date, counts). Wire add-tray submit -> `createTray` -> list refresh; empty state "No trays in this bay yet"; no tray types -> inline link to Tray types. Test: create bay, add tray, see seedling total update.
- [ ] **Step 6: Run** both files and `npx vitest run src/ui.phase*.test.tsx` -> PASS. **Step 7: Commit** `feat: float tray bays and trays`.

**Part 1 checkpoint:** run the four verification commands, push `seedbed-module`, report. Pause for owner review before Part 2.

---

# Part 2: tray operations and seedling costing

### Task 6: Tray operations

**Files:** Modify `src/services/operations.ts`, `src/pages/Operations.tsx`; Test `src/services/trayops.test.ts`.

**Interfaces:**
- Produces: `OPERATION_TYPES` gains `float_tray: string[]` = Tray filling, Seed placement, Float water top-up, Float water fertilizer, Water quality check, Clipping, Tray hardening, Tray cleaning, Other. `OperationInput.target` becomes `{ type: 'seedbed'|'field'; id: string; tray_id?: string }`. `cost_entries.tray_id` is set when `tray_id` is given, otherwise bay-level cost has `seedbed_id` only.

- [ ] **Step 1: Write failing tests:** operation on a bay (no tray) writes cost entries with `seedbed_id` set and `tray_id` null; operation on a tray writes `tray_id` and the tray's `seedbed_id`; a tray of another bay is refused; `tray_id` on a field target refused; inputs consume stock and cost as today (reuse an existing `recordOperation` test setup); delete reverses everything including tray costs; a Sowing type on a tray sets the tray's `sown_on` when empty; open-bed operations are byte-for-byte unchanged (compare rows with an existing fixture).
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement** by passing `tray_id` through `costBase`, the labour entry and `logMachine` where they accept a seedbed (add only what they already support; if `recordLabour` has no tray field, link through the operation id, which already ties cost to the operation).
- [ ] **Step 4: Run** -> PASS.
- [ ] **Step 5: UI:** Operations form: when the target is a float bay, show an optional "Tray" select and the `float_tray` types; wire to `recordOperation`; list shows the tray code. Add a jsdom test for recording "Float water top-up" on a tray.
- [ ] **Step 6: Commit** `feat: tray-level operations`.

### Task 7: Seedling cost engine

**Files:** Create `src/services/seedlingcost.ts`; Test `src/services/seedlingcost.test.ts`.

**Interfaces:**
- Consumes: `splitByWeight(amount: number, weights: number[]): number[]` from `src/services/allocation.ts`.
- Produces: `interface UnitCost { unit: 'tray'|'bed'; id: string; code: string; seedlings: number|null; cost: number|null; per_seedling: number|null; pending: boolean }`; `seedbedUnitCosts(ctx: Ctx, seedbedId: string, asOf?: string): UnitCost[]`; `costPerSeedling(ctx: Ctx, src: { seedbed_id: string; tray_id?: string|null }, asOf: string): { per_seedling: number|null; pending: boolean }`; (`seedbedLoss` is implemented in Task 8, because it needs the transplant attribution; Ruling R2, plan preflight.)
- Rules: seedbed costs are `cost_entries` with `seedbed_id=bay` and `field_id IS NULL`; bay-level ones (`tray_id IS NULL`) are split over trays by `actual_seedlings` with `splitByWeight`; tray costs stay on the tray; entries after `asOf` are excluded; open beds use their own `actual_seedlings`. `pending` is true when the unit has no seedling count (or the bay has none to split over) and the cost is non-zero. Without `finance.cost.view`, `cost` and `per_seedling` are null. 

- [ ] **Step 1: Write failing tests with exact numbers:** bay cost 300.00 over trays with 100/200 seedlings -> 100.00/200.00 and per-seedling 1.00 for each; 100.00 over three equal trays -> 33.34/33.33/33.33 (cents sum exactly); tray-only cost stays on that tray; entries dated after `asOf` excluded; zero-seedling tray gets 0 cost and `pending:false` only if it has no cost, otherwise pending; no tray counted -> every tray pending, per_seedling null; changing a tray count recomputes (no stored split); user without `finance.cost.view` gets nulls; transplant labour (entry has `field_id`) is not counted as seedbed cost.
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement** with SQL reads and `splitByWeight`; no writes. **Step 4: Run** -> PASS. **Step 5: Commit** `feat: seedling cost per tray and bed`.

### Task 8: Cross-season transplant and attribution

**Files:** Modify `src/services/transplants.ts`, `src/pages/Transplanting.tsx`; Add to `src/services/seedlingcost.ts`; Test `src/services/transplantcost.test.ts`.

**Interfaces:**
- Produces: `TransplantInput` gains `tray_id?: string` and `crop_season_id?: string`; `seedbedLoss(ctx: Ctx, seedbedId: string): number|null` = the seedbed's total unit cost less the amounts attributed to fields (null without `finance.cost.view`); and `seedlingCostByField(ctx: Ctx, cropSeasonId: string): { field_id: string; seedlings: number; amount: number|null }[]` = per transplant `round2(qty * costPerSeedling(source, occurred_on).per_seedling)` grouped by field, gap-fill included at the source's cost per seedling on its date; `pending` transplants contribute `null` amounts flagged, not 0.
- Rules for `recordTransplant`: a seedbed whose season is a `seedbed`-module season requires `crop_season_id` (open, not a seedbed-module season, field exists); a legacy seedbed (tobacco season) sets `crop_season_id` null and works exactly as today; a `float_bay` requires `tray_id` and the cap is that tray's remaining seedlings; the transplant labour cost stays on the crop season (`season_id` of the cost entry = the crop season; today it uses the seedbed season, so cross-season is the only behavior change, legacy keeps its season).

- [ ] **Step 1: Write failing tests:** legacy flow identical (existing `transplants` tests still pass unchanged); cross-season requires `crop_season_id`; refuses when either season is closed, when the crop season is a seedbed season, when over the tray's remaining seedlings, or from a bay without a tray; `seedlingCostByField` returns `qty * per_seedling` (e.g. 400 seedlings at 1.00 -> 400.00 to the field); transplanting before counts exist is refused by the existing rule; gap-fill later uses the cost per seedling as of its date; deleting a transplant removes its attribution (derived, so the next read changes).
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement.** **Step 4: Run** transplant and seedlingcost tests -> PASS.
- [ ] **Step 5: UI:** Transplanting form: source select lists seedbeds (and trays for bays); when the source is a seedbed-module bed, show a "Crop season" select; wire to `recordTransplant`; jsdom test for one cross-season transplant.
- [ ] **Step 6: Commit** `feat: cross-season transplant with seedling cost attribution`.

### Task 9: Field cost reports include seedling cost

**Files:** Modify `src/services/analytics.ts`, `src/pages/Profitability.tsx`, `src/pages/Fields.tsx`; Test `src/services/seedlingreports.test.ts`.

**Interfaces:**
- `Profitability` gains `seedling_cost: number` and `transfer_in: number`; `FieldProfit` gains `seedling_cost: number`. In `profitability`, each field's `field_cost` adds `seedlingCostByField` for that field; `field_cost` (total) adds the same; `total_cost` adds only the cross-season `transfer_in` (cost whose seedbed lives in another season), so a legacy same-season seedbed's cost, already in `total_cost`, is not added twice and `shared_cost = total_cost - field_cost` falls by exactly the attributed amount.

Note: `seasonComparison` is per season and no consolidated cross-season farm report exists in the repo today (checked by search of `analytics.ts`), so the spec's "exclude the transfer from consolidated reports" is met by exposing `transfer_in` separately; any future consolidated report must subtract it. Add a test that `seasonComparison` rows are unchanged for seasons without transplants.

- [ ] **Step 1: Write failing tests:** legacy: 400 seedlings at 1.00 attributed -> `field_cost` up 400, `total_cost` unchanged, `shared_cost` down 400; cross-season: `total_cost` up by `transfer_in` equal to the attribution and `shared_cost` unchanged; the sum of attributed amounts plus `seedbedLoss` equals the seedbed's total spend; pending attribution adds nothing and the report exposes a `seedling_pending` count; users without `finance.cost.view` cannot call `profitability` (existing) and Fields page cost stays hidden; every existing `phase5.test.ts` profitability expectation passes unchanged for a season with no transplants.
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement. Step 4: Run** `npx vitest run src/services/seedlingreports.test.ts src/services/phase5.test.ts` -> PASS.
- [ ] **Step 5: UI:** Profitability by-field shows a "Seedling cost" column; Fields detail shows seedling cost when permitted. Jsdom assertion on the column header and value.
- [ ] **Step 6: Commit** `feat: seedling cost in field cost and profitability`.

**Part 2 checkpoint:** four verification commands, push, report, pause for review.

---

# Part 3: Brain, evidence and docs

### Task 10: Brain lookups

**Files:** Modify `src/brain/catalogue.ts`, `src/brain/evalset.ts`; Test `src/brain/seedlookups.test.ts`.

**Interfaces:** four new `CATALOGUE` entries, all `run` from the Task 7/8 services (no model-written SQL): `seedbed_cost` (perms `finance.cost.view`, `production.seedbed.view`; rows: seedbed or bay, unit, seedlings, cost), `cost_per_seedling` (same perms; rows: unit, per_seedling or "pending"), `tray_survival` (perm `production.seedbed.view`; rows: tray, sown, actual, transplanted, mortality), `bay_operations` (perms `production.operation.view`, `production.seedbed.view`; rows: date, type, tray, no prices). Each with `season` param like `seedbeds_status`.

- [ ] **Step 1: Write failing tests:** each lookup returns the expected rows from a seeded fixture; a role without `finance.cost.view` cannot run the cost lookups and the money-free ones still run; `pending` surfaces as the word "pending", never a number; keyword router picks each id for 3 sample questions per lookup ("cost per seedling in the float bay", "which tray had the best germination", "what did we do in the float bay last week", "how much have the seedbeds cost").
- [ ] **Step 2: Run** `npx vitest run src/brain` -> FAIL. **Step 3: Implement** catalogue entries and add the questions to `evalset.ts` (not the HOLDOUT set). **Step 4: Run** all brain tests; the keyword router's accuracy on the existing questions must stay at its current figure (`evalset.test.ts`).
- [ ] **Step 5: Commit** `feat: brain lookups for seedbed cost and trays`.

### Task 11: Docs, rules and full verification

**Files:** Modify README (Seedbed module section: schema v19, screens, rules, assumptions, cloud 0021, apply order, tests, not-done list), `docs/NEXT_PHASES.md` (mark DONE), CLAUDE.md (replace the "NOT BUILT yet" rule with the built behavior), supabase apply list.

- [ ] **Step 1:** Update docs with only what was built and verified; list limits honestly (cloud tables tested in PGlite only; hub hidden; no tray edit on field devices).
- [ ] **Step 2: Browser walk-through** with the existing Playwright setup (`/tmp/claude-0/pw`, dev server `npm run dev -- --host 127.0.0.1`, stop with `pkill -f '[v]ite --host'`): at 1280 and 390 px, switch on Seedbed module, create a seedbed season, add a tray type, a float bay with two trays, record a float water top-up with an input, enter counts, transplant into a tobacco field, open Profitability and Fields, ask the Brain "cost per seedling". Check console errors and review screenshots.
- [ ] **Step 3:** Run `npx tsc --noEmit`, `npx vitest run`, `node tests/migration.test.mjs`, `npm run build`.
- [ ] **Step 4:** Commit `docs: seedbed module`, push `seedbed-module`, set tracking, and send the evidence report (Inspected, Changed, UI wiring per interaction, Tested, Visually verified, Not verified, Assumptions, Risks).

### Task 12: Module documentation

**Files:** Create `docs/modules/tobacco.md`, `docs/modules/seedbed.md`; Modify CLAUDE.md (the Docs line lists `docs/modules/`).

Each file has the same sections: Purpose, Screens (route, permission, what each does), Data (tables and key columns), Rules and calculations (including the seedling cost split and the legacy behavior), Costs, Permissions, Brain lookups, Tests (file names and what they pin), Known limits, Not verified. Tobacco's file describes the whole tobacco workflow as built (seedbeds, operations, transplanting, harvest, curing, grading, marketing, contracts, funding, pipeline) and how it receives seedlings from the Seedbed module. Claims are checked against the code and tests, not written from memory.

- [ ] **Step 1:** Write both files from the final code; verify every file path, route and function name mentioned exists (`grep`).
- [ ] **Step 2:** Run the four verification commands; commit `docs: module guides for tobacco and seedbed`.
