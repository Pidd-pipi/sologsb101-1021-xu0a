/**
 * 印谱条目（Catalog）数据模型
 * 印谱的排序、卷号与收录状态；调整排序后自动重编号并回填卷号。
 * 卷号服务于装订厂分卷制版：每卷固定 PLATE_VOLUME_SIZE 方。
 */

/** 收录状态：待收录 / 已收录 / 不收录 */
export type IncludedStatus = 'pending' | 'included' | 'excluded';

/** 装订厂分卷制版：每卷容量（方） */
export const PLATE_VOLUME_SIZE = 12;

/** 复核成因 */
export type ReviewReason = 'local_changed' | 'missing_remote' | 'remote_only';

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  /** 锁版后本地改动过，厂方回传又是另一版本 */
  local_changed: '锁版后本地改动，与厂方版本不一致',
  /** 厂方回传中缺少本地这条 */
  missing_remote: '厂方回传缺少此条',
  /** 厂方回传多出本地没有的条目 */
  remote_only: '厂方回传多出此条',
};

/** 复核条目里留存的厂方回传版本（仅对账所需字段） */
export interface CatalogReviewRemote {
  orderNo: number;
  volumeNo: number;
  included: IncludedStatus;
  note: string;
  /** 收到该回传的时间戳 */
  receivedAt: number;
}

/** 留待复核标记：锁版后本地动过且两边不一致时挂在条目上，不能被后到数据覆盖 */
export interface CatalogReview {
  reason: ReviewReason;
  markedAt: number;
  /** 厂方回传版本；缺条（missing_remote）时为空 */
  remote?: CatalogReviewRemote;
}

export interface Catalog {
  id: string;
  /** 所属印石 id */
  stoneId: string;
  /** 对应印稿 id */
  designId: string;
  /** 排序号，从 1 开始连续整数 */
  orderNo: number;
  /** 卷号，从 1 开始，按 orderNo 每 PLATE_VOLUME_SIZE 方一卷 */
  volumeNo: number;
  /** 收录状态 */
  included: IncludedStatus;
  /** 备注 */
  note: string;
  /** 留待复核标记，null/undefined 表示无需复核 */
  review?: CatalogReview | null;
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

/* ------------------------ 装订厂制版 / 回传文件结构 ------------------------ */

/** 锁版基线条目（也即导出给装订厂的清单条目） */
export interface PlateBaselineEntry {
  id: string;
  orderNo: number;
  volumeNo: number;
  included: IncludedStatus;
  note: string;
}

/** 导出给装订厂的制版清单条目 */
export type PlateHandoffEntry = PlateBaselineEntry;

/** 锁版后导出的制版清单（厂方在此基础上调整收录与顺序后回传） */
export interface PlateHandoffFile {
  app: 'gbsealcarve-plate';
  kind: 'plate-handoff';
  /** 锁版时间（ISO），回传必须原样带回，用于核对版次 */
  lockedAt: string;
  /** 每卷容量 */
  volumeSize: number;
  /** 总卷数 */
  volumes: number;
  entries: PlateHandoffEntry[];
}

/** 厂方回传条目：收录状态 / 备注允许省略（表示该条未改） */
export interface PlateReturnEntry {
  id: string;
  orderNo: number;
  volumeNo: number;
  included?: IncludedStatus;
  note?: string;
}

/** 厂方回传文件：在制版清单结构上回改，lockedAt 必须与锁版时一致 */
export interface PlateReturnFile {
  app: 'gbsealcarve-plate';
  kind: 'plate-return';
  lockedAt: string;
  returnedAt?: string;
  volumeSize?: number;
  entries: PlateReturnEntry[];
}

export function createEmptyCatalogDraft(
  stoneId: string,
  designId: string,
  orderNo: number,
  volumeNo: number,
): CatalogDraft {
  return {
    stoneId,
    designId,
    orderNo,
    volumeNo,
    included: 'pending',
    note: '',
    review: null,
  };
}
