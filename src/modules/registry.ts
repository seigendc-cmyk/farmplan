/**
 * The modules a farm can switch on. A module's id is also the `enterprise` stored on its seasons, so a season says which module it belongs to.
 * Only modules marked `available` can be enabled; the others are listed so the owner can see what is planned.
 */
export interface ModuleDef { id: string; label: string; blurb: string; available: boolean }

export const MODULES: readonly ModuleDef[] = [
  { id: 'tobacco', label: 'Tobacco', blurb: 'Seedbeds to sale: curing, grading, bales and contract farming.', available: true },
  { id: 'horticulture', label: 'Horticulture', blurb: 'Vegetable crop cycles, pack shed and market orders.', available: false },
  { id: 'orchards', label: 'Orchards', blurb: 'Granadilla, berries and long-term trees.', available: false },
  { id: 'field_crops', label: 'Field crops', blurb: 'Maize, soya beans and other seasonal field crops.', available: false },
  { id: 'tree_nursery', label: 'Tree nursery', blurb: 'Propagation batches and seedling sales.', available: false },
  { id: 'livestock', label: 'Livestock', blurb: 'Herds and flocks: breeding, health, feeding and sales.', available: false },
]

/** A farm that has never chosen modules runs Tobacco only, as every farm did before modules existed. */
export const DEFAULT_MODULES: readonly string[] = ['tobacco']
export const moduleDef = (id: string) => MODULES.find(m => m.id === id)
export const moduleLabel = (id: string) => moduleDef(id)?.label ?? id

/** Reads the comma-separated list stored on the farm. Unknown ids are dropped; an empty or missing value means the default. */
export function parseModules(raw: string | null | undefined): string[] {
  const ids = (raw ?? '').split(',').map(s => s.trim()).filter((s, i, a) => s && a.indexOf(s) === i && moduleDef(s))
  return ids.length ? ids : [...DEFAULT_MODULES]
}
export const formatModules = (ids: readonly string[]) => ids.join(',')
