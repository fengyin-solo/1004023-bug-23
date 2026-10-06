import { MODULE_BY_KEY } from '@/data/modules'
import {
  CompletionError,
  applyCompletion,
  completionDetail,
  integrityScan,
} from '@/data/inspection-completion'
import { allRows, commitState, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  CompletionActionResult,
  CompletionDetail,
  DefectDraft,
  EntryRow,
  IntegrityIssue,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 巡检任务的状态必须逐级流转，不允许跳步；「确认完成」走专门的原子提交流程，不在这里直接改状态。
const INSPECTION_KEY = 'inspection'
const INSPECTION_GUARD: Record<string, string[]> = {
  分配任务: ['待分配'],
  开始巡检: ['已分配'],
}

// 同一任务在途的完成请求：第二个并发请求直接拒绝，避免双击/并发导致重复生成。
const inflightCompletions = new Set<number>()
const SUBMIT_DELAY_MS = 300

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 巡检完成涉及缺陷生成，必须走 submitInspectionCompletion 的原子流程，禁止在通用路径里裸改状态。
  if (key === INSPECTION_KEY && action === '确认完成') {
    return { ok: false, message: '确认完成请在任务行使用「确认完成」录入缺陷，系统会原子提交' }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 巡检状态流转闸口：只能逐级走，防止从「待分配」之类的状态直接跳成已完成。
  const allowedCurrent = key === INSPECTION_KEY ? INSPECTION_GUARD[action] : undefined
  if (allowedCurrent && !allowedCurrent.includes(current)) {
    return { ok: false, message: `任务当前为「${current}」，不能执行「${action}」，请先完成前置状态` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 确认完成巡检任务（异步，模拟提交到后端）。
 * 并发保护 + 提交前重查状态 + 任务与缺陷一次原子落盘：
 * 提交失败、并发冲突、校验不通过时任务保持「执行中」，不会出现「已完成却没有缺陷」。
 * options.simulateFailure 仅用于演示/验证失败回滚。
 */
export async function submitInspectionCompletion(
  taskId: number,
  drafts: Partial<DefectDraft>[],
  options: { simulateFailure?: boolean } = {},
): Promise<CompletionActionResult> {
  if (inflightCompletions.has(taskId)) {
    return { ok: false, message: '该任务正在提交完成，请勿重复点击，等本次提交结束后再操作' }
  }
  inflightCompletions.add(taskId)
  try {
    // 模拟提交耗时：真实环境这里是一次后端事务请求。
    await delay(SUBMIT_DELAY_MS)

    // 提交前基于最新快照重算：期间若状态已被别处改走，applyCompletion 会拒绝，任务不会误标完成。
    const snapshot = allRows()
    let next: ReturnType<typeof applyCompletion>
    try {
      next = applyCompletion(snapshot, taskId, drafts, new Date().toISOString())
    } catch (error) {
      if (error instanceof CompletionError) {
        return { ok: false, message: error.message }
      }
      throw error
    }

    if (options.simulateFailure) {
      // 模拟落盘失败：直接返回，绝不 commitState，任务与缺陷维持原状。
      return { ok: false, message: '提交失败：服务暂不可用，任务保持「执行中」，本次未生成任何缺陷，请重试' }
    }

    try {
      commitState(next.state)
    } catch {
      // 落盘失败：缓存与存储都停留在提交前的快照，任务仍是「执行中」，允许用户原样重试。
      return { ok: false, message: '提交失败：结果未能保存，任务保持「执行中」，本次未生成任何缺陷，请重试' }
    }
    return {
      ok: true,
      message:
        next.defectCount === 0
          ? '任务已完成，本次巡检未发现缺陷，未生成占位记录'
          : `任务已完成，本次生成 ${next.defectCount} 条缺陷记录`,
      defectCount: next.defectCount,
      batchId: next.batchId,
    }
  } finally {
    inflightCompletions.delete(taskId)
  }
}

// 补看任务完成记录：纯读取，不会重新生成或补齐任何缺陷。
export function getCompletionDetail(taskId: number): CompletionDetail | null {
  return completionDetail(allRows(), taskId)
}

// 缺陷页的来源对账：缺失/重复/孤立/来源不明都能在这里看到来源。
export function listIntegrityIssues(): IntegrityIssue[] {
  return integrityScan(allRows())
}

export function isCompletionInflight(taskId: number): boolean {
  return inflightCompletions.has(taskId)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
