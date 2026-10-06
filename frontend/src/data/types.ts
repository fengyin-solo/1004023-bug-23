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
  // 非致命的附带提示（例如一致性提醒），不影响动作本身是否成功。
  warnings?: string[]
  // 动作新生成的关联记录数量（如巡检完成时生成的缺陷条数）。
  created?: number
}

// 巡检完成 ↔ 缺陷生成的一致性问题：缺陷页与巡检页据此把缺失/重复的来源摆出来。
export type ConsistencyIssue = {
  // missing:任务完成但缺陷缺失；duplicate:同批次重复录入；count_mismatch:数量对不上；
  // orphan:缺陷找不到来源任务；state_mismatch:已生成缺陷但任务不是已完成。
  kind: 'missing' | 'duplicate' | 'count_mismatch' | 'orphan' | 'state_mismatch'
  ref: string
  message: string
  defectIds: number[]
  taskId?: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
