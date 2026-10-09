# farmPLAN Tobacco — Zimbabwe

Offline-first, multi-tenant tobacco production and contract-farming system. Tobacco is the first enterprise module on the farmPLAN platform (seasons carry an `enterprise` column), so maize, cotton, livestock etc. can be added without reworking the foundation.

## Phase 1
Foundation + seedbeds + fields + inventory-linked costing.

| Area | What exists |
|---|---|
| Seasons | Create / activate / close; every production record belongs to a season; closed seasons reject new activity |
| Fields | Field register with blocks, area, soil, crop history, tenure, GPS, production history |
| Seedbeds | Register, auto IDs, area from dimensions, status, seedling output, achievement %, cost per 1,000 seedlings |
| Operations diary | One atomic transaction per activity: operation + input lines + stock consumption + cost entries (inputs, labour, machinery). Reversible |
| Inventory | Input catalogue, purchases (batch/expiry), weighted-average costing, audited stock adjustments, no negative stock |
| Costs | Season cost by category, by field (cost/ha), by seedbed |
| Access | Menu-driven RBAC (view/create/edit/record/delete per menu), custom roles, PIN logins, audit trail. Cost data is withheld from roles without `finance.cost.view` |
| Sync | Outbox journal, FK-ordered push, cursor pull, last-writer-wins, soft-delete propagation, backup/restore file |
| Cloud | `supabase/migrations`: tenancy, composite tenant FKs, RLS on every table, invitations + scoped grants, stock guard, audit |

## Phase 2 — the traceability chain
Transplanting → harvest batches → barns → curing cycles → starking.

| Area | What exists |
|---|---|
| Transplanting | Seedbed → field with spacing, mortality, gap filling; seedbed availability = produced − planted; over-planting blocked; plants/ha by field |
| Harvest | Coded batches `H-00001` (field, variety, priming, leaf position, green kg, labour, transport); kg/ha yield by field |
| Barns | Register + per-barn performance (recovery %, fuel and cost per kg cured) |
| Curing cycles | `C-00001`; 9-item preparation checklist gates loading; one open cycle per barn; barn capacity check; fuel allocated from inventory; temperature / ventilation / fuel logs; curing dashboard; offload with cured weight, loss and recovery %; completed cycles are immutable |
| Starking | Slate packs and piles drawn from cured weight (cannot exceed it), maturity clock, READY TO OPEN, early-open confirmation, warning for unstored cured leaf |
| Sync hardening | Rows the cloud refuses (stock/limit/permission triggers) are quarantined with a reason instead of failing the whole sync; Retry/Dismiss on **Sync & backup** |
| Cloud | `0003_curing_chain.sql`: tables, RLS, invariant triggers (transplant/storage limits, cycle transitions, close permission); backfills new permissions into existing tenants |

## Phase 3a — grading, bales, marketing
| Area | What exists |
|---|---|
| Grade catalogue | Configurable data (code, name, order, retire/reactivate); nothing pre-seeded; cannot delete a grade once used |
| Grading | Opened storage unit → grading lot `G-00001` → weight per grade + waste; input vs output check with a 2% tolerance, larger differences need a written explanation and are flagged; one grading per unit; labour costed; grade mix (% of cured leaf per grade) |
| Bales | Created in batches from graded output (cannot exceed graded weight); QR-ready codes `TB26-F04-B000123` (season year, dominant field, serial); printable QR label; scan/type a code to trace lineage field → harvest → barn/cycle → storage → grading → sale |
| Marketing | Marketing lot/sale `ML-00001`: per-bale price/kg, itemised deductions, gross/net, part-payments, reversal; revenue per kg, per ha, by grade, by field, by variety |
| Cloud | `0004_grading_marketing.sql` (bale-weight and deduction triggers, one grading per unit, one sale line per bale, RLS, role backfill) |

## Phase 3b — contract programmes
| Area | What exists |
|---|---|
| Contractors | Register with contact details; cannot be deleted while they have contracts |
| Contracts | `CT-00001` with contractor's own contract number, season, variety, contracted area, target kg, signing date, delivery deadline, fields under contract, extension services, production and delivery obligations; draft → active → settled / cancelled |
| Advances | Inputs supplied (received into stock at the advance value, so later field costs use the true price; removal blocked once used), cash and service advances |
| Obligations | Dated checklist with overdue flags |
| Deliveries | A sale can be recorded "under contract"; delivered kg, % of target, kg per contracted ha and net value roll up per contract |
| Settlement | Owner-level permission: delivered value − advances recovered − other deductions = net payable; unrecovered advances recorded as a shortfall; reopen possible; settled contracts lock their deliveries, advances and obligations |
| Cloud | `0005_contracts.sql`: tables, RLS, settle-permission trigger, one settlement per contract, arithmetic checks inside the row so offline sync order cannot break it |

## Phase 3c — contractor / extension access

| Area | What you get |
|---|---|
| Invite | Users & access → *Contractor & extension access*: sign in to the cloud, pick Contractor / Extension preset or tick exact menus, optional access duration. A one-time code (`<id>.<secret>`) is shown once; send it by WhatsApp or email. |
| Safety | View-only. Sensitive menus (costs, sales, contracts) are off by default and flagged. Codes are single-use, tied to the invitee's email, and only a hash is stored. Withdraw access or cancel an invitation at any time. |
| Portal | Login/setup screen → *Contractor / extension portal*: sign in or create an account, paste the code, choose a farm, browse read-only tables for only the granted menus. |
| Cloud | `0006_sharing.sql`: invitation RPCs, `my_access`, `revoke_access`, members-only `has_perm`, and read-only `portal_*` views that omit every cost column and reject writes. |

Limitations: season-scoped grants are not enforced by RLS (farm scope only); grantees see all records in a granted category, not just contract-linked ones; invitation codes are not emailed automatically; Supabase email-confirmation settings may affect portal sign-up.

## Phase 4 — field terminal (cloud relay)

| Area | What you get |
|---|---|
| Field terminal | Mobile-first big-button screens: Fertilizer, Chemical, Field work (stock is deducted), Harvest (issues a batch code), Rainfall, Observation, Labour. Works offline; a Sync button shows what is waiting. Installable as a PWA (`manifest.webmanifest`, `sw.js`); it opens with no signal once visited. |
| Joining | On a blank phone: *Join it as a field device* → cloud sign-in → pick the farm → name the device, choose a PIN. The phone gets the farm's roles and data and signs in locally with the person's own PIN and cloud role. |
| Staff | Users & access → *Field staff & devices*: enrol a staff member's cloud account by email and role, see their devices, remove access instantly. |
| Device tags | The cloud issues each joined device a tag (A, B … AA). Its codes read `H-B-00007`, bales `…-BB000012`, so phones recording offline can never clash with each other or the office (which keeps `H-00007`). |
| Labour | New Labour page (Resources) and schema v5 `labour_entries`; pay flows into costs. Weather/observations are captured through the terminal. |
| Cloud | `0007_field_devices.sql`: labour table + RLS, device registry, `register_device`, `my_farms`, `add_member`, `list_members`, `set_member_active`, role-permission backfill. |

Limitations: there is **no LAN/Wi-Fi hub** — field devices sync through the cloud (a hub was not built; the sync engine is transport-agnostic, so one can be added later). Role changes made later in the cloud do not reach an already-joined phone until it is re-joined. Staff must create their own cloud account before the owner can enrol them. A phone shows data its role may view; a tagged device cannot be un-joined from the app (clear site data and re-join).

## Phase 5 — planning, finance and BI

| Area | What you get |
|---|---|
| Budgets | Finance → Budgets: planned amount per cost category per season, against actual costs (under / near ≥90% / over / unplanned), copy last season's budget scaled by a factor. Synced table `budgets` (schema v6, cloud `0008_budgets.sql`, permissions `finance.budget.view/edit`; Farm Manager gets both). |
| Profitability | Season view: total cost, net revenue (after deductions), margin, cost/ha, cost/kg sold, margin/ha; by field (field margin = net revenue − costs booked to that field; shared curing/grading/overhead are *not* allocated) and by contract. |
| Season vs season | Yield/ha, price, cost/ha, cost/kg and margin side by side. |
| Rainfall vs yield | Rain by month and rain days, by field (field-specific + farm-wide rain) against green kg/ha, and season rainfall against yield across seasons. |
| Ask your data | Plain-English questions → Claude writes **one read-only SELECT** over whitelisted `bi_*` views → validated and run **on this device** (`PRAGMA query_only`, 500-row cap). Only table and column names go to Anthropic — never farm records. Views shown depend on the user's permissions (e.g. no `bi_costs` without cost access). |

How the BI is locked down: single statement only, must start with SELECT/WITH, no comments or quoted identifiers, DML/DDL/PRAGMA words rejected, any real table name (users, outbox, audit…) rejected anywhere in the text, FROM/JOIN targets must be allowed views, one automatic repair attempt on refusal. The user's own Anthropic API key is typed on the device and stored in this browser/app's localStorage (use *Remove key* on shared devices). Calls go straight from the device to `api.anthropic.com`, so the Ask page needs internet; everything else stays offline.

Limitations: shared costs were not allocated to fields (fixed in Phase 7); revenue by field uses each bale's dominant field; rain is not interpolated between records; the BI answer is a table, not a prose summary (to avoid sending result rows to the model); a key kept in localStorage is readable by anything running in that origin.

## Phase 6 — machinery

| Area | What you get |
|---|---|
| Register | Resources → Machinery: tractors, implements, vehicles, pumps, generators with make, registration, purchase details, an hourly charge rate and a service interval. |
| Logging | Log **use** (hours × rate, or an explicit cost), **fuel** (litres, cost), **service** and **repair** (description, cost), optionally against a field. Costs flow into season costs (`machinery` / `fuel`), field costs and profitability, and reverse if an entry is deleted. |
| Fleet view | Per machine: hours, fuel, litres/hour, cost, cost/hour, last service and a **service due** flag once hours since the last service reach the interval. |
| Field terminal | New *Machine* tile: hours worked or fuel put in, offline like the rest. |
| Ask your data | New `bi_machine_logs` view (cost-aware: needs finance access). |
| Cloud | `0009_machinery.sql`: `machines`, `machine_logs`, RLS (`resources.machinery.view/record/manage`), role backfill. Schema v7. |

Limitations: the hourly rate is an internal charge, not an accounting depreciation; fuel bought into inventory and fuel logged against a machine are separate records (log fuel here for per-machine consumption, or record it as an operation input, not both); the older free-text machinery fields on operations are unchanged.

## Phase 7 — shared-cost allocation

| Area | What you get |
|---|---|
| Rules | Profitability → **Allocation rules**: for each cost category choose how costs recorded *without a field* are spread: field area, green kg harvested, kg sold, or not at all. Defaults: curing and storage by green kg; grading, baling and marketing by kg sold; everything else by area. Needs `finance.budget.edit` to change. |
| Allocation | Shared costs are spread over the fields harvested in the season, in whole cents with remainder correction so the parts always sum to the cost. Costs already recorded against a field are never touched. |
| Profitability | By-field table gains **Shared share**, **Full cost/ha** and **Full margin** beside the existing direct figures; season totals are unchanged and `unallocated_cost` shows what could not be spread (no sales yet for a kg-sold rule, or a "none" rule). |
| Cloud | `0010_allocation.sql`: `allocation_rules` with RLS on the budget permissions. Schema v8. |

Limitations: rules are farm-wide, not per season; kg-sold rules leave cost unallocated until sales exist; a user without sales access has kg-sold rules fall back to green kg; seedbed and cycle costs with no field are shared costs like any other; allocation is a reporting view and writes nothing back to cost entries.

## Phase 9 (this build) — buyers

| Area | What you get |
|---|---|
| Register | Marketing → **Buyers**: auction floors, merchants, contractor companies, private buyers. Contact person, phone, email, address, payment terms (days), credit limit, default deductions (a % of gross or a fixed amount, e.g. levy, handling), bank / settlement details, notes, active flag. |
| On a sale | Pick the buyer on *Record sale*. Their default deductions are one click away, and you see what they already owe against their credit limit; passing the limit **warns** but does not block. Inactive buyers cannot be chosen; renaming a buyer updates the name on their sales. |
| Existing data | Sales that only had a typed buyer name are turned into buyers automatically on upgrade (matched ignoring case and spaces, type guessed from the channel), or with one button. Revenue figures do not change. |
| Sales & prices | Per buyer: sales, kg, gross, net, average price, paid, owed and the average days they take to pay (weighted by amount). Price history by season and grade on each buyer. |
| Balances owed | Ageing 0–30 / 31–60 / 61+ days from the sale date, with an **overdue** column against each buyer's own terms. |
| Compare | Ranks buyers by a **grade-adjusted** price premium (their price vs the farm-wide average for the same grades, weighted by kg) so a buyer who only took your best leaf isn't flattered, alongside days to pay and balance owed. |
| Ask your data | New `bi_buyers` view; `bi_sales.buyer` now shows the register name. |
| Cloud | `0011_buyers.sql`: `buyers`, `buyer_deductions`, `sales.buyer_id`, RLS on `marketing.buyer.view` / `marketing.buyer.manage` (Farm Manager gets both), role backfill. Schema v10. |

Limitations: bank details sit in the same row as the rest of the buyer, so the app hides them from people without *manage*, but the database does not enforce column-level secrecy (anyone allowed to read buyers in the cloud can read them); buyers are never sent to phones over the Wi-Fi hub; payment speed counts only money actually recorded as paid; the credit check is a warning on the device that records the sale (two offline devices can each pass the limit); "overdue" is measured from the sale date plus terms, not from a delivery or invoice date; there is no buyer statement printout yet.

## Phase 10 — Business brain, layer 1 (activity ledger and access levels)
Everything that happens is now written to one append-only **Activity** timeline (Brain → Activity): each save becomes a plain sentence with who, when, which phone and which field, plus free-text **notes**. Search by words, person, kind, area, field and date.

* **Access levels**, set by an admin per role in *Users & access → Roles & permissions → Business brain access*: None · Own activity · Operations · Management (+ finance) · Full (+ users, roles, devices). The buttons only touch the five `brain.*` permissions; custom mixes remain possible.
* One rule (`accessFilter`) decides what any reader may see; the timeline, and later the chat, must go through it.
* Existing farms get a back-filled history on upgrade (schema v11). Events sync to the cloud (`0012_activity_log.sql`: append-only, RLS by domain level, uploader stamped) and flow phone → office over the Wi-Fi hub, which never serves the log back to phones.
* Limits and the layer plan (media, search index, chat, actions, shared brain): `docs/BRAIN_ARCHITECTURE.md`.

## Phase 11 — Business brain, chat (local-first)
**Brain → Ask the brain**: plain-language questions answered by a *fixed catalogue* of checked lookups (harvest per field, rain by month, costs, cost per ha, budget vs actual, price by grade, sales by buyer, who owes, bales, curing, labour hours, fuel, recent operations, recent activity, note search). An engine only **chooses** the lookup and its parameters; the numbers always come from the tested query, run on this device under the person's own access.

* **Engines:** keyword matching (always works, no model) · local model via llama.cpp server or Ollama (OpenAI-compatible, JSON-schema-constrained routing; optional wording of the answer, rejected if it contains a number not in the table) · Claude (opt-in per question; only the question and table/field names leave the device, never records). A down or confused local model quietly falls back to keywords.
* **Access:** `brain.chat.ask` (Farm Manager by default) lets someone use the chat; each lookup also needs the data permissions behind it, and activity questions obey the activity access level. `brain.chat.cloud` (Owner only by default) allows sending a question to Claude, including the open-ended "Ask Claude instead" path.
* **Local model setup (8 GB, no GPU):** install Ollama, `ollama pull qwen2.5:3b-instruct`, set `OLLAMA_ORIGINS=*` so the app may call it, then Engine settings → *Use a local model* → Test connection. Expect a few seconds per answer.
* **Measure it on your machine:** `npx tsx tools/brain-bench/bench.ts --url http://127.0.0.1:11434 --model qwen2.5:3b-instruct` seeds a busy demo farm and reports lookup speed, how often the model picks the right lookup (on 76 questions, 18 of them never used to tune the keyword rules), how it compares with plain keyword matching, answer-wording speed, and a plain verdict. `--mock` checks the script itself without a model.
* Cloud: apply `0013_brain_chat_perms.sql`. Schema v12.
* Limits: the app does not yet start/stop the model for you (no bundled sidecar); speed and quality are untested on real 8 GB hardware; the catalogue is a fixed list, so unusual questions get "no match" unless Claude is allowed; the Claude key is stored on the device as in Phase 5 (an Edge Function proxy is planned).

## Connected records (polish A)
Record codes are links wherever they appear: field numbers, harvest batches, curing cycles, storage units, grading lots, bales, sales, contracts and registered buyers. A link opens the record's own page with its row highlighted, switches the season picker to that record's season, and for cycles, sales, contracts and buyers opens the detail straight away. Links show as plain text to roles that may not open the target page (`src/services/links.ts` → `locate`).

* **Field page** (`/fields/F-04`): one field, every module, per season: planting, field work, harvest → curing cycle, bales → sale, labour, machinery, rain (this field plus farm-wide records), direct costs by category, and the field's activity and notes. Each section follows the permission of its own module; costs, pay and machine cost need `finance.cost.view`; **revenue and margin need both `finance.cost.view` and `marketing.sale.view`** (sold kg alone needs only sales access). Activity is read through `listActivity`, so `accessFilter` decides which events appear. It replaces the old operations-only History pop-up.
* Bale trace, cycle detail, sale detail, contract statement and buyer detail (now with recent sales) link onward along the chain; Activity rows link to their field, and `/activity?field=<id>` opens the timeline filtered to one field.
* No database changes. Tests: `src/services/links.test.ts` (lookup, permissions, field page sections, finance gating, activity access), `src/ui.links.test.tsx` (click-through across seasons).

## Needs attention (polish B)
The Dashboard's **Needs attention** list is built from rules the modules already have (`src/services/attention.ts`), most urgent first:

| Tone | What | Opens |
|---|---|---|
| red | Records the cloud refused (sync conflicts) | Sync & backup |
| red | Contract obligations past due; active contracts past their delivery deadline | the contract statement |
| red | Buyers with money overdue against their payment terms | the buyer |
| red/amber | Inputs out of stock or at/below their reorder level ("low"); expired or expiring within 90 days | the product row in Inventory |
| amber | Green leaf picked 2+ days ago and not loaded into a barn | the harvest batch |
| amber | Cured leaf not yet stored | the curing cycle |
| amber | Budget categories over budget this season | the budget line |
| amber | Machines due for a service | the machine |
| blue | Storage ready to open; opened units waiting to be graded; graded leaf not yet baled | the storage unit / grading lot |

Each check runs only when the person's role can open that module, and money appears only with the finance and sales permissions. Dashboard tiles open their module. Low stock uses each input's reorder level (see below). Tests: `src/services/attention.test.ts`, `src/ui.attention.test.tsx`.

## Phone layout (polish C)
* **Sidebar:** below 768 px it is a drawer behind a menu button in a slim top bar (`aria-expanded`, focus moves into it, Escape / backdrop / choosing a page closes it and focus returns to the button; while closed it is `inert`, so Tab cannot reach it). On a desktop it can be folded away («) and back; that choice is a per-device convenience in `localStorage` (`fp.sidebar.folded`). The current page's menu item is kept in view.
* **Pages:** headers wrap (title first, then actions); stat rows are 2 columns on a phone; wide tables scroll inside their card with an edge shadow showing there is more; pop-ups use the full width (8 px margin) with a larger close button. A guard test (`src/layout.lint.test.ts`) fails if a 3+ column grid has no breakpoint.
* **Clarity:** a disabled button shows its reason under it (`<Button reason="…">`, tied with `aria-describedby`); grey text raised to AA contrast; "1 field"; the sync line says "saved on this device · cloud sync not set up" when no cloud is configured; every sign-in opens the Dashboard rather than the previous person's page.
* Verified in Chrome at 390 px and 1440 px (content 390 px wide, no page-level horizontal scroll, every pop-up 374 px). Tests: `src/ui.layout.test.tsx`, `src/ui.layout.phone.test.tsx`.

## One Ask screen and keyboard-safe pop-ups (polish F + G)
* **Brain → Ask** (`/ask`) replaces *Finance → Ask your data* and *Brain → Ask the brain*; `/brain` redirects to it. The business brain answers first (fixed lookups, `brain.chat.ask`). When it has no match, **Ask Claude instead** is the next step; on a matched answer a quieter "Not what you meant?" link offers the same. Claude's answer shows its table and, on request, the query.
* **Access:** sending a question to Claude needs `brain.chat.cloud` (Owner by default), the rule the brain already used; Claude's query still sees only the `bi_*` views the role may read. The old *Ask your data* screen let anyone with `finance.cost.view` use Claude, so **a Farm Manager no longer has the Claude path** unless an admin grants `brain.chat.cloud`. A role with only `brain.chat.cloud` asks Claude directly. The Anthropic key and model moved into *Engine settings → Claude (fallback)* (still stored on this device; *Remove key* appears only when a key is stored).
* **Pop-ups (`Modal`):** focus moves in on open (an `autoFocus` field wins, otherwise the first field), Tab and Shift+Tab stay inside, Escape closes only the topmost pop-up (nested ones such as *Load barn* no longer close their parent), and focus returns to the control that opened it. Checked in Chrome: all 17 pop-ups at both widths take focus.
* **Labels:** a field's hint is now its description (`aria-describedby`), not part of its name.
* Tests: `src/ui.ask.test.tsx`, `src/ui.modal.test.tsx`, updated `src/ui.phase5.test.tsx` and `src/ui.brainchat.test.tsx`.

## More brain lookups (polish E)
Six catalogue entries (22 in all), each reading through the same service as its page so the brain, the screens and the Dashboard's attention list agree, and none returning money:

| Lookup | Answers | Needs |
|---|---|---|
| `contract_delivery` | target kg, delivered kg and % per contract, with deadline | `contracts.contract.view` |
| `stock_on_hand` | inputs with quantity on hand and next expiry | `resources.inventory.view` |
| `seedbeds_status` | seedbeds: sown, expected/actual seedlings, achievement, available | `production.seedbed.view` |
| `storage_ready` | maturing units, ready ones first, days still to wait | `curing.storage.view` |
| `service_due` | machines with hours since service, interval, due yes/no | `resources.machinery.view` |
| `obligations_overdue` | open contract obligations past their due date | `contracts.contract.view` |

The main eval set grew from 58 to 82 questions (keyword router: 100%); the unseen `HOLDOUT_SET` was not touched or tuned against and still scores 17/18. Tests: `src/brain/lookups.test.ts`.

## Reorder levels and staying signed in (schema v13)
* **Reorder level** per input (Inventory → New/Edit product, in the input's unit; empty = not tracked). At or below it the product shows **low** on Inventory, as an amber Dashboard item ("Compound C is low: 12 kg left (reorder at 20)") and in the brain's stock lookup ("what are we low on"). Setting it needs `resources.inventory.manage`. Inputs are shared by a tenant's farms, so the level is too; stock is still counted per farm. Cloud: `0014_reorder_level.sql` (column + non-negative check; RLS unchanged; no new permissions, nothing re-granted). **Apply 0014 only after every device runs this version:** an older device fails to pull rows that carry the new column.
* **Reload keeps you signed in:** the sign-in is kept per tab (`sessionStorage`), so a reload stays on the same page. It ends on Sign out, when the tab or app window closes, after 12 hours, or if the user has been deactivated (the role's current permissions are re-read). A fresh sign-in still opens the Dashboard.
* Tests: `src/services/reorder.test.ts`, `src/ui.session.test.tsx`, the 0014 block in `tests/migration.test.mjs`.

## Phase D — fuel from inventory; labour and machine logs linked to operations (schema v14)
Design and reasoning: `docs/PHASE_D_DESIGN.md`. Decisions taken: fuel input lines are refused only when a machine line has litres; old operations are left untouched; each machine has a default fuel product, overridable per log; phone entries are not attached to operations yet.

| Area | What you get |
|---|---|
| Fuel | Machinery → a machine's **Fuel product**. A fuel log, or a use log with litres, draws the litres from that stock at the average cost (one consumption + one `fuel` cost, like curing). "Bought outside the store" keeps a typed cost and leaves stock alone. Deleting a log puts the litres back. The field-terminal Machine tile draws from stock the same way. |
| Operations | Record operation has **Workers** lines (name, hours, pay) and **Machines** lines (machine, hours, litres) instead of the free-text labour and machinery boxes. They become labour entries and machine use logs linked to the operation, in one transaction; costs come only from those, so nothing is booked twice. Machine hours on operations now count towards service-due. Deleting the operation reverses its entries, logs, stock and costs. |
| Guards | Retired boxes are refused for new operations; a fuel input line is refused when a machine line has litres; worker / machine lines need `resources.labour.record` / `resources.machinery.record`. |
| Old data | Operations recorded before v14 keep their labour/machinery values and cost rows (season totals unchanged); they show "Machine (old entry)" and never count as machine hours. Old fuel logs are not drawn from stock retroactively. |
| Cloud | `0015_fuel_and_links.sql`: five nullable columns with composite tenant FKs, and a trigger that a log's fuel draw matches its stock movement (same farm, product and litres, made by that log). RLS and permissions unchanged. **Apply after every device runs v14.** |

Fixed by cloud migration 0016 (next section). Before it: over the **cloud relay**, a phone signed in with a field role (e.g. Field Recorder) cannot insert stock movements (`resources.inventory.manage`) or cost rows (`finance.cost.edit`) in the cloud, so those rows are quarantined on the phone. This already applied to operation inputs and labour pay; machine fuel now hits it too. Over the **Wi-Fi hub** it does not apply (the office PC syncs everything under its own account). Tests: `src/services/phaseD.test.ts`, `src/ui.phaseD.test.tsx`, the 0015 block in `tests/migration.test.mjs`.

## Field roles sync their derived cost, stock and activity rows (cloud 0016; app schema unchanged)
Design and decisions: `docs/CLOUD_DERIVED_ROWS_DESIGN.md`. A security change that adds insert paths only.

| Area | What you get |
|---|---|
| Cloud | `0016_derived_rows_insert_only.sql`. A cost row or stock **consumption** may be inserted by anyone holding the permission of the record it comes from (e.g. `resources.machinery.record` for a machine log's fuel), when its source type, category, product and quantity match a source row in the same tenant and farm. A permissive policy beside the existing one: no new select, update or delete rights; default role permissions unchanged, nothing back-filled. Rules follow permissions, not role names (a custom role with `quality.grading.record` may insert grading labour; a Farm Manager, who has no `finance.cost.edit`, now syncs labour costs too). |
| Reversals | `cancel_derived(table, tenant, id, source_type, source_id)` (security definer, returns nothing) soft-deletes one derived cost/stock row only when its source record is already soft-deleted in the same tenant and farm, the row's source matches, and the caller is an active member with the originating permission. The phone calls it when it re-sends a deleted derived row. |
| Stock guard | Sums stock whatever the caller may read (a mechanic without `resources.inventory.view` can draw fuel), refuses non-members and other tenants first, and says only "Insufficient stock", never a quantity. |
| Phone | Cost and stock rows go as **plain inserts** when the role lacks `finance.cost.edit` / `resources.inventory.manage` (or after the cloud's first RLS refusal of an upsert); activity events always do. A duplicate id counts as sent only when `row_sent` confirms the id is a row of this tenant. An edit (not a deletion) of a derived row already in the cloud is quarantined with "a person with … must apply it". Push order: source records, then stock movements, then the rows that point at them (operation inputs, contract advances, machine/curing logs re-sent with their fuel link), then costs and events. Over the Wi-Fi hub nothing changes. |

**Apply 0016 together with this app build.** Phones on an older build keep sending upserts, which stay refused (quarantined, as before) until they update; then **Retry** on Sync & backup resends them. Tests: the 0016 block in `tests/migration.test.mjs`; `src/services/sync.derived.test.ts` (an RLS-aware fake cloud).

## Modules — the farm chooses what it farms (Platform Step 0, schema v15)
| | |
|---|---|
| What | A farm lists the **modules** it uses (`farms.modules`, comma-separated ids from `src/modules/registry.ts`). Every existing farm keeps `tobacco`. Only Tobacco is available today; Horticulture, Orchards, Field crops, Tree nursery and Livestock appear on **Settings → Modules** as "coming soon" (disabled). |
| Who | Permission `settings.modules.manage` (Owner via `*`; not granted to other roles, nothing back-filled). `setFarmModules` refuses an empty list, unknown or unavailable modules, and switching a module off while it has an active season. |
| Module picker | Shown in the sidebar only when the signed-in person can use two or more enabled modules. The choice is per device (`localStorage` `fp.module`) and lives in `ctx.module`. The Tobacco menu groups (Production, Curing, Quality, Marketing, Contracts) show only in the Tobacco module; shared groups stay. |
| Seasons | A module is identified by `seasons.enterprise`. **One active season per module** (before: one per farm): `createSeason`, `setSeasonStatus` and `activeSeason(ctx, module = currentModule(ctx))` only touch the module's own seasons. Shared tables are not tagged; a record's module comes from its season. |
| Cloud | `0017_farm_modules.sql`: `farms.modules` with a format check and a trigger so only `settings.modules.manage` can change it (a farm editor can still rename the farm). Default role permissions unchanged. **Apply after every device runs v15.** |
| Tests | `src/services/modules.test.ts`, `src/ui.modules.test.tsx`, the 0017 block in `tests/migration.test.mjs`. |
| Not verified | Not looked at in a real browser; the picker with two modules is tested by setting the farm's modules in data, because no second module can be switched on yet. |

## Phase 8 — Wi-Fi hub (no internet)

| Area | What you get |
|---|---|
| Hub | Users & access → **Wi-Fi hub** (desktop app, office computer): switch on, see the address phones should use (for example `192.168.1.20:7878`). The office PC stays the master copy and still syncs to the cloud whenever it is online; phone records ride along. |
| Pairing | Create a one-time 6-digit code for a named phone and role (never Owner). It works once and expires after 10 minutes; five wrong guesses lock every pending code. The phone enters address + code under *Join a farm → Farm Wi-Fi hub*, gets a secret device key and a tag (`LA`, `LB`…, so offline codes such as `H-LA-00007` never clash) and downloads the farm. |
| Syncing | The same engine as the cloud relay, pointed at the hub: one tap on the phone's Sync screen, no password. A monotonic change feed (not row timestamps) means a phone never misses a record another phone sent late. |
| Safety | Hub requests need a device key (stored hashed); remove a phone to cut it off at once. Phones may only write field-capture tables (operations, inputs, stock movements, costs, rain, harvest, labour, machine logs); anything else is quarantined on the phone, not silently dropped. A bad record rejects its whole request and nothing is half-applied; column names are validated so a phone cannot inject SQL. |
| Architecture | Rust is a thin HTTP shell (`src-tauri/src/hub.rs`): it parses a request, emits it to the web view and writes back the reply. Every rule lives in `src/services/hub.ts`, so it is tested without a network. |
| Local only | `hub_log`, `lan_pairings`, `lan_devices` (schema v9, no cloud migration). |

Verification: the protocol, pairing, ordering, safety and a full phone-pairs-captures-syncs UI flow are covered by vitest. The Rust listener's HTTP handling is compile-tested and exercised over real TCP by `tools/hub-harness/run.sh`. **Not verified here:** the Tauri wiring (event emit, commands, capability file) and anything on real devices. Before relying on it, check on your hardware:
1. `npm run tauri dev` on the office PC; switch the hub on; the Windows firewall prompt appears; allow private networks.
2. From a phone browser on the same Wi-Fi, open `http://<address>:7878/hello` — you should see `{"app":"farmplan-hub","v":1}`.
3. **Android phones:** the phone app talks plain `http://` to the hub. Android blocks cleartext traffic by default in release builds, so enable it for the app (Android `usesCleartextTraffic`), or route requests through Tauri's HTTP plugin (native, not subject to that rule). This is the most likely thing to need a tweak.
4. Pair a phone, record rain, Sync; confirm it appears on the office PC and, after the PC syncs, in the cloud.

Limitations: the hub is plain HTTP on the farm Wi-Fi (the device key and data are not encrypted in transit; use a trusted network); phones can read every synced farm table, so pair only trusted devices (cloud RLS per-permission reads do not apply over the hub); role changes do not reach paired phones until they are re-paired; the hub runs only while the office app is open; a phone is not auto-discovered, so staff type the address (shown in the hub tab) once and it is remembered; the hub accepts up to 26 phones; `hub_log` grows with activity and is not yet pruned.

## Run
```bash
npm install
npm run dev          # browser preview at http://localhost:1420
npm test             # service, sync, hub, buyers, upgrade and jsdom UI flow tests
bash tools/hub-harness/run.sh   # Rust hub transport check (needs only Rust)
node tests/migration.test.mjs   # Postgres (PGlite) migration + RLS tests
npm run build        # type-check + production bundle
npm run tauri dev    # desktop app (needs Rust + Tauri prerequisites)
npm run tauri build  # installers
```
Data is stored in a local SQLite database (sql.js, persisted to IndexedDB inside the Tauri webview; Phase 2 moves persistence to a native file).

## Supabase
Apply `supabase/migrations/0001_foundation.sql`, `0002_claim_tenant.sql`, `0003_curing_chain.sql`, `0004_grading_marketing.sql`, `0005_contracts.sql`, then `0006_sharing.sql`, `0007_field_devices.sql`, `0008_budgets.sql`, `0009_machinery.sql`, `0010_allocation.sql`, `0011_buyers.sql`, `0012_activity_log.sql`, `0013_brain_chat_perms.sql`, `0014_reorder_level.sql`, `0015_fuel_and_links.sql`, `0016_derived_rows_insert_only.sql`, `0017_farm_modules.sql` (SQL editor or `supabase db push`). Create a user (Auth), then in **Sync & backup** enter project URL, publishable key and credentials. The device claims its local tenant id via `claim_tenant`, pushes, then pulls.

## Design rules
- Everything is an event: purchases, applications, operations create linked ledger rows; costs are derived, never retyped.
- The app records what was applied; it never prescribes chemical rates (they come from the label and your agronomic protocol).
- Tenant isolation is enforced in Postgres (RLS + composite `(tenant_id, id)` foreign keys), not just the UI.
- Grade catalogue and operation types are data/config, not hard-coded structure.

## Known limits
- Conflict policy is last-writer-wins per row (device clocks matter). Custom roles/users are local; cloud member management comes with sharing.
- Contractor / extension invitations: database layer and RLS are done and tested; the invite/accept UI is Phase 3.
- Tauri packaging config is included but was not compiled in the build sandbox (no Rust toolchain).
- Sequential codes (H-/C-/SP-/SB-) are generated per device; two offline devices could issue the same code. Phase 4 adds per-device code ranges.
- Bale field/variety is the dominant source of a mixed cycle; revenue by field uses that.
