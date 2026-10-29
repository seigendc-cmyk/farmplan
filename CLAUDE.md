# farmPLAN Tobacco — Zimbabwe

Offline-first, multi-tenant tobacco production and contract-farming app. Tauri 2 + React 19 + TypeScript + Vite + Tailwind 4, local SQLite via sql.js (persisted to IndexedDB), cloud sync to Supabase/Postgres. Owner: Lovemore (Harare). Work iteratively, one phase at a time; explain trade-offs briefly and ask before large or irreversible choices.

## Commands
- `npm run dev` (browser, :1420) · `npm run typecheck` · `npx vitest run` · `node tests/migration.test.mjs` (PGlite: migrations + RLS) · `npm test` (both) · `npm run build` (typecheck + bundle)
- `bash tools/hub-harness/run.sh` compile-tests the Rust hub transport. `npm run tauri dev` needs Rust + Tauri prerequisites (not available in the original build sandbox, so desktop packaging is unverified).
- `npx tsx tools/brain-bench/bench.ts --url http://127.0.0.1:11434 --model qwen2.5:3b-instruct` measures the local model (add `--mock` to test the script).
- Before saying anything is done: typecheck, all vitest tests, migration test and build must pass.

## Architecture (read before changing things)
- `src/db/` schema (`SCHEMA_VERSION`, DDL, `bi_*` views), `database.ts` (`Db`: `tx`, `insert/update/softDelete`, `journal`, outbox, `SYNC_ORDER`), `migrations.ts` (in-place upgrades, `grantOnce`), `activity.ts` (event capture, `NOT_LOGGED`).
- `src/services/` business rules (seedbed: `traytypes.ts`, `trays.ts`, `seedlingcost.ts`). Every function takes `Ctx`, calls `require(ctx, 'perm')`, mutates inside `db.tx`, and writes through `db.insert/update/softDelete` so the outbox, hub log and activity log stay correct. Costs are derived from events (`addCost`), never retyped.
- `src/brain/` the business brain chat: a fixed `CATALOGUE` of safe lookups, engines (keyword rules, local model, Claude opt-in), `askBrain`. Engines only CHOOSE a lookup and parameters; numbers always come from the fixed queries. Never let a model write SQL for the local path.
- `src/pages/` one screen per file; `src/ui/kit.tsx` shared components; `src/lib/permissions.ts` permission keys, system roles, per-phase grants, brain access levels.
- `supabase/migrations/` numbered SQL, never applied to a live project from here. `src-tauri/` Rust shell (Wi-Fi hub is a thin HTTP server that forwards to the TypeScript `hubHandle`, which holds all rules).
- Docs: `README.md` (per-phase notes, apply order, known limits), `docs/NEXT_PHASES.md`, `docs/BRAIN_ARCHITECTURE.md`, `docs/POLISH_PROMPTS.md`.

## Rules that must not be broken
- Tenant isolation lives in Postgres (RLS + composite `(tenant_id, id)` FKs), not just the UI. Each migration replaces `default_role_permissions()` and back-fills `role_permissions`; add a PGlite test block to `tests/migration.test.mjs` for every migration.
- New permission → add to `PERMISSION_GROUPS`, add a `PHASEn_GRANTS` map, spread it into `SYSTEM_ROLES`, apply it once in `runMigrations` (`if (from < n) grantOnce(...)`), bump `SCHEMA_VERSION`, and update the `schema_version` assertion in `src/services/phase2.test.ts`.
- New synced table → DDL, `SYNC_ORDER` (FK order), cloud migration with RLS + audit/stamp triggers, `BOOL_COLS` if it has booleans, and decide `HUB_WRITE_TABLES` / `HUB_NO_READ`.
- Access to the activity log goes through `accessFilter(ctx)` only. Event sentences never contain prices or pay.
- The app records what was applied; it never prescribes chemical rates.
- Seedbed is its own module (schema v19, cloud 0021): `seedbeds.kind` open_bed|float_bay, `tray_types`, `seedbed_trays`, `tray_id` on operations/cost_entries/transplants, `transplants.crop_season_id`. Tray work and every cost come from events via `addCost` (own `tray_id` or the bay's shared cost, split by counted seedlings, exact cents); seedling cost carried to a field is DERIVED in `src/services/seedlingcost.ts` (never stored; one owning season per transplant: `COALESCE(crop_season_id, season_id)`). Brain lookups `seedbed_cost`, `cost_per_seedling`, `tray_survival`, `bay_operations` are fixed queries over those services. Legacy tobacco beds now attribute seedbed cost to fields too (field cost up, shared cost down, total unchanged).
- Postgres gotcha: `INSERT … RETURNING` also needs SELECT rights under RLS.
- Keep code style: compact, typed, no new dependencies without a reason; tests for every invariant; jsdom UI tests follow `src/ui.buyers.test.tsx` (sql.js wasm mock, `window.confirm = () => true`).

## Known limits (do not claim otherwise)
Last-writer-wins sync; per-device code ranges; hub not verified on real Android/Wi-Fi; no bundled local-model launcher; local model speed/accuracy unmeasured on real hardware; Claude API key stored on device; visual review is limited to headless-Chromium walk-throughs (Oct 2026 polish round; seedbed module at 1280/390 px), nothing on a real device or the desktop build. Seedbed known limits: README "Seedbed module".
