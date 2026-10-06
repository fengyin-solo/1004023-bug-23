import type {
  CompletionDetail,
  DefectDraft,
  EntryRow,
  IntegrityIssue,
} from './types'

// 巡检完成 -> 缺陷生成的领域规则全部集中在这里，不直接读写 localStorage：
// 入参是整份数据的快照，返回值是下一份快照，保证任务状态与缺陷原子切换、天然幂等可重放。

const INSPECTION_KEY = 'inspection'
const DEFECT_KEY = 'defect'

// 任务/缺陷之间的溯源字段（扁平存进 EntryRow，跟现有的「字段即列」风格保持一致）。
export const TASK_BATCH_FIELD = 'completionBatchId'
export const TASK_COMPLETED_AT_FIELD = 'completedAt'
// 完成时约定本应生成的缺陷条数：0 表示本次本就无缺陷，用来和「缺陷丢失」区分开。
export const TASK_DEFECT_COUNT_FIELD = 'defectCount'
export const DEFECT_SOURCE_TASK_FIELD = '来源任务'
export const DEFECT_SOURCE_BATCH_FIELD = '来源批次'

const IN_PROGRESS = '执行中'
const DONE = '已完成'
const DEFECT_PENDING_STATUS = '待确认'

export class CompletionError extends Error {}

export function normalizeDraft(input: Partial<DefectDraft>): DefectDraft {
  return {
    pipeline: (input.pipeline ?? '').trim(),
    type: (input.type ?? '').trim(),
    location: (input.location ?? '').trim(),
    severity: (input.severity ?? '').trim() || '一般',
    description: (input.description ?? '').trim(),
  }
}

// 空任务允许提交（零缺陷就是零缺陷），但同一条任务里的缺陷不能内容重复。
export function validateDrafts(rawDrafts: Partial<DefectDraft>[]): DefectDraft[] {
  const drafts = rawDrafts.map(normalizeDraft)
  for (const draft of drafts) {
    if (!draft.type) {
      throw new CompletionError('缺陷类型不能为空')
    }
    if (!draft.location) {
      throw new CompletionError('发现位置不能为空')
    }
  }
  const seen = new Set<string>()
  for (const draft of drafts) {
    const fingerprint = [draft.pipeline, draft.type, draft.location, draft.severity, draft.description].join('|')
    if (seen.has(fingerprint)) {
      throw new CompletionError('本次录入存在内容完全相同的重复缺陷，请合并后再提交')
    }
    seen.add(fingerprint)
  }
  return drafts
}

function taskCode(task: EntryRow): string {
  return String(task['任务编号'] ?? `#${task.id}`)
}

function inspectDate(task: EntryRow): string {
  return String(task['巡检日期'] ?? new Date().toISOString().slice(0, 10))
}

// 批次号按任务确定性生成：同一任务无论提交/重看多少次都只认这一个批次，天然幂等。
function batchIdFor(task: EntryRow): string {
  return `CMP-${taskCode(task)}`
}

function nextDefectId(defects: EntryRow[]): number {
  return defects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextDefectCode(defects: EntryRow[]): string {
  return `DEFE-${String(nextDefectId(defects)).padStart(4, '0')}`
}

function buildDefect(
  id: number,
  code: string,
  task: EntryRow,
  batchId: string,
  draft: DefectDraft,
): EntryRow {
  return {
    id,
    status: DEFECT_PENDING_STATUS,
    pending: true,
    abnormal: false,
    缺陷编号: code,
    所属管线: draft.pipeline,
    缺陷类型: draft.type,
    发现位置: draft.location,
    严重等级: draft.severity,
    发现日期: inspectDate(task),
    缺陷描述: draft.description,
    记录状态: DEFECT_PENDING_STATUS,
    [DEFECT_SOURCE_TASK_FIELD]: taskCode(task),
    [DEFECT_SOURCE_BATCH_FIELD]: batchId,
  }
}

type ApplyResult = {
  state: Record<string, EntryRow[]>
  batchId: string
  defectCount: number
}

/**
 * 在给定快照上执行「确认完成」。
 * - 只接受「执行中」的任务：并发的第二个请求进来时，状态若已被先到的请求改走，这里直接拒绝；
 * - 任务已完成（含历史批次）时拒绝重复完成，绝不重复生成缺陷；
 * - 任务状态与缺陷在返回的同一份快照里切换，由存储层一次原子落盘，失败则整体不生效。
 */
export function applyCompletion(
  state: Record<string, EntryRow[]>,
  taskId: number,
  rawDrafts: Partial<DefectDraft>[],
  now: string,
): ApplyResult {
  const drafts = validateDrafts(rawDrafts)
  const inspections = state[INSPECTION_KEY] ?? []
  const defects = state[DEFECT_KEY] ? [...state[DEFECT_KEY]] : []
  const index = inspections.findIndex((row) => Number(row.id) === taskId)
  if (index < 0) {
    throw new CompletionError(`没有找到编号为 ${taskId} 的巡检任务`)
  }
  const task = inspections[index]

  // 幂等闸口：状态与批次双保险。任何一路显示已完成，都不再生成缺陷。
  if (task[TASK_BATCH_FIELD]) {
    throw new CompletionError('该任务已有完成批次，不能重复完成或重复生成缺陷')
  }
  if (String(task.status) === DONE) {
    throw new CompletionError('该任务已完成，不能重复操作')
  }
  if (String(task.status) !== IN_PROGRESS) {
    throw new CompletionError(`只有「${IN_PROGRESS}」的任务才能确认完成，当前状态为「${String(task.status)}」`)
  }

  const batchId = batchIdFor(task)
  let nextId = nextDefectId(defects)
  const created = drafts.map((draft) => {
    const id = nextId
    nextId += 1
    return buildDefect(id, `DEFE-${String(id).padStart(4, '0')}`, task, batchId, draft)
  })

  const completedTask: EntryRow = {
    ...task,
    status: DONE,
    pending: false,
    abnormal: false,
    完成情况: drafts.length === 0 ? '无缺陷' : `发现 ${drafts.length} 项缺陷`,
    任务状态: DONE,
    [TASK_BATCH_FIELD]: batchId,
    [TASK_COMPLETED_AT_FIELD]: now,
    [TASK_DEFECT_COUNT_FIELD]: drafts.length,
  }

  const nextInspections = [...inspections]
  nextInspections[index] = completedTask

  return {
    state: {
      ...state,
      [INSPECTION_KEY]: nextInspections,
      [DEFECT_KEY]: [...defects, ...created],
    },
    batchId,
    defectCount: created.length,
  }
}

/**
 * 补看任务完成记录：纯读取，绝不写数据。
 * 历史已完成但没有批次的任务只标记 legacy，不会因此补出任何占位缺陷。
 */
export function completionDetail(
  state: Record<string, EntryRow[]>,
  taskId: number,
): CompletionDetail | null {
  const task = (state[INSPECTION_KEY] ?? []).find((row) => Number(row.id) === taskId)
  if (!task) {
    return null
  }
  const batchId = task[TASK_BATCH_FIELD] ? String(task[TASK_BATCH_FIELD]) : ''
  if (String(task.status) !== DONE) {
    return null
  }
  if (!batchId) {
    return {
      batchId: '',
      completedAt: task[TASK_COMPLETED_AT_FIELD] ? String(task[TASK_COMPLETED_AT_FIELD]) : '',
      defects: [],
      legacy: true,
    }
  }
  const linked = (state[DEFECT_KEY] ?? []).filter(
    (row) => String(row[DEFECT_SOURCE_BATCH_FIELD] ?? '') === batchId,
  )
  return {
    batchId,
    completedAt: task[TASK_COMPLETED_AT_FIELD] ? String(task[TASK_COMPLETED_AT_FIELD]) : '',
    legacy: false,
    defects: linked.map((row) =>
      normalizeDraft({
        pipeline: String(row['所属管线'] ?? ''),
        type: String(row['缺陷类型'] ?? ''),
        location: String(row['发现位置'] ?? ''),
        severity: String(row['严重等级'] ?? ''),
        description: String(row['缺陷描述'] ?? ''),
      }),
    ),
  }
}

function sameFingerprint(a: EntryRow, b: EntryRow): boolean {
  const fields = ['所属管线', '缺陷类型', '发现位置', '严重等级', '缺陷描述']
  return fields.every((field) => String(a[field] ?? '') === String(b[field] ?? ''))
}

/**
 * 任务完成与缺陷生成的对账，供缺陷页标注问题来源：
 * - missing   任务批次声称有缺陷，但缺陷记录缺了（原子提交失败/数据丢失）；
 * - duplicate 同一批次出现重复缺陷（重复提交/重复生成）；
 * - orphan    缺陷指向的任务或批次不存在（任务缺失）；
 * - unsourced 缺陷没有任何来源（手工/历史脏数据）。
 * 历史无批次的已完成任务按零缺陷处理，不判缺失，补看稳定。
 */
export function integrityScan(state: Record<string, EntryRow[]>): IntegrityIssue[] {
  const issues: IntegrityIssue[] = []
  const inspections = state[INSPECTION_KEY] ?? []
  const defects = state[DEFECT_KEY] ?? []
  const tasksById = new Map(inspections.map((row) => [Number(row.id), row]))
  const taskCodeToId = new Map(inspections.map((row) => [taskCode(row), Number(row.id)]))

  // 1) 从任务侧对账：批次是否有对应的、不重复的缺陷。
  for (const task of inspections) {
    if (String(task.status) !== DONE) {
      continue
    }
    const batchId = task[TASK_BATCH_FIELD] ? String(task[TASK_BATCH_FIELD]) : ''
    if (!batchId) {
      continue // 历史完成记录：无批次即零缺陷，不补占位、不判缺失。
    }
    const linked = defects.filter((row) => String(row[DEFECT_SOURCE_BATCH_FIELD] ?? '') === batchId)
    const expected = Number(task[TASK_DEFECT_COUNT_FIELD] ?? 0)
    if (linked.length < expected) {
      issues.push({
        kind: 'missing',
        label: '缺陷缺失',
        taskId: Number(task.id),
        taskCode: taskCode(task),
        batchId,
        defectIds: linked.map((row) => Number(row.id)),
        detail:
          `任务 ${taskCode(task)} 已完成（批次 ${batchId}），应生成 ${expected} 条缺陷，缺陷记录页仅有 ${linked.length} 条，`
          + `缺失 ${expected - linked.length} 条，疑似提交中断或数据丢失`,
      })
    } else if (linked.length > expected) {
      issues.push({
        kind: 'duplicate',
        label: '缺陷重复',
        taskId: Number(task.id),
        taskCode: taskCode(task),
        batchId,
        defectIds: linked.map((row) => Number(row.id)),
        detail:
          `任务 ${taskCode(task)} 完成时只应生成 ${expected} 条缺陷，缺陷记录页却有 ${linked.length} 条，`
          + `多出 ${linked.length - expected} 条，疑似重复提交或重复生成`,
      })
    }
    if (linked.length >= expected) {
      for (let i = 0; i < linked.length; i += 1) {
        for (let j = i + 1; j < linked.length; j += 1) {
          if (sameFingerprint(linked[i], linked[j])) {
            issues.push({
              kind: 'duplicate',
              label: '缺陷重复',
              taskId: Number(task.id),
              taskCode: taskCode(task),
              batchId,
              defectIds: [Number(linked[i].id), Number(linked[j].id)],
              detail: `任务 ${taskCode(task)} 的同一批次 ${batchId} 出现内容重复的缺陷（编号 ${linked[i]['缺陷编号']}、${linked[j]['缺陷编号']}），属于重复生成`,
            })
          }
        }
      }
    }
  }

  // 2) 从缺陷侧对账：每条带来源的缺陷都要能指回任务批次。
  for (const defect of defects) {
    const sourceCode = defect[DEFECT_SOURCE_TASK_FIELD] ? String(defect[DEFECT_SOURCE_TASK_FIELD]) : ''
    const sourceBatch = defect[DEFECT_SOURCE_BATCH_FIELD] ? String(defect[DEFECT_SOURCE_BATCH_FIELD]) : ''
    if (!sourceCode && !sourceBatch) {
      issues.push({
        kind: 'unsourced',
        label: '来源不明',
        defectIds: [Number(defect.id)],
        defectCode: String(defect['缺陷编号'] ?? defect.id),
        detail: `缺陷 ${defect['缺陷编号'] ?? defect.id} 没有关联来源任务，无法确认由哪次巡检生成`,
      })
      continue
    }
    const ownerId = taskCodeToId.get(sourceCode)
    const owner = ownerId === undefined ? undefined : tasksById.get(ownerId)
    const ownerBatch = owner?.[TASK_BATCH_FIELD] ? String(owner[TASK_BATCH_FIELD]) : ''
    if (!owner || String(owner.status) !== DONE || ownerBatch !== sourceBatch) {
      issues.push({
        kind: 'orphan',
        label: '来源任务缺失',
        defectIds: [Number(defect.id)],
        defectCode: String(defect['缺陷编号'] ?? defect.id),
        detail: `缺陷 ${defect['缺陷编号'] ?? defect.id} 指向任务 ${sourceCode || '（空）'} / 批次 ${sourceBatch || '（空）'}，但没有对应的已完成任务，疑似任务丢失或重复残留`,
      })
    }
  }

  return issues
}
