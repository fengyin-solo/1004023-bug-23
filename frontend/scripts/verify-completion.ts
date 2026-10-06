/* 领域不变量验证脚本（非生产代码）：
   用内存 localStorage 在 Node 里驱动 service + 纯领域层，逐条核对巡检完成与缺陷生成的对应关系。
   运行：npx esbuild scripts/verify-completion.ts --bundle --platform=node --format=esm | node --input-type=module
*/
import {
  applyCompletion,
  completionDetail,
  DEFECT_SOURCE_BATCH_FIELD,
  DEFECT_SOURCE_TASK_FIELD,
  TASK_BATCH_FIELD,
  TASK_DEFECT_COUNT_FIELD,
} from '../src/data/inspection-completion'
import {
  getCompletionDetail,
  listIntegrityIssues,
  runAction,
  submitInspectionCompletion,
} from '../src/api/local-service'
import { allRows, commitState } from '../src/data/local-store'
import type { EntryRow } from '../src/data/types'

type Store = Record<string, string>
const mem: Store = {}
const localStorageMock = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v
  },
  removeItem: (k: string) => {
    delete mem[k]
  },
  clear: () => {
    for (const k of Object.keys(mem)) delete mem[k]
  },
}
;(globalThis as { window: unknown }).window = {
  localStorage: localStorageMock,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
}

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}
function freshState(): Record<string, EntryRow[]> {
  return JSON.parse(JSON.stringify({
    inspection: [
      { id: 1, status: '待分配', pending: true, abnormal: false, 任务编号: 'INSP-T01', 巡检日期: '2026-10-06' },
      { id: 2, status: '已分配', pending: true, abnormal: false, 任务编号: 'INSP-T02', 巡检日期: '2026-10-06' },
      { id: 3, status: '执行中', pending: false, abnormal: false, 任务编号: 'INSP-T03', 巡检日期: '2026-10-06' },
      { id: 4, status: '执行中', pending: false, abnormal: false, 任务编号: 'INSP-T04', 巡检日期: '2026-10-06' },
      { id: 5, status: '已完成', pending: false, abnormal: false, 任务编号: 'INSP-T05', 巡检日期: '2026-10-01' },
    ],
    defect: [
      { id: 1, status: '待确认', pending: true, abnormal: false, 缺陷编号: 'DEFE-0001' },
    ],
  })) as Record<string, EntryRow[]>
}
function reset(factory: () => Record<string, EntryRow[]> = freshState) {
  memClear()
  commitState(factory())
}
function memClear() {
  for (const k of Object.keys(mem)) delete mem[k]
}
function defects() {
  return allRows().defect
}
function task(id: number) {
  return allRows().inspection.find((r) => Number(r.id) === id)!
}
const D = (over: Partial<{ pipeline: string; type: string; location: string; severity: string; description: string }> = {}) => ({
  pipeline: over.pipeline ?? '',
  type: over.type ?? '破裂',
  location: over.location ?? 'K1+000',
  severity: over.severity ?? '一般',
  description: over.description ?? '',
})

async function main() {
  // 1. 正常完成：任务已完成 + 缺陷同批生成，来源字段齐全
  reset()
  let r = await submitInspectionCompletion(3, [D({ type: '破裂', location: 'K1+000' }), D({ type: '渗漏', location: 'K1+200', severity: '严重' })])
  check('1.1 正常完成返回 ok', r.ok, r.message)
  check('1.2 回报缺陷数为 2', r.defectCount === 2)
  check('1.3 任务状态为已完成', String(task(3).status) === '已完成')
  check('1.4 任务记录批次号', String(task(3)[TASK_BATCH_FIELD]) === 'CMP-INSP-T03')
  check('1.5 缺陷总数为 3（原有 1 + 新增 2）', defects().length === 3, `实际 ${defects().length}`)
  const generated = defects().filter((d) => String(d[DEFECT_SOURCE_BATCH_FIELD]) === 'CMP-INSP-T03')
  check('1.6 新缺陷带来源任务', generated.every((d) => String(d[DEFECT_SOURCE_TASK_FIELD]) === 'INSP-T03'))
  check('1.7 新缺陷默认待确认且计入待处理', generated.every((d) => d.status === '待确认' && d.pending === true))
  check('1.8 完成情况回填缺陷数', String(task(3)['完成情况']) === '发现 2 项缺陷')

  // 2. 空任务：零缺陷、零占位
  reset()
  r = await submitInspectionCompletion(3, [])
  check('2.1 空任务完成成功', r.ok, r.message)
  check('2.2 回报缺陷数为 0', r.defectCount === 0)
  check('2.3 不生成任何缺陷', defects().length === 1, `实际 ${defects().length}`)
  check('2.4 完成情况标记无缺陷', String(task(3)['完成情况']) === '无缺陷')
  const detailEmpty = completionDetail(allRows(), 3)
  check('2.5 补看空任务返回 0 条且非历史', detailEmpty !== null && detailEmpty.defects.length === 0 && !detailEmpty.legacy)

  // 3. 幂等：同一任务重复完成/重复查看不再产生缺陷
  reset()
  await submitInspectionCompletion(3, [D()])
  const countAfterFirst = defects().length
  r = await submitInspectionCompletion(3, [D()])
  check('3.1 重复完成被拒', !r.ok)
  check('3.2 拒绝后缺陷数不变', defects().length === countAfterFirst)
  const detail1 = getCompletionDetail(3)
  const detail2 = getCompletionDetail(3)
  check('3.3 重复补看结果一致', JSON.stringify(detail1) === JSON.stringify(detail2))
  check('3.4 补看只有 1 条缺陷', detail1?.defects.length === 1)
  r = runAction('inspection', 3, '确认完成')
  check('3.5 通用动作路径无法绕过完成闸口', !r.ok)
  r = runAction('inspection', 1, '开始巡检')
  check('3.6 待分配任务不能跳步开始巡检', !r.ok)
  r = runAction('inspection', 1, '分配任务')
  check('3.7 待分配可正常分配', r.ok && String(task(1).status) === '已分配')
  r = runAction('inspection', 2, '分配任务')
  check('3.8 已分配不能重复/跳步分配', !r.ok)

  // 4. 非法状态不能完成
  reset()
  r = await submitInspectionCompletion(1, [D()])
  check('4.1 待分配任务不能确认完成', !r.ok)
  check('4.2 失败任务状态不变', String(task(1).status) === '待分配')
  r = await submitInspectionCompletion(5, [D()])
  check('4.3 已完成任务不能重复完成', !r.ok)
  check('4.4 已完成任务无批次时不补缺陷', defects().length === 1)

  // 5. 并发：同时点两次确认完成，只有一次生效
  reset()
  const [a, b] = await Promise.all([
    submitInspectionCompletion(3, [D({ location: '并发-A' })]),
    submitInspectionCompletion(3, [D({ location: '并发-B' })]),
  ])
  check('5.1 并发只有一个成功', a.ok !== b.ok)
  check('5.2 只生成 1 条缺陷', defects().filter((d) => String(d[DEFECT_SOURCE_TASK_FIELD]) === 'INSP-T03').length === 1)
  check('5.3 任务只完成一次', String(task(3).status) === '已完成')

  // 6. 提交失败：任务不置完成、不生成缺陷、可重试
  reset()
  r = await submitInspectionCompletion(3, [D()], { simulateFailure: true })
  check('6.1 模拟失败返回错误', !r.ok)
  check('6.2 任务保持执行中', String(task(3).status) === '执行中')
  check('6.3 未生成缺陷', defects().length === 1)
  check('6.4 任务无批次残留', task(3)[TASK_BATCH_FIELD] === undefined)
  r = await submitInspectionCompletion(3, [D()])
  check('6.5 失败后可原样重试成功', r.ok)
  check('6.6 重试后生成 1 条缺陷', defects().length === 2)

  // 6b. 校验失败：缺字段/同次重复
  reset()
  r = await submitInspectionCompletion(3, [{ type: '', location: 'X' }])
  check('6.7 缺陷类型为空被拒', !r.ok && String(task(3).status) === '执行中')
  r = await submitInspectionCompletion(3, [D({ type: '破裂', location: 'K1' }), D({ type: '破裂', location: 'K1' })])
  check('6.8 同次内容重复被拒', !r.ok && defects().length === 1)

  // 7. 对账：缺失、重复、孤立、来源不明都能点出来源
  reset(() => {
    const s = freshState()
    // task 3 应生成 2 条但缺陷缺失 -> missing
    s.inspection[2] = { ...s.inspection[2], status: '已完成', pending: false, [TASK_BATCH_FIELD]: 'CMP-INSP-T03', [TASK_DEFECT_COUNT_FIELD]: 2 }
    // task 4 应生成 1 条却有两条（且内容重复） -> duplicate
    s.inspection[3] = { ...s.inspection[3], status: '已完成', pending: false, [TASK_BATCH_FIELD]: 'CMP-INSP-T04', [TASK_DEFECT_COUNT_FIELD]: 1 }
    s.defect.push(
      { id: 2, status: '待确认', pending: true, abnormal: false, 缺陷编号: 'DEFE-0002', 所属管线: '', 缺陷类型: '破裂', 发现位置: 'K2', 严重等级: '一般', 缺陷描述: '', [DEFECT_SOURCE_TASK_FIELD]: 'INSP-T04', [DEFECT_SOURCE_BATCH_FIELD]: 'CMP-INSP-T04' },
      { id: 3, status: '待确认', pending: true, abnormal: false, 缺陷编号: 'DEFE-0003', 所属管线: '', 缺陷类型: '破裂', 发现位置: 'K2', 严重等级: '一般', 缺陷描述: '', [DEFECT_SOURCE_TASK_FIELD]: 'INSP-T04', [DEFECT_SOURCE_BATCH_FIELD]: 'CMP-INSP-T04' },
      { id: 4, status: '待确认', pending: true, abnormal: false, 缺陷编号: 'DEFE-0004', [DEFECT_SOURCE_TASK_FIELD]: 'INSP-GONE', [DEFECT_SOURCE_BATCH_FIELD]: 'CMP-GONE' },
      { id: 5, status: '待确认', pending: true, abnormal: false, 缺陷编号: 'DEFE-0005' },
    )
    return s
  })
  const issues = listIntegrityIssues()
  const kinds = issues.map((i) => i.kind).sort()
  check('7.1 识别出缺陷缺失', kinds.includes('missing'))
  check('7.2 识别出缺陷重复', kinds.includes('duplicate'))
  check('7.3 识别出来源任务缺失（孤立）', kinds.includes('orphan'))
  check('7.4 识别出来源不明', kinds.includes('unsourced'))
  const missing = issues.find((i) => i.kind === 'missing')
  check('7.5 缺失问题指得到任务和批次', missing?.taskCode === 'INSP-T03' && missing.batchId === 'CMP-INSP-T03')
  const dup = issues.find((i) => i.kind === 'duplicate')
  check('7.6 重复问题点名两条缺陷编号', (dup?.defectIds ?? []).join() === '2,3')
  check('7.7 缺失问题给出应生成/实有数量', missing?.detail.includes('应生成 2 条') && missing.detail.includes('仅有 0 条'), missing?.detail ?? '')

  // 8. 历史完成记录补看稳定：无批次、无缺陷不补占位、不判缺失
  reset()
  const legacy = completionDetail(allRows(), 5)
  check('8.1 历史完成记录标记 legacy', legacy !== null && legacy.legacy === true && legacy.defects.length === 0)
  const issuesLegacy = listIntegrityIssues()
  check('8.2 历史无缺陷完成不被判定为缺失', !issuesLegacy.some((i) => i.kind === 'missing' && i.taskCode === 'INSP-T05'))

  // 8b. 正常流程完成的零缺陷任务（有批次、应生成 0 条）不被误判为缺失
  reset(() => {
    const s = freshState()
    s.defect = []
    return s
  })
  await submitInspectionCompletion(3, [])
  const issuesEmpty = listIntegrityIssues()
  check('8.3 合法零缺陷完成不产生任何对账问题', issuesEmpty.length === 0, JSON.stringify(issuesEmpty))

  // 9. 编号确定性与并发顺序无关：连续两次不同任务完成，编号不串不重
  reset()
  await submitInspectionCompletion(3, [D({ location: 'A' })])
  await submitInspectionCompletion(4, [D({ location: 'B' })])
  const codes = defects().slice(1).map((d) => d.id)
  check('9.1 缺陷 id 单调不重复', codes.join(',') === '2,3')
  const t3 = getCompletionDetail(3)
  const t4 = getCompletionDetail(4)
  check('9.2 两任务批次不同、缺陷互不串单', t3?.batchId === 'CMP-INSP-T03' && t4?.batchId === 'CMP-INSP-T04' && t3.defects[0].location === 'A' && t4.defects[0].location === 'B')

  // 10. applyCompletion 纯函数：不修改入参快照
  reset()
  const snapshot = allRows()
  const jsonBefore = JSON.stringify(snapshot)
  applyCompletion(snapshot, 3, [D()], '2026-10-06T10:00:00Z')
  check('10.1 纯函数不改变输入快照', JSON.stringify(snapshot) === jsonBefore)

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
