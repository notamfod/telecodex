<script lang="ts">
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { Button, InlineLoading } from "carbon-components-svelte";
  import type { DashboardSession, ThreadSwipeAction } from "./model.js";
  import ThreadRow from "./ThreadRow.svelte";

  export let onTaskAction: ((action: Record<string, unknown>) => Promise<void>) | undefined = undefined;
  export let onScroll: () => void = () => {};
  export let sessions: DashboardSession[];
  export let total: number;
  export let hasMore: boolean;
  export let loadingNext: boolean;
  export let refreshing = false;
  export let nextError: string;
  export let loadMore: () => Promise<void>;
  export let creating: Set<string>;
  export let revealedSwipe: { key: string; action: ThreadSwipeAction } | null;
  export let onCodex: (url: string) => void;
  export let onTelegram: (session: DashboardSession) => void;
  export let onReveal: (key: string, action: ThreadSwipeAction | null) => void;

  let viewport: HTMLDivElement | undefined;
  let now = Date.now();
  let scrollFrame: number | undefined;
  function persistAfterScroll(): void {
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => { scrollFrame = undefined; onScroll(); });
  }
  onDestroy(() => { if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame); });

  const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: sessions.length,
    getScrollElement: () => viewport ?? null,
    getItemKey: (index) => sessions[index]?.id ?? index,
    estimateSize: () => 104,
    overscan: 8,
  });

  $: updateVirtualizer(sessions, viewport);
  $: virtualItems = $rowVirtualizer.getVirtualItems();
  $: totalSize = $rowVirtualizer.getTotalSize();
  $: lastVirtualIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
  $: if (hasMore && !loadingNext && !refreshing && !nextError && lastVirtualIndex >= sessions.length - 8) {
    void requestNext();
  }

  function updateVirtualizer(
    currentSessions: DashboardSession[],
    scrollElement: HTMLDivElement | undefined,
  ): void {
    now = Date.now();
    get(rowVirtualizer).setOptions({
      count: currentSessions.length,
      getScrollElement: () => scrollElement ?? null,
      getItemKey: (index) => currentSessions[index]?.id ?? index,
    });
  }

  function measureElement(node: HTMLDivElement): { destroy(): void } {
    const virtualizer = get(rowVirtualizer);
    virtualizer.measureElement(node);
    return {
      destroy(): void {
        queueMicrotask(() => virtualizer.measureElement(null));
      },
    };
  }

  async function requestNext(): Promise<void> {
    if (!hasMore || loadingNext || refreshing) return;
    await loadMore();
  }

  export function captureAnchor(): { ids: string[]; offset: number; index?: number } | undefined {
    if (!viewport) return;
    const first = get(rowVirtualizer).getVirtualItems().find((item) => item.end > viewport!.scrollTop);
    if (!first) return;
    const ids = [sessions[first.index].id];
    for (let distance = 1; distance < sessions.length; distance++) {
      if (sessions[first.index + distance]) ids.push(sessions[first.index + distance].id);
      if (sessions[first.index - distance]) ids.push(sessions[first.index - distance].id);
    }
    return {
      ids,
      index: first.index,
      offset: viewport.scrollTop - first.start,
    };
  }

  export function restoreAnchor(anchor: { ids: string[]; offset: number; index?: number }): void {
    const indices = new Map(sessions.map((row, index) => [row.id, index]));
    const id = anchor.ids.find((candidate) => indices.has(candidate));
    if (!sessions.length) return;
    const index = id ? indices.get(id)! : Math.min(anchor.index ?? 0, sessions.length - 1);
    const virtualizer = get(rowVirtualizer);
    const position = virtualizer.getOffsetForIndex(index, "start");
    if (position) virtualizer.scrollToOffset(position[0] + anchor.offset);
  }
</script>

<div
  class="session-list__viewport"
  bind:this={viewport}
  on:scroll={persistAfterScroll}
  role="list"
  aria-label="Сессии Codex"
  aria-busy={loadingNext}
>
  <div class="session-list__canvas" style={`height: ${totalSize}px`}>
    {#each virtualItems as virtualRow (virtualRow.key)}
      {@const thread = sessions[virtualRow.index]}
      {#if thread}
        <div
          class="session-list__row"
          data-index={virtualRow.index}
          role="listitem"
          aria-posinset={virtualRow.index + 1}
          aria-setsize={total}
          use:measureElement
          style={`transform: translateY(${virtualRow.start}px)`}
        >
          <ThreadRow {onTaskAction}
            {thread}
            {now}
            swipeKey={thread.id}
            revealedAction={revealedSwipe?.key === thread.id ? revealedSwipe.action : null}
            creating={creating.has(thread.id)}
            {onCodex}
            {onTelegram}
            {onReveal}
          />
        </div>
      {/if}
    {/each}
  </div>

  {#if loadingNext}
    <div class="session-list__status"><InlineLoading description="Загружаю следующие сессии" /></div>
  {:else if nextError}
    <div class="session-list__status session-list__status--error" role="alert">
      <span>{nextError}</span>
      <Button kind="ghost" size="small" on:click={requestNext}>Повторить</Button>
    </div>
  {:else if sessions.length === 0}
    <div class="empty">В этом разделе нет сессий</div>
  {:else if !hasMore}
    <div class="session-list__status">Показаны все сессии</div>
  {/if}
</div>
