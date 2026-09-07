<script lang="ts">
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { get } from "svelte/store";
  import { Button, InlineLoading, Tag } from "carbon-components-svelte";
  import {
    assigneeInitials,
    jiraIssueStatusType,
    shouldRequestNextBacklog,
    type JiraIssue,
  } from "./jira-model.js";

  export let issues: JiraIssue[];
  export let total: number;
  export let loadedCount: number;
  export let hasMore: boolean;
  export let loadingNext: boolean;
  export let pagingBlocked: boolean;
  export let nextError: string;
  export let loadNext: () => Promise<void>;
  export let onOpenIssue: (issue: JiraIssue) => void;

  let viewport: HTMLDivElement | undefined;
  let autoRequestedCursor = -1;

  const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: issues.length,
    getScrollElement: () => viewport ?? null,
    getItemKey: (index) => issues[index]?.key ?? index,
    estimateSize: () => 112,
    overscan: 8,
  });

  $: updateVirtualizer(issues, viewport);
  $: virtualItems = $rowVirtualizer.getVirtualItems();
  $: totalSize = $rowVirtualizer.getTotalSize();
  $: lastVirtualIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
  $: if (!pagingBlocked && hasMore && lastVirtualIndex >= issues.length - 8) {
    void requestNext(false);
  }

  function updateVirtualizer(
    currentIssues: JiraIssue[],
    scrollElement: HTMLDivElement | undefined,
  ): void {
    get(rowVirtualizer).setOptions({
      count: currentIssues.length,
      getScrollElement: () => scrollElement ?? null,
      getItemKey: (index) => currentIssues[index]?.key ?? index,
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

  async function requestNext(manual: boolean): Promise<void> {
    if (!hasMore || loadingNext || pagingBlocked) return;
    if (!manual && !shouldRequestNextBacklog(
      hasMore,
      loadingNext || pagingBlocked,
      autoRequestedCursor,
      loadedCount,
    )) return;
    autoRequestedCursor = loadedCount;
    await loadNext();
  }

</script>

<div
  class="jira-backlog__viewport"
  bind:this={viewport}
  role="list"
  aria-label="Бэклог Jira"
  aria-busy={loadingNext}
>
  <div class="jira-backlog__canvas" style={`height: ${totalSize}px`}>
    {#each virtualItems as virtualRow (virtualRow.key)}
      {@const issue = issues[virtualRow.index]}
      {#if issue}
        {@const statusType = jiraIssueStatusType(issue)}
        <div
          class="jira-backlog__row"
          data-index={virtualRow.index}
          role="listitem"
          aria-posinset={virtualRow.index + 1}
          aria-setsize={total}
          use:measureElement
          style={`transform: translateY(${virtualRow.start}px)`}
        >
          <button class="jira-issue" on:click={() => onOpenIssue(issue)}>
            <span class={`jira-issue__rail jira-issue__rail--${statusType}`} aria-hidden="true"></span>
            <span class="jira-issue__body">
              <span class="jira-issue__top">
                <span class="jira-key">{issue.key}</span>
                <span class="jira-priority">{issue.priority ?? ""}</span>
              </span>
              <strong>{issue.summary}</strong>
              <span class="jira-issue__meta">
                <span>{issue.status} · {issue.issue_type ?? "Задача"}</span>
                {#if issue.telegramUrl}<span class="jira-thread-found">тред найден ↗</span>{/if}
              </span>
              <span class="jira-assignee-chip" title={issue.assignee ?? "Не назначен"}>
                <Tag inline size="sm" type="cool-gray" aria-label={`Исполнитель: ${issue.assignee ?? "Не назначен"}`}>
                  {assigneeInitials(issue.assignee)}
                </Tag>
              </span>
            </span>
          </button>
        </div>
      {/if}
    {/each}
  </div>

  {#if loadingNext}
    <div class="jira-backlog__status" aria-live="polite">
      <InlineLoading description="Загружаю следующие задачи" />
    </div>
  {:else if nextError}
    <div class="jira-backlog__status jira-backlog__status--error" role="alert">
      <span>{nextError}</span>
      <Button kind="ghost" size="small" on:click={() => requestNext(true)}>Повторить</Button>
    </div>
  {:else if !hasMore && issues.length > 0}
    <div class="jira-backlog__status" aria-live="polite">Загружен весь бэклог</div>
  {:else if issues.length === 0}
    <div class="jira-empty">В бэклоге нет задач</div>
  {/if}
</div>
