import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'underground-pipeline-inspection:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 存储里的数据优先；但只认存储中真实存在的模块键，
    // 不能用种子把存储里已被删除/重置的旧数据再合并回来（那会让重置、删除失效）。
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitRows(new Map([[key, rows]]))
}

// 跨模块原子写入：先把整份数据序列化落盘，落盘成功后才一次性替换内存缓存。
// 巡检完成要同时写「巡检任务」和「缺陷记录」两张表，任一步失败都不能出现
// 「任务已完成、缺陷没写进去」的半截状态。
export function commitRows(changes: Map<string, EntryRow[]>): void {
  const next: Record<string, EntryRow[]> = { ...allRows() }
  for (const [key, rows] of changes) {
    next[key] = rows
  }
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先落盘；写入抛错（配额满 / 存储被禁用）时内存缓存保持原样，调用方按失败处理。
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = JSON.parse(serialized) as Record<string, EntryRow[]>
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
