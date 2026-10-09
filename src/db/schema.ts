// Local SQLite schema. Mirrors supabase/migrations/0001_foundation.sql so rows sync 1:1.
export const SCHEMA_VERSION = 15

const common = `
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1`

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'farm', ${common});

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 0, ${common},
  UNIQUE (tenant_id, name));
CREATE TABLE IF NOT EXISTS role_permissions (
  tenant_id TEXT NOT NULL, role_id TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY (role_id, permission));

CREATE TABLE IF NOT EXISTS local_users (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, role_id TEXT NOT NULL,
  pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, ${common},
  UNIQUE (tenant_id, name));

CREATE TABLE IF NOT EXISTS farms (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, location TEXT, total_area_ha REAL,
  currency TEXT NOT NULL DEFAULT 'USD', modules TEXT NOT NULL DEFAULT 'tobacco', ${common});

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  enterprise TEXT NOT NULL DEFAULT 'tobacco', label TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','closed')), ${common},
  CHECK (ends_on > starts_on), UNIQUE (tenant_id, farm_id, enterprise, label));

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), name TEXT NOT NULL, ${common},
  UNIQUE (tenant_id, farm_id, name));

CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  block_id TEXT REFERENCES blocks(id), field_no TEXT NOT NULL, area_ha REAL NOT NULL CHECK (area_ha > 0),
  latitude REAL, longitude REAL, soil_type TEXT, soil_notes TEXT, previous_crop TEXT, current_crop TEXT, variety TEXT,
  irrigated INTEGER NOT NULL DEFAULT 0, tenure TEXT NOT NULL DEFAULT 'owned', tenure_notes TEXT, ${common},
  UNIQUE (tenant_id, farm_id, field_no));

CREATE TABLE IF NOT EXISTS inputs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('seed','fertilizer','chemical','fuel','packaging','other')),
  unit TEXT NOT NULL, supplier TEXT, default_unit_cost REAL NOT NULL DEFAULT 0,
  application_notes TEXT, safety_notes TEXT, active INTEGER NOT NULL DEFAULT 1,
  reorder_level REAL CHECK (reorder_level IS NULL OR reorder_level >= 0), ${common},
  UNIQUE (tenant_id, name));

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  input_id TEXT NOT NULL REFERENCES inputs(id),
  kind TEXT NOT NULL CHECK (kind IN ('purchase','consumption','adjustment','return')),
  qty_delta REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, batch_ref TEXT, expiry_date TEXT,
  occurred_on TEXT NOT NULL, source_type TEXT, source_id TEXT, note TEXT, created_by TEXT, ${common},
  CHECK ((kind IN ('purchase','return') AND qty_delta > 0) OR (kind = 'consumption' AND qty_delta < 0) OR kind = 'adjustment'));
CREATE INDEX IF NOT EXISTS ix_inv_input ON inventory_transactions(input_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS seedbeds (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  season_id TEXT NOT NULL REFERENCES seasons(id), code TEXT NOT NULL, location TEXT, variety TEXT,
  seed_lot TEXT, seed_supplier TEXT, bed_length_m REAL, bed_width_m REAL,
  bed_count INTEGER NOT NULL DEFAULT 1 CHECK (bed_count > 0), area_m2 REAL, prepared_on TEXT, sown_on TEXT,
  expected_seedlings INTEGER CHECK (expected_seedlings >= 0), actual_seedlings INTEGER CHECK (actual_seedlings >= 0),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared','sown','germinating','growing','hardening','ready','depleted','abandoned')), ${common},
  UNIQUE (tenant_id, season_id, code));

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('seedbed','field')),
  seedbed_id TEXT REFERENCES seedbeds(id), field_id TEXT REFERENCES fields(id),
  op_type TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'field' CHECK (phase IN ('seedbed','land_prep','field')),
  occurred_on TEXT NOT NULL, area_ha REAL, labour_workers INTEGER, labour_hours REAL,
  labour_cost REAL NOT NULL DEFAULT 0, machinery_asset TEXT, machinery_hours REAL, machinery_fuel_l REAL,
  machinery_cost REAL NOT NULL DEFAULT 0, operator TEXT, weather TEXT, remarks TEXT, created_by TEXT, ${common},
  CHECK ((target_type = 'seedbed' AND seedbed_id IS NOT NULL AND field_id IS NULL)
      OR (target_type = 'field' AND field_id IS NOT NULL AND seedbed_id IS NULL)));
CREATE INDEX IF NOT EXISTS ix_ops_season ON operations(season_id, occurred_on) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS operation_inputs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL REFERENCES operations(id),
  input_id TEXT NOT NULL REFERENCES inputs(id), qty REAL NOT NULL CHECK (qty > 0), rate_note TEXT,
  unit_cost REAL NOT NULL DEFAULT 0, inventory_txn_id TEXT REFERENCES inventory_transactions(id), ${common});

CREATE TABLE IF NOT EXISTS cost_entries (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  category TEXT NOT NULL CHECK (category IN ('seed','fertilizer','chemicals','labour','machinery','fuel','irrigation',
    'transport','curing','storage','grading','baling','marketing','overhead')),
  amount REAL NOT NULL, occurred_on TEXT NOT NULL, seedbed_id TEXT REFERENCES seedbeds(id),
  field_id TEXT REFERENCES fields(id), source_type TEXT NOT NULL, source_id TEXT, note TEXT,
  cycle_id TEXT, ${common});
CREATE INDEX IF NOT EXISTS ix_cost_season ON cost_entries(season_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS weather_records (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  season_id TEXT REFERENCES seasons(id), field_id TEXT REFERENCES fields(id), recorded_on TEXT NOT NULL,
  rainfall_mm REAL CHECK (rainfall_mm >= 0), temp_min_c REAL, temp_max_c REAL, wind_kmh REAL,
  event TEXT CHECK (event IN ('hail','frost','drought','none')), observation TEXT, ${common});

-- ---- Phase 2: transplanting, harvest, curing, starking ----
CREATE TABLE IF NOT EXISTS transplants (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  season_id TEXT NOT NULL REFERENCES seasons(id), seedbed_id TEXT NOT NULL REFERENCES seedbeds(id),
  field_id TEXT NOT NULL REFERENCES fields(id), kind TEXT NOT NULL DEFAULT 'transplant' CHECK (kind IN ('transplant','gap_fill')),
  occurred_on TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0), mortality INTEGER NOT NULL DEFAULT 0 CHECK (mortality >= 0),
  spacing_row_m REAL, spacing_plant_m REAL, labour_workers INTEGER, labour_cost REAL NOT NULL DEFAULT 0,
  weather TEXT, soil_condition TEXT, remarks TEXT, created_by TEXT, ${common});
CREATE INDEX IF NOT EXISTS ix_tp_seedbed ON transplants(seedbed_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS harvest_batches (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  season_id TEXT NOT NULL REFERENCES seasons(id), code TEXT NOT NULL, field_id TEXT NOT NULL REFERENCES fields(id),
  variety TEXT, harvested_on TEXT NOT NULL, priming INTEGER, leaf_position TEXT, labour_workers INTEGER,
  labour_cost REAL NOT NULL DEFAULT 0, green_weight_kg REAL NOT NULL CHECK (green_weight_kg > 0), bundles INTEGER,
  transport_cost REAL NOT NULL DEFAULT 0, barn_destination TEXT,
  status TEXT NOT NULL DEFAULT 'harvested' CHECK (status IN ('harvested','loaded')), remarks TEXT, created_by TEXT, ${common},
  UNIQUE (tenant_id, farm_id, code));

CREATE TABLE IF NOT EXISTS barns (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), code TEXT NOT NULL,
  location TEXT, capacity_kg REAL CHECK (capacity_kg > 0), barn_type TEXT, condition TEXT, furnace TEXT, flues TEXT,
  ventilation TEXT, sensors TEXT, fuel_type TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1, ${common},
  UNIQUE (tenant_id, farm_id, code));

CREATE TABLE IF NOT EXISTS curing_cycles (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  season_id TEXT NOT NULL REFERENCES seasons(id), code TEXT NOT NULL, barn_id TEXT NOT NULL REFERENCES barns(id),
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','ready','curing','completed','aborted')),
  loaded_at TEXT, green_weight_kg REAL, slates INTEGER, labour_workers INTEGER, labour_cost REAL NOT NULL DEFAULT 0,
  operator TEXT, fuel_input_id TEXT REFERENCES inputs(id), fuel_opening_kg REAL,
  offloaded_at TEXT, cured_weight_kg REAL, offload_labour_cost REAL NOT NULL DEFAULT 0, condition TEXT, losses_note TEXT,
  remarks TEXT, created_by TEXT, ${common}, UNIQUE (tenant_id, farm_id, code));
CREATE INDEX IF NOT EXISTS ix_cycle_barn ON curing_cycles(barn_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS curing_cycle_checks (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, cycle_id TEXT NOT NULL REFERENCES curing_cycles(id), item TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, done_on TEXT, done_by TEXT, ${common}, UNIQUE (cycle_id, item));

CREATE TABLE IF NOT EXISTS cycle_batches (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, cycle_id TEXT NOT NULL REFERENCES curing_cycles(id),
  batch_id TEXT NOT NULL REFERENCES harvest_batches(id), green_weight_kg REAL NOT NULL CHECK (green_weight_kg > 0), ${common});

CREATE TABLE IF NOT EXISTS curing_logs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, cycle_id TEXT NOT NULL REFERENCES curing_cycles(id),
  logged_at TEXT NOT NULL, temperature_c REAL, ventilation TEXT, fuel_added_kg REAL CHECK (fuel_added_kg >= 0),
  fuel_txn_id TEXT REFERENCES inventory_transactions(id), operator TEXT, remarks TEXT, ${common});
CREATE INDEX IF NOT EXISTS ix_cl_cycle ON curing_logs(cycle_id, logged_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS storage_units (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  season_id TEXT NOT NULL REFERENCES seasons(id), code TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('slate_pack','pile')),
  cycle_id TEXT NOT NULL REFERENCES curing_cycles(id), weight_kg REAL NOT NULL CHECK (weight_kg > 0), location TEXT,
  created_on TEXT NOT NULL, condition TEXT, maturity_start TEXT NOT NULL, expected_open_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'maturing' CHECK (status IN ('maturing','opened')), opened_on TEXT, remarks TEXT, ${common},
  UNIQUE (tenant_id, farm_id, code));

-- Phase 3: grading, bales, marketing
CREATE TABLE IF NOT EXISTS grades (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), code TEXT NOT NULL, name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, notes TEXT, ${common}, UNIQUE (tenant_id, farm_id, code));

CREATE TABLE IF NOT EXISTS grading_lots (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), season_id TEXT NOT NULL REFERENCES seasons(id),
  code TEXT NOT NULL, storage_unit_id TEXT NOT NULL REFERENCES storage_units(id), graded_on TEXT NOT NULL,
  input_kg REAL NOT NULL CHECK (input_kg > 0), waste_kg REAL NOT NULL DEFAULT 0 CHECK (waste_kg >= 0), variance_kg REAL NOT NULL DEFAULT 0,
  variance_note TEXT, grader TEXT, labour_cost REAL NOT NULL DEFAULT 0, notes TEXT, ${common}, UNIQUE (tenant_id, farm_id, code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_grading_unit ON grading_lots(storage_unit_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS grading_outputs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lot_id TEXT NOT NULL REFERENCES grading_lots(id), grade_id TEXT NOT NULL REFERENCES grades(id),
  weight_kg REAL NOT NULL CHECK (weight_kg > 0), grader TEXT, notes TEXT, ${common});

CREATE TABLE IF NOT EXISTS bales (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), season_id TEXT NOT NULL REFERENCES seasons(id),
  code TEXT NOT NULL, output_id TEXT NOT NULL REFERENCES grading_outputs(id), grade_id TEXT NOT NULL REFERENCES grades(id),
  weight_kg REAL NOT NULL CHECK (weight_kg > 0), baled_on TEXT NOT NULL, field_id TEXT REFERENCES fields(id), variety TEXT,
  status TEXT NOT NULL DEFAULT 'baled' CHECK (status IN ('baled','sold')), notes TEXT, ${common}, UNIQUE (tenant_id, farm_id, code));

-- Phase 3b: contract farming (the farm's own view of the programmes it participates in)
CREATE TABLE IF NOT EXISTS contractors (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), name TEXT NOT NULL, contact_person TEXT, phone TEXT, email TEXT,
  notes TEXT, active INTEGER NOT NULL DEFAULT 1, ${common});

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), season_id TEXT NOT NULL REFERENCES seasons(id),
  code TEXT NOT NULL, contract_no TEXT, contractor_id TEXT NOT NULL REFERENCES contractors(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','settled','cancelled')),
  crop TEXT NOT NULL DEFAULT 'tobacco', variety TEXT, area_ha REAL CHECK (area_ha > 0), target_kg REAL CHECK (target_kg > 0),
  signed_on TEXT, delivery_deadline TEXT, extension_services TEXT, production_obligations TEXT, delivery_requirements TEXT, notes TEXT, ${common},
  UNIQUE (tenant_id, farm_id, code));

CREATE TABLE IF NOT EXISTS contract_fields (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contract_id TEXT NOT NULL REFERENCES contracts(id), field_id TEXT NOT NULL REFERENCES fields(id), ${common});
CREATE UNIQUE INDEX IF NOT EXISTS ux_contract_field ON contract_fields(contract_id, field_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS contract_advances (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contract_id TEXT NOT NULL REFERENCES contracts(id),
  kind TEXT NOT NULL CHECK (kind IN ('input','cash','service')), description TEXT NOT NULL, input_id TEXT REFERENCES inputs(id), qty REAL,
  value REAL NOT NULL CHECK (value >= 0), advanced_on TEXT NOT NULL, inventory_txn_id TEXT REFERENCES inventory_transactions(id), notes TEXT, ${common});

CREATE TABLE IF NOT EXISTS contract_obligations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contract_id TEXT NOT NULL REFERENCES contracts(id),
  kind TEXT NOT NULL CHECK (kind IN ('production','delivery','extension','other')), description TEXT NOT NULL, due_on TEXT,
  done INTEGER NOT NULL DEFAULT 0, done_on TEXT, ${common});

CREATE TABLE IF NOT EXISTS contract_settlements (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contract_id TEXT NOT NULL REFERENCES contracts(id), settled_on TEXT NOT NULL,
  delivered_kg REAL NOT NULL, delivered_gross REAL NOT NULL, sale_deductions REAL NOT NULL DEFAULT 0, advances_total REAL NOT NULL,
  advances_recovered REAL NOT NULL CHECK (advances_recovered >= 0), other_deductions REAL NOT NULL DEFAULT 0 CHECK (other_deductions >= 0),
  net_payable REAL NOT NULL, shortfall REAL NOT NULL DEFAULT 0, notes TEXT, ${common});
CREATE UNIQUE INDEX IF NOT EXISTS ux_settlement_contract ON contract_settlements(contract_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS buyers (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'merchant' CHECK (kind IN ('auction_floor','merchant','contractor','private','other')),
  contact_person TEXT, phone TEXT, email TEXT, address TEXT,
  payment_terms_days INTEGER CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0), credit_limit REAL CHECK (credit_limit IS NULL OR credit_limit >= 0),
  bank_name TEXT, account_name TEXT, account_no TEXT, settlement_notes TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1, ${common});
CREATE UNIQUE INDEX IF NOT EXISTS ux_buyer_name ON buyers(farm_id, lower(name)) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS buyer_deductions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, buyer_id TEXT NOT NULL REFERENCES buyers(id), label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('percent','fixed')), value REAL NOT NULL CHECK (value >= 0 AND (kind <> 'percent' OR value <= 100)), ${common});

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), season_id TEXT NOT NULL REFERENCES seasons(id),
  code TEXT NOT NULL, sale_ref TEXT, sold_on TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'auction', buyer TEXT, buyer_id TEXT, notes TEXT, contract_id TEXT REFERENCES contracts(id), ${common},
  UNIQUE (tenant_id, farm_id, code));

CREATE TABLE IF NOT EXISTS sale_lines (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL REFERENCES sales(id), bale_id TEXT NOT NULL REFERENCES bales(id),
  weight_kg REAL NOT NULL CHECK (weight_kg > 0), price_per_kg REAL NOT NULL CHECK (price_per_kg >= 0), gross REAL NOT NULL, ${common});
CREATE UNIQUE INDEX IF NOT EXISTS ux_sale_line_bale ON sale_lines(bale_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sale_deductions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL REFERENCES sales(id), label TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0), ${common});

CREATE TABLE IF NOT EXISTS sale_payments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL REFERENCES sales(id), paid_on TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0), method TEXT, reference TEXT, ${common});

-- ---- Phase 4: labour (field terminal) ----
CREATE TABLE IF NOT EXISTS labour_entries (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  season_id TEXT NOT NULL REFERENCES seasons(id), field_id TEXT REFERENCES fields(id), worked_on TEXT NOT NULL,
  worker_name TEXT NOT NULL, task TEXT NOT NULL, hours REAL CHECK (hours >= 0), pay_amount REAL NOT NULL DEFAULT 0 CHECK (pay_amount >= 0),
  remarks TEXT, created_by TEXT, operation_id TEXT REFERENCES operations(id), ${common});
CREATE INDEX IF NOT EXISTS ix_labour_season ON labour_entries(season_id) WHERE deleted_at IS NULL;

-- ---- Phase 5: budgets and the read-only BI view layer ----
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), season_id TEXT NOT NULL REFERENCES seasons(id),
  category TEXT NOT NULL CHECK (category IN ('seed','fertilizer','chemicals','labour','machinery','fuel','irrigation','transport','curing','storage','grading','baling','marketing','overhead')),
  amount REAL NOT NULL CHECK (amount >= 0), notes TEXT, ${common});
CREATE UNIQUE INDEX IF NOT EXISTS ux_budget_cat ON budgets(season_id, category) WHERE deleted_at IS NULL;

-- Read-only BI layer: the only objects natural-language questions may touch. No users, PINs, outbox or audit data.
DROP VIEW IF EXISTS bi_seasons; CREATE VIEW bi_seasons AS SELECT label AS season, starts_on, ends_on, status FROM seasons WHERE deleted_at IS NULL;
DROP VIEW IF EXISTS bi_fields; CREATE VIEW bi_fields AS SELECT field_no, area_ha, variety, soil_type, previous_crop, current_crop, irrigated, tenure FROM fields WHERE deleted_at IS NULL;
DROP VIEW IF EXISTS bi_costs; CREATE VIEW bi_costs AS SELECT se.label AS season, c.category, c.amount, c.occurred_on, f.field_no, c.note
  FROM cost_entries c JOIN seasons se ON se.id=c.season_id LEFT JOIN fields f ON f.id=c.field_id WHERE c.deleted_at IS NULL;
DROP VIEW IF EXISTS bi_budgets; CREATE VIEW bi_budgets AS SELECT se.label AS season, b.category, b.amount AS budget FROM budgets b JOIN seasons se ON se.id=b.season_id WHERE b.deleted_at IS NULL;
DROP VIEW IF EXISTS bi_harvests; CREATE VIEW bi_harvests AS SELECT se.label AS season, h.code, f.field_no, h.harvested_on, h.variety, h.priming, h.leaf_position, h.green_weight_kg
  FROM harvest_batches h JOIN seasons se ON se.id=h.season_id JOIN fields f ON f.id=h.field_id WHERE h.deleted_at IS NULL;
DROP VIEW IF EXISTS bi_bales; CREATE VIEW bi_bales AS SELECT se.label AS season, b.code, g.code AS grade, b.weight_kg, b.baled_on, f.field_no, b.variety, b.status
  FROM bales b JOIN seasons se ON se.id=b.season_id JOIN grades g ON g.id=b.grade_id LEFT JOIN fields f ON f.id=b.field_id WHERE b.deleted_at IS NULL;
DROP VIEW IF EXISTS bi_sales; CREATE VIEW bi_sales AS SELECT se.label AS season, s.code AS sale_code, s.sold_on, s.channel, COALESCE(bu.name, s.buyer) AS buyer, g.code AS grade, l.weight_kg, l.price_per_kg, l.gross, f.field_no, b.variety
  FROM sale_lines l JOIN sales s ON s.id=l.sale_id JOIN seasons se ON se.id=s.season_id JOIN bales b ON b.id=l.bale_id JOIN grades g ON g.id=b.grade_id LEFT JOIN fields f ON f.id=b.field_id LEFT JOIN buyers bu ON bu.id=s.buyer_id
  WHERE l.deleted_at IS NULL AND s.deleted_at IS NULL;
DROP VIEW IF EXISTS bi_buyers; CREATE VIEW bi_buyers AS SELECT name, kind, payment_terms_days, credit_limit, active FROM buyers WHERE deleted_at IS NULL;
DROP VIEW IF EXISTS bi_weather; CREATE VIEW bi_weather AS SELECT w.recorded_on, f.field_no, w.rainfall_mm, w.temp_min_c, w.temp_max_c, w.event, w.observation
  FROM weather_records w LEFT JOIN fields f ON f.id=w.field_id WHERE w.deleted_at IS NULL;
DROP VIEW IF EXISTS bi_labour; CREATE VIEW bi_labour AS SELECT se.label AS season, l.worked_on, l.worker_name, l.task, f.field_no, l.hours, l.pay_amount
  FROM labour_entries l JOIN seasons se ON se.id=l.season_id LEFT JOIN fields f ON f.id=l.field_id WHERE l.deleted_at IS NULL;
DROP VIEW IF EXISTS bi_operations; CREATE VIEW bi_operations AS SELECT se.label AS season, o.occurred_on, o.op_type, f.field_no, sb.code AS seedbed, o.operator, o.area_ha
  FROM operations o JOIN seasons se ON se.id=o.season_id LEFT JOIN fields f ON f.id=o.field_id LEFT JOIN seedbeds sb ON sb.id=o.seedbed_id WHERE o.deleted_at IS NULL;
DROP VIEW IF EXISTS bi_curing; CREATE VIEW bi_curing AS SELECT se.label AS season, c.code, br.code AS barn, c.status, c.loaded_at, c.green_weight_kg, c.offloaded_at, c.cured_weight_kg
  FROM curing_cycles c JOIN seasons se ON se.id=c.season_id JOIN barns br ON br.id=c.barn_id WHERE c.deleted_at IS NULL;

-- ---- Phase 6: machinery ----
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'tractor' CHECK (kind IN ('tractor','implement','vehicle','pump','generator','other')),
  make_model TEXT, reg_no TEXT, purchased_on TEXT, purchase_cost REAL CHECK (purchase_cost >= 0),
  hourly_rate REAL NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0), service_interval_hours REAL CHECK (service_interval_hours > 0),
  active INTEGER NOT NULL DEFAULT 1, notes TEXT, fuel_input_id TEXT REFERENCES inputs(id), ${common});
CREATE TABLE IF NOT EXISTS machine_logs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id), season_id TEXT NOT NULL REFERENCES seasons(id),
  machine_id TEXT NOT NULL REFERENCES machines(id), field_id TEXT REFERENCES fields(id),
  kind TEXT NOT NULL CHECK (kind IN ('use','fuel','service','repair')), logged_on TEXT NOT NULL,
  hours REAL CHECK (hours >= 0), fuel_l REAL CHECK (fuel_l >= 0), cost REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
  description TEXT, operator TEXT, created_by TEXT,
  input_id TEXT REFERENCES inputs(id), fuel_txn_id TEXT REFERENCES inventory_transactions(id), operation_id TEXT REFERENCES operations(id), ${common},
  CHECK (kind <> 'use' OR hours IS NOT NULL), CHECK (kind <> 'fuel' OR fuel_l IS NOT NULL));
CREATE INDEX IF NOT EXISTS ix_mlog_machine ON machine_logs(machine_id) WHERE deleted_at IS NULL;
DROP VIEW IF EXISTS bi_machine_logs; CREATE VIEW bi_machine_logs AS SELECT se.label AS season, m.name AS machine, m.kind AS machine_kind, l.kind AS log_kind, l.logged_on, f.field_no, l.hours, l.fuel_l, l.cost, l.description, l.operator
  FROM machine_logs l JOIN machines m ON m.id=l.machine_id JOIN seasons se ON se.id=l.season_id LEFT JOIN fields f ON f.id=l.field_id WHERE l.deleted_at IS NULL;

-- ---- Phase 7: shared-cost allocation ----
CREATE TABLE IF NOT EXISTS allocation_rules (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  category TEXT NOT NULL CHECK (category IN ('seed','fertilizer','chemicals','labour','machinery','fuel','irrigation','transport','curing','storage','grading','baling','marketing','overhead')),
  basis TEXT NOT NULL CHECK (basis IN ('none','area','green_kg','sold_kg')), ${common});
CREATE UNIQUE INDEX IF NOT EXISTS ux_alloc_cat ON allocation_rules(farm_id, category) WHERE deleted_at IS NULL;

-- Sync outbox: every local write is journalled here and pushed to Supabase when online / via Wi-Fi hub.
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert','delete')), payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), synced_at TEXT);

-- Rows the cloud refused (stock/limit/permission rules). Quarantined so one bad row never blocks the rest of the sync.
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id TEXT NOT NULL, reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT, resolution TEXT);

-- Business brain, layer 1: append-only stream of readable events. Synced; the cloud forbids update/delete.
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT NOT NULL REFERENCES farms(id),
  occurred_at TEXT NOT NULL, actor_id TEXT, actor_name TEXT, device_tag TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('action','note','voice','photo','system')), verb TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('ops','finance','admin')), table_name TEXT, row_id TEXT, season_id TEXT, field_id TEXT,
  summary TEXT NOT NULL, body TEXT, details TEXT, recorded_by TEXT, ${common});
CREATE INDEX IF NOT EXISTS ix_activity_time ON activity_log(farm_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_activity_row ON activity_log(table_name, row_id);

-- Wi-Fi hub (office PC). Local-only: never synced to the cloud.
-- hub_log is a monotonic change feed so phones can ask "what changed since #N" regardless of a row's own updated_at.
CREATE TABLE IF NOT EXISTS hub_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_hub_log_tbl ON hub_log(table_name, seq);
CREATE TABLE IF NOT EXISTS lan_pairings (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, device_label TEXT NOT NULL, role_id TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS lan_devices (
  id TEXT PRIMARY KEY, tag TEXT NOT NULL UNIQUE, label TEXT NOT NULL, role_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT, revoked_at TEXT);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT, action TEXT NOT NULL, table_name TEXT, row_id TEXT, detail TEXT);
`
