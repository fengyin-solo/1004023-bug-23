/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 完成巡检时录入的一条缺陷草稿（页面表单 -> 领域层）。
export type DefectDraft = {
  pipeline: string
  type: string
  location: string
  severity: string
  description: string
}

// 巡检任务与缺陷之间的溯源信息：两边各存一份，用于幂等与对账。
export type CompletionDetail = {
  batchId: string
  completedAt: string
  defects: DefectDraft[]
  // 种子里的历史已完成任务没有批次，补看时标记为历史记录，不再补缺陷。
  legacy: boolean
}

// 完成提交的结果：除了成功与否，还回传生成的缺陷数，页面可以直接提示。
export type CompletionActionResult = ActionResult & {
  defectCount?: number
  batchId?: string
}

export type IntegrityIssueKind = 'missing' | 'duplicate' | 'orphan' | 'unsourced'

export type IntegrityIssue = {
  kind: IntegrityIssueKind
  label: string
  // 巡检任务侧的问题：关联任务与涉及的缺陷（缺失时为空）。
  taskId?: number
  taskCode?: string
  batchId?: string
  // 缺陷侧的问题：涉及的缺陷记录编号。
  defectIds?: number[]
  defectCode?: string
  detail: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
