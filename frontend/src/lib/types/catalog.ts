/**
 * 印谱条目（Catalog）数据模型
 * 印谱的排序、收录状态与分卷制版；调整排序后自动重编号，每卷十二方。
 */

/** 收录状态：待收录 / 已收录 / 不收录 */
export type IncludedStatus = 'pending' | 'included' | 'excluded';

/** 复核状态：无需复核 / 留待复核（锁版后本地改动与回传不一致，后到不覆盖） */
export type ReviewState = 'none' | 'pending';

/** 分卷制版：每卷容量（方数） */
export const VOLUME_CAPACITY = 12;

export interface Catalog {
  id: string;
  /** 所属印石 id */
  stoneId: string;
  /** 对应印稿 id */
  designId: string;
  /** 排序号，从 1 开始连续整数 */
  orderNo: number;
  /** 卷号，从 1 开始；默认按排序号每 12 方分一卷 */
  volumeNo: number;
  /** 收录状态 */
  included: IncludedStatus;
  /** 复核状态：none 无需复核；pending 锁版后本地与回传冲突、留待人工复核 */
  reviewState: ReviewState;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type CatalogDraft = Omit<Catalog, 'id' | 'createdAt' | 'updatedAt'>;

export const INCLUDED_LABEL: Record<IncludedStatus, string> = {
  pending: '待收录',
  included: '已收录',
  excluded: '不收录',
};

export const INCLUDED_COLOR: Record<IncludedStatus, string> = {
  pending: '#8b8f90',
  included: '#3f6b57',
  excluded: '#9c2b1f',
};

export const INCLUDED_OPTIONS: ReadonlyArray<{ value: IncludedStatus; label: string }> = [
  { value: 'pending', label: '待收录' },
  { value: 'included', label: '已收录' },
  { value: 'excluded', label: '不收录' },
];

export const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  none: '正常',
  pending: '待复核',
};

export const REVIEW_STATE_COLOR: Record<ReviewState, string> = {
  none: '#8b8f90',
  pending: '#b98a3c',
};

/** 按排序号计算默认卷号：第 1-12 方为卷一，13-24 为卷二，依此类推 */
export function volumeNoForOrder(orderNo: number): number {
  if (!Number.isFinite(orderNo) || orderNo <= 0) return 1;
  return Math.floor((Math.floor(orderNo) - 1) / VOLUME_CAPACITY) + 1;
}

/** 某卷的起始排序号（含） */
export function volumeStartOrder(volumeNo: number): number {
  return (volumeNo - 1) * VOLUME_CAPACITY + 1;
}

/** 某卷的结束排序号（含） */
export function volumeEndOrder(volumeNo: number): number {
  return volumeNo * VOLUME_CAPACITY;
}

export function createEmptyCatalogDraft(stoneId: string, designId: string, orderNo: number): CatalogDraft {
  return {
    stoneId,
    designId,
    orderNo,
    volumeNo: volumeNoForOrder(orderNo),
    included: 'pending',
    reviewState: 'none',
    note: '',
  };
}
