<template>
  <section class="page" data-module="defect">
    <header class="page-head">
      <div>
        <h2>缺陷记录管理</h2>
        <p class="page-desc">维护缺陷记录，围绕缺陷编号、所属管线、缺陷类型、发现位置做登记、筛选与状态流转。巡检任务确认完成后，缺陷按来源批次一次性生成、可追溯、不重复。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记缺陷记录</button>
        <button class="btn" type="button" @click="exportRows">导出缺陷记录清单</button>
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
      <span v-if="sourceFilter" class="legend-item">来源任务筛选：{{ sourceFilter }}</span>
    </p>

    <div v-if="issues.length" class="issue-banner">
      <strong>缺陷与巡检任务一致性检查发现 {{ issues.length }} 个问题：</strong>
      <ul>
        <li v-for="(issue, index) in issues" :key="`${issue.kind}-${index}`">{{ issue.message }}</li>
      </ul>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>来源任务</span>
        <input v-model="sourceFilter" placeholder="按来源任务编号检索" />
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
          :class="{ 'issue-row': issueDefectIdSet.has(Number(row.id)) }"
        >
          <td v-for="column in columns" :key="column">
            <template v-if="column === '来源任务'">
              {{ row[column] ?? '—' }}
              <span v-if="issueDefectIdSet.has(Number(row.id))" class="issue-tag">来源异常</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            {{ sourceFilter ? `任务「${sourceFilter}」没有对应的缺陷记录（无缺陷任务不生成占位记录）` : '暂无缺陷记录数据，完成巡检任务后自动生成' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条缺陷记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  downloadEntries,
  inspectionConsistency,
  issueDefectIds,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { ConsistencyIssue, EntryRow } from '@/data/types'

const route = useRoute()
const router = useRouter()
const meta = moduleMeta('defect')
const columns = [
  '缺陷编号',
  '所属管线',
  '缺陷类型',
  '发现位置',
  '严重等级',
  '发现日期',
  '缺陷描述',
  '记录状态',
  '来源任务',
  '来源批次',
]
const actions = ['确认缺陷', '标记修复', '忽略缺陷']
const statuses = ['待确认', '已确认', '已修复', '已忽略']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['缺陷编号', '所属管线', '缺陷类型']
const sourceFilter = ref('')
const issues = ref<ConsistencyIssue[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  {
    label: '待确认缺陷',
    value: rows.value.filter((row) => String(row.status) === '待确认').length,
  },
  {
    label: '已修复缺陷',
    value: rows.value.filter((row) => String(row.status) === '已修复').length,
  },
  {
    label: '严重缺陷',
    value: rows.value.filter((row) => String(row.严重等级) === '严重').length,
  },
])

const issueDefectIdSet = computed(() => issueDefectIds(issues.value))

function resetFilters() {
  filters.value = {}
  sourceFilter.value = ''
  void router.replace({ query: {} })
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '缺陷记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
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
    // 来源任务与来源批次同值（批次确定性取任务编号），用「来源任务」一个入口筛选即可。
    const merged = sourceFilter.value.trim()
      ? { ...filters.value, 来源任务: sourceFilter.value.trim() }
      : filters.value
    const payload = listEntries(meta.key, merged)
    rows.value = payload.items
    total.value = payload.total
    issues.value = inspectionConsistency()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '缺陷记录列表读取失败'
  }
}

// 从巡检任务页「查看缺陷」跳进来时，按来源任务编号自动筛选。
watch(
  () => route.query.source,
  (source) => {
    sourceFilter.value = typeof source === 'string' ? source : ''
    reload()
  },
)

onMounted(() => {
  const source = route.query.source
  sourceFilter.value = typeof source === 'string' ? source : ''
  reload()
})
</script>
