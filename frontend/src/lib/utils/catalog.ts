/**
 * 印谱分卷制版领域逻辑（纯函数，便于核对，不触碰存储）
 * - 卷号计算（每卷 PLATE_VOLUME_SIZE 方）、排序重排与卷号回填
 * - 锁版基线生成与逐条比对
 * - 装订厂回传对账：锁版后本地动过且两边不同 → 双方留待复核，不做覆盖
 * - 回传容量校验：某卷超出容量即判失败，并指出卷号
 */
import {
  PLATE_VOLUME_SIZE,
  type Catalog,
  type CatalogReview,
  type CatalogReviewRemote,
  type IncludedStatus,
  type PlateBaselineEntry,
  type PlateReturnEntry,
  type PlateReturnFile,
  type ReviewReason,
} from '$lib/types/catalog';

/** 方数 → 卷号（从 1 开始） */
export function volumeNoOf(orderNo: number, volumeSize: number = PLATE_VOLUME_SIZE): number {
  return Math.floor((orderNo - 1) / volumeSize) + 1;
}

/** 按排序号升序排列印谱条目 */
export function sortByOrder(rows: Catalog[]): Catalog[] {
  return [...rows].sort((a, b) => a.orderNo - b.orderNo);
}

/**
 * 顺序重排 + 卷号回填：按排序号 1…n 连续编号，
 * 并按每卷 volumeSize 方写入 volumeNo。返回新数组，不改原对象。
 */
export function resequence(
  rows: Catalog[],
  now: number = Date.now(),
  volumeSize: number = PLATE_VOLUME_SIZE,
): Catalog[] {
  return sortByOrder(rows).map((row, index) => ({
    ...row,
    orderNo: index + 1,
    volumeNo: volumeNoOf(index + 1, volumeSize),
    updatedAt: now,
  }));
}

/** 旧数据没有卷号时，按现有顺序回填默认卷（返回完整的新数组） */
export function ensureVolumeNos(
  rows: Catalog[],
  now: number = Date.now(),
  volumeSize: number = PLATE_VOLUME_SIZE,
): Catalog[] {
  const sorted = sortByOrder(rows);
  return sorted.map((row, index) => {
    const expectedVolume = volumeNoOf(index + 1, volumeSize);
    if (typeof row.volumeNo === 'number' && Number.isInteger(row.volumeNo) && row.volumeNo > 0) {
      return row;
    }
    return { ...row, volumeNo: expectedVolume, updatedAt: now };
  });
}

/** 仅挑出缺卷号的行（用于判断是否需要落库回填） */
export function fillMissingVolumeNos(
  rows: Catalog[],
  now: number = Date.now(),
  volumeSize: number = PLATE_VOLUME_SIZE,
): Catalog[] {
  const before = sortByOrder(rows);
  const after = ensureVolumeNos(before, now, volumeSize);
  return after.filter((row, index) => row.volumeNo !== before[index]?.volumeNo);
}

/** 印谱汇总方数（收录状态一改动即由调用方经 liveQuery / $derived 重算） */
export function summarizeCatalog(catalogs: Catalog[]): {
  total: number;
  included: number;
  pending: number;
  excluded: number;
} {
  return {
    total: catalogs.length,
    included: catalogs.filter((item) => item.included === 'included').length,
    pending: catalogs.filter((item) => item.included === 'pending').length,
    excluded: catalogs.filter((item) => item.included === 'excluded').length,
  };
}

/** 每卷方数统计（卷号 → 条目数），仅统计待应用的回传结果时用 */
export function countByVolume(rows: Array<Pick<Catalog, 'volumeNo'>>): Map<number, number> {
  const map = new Map<number, number>();
  rows.forEach((row) => {
    map.set(row.volumeNo, (map.get(row.volumeNo) ?? 0) + 1);
  });
  return map;
}

/* ------------------------------ 锁版基线 ------------------------------ */

export function toBaselineEntry(catalog: Catalog): PlateBaselineEntry {
  return {
    id: catalog.id,
    orderNo: catalog.orderNo,
    volumeNo: catalog.volumeNo,
    included: catalog.included,
    note: catalog.note,
  };
}

/** 基线快照条目（锁版时逐条留存） */
export type BaselineSnapshot = PlateBaselineEntry;

/** 锁版后本地是否动过对账字段（收录状态 / 顺序 / 卷号 / 备注） */
export function differsFromBaseline(local: Catalog, baseline: PlateBaselineEntry | undefined): boolean {
  if (!baseline) return true;
  return (
    local.orderNo !== baseline.orderNo ||
    local.volumeNo !== baseline.volumeNo ||
    local.included !== baseline.included ||
    local.note !== baseline.note
  );
}

/* --------------------------- 回传文件结构校验 --------------------------- */

export type PlateValidationResult =
  | { ok: true; value: PlateReturnFile }
  | { ok: false; message: string };

const INCLUDED_STATUSES: IncludedStatus[] = ['pending', 'included', 'excluded'];

/** 校验装订厂回传文件（容量规则不在此判，容量要在对账时结合本地数据） */
export function validatePlateReturn(input: unknown): PlateValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, message: '回传文件不是合法的 JSON 对象' };
  }
  const file = input as Partial<PlateReturnFile>;
  if (file.app !== 'gbsealcarve-plate') {
    return { ok: false, message: `回传文件不属于制版清单（app=${String(file.app)}）` };
  }
  if (file.kind !== 'plate-return') {
    return { ok: false, message: `不是装订厂回传文件（kind=${String(file.kind)}）` };
  }
  if (typeof file.lockedAt !== 'string' || file.lockedAt.length === 0) {
    return { ok: false, message: '回传文件缺少锁版时间 lockedAt' };
  }
  if (!Array.isArray(file.entries)) {
    return { ok: false, message: '回传文件缺少 entries 清单' };
  }
  const seen = new Set<string>();
  for (const entry of file.entries) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, message: '回传清单中存在非法条目' };
    }
    const item = entry as Partial<PlateReturnEntry>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return { ok: false, message: '回传清单存在缺少 id 的条目' };
    }
    if (seen.has(item.id)) {
      return { ok: false, message: `回传清单中「${item.id}」重复` };
    }
    seen.add(item.id);
    if (!Number.isInteger(item.orderNo) || (item.orderNo ?? 0) <= 0) {
      return { ok: false, message: `回传条目「${item.id}」排序号非法` };
    }
    if (!Number.isInteger(item.volumeNo) || (item.volumeNo ?? 0) <= 0) {
      return { ok: false, message: `回传条目「${item.id}」卷号非法` };
    }
    if (item.included !== undefined && !INCLUDED_STATUSES.includes(item.included)) {
      return { ok: false, message: `回传条目「${item.id}」收录状态非法` };
    }
  }
  return { ok: true, value: file as PlateReturnFile };
}

/* ------------------------------ 逐条对账 ------------------------------ */

export type ReconcileItemStatus = 'applied' | ReviewReason;

export interface ReconcileItem {
  status: ReconcileItemStatus;
  /** applied 时为应写入的完整条目；否则为当前本地条目（已挂复核标记） */
  entry: Catalog;
  message: string;
}

export interface ReconcileReport {
  applied: number;
  reviewLocalChanged: number;
  reviewMissingRemote: number;
  reviewRemoteOnly: number;
  items: ReconcileItem[];
  /** 各卷待写入方数 */
  volumeCounts: Map<number, number>;
}

export type ReconcileResult =
  | ({ ok: true } & ReconcileReport)
  | { ok: false; message: string };

function makeReview(reason: ReviewReason, remote: CatalogReviewRemote | null, now: number): CatalogReview {
  const review: CatalogReview = { reason, markedAt: now };
  if (remote) review.remote = remote;
  return review;
}

function reviewRemoteOf(remote: PlateReturnEntry, receivedAt: number): CatalogReviewRemote {
  return {
    orderNo: remote.orderNo,
    volumeNo: remote.volumeNo,
    included: remote.included ?? 'pending',
    note: remote.note ?? '',
    receivedAt,
  };
}

/** 找容量超限的卷号（> volumeSize），返回排序后的卷号列表 */
export function findOverflowVolumes(
  rows: Array<Pick<Catalog, 'volumeNo'>>,
  volumeSize: number = PLATE_VOLUME_SIZE,
): number[] {
  const overflows: number[] = [];
  for (const [volumeNo, count] of countByVolume(rows)) {
    if (count > volumeSize) overflows.push(volumeNo);
  }
  return overflows.sort((a, b) => a - b);
}

/**
 * 按锁版基线对厂方回传逐条对账，产出待写入条目集合。
 *
 * 规则：
 * - 锁版后本地动过对账字段，且厂方回传与本地不一致 → 双方留待复核，本地不被覆盖；
 * - 本地未动 → 直接应用厂方回传；
 * - 厂方回传缺条 → 该条留待复核；
 * - 厂方回传多出 → 留待复核（不写入谱册）；
 * - 待写入集合中任一卷超出 volumeSize → 整体拒绝（不写入任何一条）。
 */
export function reconcilePlateReturn(
  localRows: Catalog[],
  baseline: BaselineSnapshot[],
  file: PlateReturnFile,
  options: { now?: number; volumeSize?: number } = {},
): ReconcileResult {
  const now = options.now ?? Date.now();
  const volumeSize = options.volumeSize ?? PLATE_VOLUME_SIZE;
  const receivedAt = file.returnedAt ? Date.parse(file.returnedAt) || now : now;

  const baselineById = new Map(baseline.map((entry) => [entry.id, entry]));
  const remoteById = new Map(file.entries.map((entry) => [entry.id, entry]));
  const localById = new Map(localRows.map((row) => [row.id, row]));

  const items: ReconcileItem[] = [];
  const toWrite: Catalog[] = [];

  // 本地与基线中出现过的条目逐条对账（以当前谱序展开，保证报告可读）
  const unionIds = new Set<string>([...localById.keys(), ...baselineById.keys(), ...remoteById.keys()]);
  const orderedIds = [...unionIds].sort((a, b) => {
    const rankA = localById.get(a)?.orderNo ?? remoteById.get(a)?.orderNo ?? Number.MAX_SAFE_INTEGER;
    const rankB = localById.get(b)?.orderNo ?? remoteById.get(b)?.orderNo ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB || a.localeCompare(b);
  });

  for (const id of orderedIds) {
    const local = localById.get(id);
    const remote = remoteById.get(id);
    const base = baselineById.get(id);

    if (local && remote) {
      const dirty = differsFromBaseline(local, base);
      if (dirty) {
        const remoteReview = reviewRemoteOf(remote, receivedAt);
        const sameAsRemote =
          local.orderNo === remote.orderNo &&
          local.volumeNo === remote.volumeNo &&
          local.included === (remote.included ?? local.included) &&
          local.note === (remote.note ?? local.note);
        if (!sameAsRemote) {
          const entry: Catalog = {
            ...local,
            review: makeReview('local_changed', remoteReview, now),
            updatedAt: now,
          };
          items.push({
            status: 'local_changed',
            entry,
            message: `「${id}」锁版后本地改动过，与厂方回传不一致，双方版本均留待复核`,
          });
          toWrite.push(entry);
          continue;
        }
      }
      // 本地未动（或本地虽动但恰好与厂方版本相同）→ 直接应用厂方回传
      const applied: Catalog = {
        ...local,
        orderNo: remote.orderNo,
        volumeNo: remote.volumeNo,
        included: remote.included ?? local.included,
        note: remote.note ?? local.note,
        review: null,
        updatedAt: now,
      };
      items.push({ status: 'applied', entry: applied, message: `「${id}」已按厂方回传更新` });
      toWrite.push(applied);
      continue;
    }

    if (local && !remote) {
      // 厂方回传缺条：留待复核，保持本地数据不动
      const entry: Catalog = {
        ...local,
        review: makeReview('missing_remote', null, now),
        updatedAt: now,
      };
      items.push({
        status: 'missing_remote',
        entry,
        message: `「${id}」厂方回传中缺失，留待复核`,
      });
      toWrite.push(entry);
      continue;
    }

    if (!local && remote) {
      // 厂方回传多出：不写入谱册，仅在报告中列出留待复核
      const virtual: Catalog = {
        id,
        stoneId: '',
        designId: '',
        orderNo: remote.orderNo,
        volumeNo: remote.volumeNo,
        included: remote.included ?? 'pending',
        note: remote.note ?? '',
        review: makeReview('remote_only', reviewRemoteOf(remote, receivedAt), now),
        createdAt: now,
        updatedAt: now,
      };
      items.push({
        status: 'remote_only',
        entry: virtual,
        message: `「${id}」为厂方回传多出的条目，本地无对应印谱，留待复核`,
      });
      // remote_only 不计入待写入容量
      continue;
    }
  }

  const overflows = findOverflowVolumes(toWrite, volumeSize);
  if (overflows.length > 0) {
    return {
      ok: false,
      message:
        `回传会导致第 ${overflows.map((n) => n).join('、')} 卷超过每卷 ${volumeSize} 方的容量，` +
        '已拒绝写入，请装订厂重新分卷后回传。',
    };
  }

  return {
    ok: true,
    applied: items.filter((item) => item.status === 'applied').length,
    reviewLocalChanged: items.filter((item) => item.status === 'local_changed').length,
    reviewMissingRemote: items.filter((item) => item.status === 'missing_remote').length,
    reviewRemoteOnly: items.filter((item) => item.status === 'remote_only').length,
    items,
    volumeCounts: countByVolume(toWrite),
  };
}
