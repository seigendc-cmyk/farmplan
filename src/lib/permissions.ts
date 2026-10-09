// Menu-driven permission catalogue. Keys match the Supabase role_permissions.permission values.
export interface PermissionDef { key: string; label: string }
export interface PermissionGroup { menu: string; items: PermissionDef[] }

export const PERMISSION_GROUPS: PermissionGroup[] = [
  { menu: 'Production', items: [
    { key: 'production.field.view', label: 'View fields' },
    { key: 'production.field.edit', label: 'Create / edit fields' },
    { key: 'production.seedbed.view', label: 'View seedbeds' },
    { key: 'production.seedbed.edit', label: 'Create / edit seedbeds' },
    { key: 'production.operation.view', label: 'View operations' },
    { key: 'production.operation.record', label: 'Record operations' },
    { key: 'production.operation.delete', label: 'Delete operations' },
    { key: 'production.weather.view', label: 'View weather' },
    { key: 'production.weather.record', label: 'Record weather' },
    { key: 'production.transplant.view', label: 'View transplanting' },
    { key: 'production.transplant.record', label: 'Record transplanting' },
    { key: 'production.harvest.view', label: 'View harvest batches' },
    { key: 'production.harvest.record', label: 'Record harvests' },
  ]},
  { menu: 'Curing', items: [
    { key: 'curing.barn.view', label: 'View barns' },
    { key: 'curing.barn.edit', label: 'Create / edit barns' },
    { key: 'curing.cycle.view', label: 'View curing cycles' },
    { key: 'curing.cycle.create', label: 'Create, prepare and load curing cycles' },
    { key: 'curing.cycle.record', label: 'Record temperature and fuel' },
    { key: 'curing.cycle.close', label: 'Close (offload) curing cycles' },
    { key: 'curing.storage.view', label: 'View starking / storage' },
    { key: 'curing.storage.edit', label: 'Create and open storage units' },
  ]},
  { menu: 'Quality', items: [
    { key: 'quality.grade.edit', label: 'Maintain grade catalogue' },
    { key: 'quality.grading.view', label: 'View grading' },
    { key: 'quality.grading.record', label: 'Record grading' },
    { key: 'quality.bale.view', label: 'View bales' },
    { key: 'quality.bale.record', label: 'Create bales' },
  ]},
  { menu: 'Marketing', items: [
    { key: 'marketing.sale.view', label: 'View sales and revenue' },
    { key: 'marketing.sale.record', label: 'Record sales and payments' },
    { key: 'marketing.buyer.view', label: 'View buyers, balances and price history' },
    { key: 'marketing.buyer.manage', label: 'Manage buyers (terms, credit limits, bank details)' },
  ]},
  { menu: 'Business brain', items: [
    { key: 'brain.note.record', label: 'Add notes to the activity log' },
    { key: 'brain.log.view_own', label: 'See activity they made themselves' },
    { key: 'brain.log.view_ops', label: 'See all operations activity (field, curing, stock, machines, labour)' },
    { key: 'brain.log.view_finance', label: 'See finance activity (sales, payments, buyers, contracts, budgets)' },
    { key: 'brain.log.view_admin', label: 'See administration activity (users, roles, devices)' },
    { key: 'brain.chat.ask', label: 'Ask the brain questions in plain language (answers stay limited by their other access)' },
    { key: 'brain.chat.cloud', label: 'May send a question to Claude (names only, never records) when the local model cannot answer' },
  ]},
  { menu: 'Contracts', items: [
    { key: 'contracts.contract.view', label: 'View contractors and contract programmes' },
    { key: 'contracts.contract.edit', label: 'Create / edit contracts, advances and obligations' },
    { key: 'contracts.contract.settle', label: 'Settle contracts' },
  ]},
  { menu: 'Resources', items: [
    { key: 'resources.inventory.view', label: 'View inventory' },
    { key: 'resources.inventory.manage', label: 'Manage inputs and stock' },
    { key: 'resources.labour.view', label: 'View labour records' },
    { key: 'resources.labour.record', label: 'Record labour' },
    { key: 'resources.machinery.view', label: 'View machinery and usage' },
    { key: 'resources.machinery.record', label: 'Log machine use, fuel and service' },
    { key: 'resources.machinery.manage', label: 'Register and edit machines' },
  ]},
  { menu: 'Finance', items: [
    { key: 'finance.cost.view', label: 'View costs' },
    { key: 'finance.cost.edit', label: 'Edit financial records' },
    { key: 'finance.budget.view', label: 'View budgets' },
    { key: 'finance.budget.edit', label: 'Set season budgets' },
  ]},
  { menu: 'Projects', items: [
    { key: 'projects.project.view', label: 'View the project pipeline' },
    { key: 'projects.project.edit', label: 'Edit project notes' },
    { key: 'projects.stage.advance', label: 'Move projects forward or back a stage' },
    { key: 'projects.stage.override', label: 'Move a project past an unmet requirement (reason is logged)' },
  ]},
  { menu: 'Settings', items: [
    { key: 'settings.farm.view', label: 'View farm' },
    { key: 'settings.farm.manage', label: 'Manage farm' },
    { key: 'settings.season.view', label: 'View seasons' },
    { key: 'settings.season.manage', label: 'Manage seasons' },
    { key: 'settings.modules.manage', label: 'Switch farm modules on and off' },
    { key: 'settings.users.manage', label: 'Manage users' },
    { key: 'settings.roles.manage', label: 'Manage roles' },
    { key: 'settings.access.manage', label: 'Manage contractor / extension access' },
    { key: 'settings.audit.view', label: 'View audit trail' },
  ]},
]

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap(g => g.items.map(i => i.key))

/** Permissions introduced after Phase 1, granted once to existing system roles by the schema-v2 migration. */
export const PHASE2_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['production.transplant.view','production.transplant.record','production.harvest.view','production.harvest.record',
    'curing.barn.view','curing.barn.edit','curing.cycle.view','curing.cycle.create','curing.cycle.record','curing.cycle.close','curing.storage.view','curing.storage.edit'],
  'Field Recorder': ['production.transplant.view','production.transplant.record','production.harvest.view','production.harvest.record',
    'curing.barn.view','curing.cycle.view','curing.cycle.record','curing.storage.view'],
}

/** Permissions introduced in Phase 3, granted once to existing system roles by the schema-v3 migration. */
export const PHASE3_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['quality.grade.edit','quality.grading.view','quality.grading.record','quality.bale.view','quality.bale.record','marketing.sale.view','marketing.sale.record'],
  'Field Recorder': ['quality.grading.view','quality.bale.view'],
}

/** Permissions introduced with contract programmes (schema v4). Settlement stays with the Owner unless granted. */
export const PHASE4_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['contracts.contract.view','contracts.contract.edit'],
}

/** Permissions introduced with the field terminal (schema v5). */
export const PHASE5_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['resources.labour.view','resources.labour.record'],
  'Field Recorder': ['resources.labour.view','resources.labour.record'],
}

/** Permissions introduced with budgets and analysis (schema v6). */
export const PHASE6_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['finance.budget.view','finance.budget.edit'],
}

/** Permissions introduced with machinery (schema v7). */
export const PHASE7_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['resources.machinery.view','resources.machinery.record','resources.machinery.manage'],
  'Field Recorder': ['resources.machinery.view','resources.machinery.record'],
}

/** Permissions introduced with the buyers register (schema v10). */
export const PHASE10_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['marketing.buyer.view','marketing.buyer.manage'],
}

/** Permissions introduced with the business brain (schema v11). */
export const PHASE11_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['brain.note.record', 'brain.log.view_own', 'brain.log.view_ops', 'brain.log.view_finance'],
  'Field Recorder': ['brain.note.record', 'brain.log.view_own'],
}

/** Permissions introduced with the brain chat (schema v12). */
export const PHASE12_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['brain.chat.ask'],
}

/** Permissions introduced with the project pipeline (schema v16). Overriding an unmet stage requirement stays with the Owner unless granted. */
export const PHASE13_GRANTS: Record<string, string[]> = {
  'Farm Manager': ['projects.project.view','projects.project.edit','projects.stage.advance'],
}

/** One-click access levels an admin can apply to a role; they only touch the business-brain permissions. */
export const BRAIN_KEYS = ['brain.note.record', 'brain.log.view_own', 'brain.log.view_ops', 'brain.log.view_finance', 'brain.log.view_admin']
export const BRAIN_LEVELS: { id: string; label: string; help: string; perms: string[] }[] = [
  { id: 'none', label: 'None', help: 'No access to the activity log', perms: [] },
  { id: 'own', label: 'Own activity', help: 'Their own entries, and they can add notes', perms: ['brain.note.record', 'brain.log.view_own'] },
  { id: 'ops', label: 'Operations', help: 'All field, curing, stock, machine and labour activity', perms: ['brain.note.record', 'brain.log.view_own', 'brain.log.view_ops'] },
  { id: 'mgmt', label: 'Management', help: 'Operations plus finance (sales, payments, buyers, contracts, budgets)', perms: ['brain.note.record', 'brain.log.view_own', 'brain.log.view_ops', 'brain.log.view_finance'] },
  { id: 'full', label: 'Full', help: 'Everything, including users, roles and devices', perms: BRAIN_KEYS },
]
/** Which level a set of permissions amounts to, or null if it is a custom mix. */
export const brainLevelOf = (perms: Iterable<string>) => { const have = new Set([...perms].filter(p => BRAIN_KEYS.includes(p))); return BRAIN_LEVELS.find(l => l.perms.length === have.size && l.perms.every(p => have.has(p)))?.id ?? null }

export const SYSTEM_ROLES: Record<string, string[]> = {
  'Owner': ['*'],
  'Farm Manager': [
    'settings.farm.view','settings.season.view','settings.season.manage',
    'production.field.view','production.field.edit','production.seedbed.view','production.seedbed.edit',
    'production.operation.view','production.operation.record','production.weather.view','production.weather.record',
    'resources.inventory.view','resources.inventory.manage','finance.cost.view', ...PHASE2_GRANTS['Farm Manager'], ...PHASE3_GRANTS['Farm Manager'], ...PHASE4_GRANTS['Farm Manager'], ...PHASE5_GRANTS['Farm Manager'], ...PHASE6_GRANTS['Farm Manager'], ...PHASE7_GRANTS['Farm Manager'], ...PHASE10_GRANTS['Farm Manager'], ...PHASE11_GRANTS['Farm Manager'], ...PHASE12_GRANTS['Farm Manager'], ...PHASE13_GRANTS['Farm Manager']],
  'Store Clerk': ['settings.farm.view','resources.inventory.view','resources.inventory.manage'],
  'Field Recorder': [
    'settings.farm.view','production.field.view','production.seedbed.view',
    'production.operation.view','production.operation.record','production.weather.view','production.weather.record',
    'resources.inventory.view', ...PHASE2_GRANTS['Field Recorder'], ...PHASE3_GRANTS['Field Recorder'], ...PHASE5_GRANTS['Field Recorder'], ...PHASE7_GRANTS['Field Recorder'], ...PHASE11_GRANTS['Field Recorder']],
}

export function hasPermission(granted: Iterable<string>, key: string): boolean {
  for (const g of granted) if (g === '*' || g === key) return true
  return false
}
