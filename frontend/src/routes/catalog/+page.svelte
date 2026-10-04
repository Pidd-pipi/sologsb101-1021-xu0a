<script lang="ts">
  /**
   * /catalog 印谱汇总、分卷制版与回传对账
   * 收录状态切换、排序重编号、本地结构版本查看与 JSON 导入导出；
   * 每卷十二方分卷制版、送厂锁版、厂里回传逐条对账（锁版后本地改动且不一致留待复核，后到不覆盖）。
   * 消费 Catalog 及全部模型；复用 <StatBadge>、<EmptyPanel>、<GradeTag>。
   */
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import GradeTag from '$lib/components/common/GradeTag.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import { designs, loadDesigns } from '$lib/stores/designStore';
  import { carves, loadCarves } from '$lib/stores/carveStore';
  import { impressions, loadImpressions, bestImpressionOf } from '$lib/stores/impressionStore';
  import { loadStones, stones } from '$lib/stores/stoneStore';
  import {
    INCLUDED_COLOR,
    INCLUDED_LABEL,
    INCLUDED_OPTIONS,
    REVIEW_STATE_COLOR,
    REVIEW_STATE_LABEL,
    VOLUME_CAPACITY,
    createEmptyCatalogDraft,
    volumeNoForOrder,
    type Catalog,
    type IncludedStatus,
  } from '$lib/types/catalog';
  import {
    DB_NAME,
    DB_VERSION,
    exportSnapshot,
    importSnapshot,
    readLastBackupAt,
    resetDatabase,
    writeLastBackupAt,
  } from '$lib/utils/db';
  import {
    buildCatalogText,
    copyText,
    download,
    exportCatalogText,
    exportImpressionCsv,
    exportSnapshotJson,
    validateSnapshot,
  } from '$lib/utils/export';
  import {
    applyCatalogReconciliation,
    backfillVolumeRows,
    buildPlateExport,
    buildVolumeStats,
    clearCatalogLock,
    parsePlateReturn,
    readCatalogLock,
    readPendingProposals,
    reconcileCatalogs,
    removePendingProposal,
    validateVolumeCapacity,
    writeCatalogLock,
    writePendingProposal,
    type CatalogLock,
    type PendingProposal,
    type ReconcileReport,
  } from '$lib/utils/reconcile';
  import type { SealCarveSnapshot } from '$lib/utils/db';

  // 印谱条目没有独立 store：本页通过 useIdbTable 的 liveQuery 订阅并完成全部读写
  const catalogTable = useIdbTable<Catalog>((database) => database.catalogs, { sortByUpdatedAt: false });
  const catalogRows = catalogTable.rows;

  let fileInput = $state<HTMLInputElement | null>(null);
  let plateFileInput = $state<HTMLInputElement | null>(null);
  let lastBackupAt = $state<string | null>(readLastBackupAt());
  let toast = $state('');
  let pendingDelete = $state<Catalog | null>(null);
  let dialogOpen = $state(false);
  let newStoneId = $state('');
  let newDesignId = $state('');
  let newNote = $state('');

  // 分卷制版与回传对账
  let lock = $state<CatalogLock | null>(readCatalogLock());
  let report = $state<ReconcileReport | null>(null);

  const ordered = $derived([...$catalogRows].sort((a, b) => a.orderNo - b.orderNo));

  const context = $derived({
    stones: $stones,
    designs: $designs,
    carves: $carves,
    impressions: $impressions,
    catalogs: ordered,
  });

  const catalogText = $derived(buildCatalogText(context));

  const stat = $derived({
    total: ordered.length,
    included: ordered.filter((item) => item.included === 'included').length,
    pending: ordered.filter((item) => item.included === 'pending').length,
    excluded: ordered.filter((item) => item.included === 'excluded').length,
  });

  const volumeStats = $derived(buildVolumeStats(ordered));

  const pendingConflicts = $derived(ordered.filter((item) => item.reviewState === 'pending'));

  const lockedAtText = $derived(
    lock ? new Date(lock.lockedAt).toLocaleString('zh-CN') : '未锁版',
  );

  const unlistedDesigns = $derived(
    $designs.filter((design) => !ordered.some((item) => item.designId === design.id)),
  );
  const designsOfNewStone = $derived(unlistedDesigns.filter((design) => design.stoneId === newStoneId));

  $effect(() => {
    if (newStoneId.length === 0 && $stones.length > 0) newStoneId = $stones[0]?.id ?? '';
  });

  $effect(() => {
    const first = designsOfNewStone[0];
    if (first && !designsOfNewStone.some((design) => design.id === newDesignId)) newDesignId = first.id;
  });

  function designText(designId: string): string {
    const design = $designs.find((item) => item.id === designId);
    return design ? `${design.sealText}（${design.annotation || '无释文'}）` : '（印稿已删除）';
  }

  function stoneText(stoneId: string): string {
    return $stones.find((stone) => stone.id === stoneId)?.name ?? '（印石已删除）';
  }

  function showToast(text: string): void {
    toast = text;
    setTimeout(() => (toast = ''), 3600);
  }

  async function move(entry: Catalog, delta: number): Promise<void> {
    const list = ordered;
    const index = list.findIndex((item) => item.id === entry.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    const reordered = [...list];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved as Catalog);
    const now = Date.now();
    await catalogTable.bulkPut(
      reordered.map((item, position) => ({
        ...item,
        orderNo: position + 1,
        volumeNo: volumeNoForOrder(position + 1),
        updatedAt: now,
      })),
    );
    showToast('排序已更新并重编号、重新分卷');
  }

  async function setIncluded(entry: Catalog, included: IncludedStatus): Promise<void> {
    // 手动改收录即视为人工裁决：若此前留待复核，一并清除复核标记与厂里建议值
    await catalogTable.update(entry.id, { included, reviewState: 'none' });
    removePendingProposal(entry.id);
  }

  async function saveNote(entry: Catalog, note: string): Promise<void> {
    await catalogTable.update(entry.id, { note });
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    await catalogTable.remove(pendingDelete.id);
    removePendingProposal(pendingDelete.id);
    const rest = ordered.filter((item) => item.id !== pendingDelete?.id);
    const now = Date.now();
    if (rest.length > 0) {
      await catalogTable.bulkPut(
        rest.map((item, index) => ({
          ...item,
          orderNo: index + 1,
          volumeNo: volumeNoForOrder(index + 1),
          updatedAt: now,
        })),
      );
    }
    pendingDelete = null;
    showToast('已删除并重编号、重新分卷');
  }

  function openCreate(): void {
    if (unlistedDesigns.length === 0) {
      showToast('所有印稿都已进入印谱');
      return;
    }
    newStoneId = unlistedDesigns[0]?.stoneId ?? $stones[0]?.id ?? '';
    newDesignId = unlistedDesigns[0]?.id ?? '';
    newNote = '';
    dialogOpen = true;
  }

  async function submitNew(): Promise<void> {
    const design = $designs.find((item) => item.id === newDesignId);
    if (!design) return;
    const draft = createEmptyCatalogDraft(design.stoneId, design.id, ordered.length + 1);
    await catalogTable.create({ ...draft, note: newNote }, 'cata');
    dialogOpen = false;
    showToast(`已加入印谱：${design.sealText}`);
  }

  /** 按当前顺序重新分卷（每卷十二方） */
  async function revolume(): Promise<void> {
    const now = Date.now();
    await catalogTable.bulkPut(
      ordered.map((item, index) => ({
        ...item,
        orderNo: index + 1,
        volumeNo: volumeNoForOrder(index + 1),
        updatedAt: now,
      })),
    );
    showToast('已按当前顺序重新分卷（每卷十二方）');
  }

  /** 导出送装订厂制版清单并锁版（快照此刻排序 / 收录 / 卷号） */
  async function handlePlateExport(): Promise<void> {
    const rows = await catalogTable.list();
    const sorted = [...backfillVolumeRows(rows)].sort((a, b) => a.orderNo - b.orderNo);
    const now = Date.now();
    const normalized = sorted.map((item, index) => ({
      ...item,
      orderNo: index + 1,
      volumeNo: volumeNoForOrder(index + 1),
      updatedAt: now,
    }));
    await catalogTable.bulkPut(normalized);
    const plate = buildPlateExport(normalized, $designs, $stones);
    const filename = `篆刻制版清单-${stampSuffix()}.json`;
    download(filename, JSON.stringify(plate, null, 2), 'application/json;charset=utf-8');
    writeCatalogLock(normalized);
    lock = readCatalogLock();
    const volumeCount = new Set(normalized.map((item) => item.volumeNo)).size;
    showToast(`制版清单已导出并锁版：${plate.items.length} 方，分 ${volumeCount} 卷（每卷 ${VOLUME_CAPACITY} 方）`);
  }

  /** 导入厂里回传清单，逐条对账（先校验容量，再事务性入库） */
  async function handlePlateReturn(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      showToast('回传文件 JSON 解析失败，请确认文件格式');
      return;
    }
    const result = parsePlateReturn(parsed);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    // 容量校验：回传使某卷超过容量即拒绝写入并指明卷号
    const capacityError = validateVolumeCapacity(result.items);
    if (capacityError) {
      showToast(`已拒绝写入：${capacityError}`);
      return;
    }
    const localRows = await catalogTable.list();
    const currentLock = readCatalogLock();
    const reconcileResult = reconcileCatalogs(localRows, result.items, currentLock);
    try {
      await applyCatalogReconciliation(reconcileResult.applyRows);
    } catch {
      showToast('回传入库失败，已回滚到应用前清单，可修正后重新导入重试');
      return;
    }
    await catalogTable.refresh();
    // 本周期对账完成，清除送厂锁版快照（新的周期从下一次制版导出重新锁版开始）
    clearCatalogLock();
    lock = readCatalogLock();
    report = reconcileResult;
    // 锁版后本地改动且与回传不一致的条目：保留本地、置待复核，并记下厂里建议值供择机采用
    for (const conflict of reconcileResult.conflicts) {
      writePendingProposal(conflict.id, {
        orderNo: conflict.returned.orderNo,
        included: conflict.returned.included,
        volumeNo: conflict.returned.volumeNo,
      });
    }
    const volumeCount = new Set(result.items.map((item) => item.volumeNo)).size;
    const parts = [
      `对账完成：应用 ${reconcileResult.matchedCount} 方，${volumeCount} 卷`,
    ];
    if (reconcileResult.conflicts.length > 0) {
      parts.push(`其中 ${reconcileResult.conflicts.length} 方与锁版后本地改动不一致，已留待复核（后到不覆盖）`);
    }
    if (reconcileResult.unmatchedReturnIds.length > 0) {
      parts.push(`回传有、本地无 ${reconcileResult.unmatchedReturnIds.length} 方未处理`);
    }
    if (reconcileResult.missingLocalIds.length > 0) {
      parts.push(`本地有、回传未提及 ${reconcileResult.missingLocalIds.length} 方保留不动`);
    }
    showToast(parts.join('；'));
  }

  /** 取某待复核条目的厂里建议值（优先本次对账报告，其次本地持久化） */
  function proposalOf(id: string): PendingProposal | undefined {
    const fromReport = report?.conflicts.find((item) => item.id === id)?.returned;
    if (fromReport) {
      return { orderNo: fromReport.orderNo, included: fromReport.included, volumeNo: fromReport.volumeNo };
    }
    return readPendingProposals()[id];
  }

  /** 复核：按厂里回传更新（以厂里为准） */
  async function resolveWithFactory(id: string): Promise<void> {
    const entry = ordered.find((item) => item.id === id);
    const proposal = proposalOf(id);
    if (!entry || !proposal) return;
    await catalogTable.update(id, {
      orderNo: proposal.orderNo,
      included: proposal.included,
      volumeNo: proposal.volumeNo,
      reviewState: 'none',
    });
    removePendingProposal(id);
    report = report
      ? { ...report, conflicts: report.conflicts.filter((item) => item.id !== id) }
      : null;
    showToast('已按厂里回传更新');
  }

  /** 复核：保留本地版本（以本地为准） */
  async function resolveWithLocal(id: string): Promise<void> {
    const entry = ordered.find((item) => item.id === id);
    if (!entry) return;
    await catalogTable.update(id, { reviewState: 'none' });
    removePendingProposal(id);
    report = report
      ? { ...report, conflicts: report.conflicts.filter((item) => item.id !== id) }
      : null;
    showToast('已保留本地版本');
  }

  function stampSuffix(): string {
    const date = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  async function handleExport(): Promise<void> {
    const snapshot = await exportSnapshot();
    const filename = exportSnapshotJson(snapshot);
    const stamp = new Date().toISOString();
    writeLastBackupAt(stamp);
    lastBackupAt = stamp;
    showToast(`已导出 ${filename}（结构版本 v${snapshot.schemaVersion}）`);
  }

  async function handleImport(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      showToast('JSON 解析失败，请确认文件格式');
      return;
    }
    const invalid = validateSnapshot(parsed);
    if (invalid) {
      showToast(invalid);
      return;
    }
    if (!window.confirm('导入会清空当前浏览器中的全部档案，再写入备份内容，操作不可撤销。是否继续？')) return;
    await importSnapshot(parsed as SealCarveSnapshot);
    await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), catalogTable.refresh()]);
    showToast('导入完成，数据已覆盖');
  }

  async function handleReset(): Promise<void> {
    if (!window.confirm('会删除当前浏览器中的全部档案并恢复演示数据，不可撤销。是否继续？')) return;
    await resetDatabase();
    await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), catalogTable.refresh()]);
    showToast('已清空并重新载入演示数据');
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">印谱汇总 · 分卷制版与回传对账</h2>
      <p class="mt-1 text-sm text-ink-soft">
        本地库 {DB_NAME} · 结构版本 v{DB_VERSION} · 每卷 {VOLUME_CAPACITY} 方
        {lastBackupAt ? ` · 最近导出 ${new Date(lastBackupAt).toLocaleString('zh-CN')}` : ' · 尚未导出过备份'}
      </p>
      <p class="mt-0.5 text-xs text-ink-soft">
        制版锁版：{lockedAtText}
        {lock ? `（快照 ${lock.items.length} 方；锁版后本地改动与回传不一致将留待复核）` : '（导出送厂清单时自动锁版）'}
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button class="gb-btn-primary" onclick={() => void handlePlateExport()}>导出送厂清单并锁版</button>
      <button class="gb-btn" onclick={() => plateFileInput?.click()}>回传对账</button>
      <button class="gb-btn" onclick={() => void revolume()}>重新分卷</button>
      <input
        bind:this={plateFileInput}
        type="file"
        accept="application/json,.json"
        class="hidden"
        onchange={(event) => void handlePlateReturn(event)}
      />
      <button class="gb-btn" onclick={() => void handleExport()}>导出 JSON</button>
      <button class="gb-btn" onclick={() => fileInput?.click()}>导入 JSON</button>
      <button class="gb-btn-danger" onclick={() => void handleReset()}>清空重播种</button>
      <button class="gb-btn-primary" onclick={openCreate}>加入印谱</button>
      <input
        bind:this={fileInput}
        type="file"
        accept="application/json,.json"
        class="hidden"
        onchange={(event) => void handleImport(event)}
      />
    </div>
  </div>

  {#if toast}
    <div class="rounded-xl border border-jade/40 bg-jade/10 px-4 py-2 text-sm text-jade">{toast}</div>
  {/if}

  <div class="flex flex-wrap gap-3">
    <StatBadge label="谱录条目" value={stat.total} suffix="方" tone="seal" />
    <StatBadge label="已收录" value={stat.included} suffix="方" tone="jade" />
    <StatBadge label="待收录" value={stat.pending} suffix="方" tone="amber" />
    <StatBadge label="不收录" value={stat.excluded} suffix="方" tone="ink" />
    <StatBadge label="分卷" value={volumeStats.length} suffix="卷" />
    <StatBadge label="钤印总数" value={$impressions.length} suffix="次" />
  </div>

  {#if volumeStats.length > 0}
    <div class="flex flex-wrap gap-2">
      {#each volumeStats as vol (vol.volumeNo)}
        <span
          class="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper-light px-3 py-1 text-xs text-ink"
          title={`第 ${vol.volumeNo} 卷：${vol.count}/${vol.capacity} 方，已收录 ${vol.included} 方`}
        >
          卷 {vol.volumeNo}
          <span class="tabular-nums {vol.count >= vol.capacity ? 'text-seal font-semibold' : ''}">
            {vol.count}/{vol.capacity}
          </span>
          <span class="text-ink-soft">已收录 {vol.included}</span>
        </span>
      {/each}
    </div>
  {/if}

  {#if pendingConflicts.length > 0}
    <section class="rounded-xl border border-amber/50 bg-amber/10 p-4">
      <h3 class="mb-2 text-base text-ink">留待复核（{pendingConflicts.length} 方）</h3>
      <p class="mb-3 text-xs text-ink-soft">
        锁版后本地改动过的条目与厂里回传不一致，已保留本地版本、未以后到覆盖。请逐条核对后选择以哪方为准。
      </p>
      <div class="space-y-2">
        {#each pendingConflicts as entry (entry.id)}
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-paper-light px-3 py-2">
            <div class="text-sm">
              <span class="text-ink">{designText(entry.designId)}</span>
              <span class="ml-2 text-xs text-ink-soft">
                本地：第 {entry.orderNo} 方 · 卷 {entry.volumeNo} · {INCLUDED_LABEL[entry.included]}
              </span>
            </div>
            <div class="flex gap-1">
              <button class="gb-btn px-2 py-1 text-xs" onclick={() => void resolveWithFactory(entry.id)}>
                以厂里为准
              </button>
              <button class="gb-btn-primary px-2 py-1 text-xs" onclick={() => void resolveWithLocal(entry.id)}>
                以本地为准
              </button>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if ordered.length === 0}
    <EmptyPanel
      title="印谱还没有条目"
      description="把已完成的印稿加入印谱，调整排序与收录状态，即可导出印谱清单与制版清单。"
      actionText="加入印谱"
      onAction={openCreate}
    />
  {:else}
    <div class="gb-panel overflow-x-auto">
      <table class="gb-table">
        <thead>
          <tr>
            <th class="w-20">排序</th>
            <th class="w-16">卷号</th>
            <th>印文 / 释文</th>
            <th class="w-40">印石</th>
            <th class="w-32">状态</th>
            <th class="w-24">复核</th>
            <th class="w-28">最佳评级</th>
            <th class="w-56">备注</th>
            <th class="w-52">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each ordered as entry, index (entry.id)}
            {@const best = bestImpressionOf(entry.designId)}
            <tr>
              <td class="whitespace-nowrap">
                <div class="flex items-center gap-1">
                  <span class="tabular-nums">{entry.orderNo}</span>
                  <button class="gb-btn px-2 py-0.5" disabled={index === 0} onclick={() => void move(entry, -1)}>↑</button>
                  <button
                    class="gb-btn px-2 py-0.5"
                    disabled={index === ordered.length - 1}
                    onclick={() => void move(entry, 1)}
                  >
                    ↓
                  </button>
                </div>
              </td>
              <td class="whitespace-nowrap tabular-nums text-ink-soft">卷 {entry.volumeNo}</td>
              <td>{designText(entry.designId)}</td>
              <td>{stoneText(entry.stoneId)}</td>
              <td>
                <select
                  class="gb-input py-1"
                  style="color:{INCLUDED_COLOR[entry.included]}"
                  value={entry.included}
                  onchange={(event) =>
                    void setIncluded(entry, (event.currentTarget as HTMLSelectElement).value as IncludedStatus)}
                >
                  {#each INCLUDED_OPTIONS as item (item.value)}
                    <option value={item.value}>{item.label}</option>
                  {/each}
                </select>
              </td>
              <td>
                {#if entry.reviewState === 'pending'}
                  <span class="gb-tag" style="color:{REVIEW_STATE_COLOR.pending};border-color:{REVIEW_STATE_COLOR.pending}66">
                    {REVIEW_STATE_LABEL.pending}
                  </span>
                {:else}
                  <span class="text-xs text-ink-soft">—</span>
                {/if}
              </td>
              <td>
                {#if best}
                  <GradeTag grade={best.grade} size="small" />
                {:else}
                  <span class="text-xs text-ink-soft">未钤印</span>
                {/if}
              </td>
              <td>
                <input
                  class="gb-input py-1"
                  value={entry.note}
                  placeholder="备注"
                  onchange={(event) => void saveNote(entry, (event.currentTarget as HTMLInputElement).value)}
                />
              </td>
              <td>
                <div class="flex flex-wrap gap-1">
                  <button
                    class="gb-btn px-2 py-1"
                    onclick={() => void setIncluded(entry, entry.included === 'included' ? 'pending' : 'included')}
                  >
                    {entry.included === 'included' ? '取消收录' : '标记收录'}
                  </button>
                  <button class="gb-btn-danger px-2 py-1" onclick={() => (pendingDelete = entry)}>删除</button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="grid gap-4 xl:grid-cols-2">
    <section class="gb-panel">
      <header class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-base text-ink">印谱清单</h3>
        <div class="flex flex-wrap gap-2">
          <button class="gb-btn" onclick={() => showToast(exportCatalogText(context))}>导出清单</button>
          <button
            class="gb-btn"
            onclick={async () => {
              const ok = await copyText(catalogText);
              showToast(ok ? '印谱清单已复制到剪贴板' : '浏览器未授权剪贴板');
            }}
          >
            复制
          </button>
        </div>
      </header>
      <pre class="max-h-[360px] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{catalogText}</pre>
    </section>

    <section class="gb-panel space-y-3">
      <h3 class="text-base text-ink">整库导出</h3>
      <p class="text-sm text-ink-soft">
        导出文件包含 5 张业务表全量数据与结构版本号（v{DB_VERSION}），可在其他设备通过「导入 JSON」还原。
      </p>
      <div class="flex flex-wrap gap-2">
        <button class="gb-btn" onclick={() => void handleExport()}>JSON 备份</button>
        <button class="gb-btn" onclick={() => showToast(exportImpressionCsv(context))}>钤印台账 CSV</button>
      </div>
      <div class="rounded-xl border border-line bg-black/[0.02] px-3 py-2 text-xs text-ink-soft">
        无状态容器：服务端不保存任何数据；清理浏览器站点数据会丢失档案，请定期导出备份。
      </div>
      <dl class="grid grid-cols-2 gap-2 text-xs text-ink-soft">
        <div>印石 {$stones.length} 方</div>
        <div>印稿 {$designs.length} 稿</div>
        <div>工序 {$carves.length} 道</div>
        <div>钤印 {$impressions.length} 次</div>
      </dl>
    </section>
  </div>

  <p class="text-xs text-ink-soft">
    分卷制版：每卷 {VOLUME_CAPACITY} 方，导出送厂清单时锁版；厂里回传后逐条对账，锁版后本地改动且与回传不一致的条目留待复核（后到不覆盖），回传使某卷超容会被拒绝并指明卷号。
  </p>
</div>

{#if dialogOpen}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-lg rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-3 text-lg text-ink">加入印谱</h3>
      <div class="space-y-3">
        <label class="block">
          <span class="gb-label">印石（仅显示尚有未收录印稿的印石）</span>
          <select class="gb-input" bind:value={newStoneId}>
            {#each $stones as stone (stone.id)}
              <option value={stone.id}>{stone.name}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="gb-label">印稿</span>
          <select class="gb-input" bind:value={newDesignId}>
            {#each designsOfNewStone as design (design.id)}
              <option value={design.id}>{design.sealText}（{design.annotation || '无释文'}）</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="gb-label">备注</span>
          <input class="gb-input" bind:value={newNote} placeholder="如：印谱首方" />
        </label>
        <p class="text-xs text-ink-soft">新条目将追加到第 {ordered.length + 1} 位，默认状态为「待收录」，卷号按顺序自动归入相应卷。</p>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (dialogOpen = false)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void submitNew()}>加入</button>
      </div>
    </div>
  </div>
{/if}

{#if pendingDelete}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="text-lg text-ink">删除谱录条目</h3>
      <p class="mt-2 text-sm text-ink-soft">
        将把「{designText(pendingDelete.designId)}」移出印谱，其余条目自动重编号并重新分卷；印稿与钤印记录不受影响。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (pendingDelete = null)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void confirmDelete()}>确认删除</button>
      </div>
    </div>
  </div>
{/if}
