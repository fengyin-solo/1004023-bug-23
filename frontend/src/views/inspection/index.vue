<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检任务管理</h2>
        <p class="page-desc">维护巡检任务，围绕任务编号、巡检区域、巡检人员、巡检日期做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检任务</button>
        <button class="btn" type="button" @click="exportRows">导出巡检任务清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              :disabled="action === '确认完成' && submittingId === Number(row.id)"
              type="button"
              @click="runAction(action, row)"
            >
              {{ actionLabel(action, row) }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡检任务数据，可先登记巡检任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检任务记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 确认完成：任务状态与本次缺陷原子提交，提交中锁定，失败可直接重试 -->
    <div v-if="dialogMode === 'complete' && currentTask" class="modal-mask" @click.self="closeDialog">
      <div class="modal-box">
        <h3 class="modal-title">确认完成 · {{ currentTask['任务编号'] }}</h3>
        <p class="modal-hint">
          提交后任务置为「已完成」，同时原子生成下列缺陷；不添加缺陷即视为本次无缺陷，不会生成占位记录。同一任务重复提交或重复查看都不会再次生成缺陷。
        </p>

        <table class="data-table draft-table">
          <thead>
            <tr>
              <th>所属管线</th>
              <th>缺陷类型</th>
              <th>发现位置</th>
              <th>严重等级</th>
              <th>缺陷描述</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(draft, index) in drafts" :key="index">
              <td><input v-model="draft.pipeline" placeholder="选填" /></td>
              <td><input v-model="draft.type" placeholder="必填，如破裂" /></td>
              <td><input v-model="draft.location" placeholder="必填，如桩号 K1+200" /></td>
              <td>
                <select v-model="draft.severity">
                  <option v-for="level in severityLevels" :key="level" :value="level">{{ level }}</option>
                </select>
              </td>
              <td><input v-model="draft.description" placeholder="选填" /></td>
              <td>
                <button class="link danger" type="button" :disabled="submitting" @click="removeDraft(index)">删除</button>
              </td>
            </tr>
            <tr v-if="!drafts.length">
              <td colspan="6" class="empty-state">本次巡检未录入缺陷（提交后不生成任何占位记录）</td>
            </tr>
          </tbody>
        </table>

        <div class="modal-toolbar">
          <button class="btn" type="button" :disabled="submitting" @click="addDraft">+ 添加缺陷</button>
          <label class="fail-toggle" title="用于验证提交失败时任务不会变成已完成">
            <input v-model="simulateFailure" type="checkbox" :disabled="submitting" />
            模拟本次提交失败（验证回滚）
          </label>
        </div>

        <p v-if="dialogError" class="error-text dialog-error">{{ dialogError }}</p>

        <div class="modal-actions">
          <button class="btn ghost" type="button" :disabled="submitting" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitComplete">
            {{ submitting ? '提交中…' : '确认完成并提交' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 查看完成：纯只读补看，不写任何数据；历史无缺陷任务不会被补占位 -->
    <div v-if="dialogMode === 'detail' && currentTask" class="modal-mask" @click.self="closeDialog">
      <div class="modal-box">
        <h3 class="modal-title">完成记录 · {{ currentTask['任务编号'] }}</h3>
        <ul class="detail-meta">
          <li>任务状态：{{ currentTask.status }}</li>
          <li>完成批次：{{ detail?.batchId || '历史完成记录（无批次）' }}</li>
          <li>完成时间：{{ detail?.completedAt || '—' }}</li>
          <li>缺陷数量：{{ detail?.defects.length ?? 0 }}</li>
        </ul>
        <table class="data-table draft-table">
          <thead>
            <tr>
              <th>所属管线</th>
              <th>缺陷类型</th>
              <th>发现位置</th>
              <th>严重等级</th>
              <th>缺陷描述</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(draft, index) in detail?.defects ?? []" :key="index">
              <td>{{ draft.pipeline || '—' }}</td>
              <td>{{ draft.type }}</td>
              <td>{{ draft.location }}</td>
              <td>{{ draft.severity }}</td>
              <td>{{ draft.description || '—' }}</td>
            </tr>
            <tr v-if="!detail || detail.defects.length === 0">
              <td colspan="5" class="empty-state">
                {{ detail?.legacy ? '历史完成记录：无批次、无缺陷，不补占位' : '本次巡检无缺陷，无占位记录' }}
              </td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="closeDialog">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getCompletionDetail,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitInspectionCompletion,
} from '@/api/local-service'
import type { CompletionDetail, DefectDraft, EntryRow } from '@/data/types'

const meta = moduleMeta('inspection')
const columns = ['任务编号', '巡检区域', '巡检人员', '巡检日期', '巡检路线', '计划时长', '完成情况', '任务状态']
const statuses = ['待分配', '已分配', '执行中', '已完成']
const severityLevels = ['轻微', '一般', '严重', '紧急']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return [
    { label: '今日任务', value: rows.value.filter((row) => String(row['巡检日期']) === today).length },
    { label: '待分配任务', value: rows.value.filter((row) => String(row.status) === '待分配').length },
    { label: '已完成任务', value: rows.value.filter((row) => String(row.status) === '已完成').length },
  ]
})

// 完成弹窗状态
const dialogMode = ref<'' | 'complete' | 'detail'>('')
const currentTask = ref<EntryRow | null>(null)
const drafts = ref<DefectDraft[]>([])
const detail = ref<CompletionDetail | null>(null)
const submitting = ref(false)
const submittingId = ref(0)
const dialogError = ref('')
const simulateFailure = ref(false)

function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待分配':
      return ['分配任务']
    case '已分配':
      return ['开始巡检']
    case '执行中':
      return ['确认完成']
    case '已完成':
      return ['查看完成']
    default:
      return []
  }
}

function actionLabel(action: string, row: EntryRow): string {
  if (action === '确认完成' && submittingId.value === Number(row.id)) {
    return '提交中…'
  }
  return action
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡检任务登记入口尚未接入审批流'
}

function closeDialog() {
  if (submitting.value) {
    return
  }
  dialogMode.value = ''
  currentTask.value = null
  drafts.value = []
  detail.value = null
  dialogError.value = ''
  simulateFailure.value = false
}

function openComplete(row: EntryRow) {
  currentTask.value = row
  drafts.value = []
  detail.value = null
  dialogError.value = ''
  simulateFailure.value = false
  dialogMode.value = 'complete'
}

function openDetail(row: EntryRow) {
  currentTask.value = row
  detail.value = getCompletionDetail(Number(row.id))
  dialogError.value = ''
  dialogMode.value = 'detail'
}

function addDraft() {
  drafts.value.push({ pipeline: '', type: '', location: '', severity: '一般', description: '' })
}

function removeDraft(index: number) {
  drafts.value.splice(index, 1)
}

async function submitComplete() {
  if (!currentTask.value || submitting.value) {
    return
  }
  submitting.value = true
  submittingId.value = Number(currentTask.value.id)
  dialogError.value = ''
  try {
    const result = await submitInspectionCompletion(
      Number(currentTask.value.id),
      drafts.value,
      { simulateFailure: simulateFailure.value },
    )
    if (!result.ok) {
      // 失败不关弹窗、任务保持「执行中」：用户改完缺陷或重试都在当前表单里进行。
      dialogError.value = result.message
      return
    }
    closeDialog()
    reload()
  } finally {
    submitting.value = false
    submittingId.value = 0
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '确认完成') {
    openComplete(row)
    return
  }
  if (action === '查看完成') {
    openDetail(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡检任务列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-box {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: min(880px, 92vw);
  max-height: 86vh;
  overflow: auto;
}
.modal-title { margin: 0 0 8px; font-size: 16px; }
.modal-hint { margin: 0 0 12px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.draft-table input,
.draft-table select {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 13px;
}
.modal-toolbar { display: flex; justify-content: space-between; align-items: center; margin: 10px 0; }
.fail-toggle { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.dialog-error { margin: 6px 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.link.danger { color: #b42318; }
.link:disabled { color: #9aa7b8; cursor: not-allowed; }
.detail-meta { list-style: none; padding: 0; margin: 0 0 12px; display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 13px; }
</style>
