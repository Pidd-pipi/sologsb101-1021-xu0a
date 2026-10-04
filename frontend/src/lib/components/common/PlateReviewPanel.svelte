<script lang="ts">
  /**
   * <PlateReviewPanel> 装订厂回传复核清单
   * 展示挂在印谱条目上的复核标记（锁版后本地改动与厂方不一致 / 厂方缺条），
   * 支持「采信本地 / 采用厂方版本」逐条处理；厂方多出的条目在回传报告中单独展示。
   */
  import { REVIEW_REASON_LABEL, type Catalog, type ReviewReason } from '$lib/types/catalog';
  import type { Design } from '$lib/types/design';
  import { GRADE_LABEL } from '$lib/types/impression';
  import { bestImpressionOf } from '$lib/stores/impressionStore';

  interface Props {
    reviews: Catalog[];
    designs: Design[];
    onKeepLocal: (entry: Catalog) => void;
    onAcceptRemote: (entry: Catalog) => void;
    onClearAll?: () => void;
  }

  let { reviews, designs, onKeepLocal, onAcceptRemote, onClearAll }: Props = $props();

  function designText(designId: string): string {
    const design = designs.find((item) => item.id === designId);
    return design ? `${design.sealText}（${design.annotation || '无释文'}）` : '（印稿已删除）';
  }

  function reasonTone(reason: ReviewReason): string {
    if (reason === 'local_changed') return 'border-seal/50 bg-seal/5 text-seal';
    if (reason === 'missing_remote') return 'border-amber-600/40 bg-amber-100/40 text-amber-800';
    return 'border-jade/50 bg-jade/5 text-jade';
  }
</script>

{#if reviews.length > 0}
  <section class="gb-panel space-y-3 border-seal/40">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 class="text-base text-ink">留待复核（{reviews.length} 条）</h3>
        <p class="mt-1 text-xs text-ink-soft">
          锁版后本地改动且与厂方回传不一致、或厂方缺条的条目，两边版本都保留，不会被后到数据覆盖。
        </p>
      </div>
      {#if onClearAll}
        <button class="gb-btn" onclick={() => onClearAll()}>全部采信本地</button>
      {/if}
    </header>

    <ul class="space-y-2">
      {#each reviews as entry (entry.id)}
        {@const reason = entry.review?.reason ?? 'local_changed'}
        {@const remote = entry.review?.remote}
        {@const best = bestImpressionOf(entry.designId)}
        <li class="rounded-xl border border-line bg-white/60 p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="gb-tag {reasonTone(reason)}">{REVIEW_REASON_LABEL[reason]}</span>
              <span class="font-medium text-ink">{designText(entry.designId)}</span>
              <span class="text-xs text-ink-soft">第 {entry.orderNo} 方 · 第 {entry.volumeNo} 卷</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <button class="gb-btn px-2 py-1" onclick={() => onKeepLocal(entry)}>保留本地</button>
              {#if remote}
                <button class="gb-btn-primary px-2 py-1" onclick={() => onAcceptRemote(entry)}>采用厂方版本</button>
              {/if}
            </div>
          </div>

          <div class="mt-2 grid gap-2 text-xs sm:grid-cols-2">
            <div class="rounded-lg border border-line bg-paper-light/70 p-2">
              <div class="mb-1 font-medium text-ink">本地版本</div>
              <div class="text-ink-soft">
                排序 {entry.orderNo} · 第 {entry.volumeNo} 卷 · {entry.note || '无备注'}
                {#if best} · 最佳评级 {GRADE_LABEL[best.grade]}{/if}
              </div>
            </div>
            {#if remote}
              <div class="rounded-lg border border-line bg-paper-light/70 p-2">
                <div class="mb-1 font-medium text-ink">厂方回传版本</div>
                <div class="text-ink-soft">
                  排序 {remote.orderNo} · 第 {remote.volumeNo} 卷 · {remote.note || '无备注'}
                  <div>收到时间：{new Date(remote.receivedAt).toLocaleString('zh-CN')}</div>
                </div>
              </div>
            {:else}
              <div class="rounded-lg border border-dashed border-amber-600/40 bg-amber-50/50 p-2 text-amber-800">
                厂方回传中没有这条；保留本地并请与装订厂核对。
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}
