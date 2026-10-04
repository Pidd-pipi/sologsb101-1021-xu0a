/**
 * 印谱分卷制版与回传对账工具
 *
 * 流程：电子印谱按每卷十二方分卷制版 → 导出送装订厂并「锁版」（快照此刻状态）
 *      → 社里在本地改了收录 / 顺序 → 厂里回传清单 → 逐条对账。
 *
 * 对账规则：
 * - 锁版后本地动过的条目，若与回传不一致 → 留待复核（reviewState='pending'），后到不覆盖；
 * - 锁版后本地未动的条目 → 以回传为准（厂里改了收录 / 顺序）；
 * - 回传使某卷超过容量（12 方）→ 拒绝写入并指明卷号；
 * - 入库在单个 Dexie 事务内执行，失败整体回滚，可退回应用前清单重试。
 *
 * 纯前端本地完成，不经过任何服务端。
 */
import { db } from '$lib/utils/db';
import {
  INCLUDED_OPTIONS,
  VOLUME_CAPACITY,
  volumeNoForOrder,
  type Catalog,
  type IncludedStatus,
} from '$lib/types/catalog';

/** 制版 / 回传文件的 app 标识 */
export const PLATE_APP = 'gbsealcarve';
/** 制版清单（送厂）文件标记 */
export const PLATE_KIND_EXPORT = 'catalog-plate';
/** 回传清单（厂里返回）文件标记 */
export const PLATE_KIND_RETURN = 'catalog-return';

const LOCK_STORAGE_KEY = 'gbsealcarve:catalog-lock';
const PROPOSALS_STORAGE_KEY = 'gbsealcarve:catalog-pending-proposals';

const INCLUDED_VALUES: ReadonlySet<IncludedStatus> = new Set(INCLUDED_OPTIONS.map((item) => item.value));

/* ------------------------------ 类型 ------------------------------ */

/** 制版清单项（送厂，附印文 / 印石名便于厂里核对） */
export interface PlateExportItem {
  id: string;
  stoneId: string;
  designId: string;
  orderNo: number;
  volumeNo: number;
  included: IncludedStatus;
  note: string;
  sealText?: string;
  stoneName?: string;
}

export interface PlateExport {
  app: typeof PLATE_APP;
  kind: typeof PLATE_KIND_EXPORT;
  schemaVersion: number;
  exportedAt: string;
  capacity: number;
  items: PlateExportItem[];
}

/** 回传清单项（厂里按制版结果回填卷号 / 收录 / 顺序） */
export interface PlateReturnItem {
  id: string;
  orderNo: number;
  volumeNo: number;
  included: IncludedStatus;
  note?: string;
}

export interface PlateReturn {
  app: typeof PLATE_APP;
  kind: typeof PLATE_KIND_RETURN;
  returnedAt: string;
  capacity: number;
  items: PlateReturnItem[];
}

/** 锁版快照：送厂时刻每条印谱的排序 / 收录 / 卷号 */
export interface CatalogLock {
  lockedAt: string;
  items: Array<{ id: string; orderNo: number; included: IncludedStatus; volumeNo: number }>;
}

/** 一条对账冲突：本地锁版后改过，且与回传不一致 */
export interface ReconcileConflict {
  id: string;
  local: Catalog;
  returned: PlateReturnItem;
}

/** 对账结果 */
export interface ReconcileReport {
  /** 待写入的完整行（已按规则决定收录 / 顺序 / 卷号 / 复核状态） */
  applyRows: Catalog[];
  /** 冲突条目（留待复核，未以后到覆盖） */
  conflicts: ReconcileConflict[];
  /** 回传里有、本地找不到的条目 id */
  unmatchedReturnIds: string[];
  /** 本地有、回传清单里没有的条目 id（不删除） */
  missingLocalIds: string[];
  /** 实际参与对账的条目数 */
  matchedCount: number;
}

/* ------------------------------ 卷号回填 ------------------------------ */

/**
 * 为缺少卷号的旧数据按当前顺序回填默认卷（每卷十二方）。
 * 仅补全缺失 / 非法的 volumeNo，已合法的卷号（如厂里指定）保持不变。
 */
export function backfillVolumeRows(rows: Catalog[]): Catalog[] {
  return rows.map((row) => {
    const volumeNo =
      typeof row.volumeNo === 'number' && row.volumeNo > 0
        ? row.volumeNo
        : volumeNoForOrder(row.orderNo);
    return { ...row, volumeNo };
  });
}

/* ------------------------------ 锁版快照 ------------------------------ */

export function readCatalogLock(): CatalogLock | null {
  try {
    const raw = localStorage.getItem(LOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CatalogLock>;
    if (typeof parsed.lockedAt !== 'string' || !Array.isArray(parsed.items)) return null;
    const items = parsed.items
      .filter((item): item is CatalogLock['items'][number] => typeof item?.id === 'string')
      .map((item) => ({
        id: item.id,
        orderNo: Number(item.orderNo) || 0,
        included: (INCLUDED_VALUES.has(item.included as IncludedStatus)
          ? item.included
          : 'pending') as IncludedStatus,
        volumeNo: Number(item.volumeNo) || volumeNoForOrder(Number(item.orderNo) || 1),
      }));
    return { lockedAt: parsed.lockedAt, items };
  } catch {
    return null;
  }
}

export function writeCatalogLock(rows: Catalog[]): CatalogLock {
  const lock: CatalogLock = {
    lockedAt: new Date().toISOString(),
    items: rows.map((row) => ({
      id: row.id,
      orderNo: row.orderNo,
      included: row.included,
      volumeNo: row.volumeNo,
    })),
  };
  try {
    localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(lock));
  } catch {
    /* 隐私模式下忽略 */
  }
  return lock;
}

export function clearCatalogLock(): void {
  try {
    localStorage.removeItem(LOCK_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------ 待复核建议值 ------------------------------ */

/** 厂里回传对某条目的建议值（用于留待复核后择机按厂里为准） */
export interface PendingProposal {
  orderNo: number;
  included: IncludedStatus;
  volumeNo: number;
}

/** 读取所有待复核条目的厂里建议值（按条目 id 索引） */
export function readPendingProposals(): Record<string, PendingProposal> {
  try {
    const raw = localStorage.getItem(PROPOSALS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, PendingProposal> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const orderNo = Math.floor(Number(v.orderNo));
      if (!Number.isFinite(orderNo) || orderNo <= 0) continue;
      const included = INCLUDED_VALUES.has(v.included as IncludedStatus)
        ? (v.included as IncludedStatus)
        : 'pending';
      const volumeRaw = Math.floor(Number(v.volumeNo));
      const volumeNo = Number.isFinite(volumeRaw) && volumeRaw > 0 ? volumeRaw : volumeNoForOrder(orderNo);
      result[id] = { orderNo, included, volumeNo };
    }
    return result;
  } catch {
    return {};
  }
}

/** 写入 / 更新一条待复核建议值 */
export function writePendingProposal(id: string, proposal: PendingProposal): void {
  try {
    const all = readPendingProposals();
    all[id] = proposal;
    localStorage.setItem(PROPOSALS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 移除一条待复核建议值（复核完成后） */
export function removePendingProposal(id: string): void {
  try {
    const all = readPendingProposals();
    delete all[id];
    localStorage.setItem(PROPOSALS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/* ------------------------------ 制版清单 ------------------------------ */

/** 构建送装订厂的制版清单（附印文 / 印石名便于核对） */
export function buildPlateExport(
  rows: Catalog[],
  designs: Array<{ id: string; sealText: string; annotation: string }>,
  stones: Array<{ id: string; name: string }>,
): PlateExport {
  const designMap = new Map(designs.map((design) => [design.id, design]));
  const stoneMap = new Map(stones.map((stone) => [stone.id, stone]));
  const sorted = [...rows].sort((a, b) => a.orderNo - b.orderNo);
  const items: PlateExportItem[] = sorted.map((row) => {
    const design = designMap.get(row.designId);
    const stone = stoneMap.get(row.stoneId);
    return {
      id: row.id,
      stoneId: row.stoneId,
      designId: row.designId,
      orderNo: row.orderNo,
      volumeNo: row.volumeNo,
      included: row.included,
      note: row.note,
      sealText: design?.sealText ?? '',
      stoneName: stone?.name ?? '',
    };
  });
  return {
    app: PLATE_APP,
    kind: PLATE_KIND_EXPORT,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    capacity: VOLUME_CAPACITY,
    items,
  };
}

/* ------------------------------ 回传解析 ------------------------------ */

function normalizeItem(raw: unknown): PlateReturnItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || item.id.length === 0) return null;
  const orderNo = Math.floor(Number(item.orderNo));
  if (!Number.isFinite(orderNo) || orderNo <= 0) return null;
  const includedRaw = item.included;
  const included: IncludedStatus = INCLUDED_VALUES.has(includedRaw as IncludedStatus)
    ? (includedRaw as IncludedStatus)
    : 'pending';
  const volumeRaw = Math.floor(Number(item.volumeNo));
  const volumeNo =
    Number.isFinite(volumeRaw) && volumeRaw > 0 ? volumeRaw : volumeNoForOrder(orderNo);
  const note = typeof item.note === 'string' ? item.note : undefined;
  return { id: item.id, orderNo, volumeNo, included, note };
}

export interface ParsedReturn {
  ok: boolean;
  error: string;
  items: PlateReturnItem[];
}

/**
 * 解析厂里回传清单。
 * 兼容：回传清单（catalog-return）、制版清单回传（catalog-plate）、整库备份（取 catalogs）、裸条目数组。
 */
export function parsePlateReturn(input: unknown): ParsedReturn {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: '回传文件不是合法的 JSON 对象', items: [] };
  }
  const obj = input as Record<string, unknown>;

  let rawItems: unknown = null;
  if (obj.kind === PLATE_KIND_RETURN || obj.kind === PLATE_KIND_EXPORT) {
    rawItems = obj.items;
  } else if (obj.app === PLATE_APP && Array.isArray(obj.catalogs)) {
    rawItems = obj.catalogs;
  } else if (Array.isArray(obj.items)) {
    rawItems = obj.items;
  } else if (Array.isArray(input)) {
    rawItems = input;
  }

  if (!Array.isArray(rawItems)) {
    return { ok: false, error: '回传文件缺少 items / catalogs 条目数组', items: [] };
  }
  const items = rawItems.map(normalizeItem).filter((item): item is PlateReturnItem => item !== null);
  if (items.length === 0) {
    return { ok: false, error: '回传清单没有可识别的条目（需含 id / orderNo / included）', items: [] };
  }
  return { ok: true, error: '', items };
}

/**
 * 容量校验：回传使某卷超过每卷容量即拒绝。
 * 返回错误文案（空串表示通过），文案指明卷号与实际方数。
 */
export function validateVolumeCapacity(items: PlateReturnItem[]): string {
  const counts = new Map<number, number>();
  for (const item of items) {
    counts.set(item.volumeNo, (counts.get(item.volumeNo) ?? 0) + 1);
  }
  for (const [volumeNo, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > VOLUME_CAPACITY) {
      return `第 ${volumeNo} 卷超过容量：每卷 ${VOLUME_CAPACITY} 方，回传 ${count} 方，请厂里调整后重新回传`;
    }
  }
  return '';
}

/* ------------------------------ 逐条对账 ------------------------------ */

/**
 * 逐条对账，生成待写入行与报告（纯函数，不落库）。
 * 冲突条目保留本地值并置 reviewState='pending'，后到不覆盖；其余以回传为准。
 */
export function reconcileCatalogs(
  localRows: Catalog[],
  returnItems: PlateReturnItem[],
  lock: CatalogLock | null,
): ReconcileReport {
  const now = Date.now();
  const localMap = new Map(localRows.map((row) => [row.id, row]));
  const lockMap = new Map<string, CatalogLock['items'][number]>(
    (lock?.items ?? []).map((item) => [item.id, item]),
  );

  const applyRows: Catalog[] = [];
  const conflicts: ReconcileConflict[] = [];
  const unmatchedReturnIds: string[] = [];
  const touchedIds = new Set<string>();

  for (const returned of returnItems) {
    const local = localMap.get(returned.id);
    if (!local) {
      unmatchedReturnIds.push(returned.id);
      continue;
    }
    touchedIds.add(returned.id);

    const locked = lockMap.get(returned.id);
    const locallyModified =
      !locked ||
      local.orderNo !== locked.orderNo ||
      local.included !== locked.included ||
      local.volumeNo !== locked.volumeNo;
    const differsFromReturn =
      local.orderNo !== returned.orderNo ||
      local.included !== returned.included ||
      local.volumeNo !== returned.volumeNo;

    if (locallyModified && differsFromReturn) {
      // 锁版后本地动过、且与回传不一致 → 留待复核，后到不覆盖
      conflicts.push({ id: local.id, local, returned });
      applyRows.push({ ...local, reviewState: 'pending', updatedAt: now });
    } else {
      // 本地未动过（以回传为准）或两边一致 → 应用回传值并解除复核
      applyRows.push({
        ...local,
        orderNo: returned.orderNo,
        included: returned.included,
        volumeNo: returned.volumeNo,
        note: returned.note ?? local.note,
        reviewState: 'none',
        updatedAt: now,
      });
    }
  }

  // 本地有、回传未提及的条目：保留不动（不删除）
  const missingLocalIds = localRows.filter((row) => !touchedIds.has(row.id)).map((row) => row.id);

  return {
    applyRows,
    conflicts,
    unmatchedReturnIds,
    missingLocalIds,
    matchedCount: touchedIds.size,
  };
}

/**
 * 事务性入库：全部条目在同一 Dexie 事务内写入，
 * 任一失败则整体回滚（应用前清单不被破坏），可退回重试。
 */
export async function applyCatalogReconciliation(rows: Catalog[]): Promise<void> {
  await db.transaction('rw', db.catalogs, async () => {
    await db.catalogs.bulkPut(rows);
  });
}

/* ------------------------------ 分卷统计 ------------------------------ */

export interface VolumeStat {
  volumeNo: number;
  count: number;
  included: number;
  pending: number;
  excluded: number;
  capacity: number;
}

/** 按卷汇总方数（含已收录 / 待收录 / 不收录） */
export function buildVolumeStats(rows: Catalog[]): VolumeStat[] {
  const map = new Map<number, VolumeStat>();
  for (const row of rows) {
    const volumeNo = typeof row.volumeNo === 'number' && row.volumeNo > 0 ? row.volumeNo : volumeNoForOrder(row.orderNo);
    let stat = map.get(volumeNo);
    if (!stat) {
      stat = { volumeNo, count: 0, included: 0, pending: 0, excluded: 0, capacity: VOLUME_CAPACITY };
      map.set(volumeNo, stat);
    }
    stat.count += 1;
    if (row.included === 'included') stat.included += 1;
    else if (row.included === 'pending') stat.pending += 1;
    else stat.excluded += 1;
  }
  return [...map.values()].sort((a, b) => a.volumeNo - b.volumeNo);
}
