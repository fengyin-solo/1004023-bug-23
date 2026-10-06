<template>
  <section class="page" data-module="defect">
    <header class="page-head">
      <div>
        <h2>缺陷记录管理</h2>
        <p class="page-desc">维护缺陷记录，围绕缺陷编号、所属管线、缺陷类型、发现位置做登记、筛选与状态流转；每条巡检缺陷都能追溯到唯一的完成批次。</p>
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

    <!-- 与巡检任务的对账结果：缺失/重复/来源缺失都在这里点名，运营能看出问题来自哪次任务 -->
    <div v-if="issues.length" class="issue-banner">
      <h4 class="issue-title">发现 {{ issues.length }} 处任务—缺陷对应关系异常</h4>
      <ul class="issue-list">
        <li v-for="(issue, index) in issues" :key="index" :class="['issue-item', `kind-${issue.kind}`]">
          <span class="issue-tag">{{ issue.label }}</span>
          <span>{{ issue.detail }}</span>
        </li>
      </ul>
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
          <th>来源任务</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-issue': issueOf(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span v-if="row[SOURCE_TASK_FIELD]">{{ row[SOURCE_TASK_FIELD] }}</span>
            <span v-else class="source-unknown">来源不明</span>
            <span v-if="issueOf(row)" :class="['row-issue-flag', `kind-${issueOf(row)!.kind}`]">
              {{ issueOf(row)!.label }}
            </span>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无缺陷记录数据，可先登记缺陷记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条缺陷记录（{{ issues.length }} 条对应关系异常）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listIntegrityIssues,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { DEFECT_SOURCE_TASK_FIELD as SOURCE_TASK_FIELD } from '@/data/inspection-completion'
import type { EntryRow, IntegrityIssue } from '@/data/types'

const meta = moduleMeta('defect')
const columns = ['缺陷编号', '所属管线', '缺陷类型', '发现位置', '严重等级', '发现日期', '缺陷描述', '记录状态']
const actions = ['确认缺陷', '标记修复', '忽略缺陷']
const statuses = ['待确认', '已确认', '已修复', '已忽略']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const issues = ref<IntegrityIssue[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待确认缺陷', value: rows.value.filter((row) => String(row.status) === '待确认').length },
  { label: '已修复缺陷', value: rows.value.filter((row) => String(row.status) === '已修复').length },
  { label: '严重缺陷', value: rows.value.filter((row) => String(row['严重等级']) === '严重' || String(row['严重等级']) === '紧急').length },
])

// 每条缺陷命中的对账问题（取最严重的一个用于行标记）。
const issuePriority: Record<IntegrityIssue['kind'], number> = {
  missing: 4,
  duplicate: 3,
  orphan: 2,
  unsourced: 1,
}

function issueOf(row: EntryRow): IntegrityIssue | null {
  const id = Number(row.id)
  const matched = issues.value
    .filter((issue) => issue.defectIds?.includes(id))
    .sort((a, b) => issuePriority[b.kind] - issuePriority[a.kind])
  return matched[0] ?? null
}

function resetFilters() {
  filters.value = {}
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    issues.value = listIntegrityIssues()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '缺陷记录列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.issue-banner {
  background: #fef3f2;
  border: 1px solid #f0a9a2;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.issue-title { margin: 0 0 8px; font-size: 13px; color: #b42318; }
.issue-list { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.issue-item { font-size: 12px; display: flex; gap: 8px; align-items: baseline; }
.issue-tag {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  color: #fff;
}
.kind-missing .issue-tag,
.kind-duplicate .issue-tag { background: #b42318; }
.kind-orphan .issue-tag { background: #c2410c; }
.kind-unsourced .issue-tag { background: #b45309; }
.kind-missing,
.kind-duplicate { color: #912018; }
.kind-orphan { color: #9a3412; }
.kind-unsourced { color: #92400e; }
.row-issue { background: #fef3f2; }
.row-issue-flag {
  margin-left: 6px;
  border-radius: 999px;
  padding: 0 6px;
  font-size: 11px;
  color: #fff;
}
.row-issue-flag.kind-missing,
.row-issue-flag.kind-duplicate { background: #b42318; }
.row-issue-flag.kind-orphan { background: #c2410c; }
.row-issue-flag.kind-unsourced { background: #b45309; }
.source-unknown { color: #b45309; }
</style>
