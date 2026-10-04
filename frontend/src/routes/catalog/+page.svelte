<script lang="ts">
  /**
   * /catalog 印谱汇总、分卷制版与回传对账
   * - 收录状态切换 / 排序重编号（自动回填卷号，每卷 PLATE_VOLUME_SIZE 方）
   * - 锁版导出制版清单；厂方回传按基线逐条对账（锁版后本地动过且两边不同 → 留待复核）
   * - 回传超容量拒绝写入并指出卷号；入库失败可退回应用前清单并重试
   * - 印谱清单生成、JSON 导入导出与清空重播种
   */
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import GradeTag from '$lib/components/common/GradeTag.svelte';
  import PlateReviewPanel from '$lib/components/common/PlateReviewPanel.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import { designs, loadDesigns } from '$lib/stores/designStore';
  import { carves, loadCarves } from '$lib/stores/carveStore';
  import { impressions, loadImpressions, bestImpressionOf } from '$lib/stores/impressionStore';
  import { loadStones, stones } from '$lib/stores/stoneStore';
  import {
    INCLUDED_COLOR,
    INCLUDED_OPTIONS,
    PLATE_VOLUME_SIZE,
    REVIEW_REASON_LABEL,
    createEmptyCatalogDraft,
    type Catalog,
    type IncludedStatus,
    type PlateHandoffFile,
    type PlateReturnFile,
  } from '$lib/types/catalog';
  import {
    DB_NAME,
    DB_VERSION,
    exportSnapshot,
    importSnapshot,
    readLastBackupAt,
    resetDatabase,
    writeLastBackupAt,
    type SealCarveSnapshot,
  } from '$lib/utils/db';
  import {
    differsFromBaseline,
    reconcilePlateReturn,
    resequence,
    summarizeCatalog,
    validatePlateReturn,
    type ReconcileReport,
  } from '$lib/utils/catalog';
  import {
    applyPlateReturn,
    clearAllReviews,
    clearPlateSession,
    lockPlate,
    readApplyReport,
    readPlateLock,
    readReturnStash,
    readRollbackStash,
    resolveReviewAcceptRemote,
    resolveReviewKeepLocal,
    retryPlateReturn,
    rollbackPlateApply,
    unlockPlate,
    type PlateApplyReport,
    type PlateLockMeta,
  } from '$lib/utils/plate';
  import {
    buildCatalogText,
    copyText,
    exportCatalogText,
    exportImpressionCsv,
    exportPlateHandoffJson,
    exportPlateHandoffText,
    exportSnapshotJson,
    validateSnapshot,
  } from '$lib/utils/export';

  // 印谱条目没有独立 store：本页通过 useIdbTable 的 liveQuery 订阅并完成全部读写；
  // 收录状态一改动，下面的 $derived 汇总（含印石台账谱录方数）即时重算。
  const catalogTable = useIdbTable<Catalog>((database) => database.catalogs, { sortByUpdatedAt: false });
  const catalogRows = catalogTable.rows;

  let fileInput = $state<HTMLInputElement | null>(null);
  let returnInput = $state<HTMLInputElement | null>(null);
  let lastBackupAt = $state<string | null>(readLastBackupAt());
  let toast = $state('');
  let toastTone = $state<'jade' | 'seal'>('jade');
  let pendingDelete = $state<Catalog | null>(null);
  let dialogOpen = $state(false);
  let newStoneId = $state('');
  let newDesignId = $state('');
  let newNote = $state('');

  // 装订厂制版会话
  let lock = $state<PlateLockMeta | null>(readPlateLock());
  let returnStashPresent = $state<boolean>(readReturnStash() !== null);
  let rollbackStashPresent = $state<boolean>(readRollbackStash() !== null);
  let applyReport = $state<PlateApplyReport | null>(readApplyReport());
  let pendingReturn = $state<{ file: PlateReturnFile; raw: string } | null>(null);
  let preview = $state<ReconcileReport | null>(null);
  let previewError = $state('');

  const ordered = $derived([...$catalogRows].sort((a, b) => a.orderNo - b.orderNo));

  const context = $derived({
    stones: $stones,
    designs: $designs,
    carves: $carves,
    impressions: $impressions,
    catalogs: ordered,
  });

  const catalogText = $derived(buildCatalogText(context));
  const stat = $derived(summarizeCatalog(ordered));

  /** 卷号 → 条目列表（每卷 12 方） */
  const volumeGroups = $derived.by(() => {
    const map = new Map<number, Catalog[]>();
    ordered.forEach((entry) => {
      const list = map.get(entry.volumeNo) ?? [];
      list.push(entry);
      map.set(entry.volumeNo, list);
    });
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  });

  /** 锁版后本地动过对账字段的条目数 */
  const dirtyCount = $derived.by(() => {
    const current = lock;
    if (!current) return 0;
    return ordered.filter((entry) =>
      differsFromBaseline(entry, current.entries.find((base) => base.id === entry.id)),
    ).length;
  });

  const reviewRows = $derived(ordered.filter((entry) => entry.review != null));

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

  function showToast(text: string, tone: 'jade' | 'seal' = 'jade'): void {
    toast = text;
    toastTone = tone;
    setTimeout(() => (toast = ''), 3200);
  }

  function refreshSession(): void {
    lock = readPlateLock();
    returnStashPresent = readReturnStash() !== null;
    rollbackStashPresent = readRollbackStash() !== null;
    applyReport = readApplyReport();
  }

  async function move(entry: Catalog, delta: number): Promise<void> {
    const list = ordered;
    const index = list.findIndex((item) => item.id === entry.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    const reordered = [...list];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved as Catalog);
    // 顺序变化后统一重排：排序号连续，卷号按每卷 PLATE_VOLUME_SIZE 方回填
    await catalogTable.bulkPut(resequence(reordered));
    showToast('排序已更新，排序号与卷号已重排');
  }

  async function setIncluded(entry: Catalog, included: IncludedStatus): Promise<void> {
    await catalogTable.update(entry.id, { included });
    // 印谱汇总方数与印石台账谱录方数由 liveQuery + $derived 自动重算，无需手动刷新
  }

  async function saveNote(entry: Catalog, note: string): Promise<void> {
    await catalogTable.update(entry.id, { note });
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    const rest = ordered.filter((item) => item.id !== pendingDelete?.id);
    await catalogTable.remove(pendingDelete.id);
    if (rest.length > 0) {
      await catalogTable.bulkPut(resequence(rest));
    }
    pendingDelete = null;
    showToast('已删除并重排排序号与卷号');
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
    const orderNo = ordered.length + 1;
    const volumeNo = Math.floor((orderNo - 1) / PLATE_VOLUME_SIZE) + 1;
    const draft = createEmptyCatalogDraft(design.stoneId, design.id, orderNo, volumeNo);
    await catalogTable.create({ ...draft, note: newNote }, 'cata');
    dialogOpen = false;
    showToast(`已加入印谱：${design.sealText}（第 ${volumeNo} 卷）`);
  }

  /* --------------------------- 锁版与制版清单 --------------------------- */

  async function handleLock(): Promise<void> {
    if (ordered.length === 0) {
      showToast('印谱还没有条目，无法锁版', 'seal');
      return;
    }
    if (!window.confirm('锁版后导出清单给装订厂；锁版期间的本地改动会在回传对账时逐条留痕。确认锁版？')) return;
    let result;
    try {
      result = await lockPlate();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '锁版失败', 'seal');
      return;
    }
    await catalogTable.refresh();
    refreshSession();
    exportPlateHandoffJson(result.handoff);
    showToast(`已锁版并导出制版清单（${result.handoff.volumes} 卷，${result.handoff.entries.length} 方）`);
  }

  function handleExportHandoffText(): void {
    if (!lock) {
      showToast('请先锁版再导出制版清单', 'seal');
      return;
    }
    const handoff: PlateHandoffFile = {
      app: 'gbsealcarve-plate',
      kind: 'plate-handoff',
      lockedAt: lock.lockedAt,
      volumeSize: lock.volumeSize,
      volumes: lock.entries.reduce((max, entry) => Math.max(max, entry.volumeNo), 0),
      entries: lock.entries,
    };
    const filename = exportPlateHandoffText(handoff, context);
    showToast(`已导出制版清单文本 ${filename}`);
  }

  async function handleUnlock(): Promise<void> {
    if (!window.confirm('解锁会清除锁版基线与回传留存；条目上的复核标记仍保留，可稍后处理。确认解锁？')) return;
    unlockPlate();
    refreshSession();
    showToast('已解锁，可继续调整印谱并重新锁版');
  }

  /* ------------------------------ 回传对账 ------------------------------ */

  async function handleReturnFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    previewError = '';
    preview = null;
    pendingReturn = null;
    if (!file) return;
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      showToast('回传文件 JSON 解析失败，请确认文件内容', 'seal');
      return;
    }
    const validation = validatePlateReturn(parsed);
    if (!validation.ok) {
      showToast(validation.message, 'seal');
      return;
    }
    if (!lock) {
      showToast('尚未锁版，无法对账回传；请先锁版导出制版清单。', 'seal');
      return;
    }
    if (validation.value.lockedAt !== lock.lockedAt) {
      showToast(
        `版次不一致：回传 ${validation.value.lockedAt}，当前锁版 ${lock.lockedAt}，拒绝写入。`,
        'seal',
      );
      return;
    }
    // 预演对账（不写库）：容量超限即在这一步拦下，并指出卷号
    const localRows = await catalogTable.list();
    const result = reconcilePlateReturn(localRows, lock.entries, validation.value, {
      volumeSize: lock.volumeSize,
    });
    if (!result.ok) {
      previewError = result.message;
      showToast(result.message, 'seal');
      return;
    }
    pendingReturn = { file: validation.value, raw: text };
    preview = result;
  }

  async function confirmApplyReturn(): Promise<void> {
    if (!pendingReturn) return;
    const outcome = await applyPlateReturn(pendingReturn.raw);
    pendingReturn = null;
    preview = null;
    await catalogTable.refresh();
    refreshSession();
    if (outcome.ok) {
      showToast(
        `回传已入库：更新 ${outcome.applied} 方，留待复核 ${outcome.reviewLocalChanged + outcome.reviewMissingRemote + outcome.reviewRemoteOnly} 条`,
      );
    } else {
      showToast(outcome.message, 'seal');
    }
  }

  async function handleRetryReturn(): Promise<void> {
    const outcome = await retryPlateReturn();
    await catalogTable.refresh();
    refreshSession();
    if (outcome.ok) {
      showToast(`重试成功：更新 ${outcome.applied} 方`);
    } else {
      showToast(outcome.message, 'seal');
    }
  }

  async function handleRollback(): Promise<void> {
    if (!window.confirm('将把印谱清单退回到本次应用回传之前的状态，回传原文保留以便重试。确认退回？')) return;
    const ok = await rollbackPlateApply();
    await catalogTable.refresh();
    refreshSession();
    showToast(ok ? '已退回应用前的清单，可重新应用回传' : '没有可退回的快照', ok ? 'jade' : 'seal');
  }

  async function handleKeepLocal(entry: Catalog): Promise<void> {
    await resolveReviewKeepLocal(entry.id);
    await catalogTable.refresh();
    showToast('已采信本地版本并解除复核');
  }

  async function handleAcceptRemote(entry: Catalog): Promise<void> {
    await resolveReviewAcceptRemote(entry);
    await catalogTable.refresh();
    refreshSession();
    showToast('已采用厂方回传版本并解除复核');
  }

  async function handleClearAllReviews(): Promise<void> {
    if (!window.confirm('将全部复核条目按本地版本解除复核（不改动条目内容），确认？')) return;
    const count = await clearAllReviews();
    await catalogTable.refresh();
    showToast(`已解除 ${count} 条复核`);
  }

  /* ------------------------------ 整库备份 ------------------------------ */

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
      showToast('JSON 解析失败，请确认文件格式', 'seal');
      return;
    }
    const invalid = validateSnapshot(parsed);
    if (invalid) {
      showToast(invalid, 'seal');
      return;
    }
    if (!window.confirm('导入会清空当前浏览器中的全部档案，再写入备份内容，操作不可撤销。是否继续？')) return;
    await importSnapshot(parsed as SealCarveSnapshot);
    // 备份可能来自锁版前的另一轮制版：清掉旧基线 / 回传留存，避免误对账
    clearPlateSession();
    await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), catalogTable.refresh()]);
    refreshSession();
    showToast('导入完成，数据已覆盖；旧制版会话已清除');
  }

  async function handleReset(): Promise<void> {
    if (!window.confirm('会删除当前浏览器中的全部档案并恢复演示数据，不可撤销。是否继续？')) return;
    await resetDatabase();
    clearPlateSession();
    await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), catalogTable.refresh()]);
    refreshSession();
    showToast('已清空并重新载入演示数据');
  }

  const reviewTotal = $derived(
    applyReport
      ? applyReport.reviewLocalChanged + applyReport.reviewMissingRemote + applyReport.reviewRemoteOnly
      : 0,
  );
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">印谱汇总、分卷制版与数据导出</h2>
      <p class="mt-1 text-sm text-ink-soft">
        本地库 {DB_NAME} · 结构版本 v{DB_VERSION} · 每卷 {PLATE_VOLUME_SIZE} 方
        {lastBackupAt ? `· 最近导出 ${new Date(lastBackupAt).toLocaleString('zh-CN')}` : '· 尚未导出过备份'}
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
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
    <div
      class="rounded-xl border px-4 py-2 text-sm {toastTone === 'jade'
        ? 'border-jade/40 bg-jade/10 text-jade'
        : 'border-seal/40 bg-seal/10 text-seal'}"
    >
      {toast}
    </div>
  {/if}

  <!-- 装订厂分卷制版 -->
  <section class="gb-panel space-y-3">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 class="text-base text-ink">装订厂分卷制版</h3>
        <p class="mt-1 text-xs text-ink-soft">
          锁版导出清单后社里仍可调整；厂方回传时逐条对账：锁版后本地动过且两边不同的条目一律留待复核，不会被回传覆盖。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        {#if lock}
          <button class="gb-btn" onclick={handleExportHandoffText}>重出清单文本</button>
          <button class="gb-btn-danger" onclick={() => void handleUnlock()}>解锁</button>
        {:else}
          <button class="gb-btn-primary" onclick={() => void handleLock()}>锁版并导出清单</button>
        {/if}
        <button class="gb-btn" onclick={() => returnInput?.click()} disabled={!lock}>导入厂方回传</button>
        <input
          bind:this={returnInput}
          type="file"
          accept="application/json,.json"
          class="hidden"
          onchange={(event) => void handleReturnFile(event)}
        />
      </div>
    </header>

    {#if lock}
      <div class="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
        <span class="gb-tag border-jade/50 text-jade">已锁版 {new Date(lock.lockedAt).toLocaleString('zh-CN')}</span>
        <span>基线 {lock.entries.length} 方 · {lock.entries.reduce((max, entry) => Math.max(max, entry.volumeNo), 0)} 卷</span>
        <span class={dirtyCount > 0 ? 'text-seal' : ''}>锁版后本地改动 {dirtyCount} 条</span>
        {#if returnStashPresent}<span class="text-amber-700">留有回传原文</span>{/if}
        {#if rollbackStashPresent}<span class="text-amber-700">留有应用前清单快照</span>{/if}
      </div>
      <div class="flex flex-wrap gap-2">
        {#if returnStashPresent}
          <button class="gb-btn" onclick={() => void handleRetryReturn()}>用留存回传重试</button>
        {/if}
        {#if rollbackStashPresent}
          <button class="gb-btn-danger" onclick={() => void handleRollback()}>退回应用前清单</button>
        {/if}
      </div>
      {#if applyReport}
        <p class="text-xs text-ink-soft">
          最近入库 {new Date(applyReport.appliedAt).toLocaleString('zh-CN')}：更新 {applyReport.applied} 方
          {#if reviewTotal > 0}，留待复核 {reviewTotal} 条（含厂方多出 {applyReport.reviewRemoteOnly} 条）{/if}。
        </p>
      {/if}
    {:else}
      <p class="text-xs text-ink-soft">未锁版时导入回传会被拒绝；锁版会先按当前顺序把卷号回填落库。</p>
    {/if}

    {#if previewError}
      <div class="rounded-xl border border-seal/40 bg-seal/10 px-3 py-2 text-sm text-seal">{previewError}</div>
    {/if}
  </section>

  <div class="flex flex-wrap gap-3">
    <StatBadge label="谱录条目" value={stat.total} suffix="方" tone="seal" />
    <StatBadge label="已收录" value={stat.included} suffix="方" tone="jade" />
    <StatBadge label="待收录" value={stat.pending} suffix="方" tone="amber" />
    <StatBadge label="不收录" value={stat.excluded} suffix="方" tone="ink" />
    <StatBadge label="钤印总数" value={$impressions.length} suffix="次" />
    {#if reviewRows.length > 0}
      <StatBadge label="待复核" value={reviewRows.length} suffix="条" tone="seal" />
    {/if}
  </div>

  <!-- 分卷概览 -->
  {#if volumeGroups.length > 0}
    <div class="flex flex-wrap gap-2">
      {#each volumeGroups as [volumeNo, list] (volumeNo)}
        <span class="gb-tag {list.length > PLATE_VOLUME_SIZE ? 'border-seal text-seal' : 'border-line text-ink-soft'}">
          第 {volumeNo} 卷 · {list.length}/{PLATE_VOLUME_SIZE} 方
        </span>
      {/each}
    </div>
  {/if}

  {#if applyReport && applyReport.remoteOnlyItems.length > 0}
    <section class="gb-panel space-y-2 border-jade/40">
      <h3 class="text-base text-ink">厂方回传多出的条目（{applyReport.remoteOnlyItems.length} 条，未写入谱册）</h3>
      <ul class="space-y-1 text-xs text-ink-soft">
        {#each applyReport.remoteOnlyItems as item (item.id)}
          <li>
            id={item.id} · 第 {item.orderNo} 方 · 第 {item.volumeNo} 卷{item.note ? ` · ${item.note}` : ''}
            （{REVIEW_REASON_LABEL.remote_only}）
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <PlateReviewPanel
    reviews={reviewRows}
    designs={$designs}
    onKeepLocal={(entry) => void handleKeepLocal(entry)}
    onAcceptRemote={(entry) => void handleAcceptRemote(entry)}
    onClearAll={() => void handleClearAllReviews()}
  />

  {#if ordered.length === 0}
    <EmptyPanel
      title="印谱还没有条目"
      description="把已完成的印稿加入印谱，调整排序与收录状态，即可导出印谱清单、分卷锁版与 JSON 备份。"
      actionText="加入印谱"
      onAction={openCreate}
    />
  {:else}
    <div class="gb-panel overflow-x-auto">
      <table class="gb-table">
        <thead>
          <tr>
            <th class="w-20">排序</th>
            <th class="w-20">卷号</th>
            <th>印文 / 释文</th>
            <th class="w-40">印石</th>
            <th class="w-32">状态</th>
            <th class="w-28">最佳评级</th>
            <th class="w-56">备注</th>
            <th class="w-52">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each ordered as entry, index (entry.id)}
            {@const best = bestImpressionOf(entry.designId)}
            <tr class={entry.review ? 'bg-seal/[0.04]' : ''}>
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
              <td>
                <span class="gb-tag border-line text-ink-soft">第 {entry.volumeNo} 卷</span>
              </td>
              <td>
                {designText(entry.designId)}
                {#if entry.review}
                  <div class="mt-1 text-xs text-seal">待复核：{REVIEW_REASON_LABEL[entry.review.reason]}</div>
                {/if}
              </td>
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
        导出文件包含 5 张业务表全量数据与结构版本号（v{DB_VERSION}，含卷号与复核标记），可在其他设备通过「导入 JSON」还原。
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
    排序调整后自动重编号并回填卷号（每卷 {PLATE_VOLUME_SIZE} 方）；收录状态一改动，印谱汇总方数与印石台账的谱录方数即时重算。
  </p>
</div>

{#if preview && pendingReturn}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-2xl rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-2 text-lg text-ink">回传对账预览（尚未写入）</h3>
      <div class="flex flex-wrap gap-3 text-sm text-ink-soft">
        <span>按厂方更新 <strong class="text-jade">{preview.applied}</strong> 方</span>
        <span>本地改动不一致 <strong class="text-seal">{preview.reviewLocalChanged}</strong></span>
        <span>厂方缺条 <strong class="text-amber-700">{preview.reviewMissingRemote}</strong></span>
        <span>厂方多出 <strong class="text-seal">{preview.reviewRemoteOnly}</strong></span>
      </div>
      <ul class="mt-3 max-h-72 space-y-1 overflow-auto text-xs text-ink-soft">
        {#each preview.items as item (item.entry.id)}
          <li class="flex flex-wrap items-center gap-2">
            <span
              class="gb-tag {item.status === 'applied'
                ? 'border-jade/50 text-jade'
                : 'border-seal/50 text-seal'}"
            >
              {item.status === 'applied'
                ? '更新'
                : item.status === 'local_changed'
                  ? '留复核·本地改动'
                  : item.status === 'missing_remote'
                    ? '留复核·厂方缺条'
                    : '留复核·厂方多出'}
            </span>
            <span>{item.message}</span>
          </li>
        {/each}
      </ul>
      <p class="mt-3 text-xs text-ink-soft">
        各卷待写入方数：
        {[...preview.volumeCounts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([volumeNo, count]) => `第${volumeNo}卷${count}方`)
          .join('，')}
        ；容量已校验通过，确认后整批入库。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => { preview = null; pendingReturn = null; }}>取消</button>
        <button class="gb-btn-primary" onclick={() => void confirmApplyReturn()}>确认入库</button>
      </div>
    </div>
  </div>
{/if}

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
        <p class="text-xs text-ink-soft">
          新条目将追加到第 {ordered.length + 1} 位、第
          {Math.floor(ordered.length / PLATE_VOLUME_SIZE) + 1} 卷，默认状态为「待收录」。
        </p>
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
        将把「{designText(pendingDelete.designId)}」移出印谱，其余条目自动重排序号与卷号；印稿与钤印记录不受影响。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (pendingDelete = null)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void confirmDelete()}>确认删除</button>
      </div>
    </div>
  </div>
{/if}
