/**
 * 装订厂分卷制版：锁版、回传对账、失败回滚重试
 * - 锁版时把卷号回填落库，并在 localStorage 留存逐条基线（导出制版清单）
 * - 厂方回传按基线逐条对账：锁版后本地动过且两边不同 → 留待复核，不覆盖
 * - 回传让某卷超容量 → 拒绝写入（不改动本地库），并指出卷号
 * - 应用入库前留存完整清单快照；入库失败自动回滚，也可手动退回应用前清单后重试
 *
 * 纯前端应用：基线、回传与回滚快照都保存在浏览器 localStorage。
 */
import { db } from './db';
import {
  PLATE_VOLUME_SIZE,
  type Catalog,
  type PlateBaselineEntry,
  type PlateHandoffFile,
  type PlateReturnFile,
} from '$lib/types/catalog';
import {
  ensureVolumeNos,
  reconcilePlateReturn,
  toBaselineEntry,
  validatePlateReturn,
  type ReconcileReport,
  type ReconcileResult,
} from './catalog';

const LS_KEY = {
  lock: 'gbsealcarve:plate-lock',
  return: 'gbsealcarve:plate-return',
  rollback: 'gbsealcarve:plate-rollback',
  report: 'gbsealcarve:plate-report',
} as const;

export interface PlateLockMeta {
  lockedAt: string;
  lockedAtMs: number;
  volumeSize: number;
  entries: PlateBaselineEntry[];
}

interface ReturnStash {
  receivedAtMs: number;
  raw: string;
  file: PlateReturnFile;
}

interface RollbackStash {
  stashedAt: string;
  lockedAt: string;
  catalogs: Catalog[];
}

/** 最近一次成功应用回传的简要报告（remote_only 不入谱册，留存于此供页面复核） */
export interface PlateApplyReport {
  appliedAt: string;
  applied: number;
  reviewLocalChanged: number;
  reviewMissingRemote: number;
  reviewRemoteOnly: number;
  remoteOnlyItems: Array<{ id: string; orderNo: number; volumeNo: number; note: string }>;
}

/* ------------------------------ localStorage 读写 ------------------------------ */

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------ 锁版状态 ------------------------------ */

export function readPlateLock(): PlateLockMeta | null {
  return readJson<PlateLockMeta>(LS_KEY.lock);
}

export function isLocked(): boolean {
  return readPlateLock() !== null;
}

export interface LockPlateResult {
  lock: PlateLockMeta;
  handoff: PlateHandoffFile;
  updated: number;
}

/**
 * 锁版：按现有顺序回填默认卷号并落库，逐条留存基线，返回制版清单。
 * 已存在锁版时拒绝重复锁版（须先解锁）。
 */
export async function lockPlate(): Promise<LockPlateResult> {
  if (readPlateLock()) {
    throw new Error('当前已锁版；请先解锁或处理装订厂回传后再重新锁版');
  }
  const now = Date.now();
  const local = await db.catalogs.toArray();
  const localById = new Map(local.map((row) => [row.id, row]));
  const normalized = ensureVolumeNos(local, now);
  const patchedCount = normalized.filter(
    (row) => row.volumeNo !== localById.get(row.id)?.volumeNo,
  ).length;
  if (patchedCount > 0) {
    await db.catalogs.bulkPut(normalized);
  }

  const entries = normalized.map(toBaselineEntry);
  const lockedAt = new Date(now).toISOString();
  const lock: PlateLockMeta = {
    lockedAt,
    lockedAtMs: now,
    volumeSize: PLATE_VOLUME_SIZE,
    entries,
  };
  writeJson(LS_KEY.lock, lock);
  // 新锁版时清掉上一轮残留的回传 / 回滚 / 报告快照
  removeKey(LS_KEY.return);
  removeKey(LS_KEY.rollback);
  removeKey(LS_KEY.report);

  const maxVolume = entries.reduce((max, entry) => Math.max(max, entry.volumeNo), 0);
  const handoff: PlateHandoffFile = {
    app: 'gbsealcarve-plate',
    kind: 'plate-handoff',
    lockedAt,
    volumeSize: PLATE_VOLUME_SIZE,
    volumes: maxVolume,
    entries,
  };
  return { lock, handoff, updated: patchedCount };
}

/** 解锁：清掉锁版基线与回传 / 回滚 / 报告留存；条目上的复核标记保留，由页面单独清理 */
export function unlockPlate(): void {
  removeKey(LS_KEY.lock);
  removeKey(LS_KEY.return);
  removeKey(LS_KEY.rollback);
  removeKey(LS_KEY.report);
}

/** 清空整轮制版会话（导入备份 / 重置库时调用，避免旧基线误对账） */
export function clearPlateSession(): void {
  unlockPlate();
}

/* ------------------------------ 回传留存与回滚 ------------------------------ */

export function readReturnStash(): ReturnStash | null {
  return readJson<ReturnStash>(LS_KEY.return);
}

export function readRollbackStash(): RollbackStash | null {
  return readJson<RollbackStash>(LS_KEY.rollback);
}

export function readApplyReport(): PlateApplyReport | null {
  return readJson<PlateApplyReport>(LS_KEY.report);
}

export function clearApplyReport(): void {
  removeKey(LS_KEY.report);
}

export type ApplyOutcome =
  | ({ ok: true } & ReconcileReport & { rolledBack: boolean })
  | { ok: false; message: string; rolledBack: boolean };

/**
 * 应用厂方回传：
 * 1. 结构与版次校验；2. 逐条对账（含容量校验）；
 * 3. 留存回传原文与应用前清单快照；4. 整批入库。
 * 容量超限等前置失败：不写库、回传原文留存以便修正后重试。
 * 入库异常：自动回滚到应用前清单。
 */
export async function applyPlateReturn(rawText: string): Promise<ApplyOutcome> {
  const lock = readPlateLock();
  if (!lock) {
    return { ok: false, message: '尚未锁版，无法对账回传；请先锁版导出制版清单。', rolledBack: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, message: '回传文件 JSON 解析失败，请确认文件内容。', rolledBack: false };
  }

  const validation = validatePlateReturn(parsed);
  if (!validation.ok) return { ok: false, message: validation.message, rolledBack: false };
  const file = validation.value;

  if (file.lockedAt !== lock.lockedAt) {
    return {
      ok: false,
      message: `版次不一致：回传对应锁版时间 ${file.lockedAt}，当前锁版 ${lock.lockedAt}，拒绝写入。`,
      rolledBack: false,
    };
  }

  const localRows = await db.catalogs.toArray();
  const result: ReconcileResult = reconcilePlateReturn(localRows, lock.entries, file, {
    volumeSize: lock.volumeSize,
  });
  if (!result.ok) {
    // 容量超限 / 对账前置失败：留存回传原文，便于修正后重试；不动本地库
    writeJson(LS_KEY.return, { receivedAtMs: Date.now(), raw: rawText, file });
    return { ok: false, message: result.message, rolledBack: false };
  }

  // 应用前留存：当前完整清单（回滚到应用前清单）
  const rollback: RollbackStash = {
    stashedAt: new Date().toISOString(),
    lockedAt: lock.lockedAt,
    catalogs: localRows,
  };
  writeJson(LS_KEY.return, { receivedAtMs: Date.now(), raw: rawText, file });
  writeJson(LS_KEY.rollback, rollback);

  const toWrite = result.items
    .filter((item) => item.status !== 'remote_only')
    .map((item) => item.entry);

  try {
    await db.transaction('rw', db.catalogs, async () => {
      await db.catalogs.clear();
      await db.catalogs.bulkPut(toWrite);
    });
  } catch (error) {
    // 入库失败：自动退回应用前的清单
    await restoreCatalogs(localRows);
    return {
      ok: false,
      message: `回传入库失败，已自动回滚到应用前清单：${error instanceof Error ? error.message : '未知错误'}。可修正后重试。`,
      rolledBack: true,
    };
  }

  writeJson(LS_KEY.report, {
    appliedAt: new Date().toISOString(),
    applied: result.applied,
    reviewLocalChanged: result.reviewLocalChanged,
    reviewMissingRemote: result.reviewMissingRemote,
    reviewRemoteOnly: result.reviewRemoteOnly,
    remoteOnlyItems: result.items
      .filter((item) => item.status === 'remote_only')
      .map((item) => ({
        id: item.entry.id,
        orderNo: item.entry.orderNo,
        volumeNo: item.entry.volumeNo,
        note: item.entry.note,
      })),
  } satisfies PlateApplyReport);

  return {
    ok: true,
    applied: result.applied,
    reviewLocalChanged: result.reviewLocalChanged,
    reviewMissingRemote: result.reviewMissingRemote,
    reviewRemoteOnly: result.reviewRemoteOnly,
    items: result.items,
    volumeCounts: result.volumeCounts,
    rolledBack: false,
  };
}

/** 用留存的回传原文重新对账入库（回滚后或容量修正后重试） */
export async function retryPlateReturn(): Promise<ApplyOutcome> {
  const stash = readReturnStash();
  if (!stash) return { ok: false, message: '没有可重试的回传文件。', rolledBack: false };
  return applyPlateReturn(stash.raw);
}

/** 退回应用前的清单（手动回滚，随后可重新应用或重试回传） */
export async function rollbackPlateApply(): Promise<boolean> {
  const stash = readRollbackStash();
  if (!stash) return false;
  await restoreCatalogs(stash.catalogs);
  // 清单已退回应用前，撤掉上一次应用报告；回传原文保留以便重试
  removeKey(LS_KEY.report);
  return true;
}

async function restoreCatalogs(catalogs: Catalog[]): Promise<void> {
  await db.transaction('rw', db.catalogs, async () => {
    await db.catalogs.clear();
    await db.catalogs.bulkPut(catalogs);
  });
}

/* ------------------------------ 复核标记处理 ------------------------------ */

/** 保留本地版本，清除复核标记（采信本地） */
export async function resolveReviewKeepLocal(catalogId: string): Promise<void> {
  await db.catalogs.update(catalogId, { review: null, updatedAt: Date.now() } as never);
}

/** 采用厂方回传版本覆盖本地，并清除复核标记 */
export async function resolveReviewAcceptRemote(catalog: Catalog): Promise<void> {
  const remote = catalog.review?.remote;
  if (!remote) {
    await resolveReviewKeepLocal(catalog.id);
    return;
  }
  await db.catalogs.put({
    ...catalog,
    orderNo: remote.orderNo,
    volumeNo: remote.volumeNo,
    included: remote.included,
    note: remote.note,
    review: null,
    updatedAt: Date.now(),
  });
}

/** 清除全部复核标记（不动条目内容） */
export async function clearAllReviews(): Promise<number> {
  const pending = await db.catalogs.filter((row) => row.review != null).toArray();
  if (pending.length === 0) return 0;
  const now = Date.now();
  await db.catalogs.bulkPut(pending.map((row) => ({ ...row, review: null, updatedAt: now })));
  return pending.length;
}
