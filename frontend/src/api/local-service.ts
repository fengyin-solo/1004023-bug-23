import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitRows, listRows, resetRows } from '@/data/local-store'
import type {
  ActionResult,
  ConsistencyIssue,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 巡检完成 ↔ 缺陷生成是跨模块的一条事务，链路字段统一在这里维护，页面不自己拼。
export const INSPECTION_KEY = 'inspection'
export const DEFECT_KEY = 'defect'
const COMPLETED_STATUS = '已完成'
const IN_PROGRESS_STATUS = '执行中'
const DEFECT_CODE_PREFIX = 'DEFE-'

// 同一任务的完成动作进行中：挡住双击 / 并发重入，等事务落盘后才放行。
const completingTasks = new Set<number>()

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

// 动作只能按状态机顺序往前走：target 的前一个状态才是合法来源状态。
// 这样「待分配」不能直接跳「已完成」，两个并发操作里后到的那个也会被挡下。
function allowedPredecessor(meta: ModuleMeta, target: string): string | null {
  const targetIndex = meta.statuses.indexOf(target)
  return targetIndex > 0 ? meta.statuses[targetIndex - 1] : null
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 巡检「确认完成」必须走 completeInspection：完成与缺陷生成是同一个事务，
  // 放行走通用流转会出现「任务已完成、缺陷没生成」的半截链路。
  if (key === INSPECTION_KEY && target === COMPLETED_STATUS) {
    return { ok: false, message: '巡检确认完成请在任务行使用「确认完成」录入本次发现后提交' }
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
  const predecessor = allowedPredecessor(meta, target)
  if (predecessor !== null && current !== predecessor) {
    return {
      ok: false,
      message: `${meta.entity}当前为「${current}」，需先到「${predecessor}」才能${action}，未做任何改动`,
    }
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
  commitRows(new Map([[key, next]]))
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

function nextDefectId(defects: EntryRow[]): number {
  return defects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function formatDefectCode(id: number): string {
  return `${DEFECT_CODE_PREFIX}${String(id).padStart(4, '0')}`
}

// 一行一条缺陷；空行忽略（允许末尾空行），全部为空表示本次巡检无缺陷。
// 支持「类型：描述」写法，不写类型时按「巡检发现」归类。
export function parseFindings(text: string): { type: string; desc: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const separator = line.search(/[：:]/)
      if (separator > 0) {
        const type = line.slice(0, separator).trim()
        const desc = line.slice(separator + 1).trim()
        if (type && desc) {
          return { type, desc }
        }
      }
      return { type: '巡检发现', desc: line }
    })
}

export type CompleteInspectionInput = {
  findingsText: string
  severity: string
}

// 巡检完成 ↔ 缺陷生成 的唯一入口：
// 1. 只允许「执行中」的任务完成（前置状态 + 重入锁 + 批次二次查重，三道幂等）；
// 2. 缺陷批次确定性地取任务编号，同一任务重看、重进页面都不会再生成；
// 3. 任务与缺陷在同一个原子事务里落盘，落盘失败任务保持「执行中」；
// 4. 无缺陷任务只登记数量 0，绝不补占位记录。
export function completeInspection(id: number, input: CompleteInspectionInput): ActionResult {
  if (completingTasks.has(id)) {
    return { ok: false, message: '该巡检任务正在提交中，请勿重复点击，未做任何改动' }
  }
  const findings = parseFindings(input.findingsText)
  completingTasks.add(id)
  try {
    const tasks = listRows(INSPECTION_KEY)
    const taskIndex = tasks.findIndex((row) => Number(row.id) === id)
    if (taskIndex < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的巡检任务` }
    }
    const task = tasks[taskIndex]
    const taskCode = String(task.任务编号 ?? '')
    const current = String(task.status)
    if (current === COMPLETED_STATUS) {
      return { ok: false, message: `巡检任务「${taskCode}」已完成，重复查看不会再生成缺陷` }
    }
    if (current !== IN_PROGRESS_STATUS) {
      return {
        ok: false,
        message: `巡检任务「${taskCode}」当前为「${current}」，只有执行中的任务才能确认完成，未做任何改动`,
      }
    }

    // 二次查重：批次号是确定性的任务编号，任何同批次缺陷都说明这条任务已生成过。
    const defects = listRows(DEFECT_KEY)
    if (task.缺陷批次 || defects.some((row) => String(row.来源批次 ?? '') === taskCode)) {
      return {
        ok: false,
        message: `巡检任务「${taskCode}」已有缺陷批次记录，疑似重复提交，未做任何改动`,
      }
    }

    let defectId = nextDefectId(defects)
    const generated: EntryRow[] = findings.map((finding) => {
      const rowId = defectId++
      const area = String(task.巡检区域 ?? '')
      return {
        id: rowId,
        status: '待确认',
        pending: true,
        abnormal: false,
        缺陷编号: formatDefectCode(rowId),
        所属管线: area || '—',
        缺陷类型: finding.type,
        发现位置: area || '—',
        严重等级: input.severity,
        发现日期: todayText(),
        缺陷描述: finding.desc,
        记录状态: '待确认',
        来源任务: taskCode,
        来源批次: taskCode,
      }
    })

    const completedTask: EntryRow = {
      ...task,
      status: COMPLETED_STATUS,
      pending: false,
      abnormal: false,
      完成情况: findings.length > 0 ? `发现 ${findings.length} 项缺陷` : '未发现缺陷',
      任务状态: COMPLETED_STATUS,
      缺陷数量: findings.length,
      缺陷批次: taskCode,
    }
    const nextTasks = [...tasks]
    nextTasks[taskIndex] = completedTask

    // 原子提交：两张表一起落盘，任何一步抛错都不会留下半截状态。
    commitRows(
      new Map([
        [INSPECTION_KEY, nextTasks],
        [DEFECT_KEY, [...defects, ...generated]],
      ]),
    )
    return {
      ok: true,
      created: generated.length,
      message:
        generated.length > 0
          ? `巡检任务「${taskCode}」已完成，生成 ${generated.length} 条缺陷记录`
          : `巡检任务「${taskCode}」已完成，本次未发现缺陷（不生成占位记录）`,
    }
  } catch (error) {
    // 提交（落盘）失败：内存与存储都未改动，任务仍是执行中，可以重试。
    return {
      ok: false,
      message: `巡检任务提交失败，任务保持「${IN_PROGRESS_STATUS}」，可重试：${
        error instanceof Error ? error.message : '未知错误'
      }`,
    }
  } finally {
    completingTasks.delete(id)
  }
}

// 一致性体检：把「任务完成 ↔ 缺陷生成」这条链路上的缺失、重复、数量不符、孤儿全列出来。
// 只检查带批次标记的新链路数据；没有批次的历史记录按原样保留，不补不判。
export function inspectionConsistency(): ConsistencyIssue[] {
  const tasks = listRows(INSPECTION_KEY)
  const defects = listRows(DEFECT_KEY)
  const issues: ConsistencyIssue[] = []

  const byBatch = new Map<string, EntryRow[]>()
  for (const defect of defects) {
    const batch = String(defect.来源批次 ?? '')
    if (!batch) {
      continue // 历史缺陷：没有来源批次，不参与体检
    }
    const list = byBatch.get(batch) ?? []
    list.push(defect)
    byBatch.set(batch, list)
  }

  for (const task of tasks) {
    const batch = String(task.缺陷批次 ?? '')
    if (!batch) {
      continue // 历史任务：没有批次标记，保持原样，不补生成也不判异常
    }
    const taskCode = String(task.任务编号 ?? batch)
    const linked = byBatch.get(batch) ?? []

    if (String(task.status) !== COMPLETED_STATUS) {
      issues.push({
        kind: 'state_mismatch',
        ref: taskCode,
        taskId: Number(task.id),
        defectIds: linked.map((row) => Number(row.id)),
        message: `任务「${taskCode}」已生成缺陷批次但状态为「${task.status}」，完成与缺陷不一致`,
      })
    }

    if (linked.length === 0) {
      // 数量为 0 的空任务没有缺陷是正常结果；只有登记过缺陷却找不到记录才算缺失。
      if (Number(task.缺陷数量) > 0) {
        issues.push({
          kind: 'missing',
          ref: taskCode,
          taskId: Number(task.id),
          defectIds: [],
          message: `任务「${taskCode}」显示已完成且登记 ${task.缺陷数量} 条缺陷，但缺陷记录页缺失本任务的缺陷来源`,
        })
      }
      continue
    }

    // 同批次内「类型 + 描述」完全相同即重复录入（重看/并发产生的重复缺陷来源）。
    const seen = new Map<string, EntryRow[]>()
    for (const defect of linked) {
      const fingerprint = `${String(defect.缺陷类型)}@@${String(defect.缺陷描述)}`
      const group = seen.get(fingerprint) ?? []
      group.push(defect)
      seen.set(fingerprint, group)
    }
    for (const group of seen.values()) {
      if (group.length > 1) {
        issues.push({
          kind: 'duplicate',
          ref: taskCode,
          taskId: Number(task.id),
          defectIds: group.map((row) => Number(row.id)),
          message: `任务「${taskCode}」的缺陷「${group[0].缺陷描述}」重复 ${group.length} 条，来源批次同为「${batch}」`,
        })
      }
    }

    const expected = Number(task.缺陷数量)
    if (Number.isFinite(expected) && expected !== linked.length) {
      issues.push({
        kind: 'count_mismatch',
        ref: taskCode,
        taskId: Number(task.id),
        defectIds: linked.map((row) => Number(row.id)),
        message: `任务「${taskCode}」登记缺陷 ${expected} 条，缺陷页实际有 ${linked.length} 条来源记录`,
      })
    }
  }

  // 孤儿缺陷：带来源批次，但找不到对应的已完成任务批次。
  const taskBatches = new Set(
    tasks.map((row) => String(row.缺陷批次 ?? '')).filter((batch) => batch !== ''),
  )
  for (const [batch, linked] of byBatch) {
    if (!taskBatches.has(batch)) {
      issues.push({
        kind: 'orphan',
        ref: batch,
        defectIds: linked.map((row) => Number(row.id)),
        message: `${linked.length} 条缺陷的来源批次「${batch}」找不到对应巡检任务，属于孤儿记录`,
      })
    }
  }

  return issues
}

// 体检命中的缺陷/任务 id，页面据此给行打红底，让问题来源一眼可定位。
export function issueDefectIds(issues: ConsistencyIssue[]): Set<number> {
  return new Set(issues.flatMap((issue) => issue.defectIds))
}

export function issueTaskIds(issues: ConsistencyIssue[]): Set<number> {
  return new Set(
    issues.filter((issue) => issue.taskId !== undefined).map((issue) => issue.taskId as number),
  )
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
