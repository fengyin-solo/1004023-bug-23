<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检任务管理</h2>
        <p class="page-desc">维护巡检任务，围绕任务编号、巡检区域、巡检人员、巡检日期做登记、筛选与状态流转。确认完成时录入本次巡检发现，缺陷记录同步生成。</p>
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

    <div v-if="issues.length" class="issue-banner">
      <strong>完成与缺陷一致性检查发现 {{ issues.length }} 个问题：</strong>
      <ul>
        <li v-for="(issue, index) in issues" :key="`${issue.kind}-${index}`">{{ issue.message }}</li>
      </ul>
    </div>

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
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'issue-row': issueTaskIdSet.has(Number(row.id)) }"
        >
          <td v-for="column in columns" :key="column">
            <template v-if="column === '缺陷数量'">{{ hasBatch(row) ? row[column] : '—' }}</template>
            <template v-else-if="column === '缺陷批次'">{{ hasBatch(row) ? row[column] : '历史记录' }}</template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            {{ row.status }}
            <span v-if="issueTaskIdSet.has(Number(row.id))" class="issue-tag">链路异常</span>
          </td>
          <td class="row-actions">
            <template v-for="action in actions" :key="action">
              <button
                v-if="action !== '确认完成' || String(row.status) === '执行中'"
                class="link"
                type="button"
                :disabled="submittingId === Number(row.id)"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <button
              v-if="hasBatch(row)"
              class="link"
              type="button"
              @click="gotoDefects(row)"
            >
              查看缺陷
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
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-else-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="completing" class="modal-mask" @click.self="closeComplete">
      <div class="modal">
        <h3>确认完成巡检任务</h3>
        <p class="modal-sub">
          任务编号：{{ completingRow?.任务编号 }} · 巡检区域：{{ completingRow?.巡检区域 }}
        </p>
        <label class="form-item">
          <span>本次发现（每行一条缺陷，格式「缺陷类型：具体描述」，留空表示无缺陷）</span>
          <textarea
            v-model="findingsText"
            rows="6"
            placeholder="例如：&#10;管道破损：三号井盖东侧约20米管壁开裂&#10;淤积堵塞：二号检查井上游支管淤积&#10;&#10;本次巡检没有发现缺陷时，保持空白直接提交即可"
          ></textarea>
        </label>
        <label class="form-item">
          <span>默认严重等级</span>
          <select v-model="severity">
            <option v-for="item in severityOptions" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <p class="modal-hint">
          提交后任务与缺陷一次性写入；无缺陷任务只记数量 0，不生成占位记录。重复查看历史任务不会重复生成。
        </p>
        <p v-if="completeError" class="error-text">{{ completeError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" :disabled="submitting" @click="closeComplete">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitComplete">
            {{ submitting ? '提交中…' : '确认完成并生成缺陷' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  completeInspection,
  downloadEntries,
  inspectionConsistency,
  issueTaskIds,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { ConsistencyIssue, EntryRow } from '@/data/types'

const router = useRouter()
const meta = moduleMeta('inspection')
const columns = [
  '任务编号',
  '巡检区域',
  '巡检人员',
  '巡检日期',
  '巡检路线',
  '计划时长',
  '完成情况',
  '任务状态',
  '缺陷数量',
  '缺陷批次',
]
const actions = ['分配任务', '开始巡检', '确认完成']
const statuses = ['待分配', '已分配', '执行中', '已完成']
const severityOptions = ['一般', '较重', '严重']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['任务编号', '巡检区域', '巡检人员']
const issues = ref<ConsistencyIssue[]>([])

const completing = ref(false)
const completingRow = ref<EntryRow | null>(null)
const findingsText = ref('')
const severity = ref('一般')
const submitting = ref(false)
const submittingId = ref<number | null>(null)
const completeError = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '今日任务', value: rows.value.length },
  {
    label: '待分配任务',
    value: rows.value.filter((row) => String(row.status) === '待分配').length,
  },
  {
    label: '已完成任务',
    value: rows.value.filter((row) => String(row.status) === '已完成').length,
  },
])

const issueTaskIdSet = computed(() => issueTaskIds(issues.value))

function hasBatch(row: EntryRow): boolean {
  return String(row.缺陷批次 ?? '') !== ''
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

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '确认完成') {
    openComplete(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function openComplete(row: EntryRow) {
  completingRow.value = row
  findingsText.value = ''
  severity.value = '一般'
  completeError.value = ''
  submitting.value = false
  completing.value = true
}

function closeComplete() {
  if (submitting.value) {
    return
  }
  completing.value = false
  completingRow.value = null
}

async function submitComplete() {
  if (!completingRow.value || submitting.value) {
    return
  }
  submitting.value = true
  submittingId.value = Number(completingRow.value.id)
  completeError.value = ''
  // 与服务端的同步重入锁再错开一个事件循环，彻底挡住双击连发。
  await Promise.resolve()
  const result = completeInspection(Number(completingRow.value.id), {
    findingsText: findingsText.value,
    severity: severity.value,
  })
  submitting.value = false
  submittingId.value = null
  if (!result.ok) {
    completeError.value = result.message
    return
  }
  completing.value = false
  completingRow.value = null
  reload()
  noticeMessage.value = result.message
}

function gotoDefects(row: EntryRow) {
  void router.push({ path: '/defect', query: { source: String(row.任务编号 ?? '') } })
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    issues.value = inspectionConsistency()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡检任务列表读取失败'
  }
}

onMounted(reload)
</script>
