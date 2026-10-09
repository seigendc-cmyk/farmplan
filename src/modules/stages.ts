/** The project pipeline: ordered stages per module, kept as data. A module with no entry here has no pipeline yet (its projects arrive with that module). */
export interface StageDef { id: string; label: string; /** may be skipped (the Contracted stage for an independent grower) */ optional?: boolean; help: string }

export const STAGES: Record<string, readonly StageDef[]> = {
  tobacco: [
    { id: 'idea', label: 'Idea', help: 'Crop, season, target area, and whether a contractor is involved.' },
    { id: 'planning', label: 'Planning', help: 'Fields, varieties, hectares, expected yield, planting and curing capacity.' },
    { id: 'budget', label: 'Budget', help: 'Initial budget built and approved.' },
    { id: 'funding', label: 'Funding', help: 'Funding needs assessed; a request raised if cash or inputs are short.' },
    { id: 'contracted', label: 'Contracted', optional: true, help: 'Contractor and contract linked, advances agreed. Skip for independent growers.' },
    { id: 'land_seedbed', label: 'Land and seedbed', help: 'Land preparation, seedbeds, inputs received.' },
    { id: 'growing', label: 'Growing', help: 'Transplanting, crop operations, labour, fuel.' },
    { id: 'harvest_curing', label: 'Harvest and curing', help: 'Harvest batches, curing cycles, storage.' },
    { id: 'grading_marketing', label: 'Grading and marketing', help: 'Grading lots, bales, sales, buyer deductions.' },
    { id: 'closed', label: 'Closed', help: 'Final budget against actual, season report.' },
  ],
}

export const stagesOf = (module: string): readonly StageDef[] => STAGES[module] ?? []
export const hasPipeline = (module: string) => stagesOf(module).length > 0
export const stageLabel = (module: string, id: string) => stagesOf(module).find(s => s.id === id)?.label ?? id
