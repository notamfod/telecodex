<script lang="ts">
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { get } from "svelte/store";
  import { Button, InlineLoading } from "carbon-components-svelte";
  import type { DashboardSession, ThreadSwipeAction } from "./model.js";
  import ThreadRow from "./ThreadRow.svelte";

  export let sessions: DashboardSession[];
  export let total: number;
  export let hasMore: boolean;
  export let loadingNext: boolean;
  export let nextError: string;
  export let loadMore: () => Promise<void>;
  export let creating: Set<string>;
  export let revealedSwipe: { key: string; action: ThreadSwipeAction } | null;
  export let onCodex: (url: string) => void;
  export let onTelegram: (session: DashboardSession) => void;
  export let onReveal: (key: string, action: ThreadSwipeAction | null) => void;

  let viewport: HTMLDivElement | undefined;
  let requestedAtCount = -1;
  let now = Date.now();

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
  $: if (hasMore && !loadingNext && lastVirtualIndex >= sessions.length - 8) {
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
    if (!hasMore || loadingNext || requestedAtCount === sessions.length) return;
    requestedAtCount = sessions.length;
    await loadMore();
  }
</script>

<div
  class="session-list__viewport"
  bind:this={viewport}
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
          <ThreadRow
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
