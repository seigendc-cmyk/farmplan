# Claude Code prompts — next phases

Run these in Claude Code from the project root, one phase at a time. After each: `npm test && npm run build`.

## Phase 2 — Harvest, curing, storage (traceability chain) — ✅ DONE (kept for reference)
Context: read README.md, supabase/migrations, src/services/operations.ts and src/db/schema.ts first. Follow the same patterns: services take `Ctx`, call `require(ctx, perm)`, mutate inside `db.tx`, journal via `db.insert/update/softDelete`, mirror every table in SQLite and a new Supabase migration `0003_*.sql` with composite tenant FKs and RLS (extend the policy loop). Add permissions to `src/lib/permissions.ts` and the system roles in both TS and SQL (`claim_tenant`).

Build:
1. Transplanting: `transplants` (seedbed -> field, count, spacing, labour, mortality, gap filling). Seedbed `available_seedlings` becomes actual − sum(transplanted); block over-transplanting.
2. Harvest batches `H-00001` (field, variety, priming/leaf position, green weight, labour, barn destination) with per-season sequential IDs.
3. Barns register + preparation checklist; a curing cycle cannot become `ready` until every required check is complete.
4. Curing cycles `C-00001`: load (batch -> barn, green weight, fuel opening balance from inventory), temperature/ventilation/fuel logs (fuel use consumes inventory and creates `curing` cost), dedicated curing dashboard (current/min/max temp, fuel opening/used/remaining), offload (cured weight, loss, recovery %).
5. Starking: slate packs and piles with maturity start, age, expected opening date and a "next action" status.
Add tests for every invariant (weights, stock, state transitions) and a UI flow test like `src/ui.test.tsx`.

## Phase 3 — Grading, baling, marketing, contracts
**3a (grading, bales, sales), 3b (contract programmes) and 3c (invitations + read-only portal) are DONE.**
Grade catalogue (configurable data, no hard-coded Zimbabwe grades), grading lots with input≈output weight check and variance flag, bales with QR/barcode `TB26-F04-B000123` carrying full lineage, marketing lots and sales (price/kg, deductions, net, payment), revenue by grade/field/variety. Contract programmes, contractor/extension invitations UI (use `access_invitations`, `accept_invitation`, `access_grants`; the farmer picks the exact permission keys), contractor portal read views.

## Phase 4 — Field terminal (DONE via cloud relay; LAN hub deferred)
Built: PWA field terminal, join-farm flow, staff enrolment, device-tagged codes, labour and weather capture. Not built: the Tauri LAN hub described below — add only if farms need sync without internet.

Original brief:
Lightweight PWA with big-button capture (labour, operation, fertilizer, chemical, rainfall, observation, harvest). Office app exposes a LAN endpoint (Tauri command + embedded HTTP server) that accepts outbox batches; devices authenticate with a per-device token minted in Settings. Reuse `syncNow` push/pull semantics against the local hub.

## Phase 5 — Planning, finance and BI (DONE)
Built: budgets (plan vs actual), profitability, season vs season, rainfall vs yield, validated natural-language BI. Not built: cost allocation of shared costs, prose summaries of BI results, LAN hub.

Original brief:
Plan vs actual and season-vs-season, profitability (cost/ha, cost/kg, margin), weather module with rainfall-vs-yield, natural-language BI over the local SQLite using a read-only SQL view layer and the Claude API (validate generated SQL is SELECT-only against whitelisted views).

## Phase 6 — Machinery (DONE)
Register, use/fuel/service logs, cost flow, service-due flag, field-terminal tile, BI view. 

## Phase 7 — Shared-cost allocation (DONE)
Per-category rules (area / green kg / kg sold / none), cent-exact allocation, full cost and full margin per field. 

## Phase 8 — Wi-Fi hub (DONE, device-verification pending)
Office PC hub, one-time pairing, device keys, change-feed sync, write allow-list, Rust thin shell. Still open: BI prose summaries, hub log pruning, TLS/Tauri HTTP plugin for Android.

## Phase 9 — Buyers (DONE)
Register with terms, credit limit, default deductions and settlement details; buyer on sales with credit warning; auto-link of typed names; per-buyer sales and prices, ageing, grade-adjusted comparison. Still open: buyer statements, per-buyer payment reminders.

## Phase 10 — Business brain (in progress, by layer)
* **L1 ledger + access levels — DONE** (activity log, notes, timeline, role levels, cloud `0012`).
* L2 media (photos, voice) · L3 search index (FTS) · L4 chat via Edge Function proxy (answer-only, cited, privacy tier) · L5 confirm-first actions · L6 shared event stream. See `docs/BRAIN_ARCHITECTURE.md`.

### Brain chat (L3/L4, local-first) — DONE, device-verification pending
Catalogue + keyword router + local model engine + Claude opt-in + Ask the brain page. A text index was skipped on purpose: `LIKE` search is fast enough at farm scale (sql.js has FTS4 if ever needed). Still open: bundled model sidecar and hardware check, Edge Function key proxy, multi-turn follow-ups, more catalogue entries, L2 media, L5 confirm-first actions, L6 shared stream.

## Polish round (from the October 2026 browser walk-through)
Order agreed with the owner, one phase at a time, full check suite after each:
* **H — browser walk-through (DONE)**: 1440 px and 390 px, every page and Add/Record modal. Main findings: the sidebar never collapses (166 px of content on a phone), headers and tables clip, 8 of 18 modals leave focus behind, grey text below AA contrast, two "Ask" screens.
* **A — connected records (DONE)**: record links everywhere, a page per field, revenue/margin only with finance permissions, field activity via `accessFilter`. No database changes.
* **B — needs attention (DONE)**: Dashboard list from existing calculations, role-filtered, each item opens its record; tiles open their module. Low stock = out of stock until inputs get a reorder level (schema change, not done).
* **C — phone layout (DONE)**: drawer / foldable sidebar, wrapping headers, 2-column stats, tables scrolling in their cards, 390 px pop-ups, AA grey, visible disabled reasons, plurals, honest sync wording, sign-in opens the Dashboard.
* **F + G — one Ask screen, keyboard-safe pop-ups (DONE)**: `/ask` (brain first, Claude fallback behind `brain.chat.cloud`, `/brain` redirects); modal focus in / trapped / returned, Escape closes only the top pop-up; hints are descriptions, not names.
* **E — brain lookups (DONE)**: contract delivery vs target, stock on hand, seedbeds, storage ready, service due, overdue obligations; 24 eval questions, keyword router 100% on 82; HOLDOUT_SET untouched (17/18).
* **Reorder levels + reload keeps sign-in (DONE)**: schema v13, cloud `0014_reorder_level.sql`; low stock on Inventory, Dashboard and the brain; per-tab session (12 h, ends on sign-out / close / deactivation).
* **D — fuel from inventory, labour / machine logs linked to operations (DONE)**: schema v14, cloud `0015_fuel_and_links.sql`; design in `docs/PHASE_D_DESIGN.md`. Still open: attaching phone entries to an operation; letting field roles push stock and cost rows through the cloud relay (an RLS decision).
* **Cloud sync of derived rows for field roles — design written, awaiting approval** (`docs/CLOUD_DERIVED_ROWS_DESIGN.md`, migration 0016): insert-only RLS for cost and stock rows tied to the originating permission and source row; plain-insert push; push order with a link pass. No code yet.
