<script lang="ts">
  import { onMount } from "svelte";
  import { Button, InlineLoading, InlineNotification, MultiSelect, Tag, Theme } from "carbon-components-svelte";
  import Renew from "carbon-icons-svelte/lib/Renew.svelte";
  import {
    loadJiraBacklog,
    loadJiraIssue,
    loadJiraView,
    openJiraIssueThread,
  } from "./jira-api.js";
  import {
    createRequestGate,
    assigneeInitials,
    filterIssuesByAssignees,
    filterIssuesByStatuses,
    groupIssuesByStatus,
    jiraAssigneeOptions,
    jiraResultCount,
    jiraStatusOptions,
    mergeBacklogPage,
    sortStatusGroups,
    type JiraBacklogPage,
    type JiraFilters,
    type JiraIssue,
    type JiraIssueDetail,
    type JiraIssueList,
    type JiraKanban,
    type JiraStatusGroup,
    type JiraView,
    type JiraViewResult,
  } from "./jira-model.js";
  import JiraBacklogList from "./JiraBacklogList.svelte";
  import JiraIssueDetailView from "./JiraIssueDetail.svelte";
  import {
    carbonTheme,
    getTelegramWebApp,
    haptic,
    initializeTelegram,
    openExternalUrl,
    openTelegramUrl,
    type TelegramTheme,
  } from "./telegram.js";

  type JiraTab = "my-sprint" | "sprint" | "backlog" | "kanban" | "filters";

  const BACKLOG_PAGE_SIZE = 50;

  let theme: TelegramTheme = carbonTheme();
  let view: JiraView = "my-sprint";
  let selectedFilterId: string | undefined;
  let selectedFilterName = "";
  let result: JiraViewResult | null = null;
  let selectedIssue: JiraIssueDetail | null = null;
  let loading = false;
  let refreshing = false;
  let detailLoading = false;
  let openingThread = false;
  let error = "";
  let detailRetry: "refresh" | "thread" | null = null;
  let selectedAssigneeIds: string[] = [];
  let selectedStatusIds: string[] = [];
  let backlogLoadingNext = false;
  let backlogNextError = "";
  let backlogRefreshPaging = false;

  const initData = getTelegramWebApp()?.initData ?? "";
  const viewRequests = createRequestGate();
  const issueRequests = createRequestGate();
  const tabs: Array<{ id: JiraTab; label: string }> = [
    { id: "my-sprint", label: "Мой спринт" },
    { id: "sprint", label: "Текущий" },
    { id: "backlog", label: "Бэклог" },
    { id: "kanban", label: "Канбан" },
    { id: "filters", label: "Фильтры" },
  ];

  $: activeTab = view === "filter" ? "filters" : view;
  $: sprintResult = view === "sprint" && isIssueList(result) ? result : null;
  $: backlogResult = view === "backlog" && isIssueList(result)
    ? result as JiraBacklogPage
    : null;
  $: assigneeOptions = jiraAssigneeOptions(sprintResult?.issues ?? []);
  $: statusOptions = jiraStatusOptions(sprintResult?.issues ?? []);
  $: visibleSprintIssues = filterIssuesByStatuses(
    filterIssuesByAssignees(sprintResult?.issues ?? [], selectedAssigneeIds),
    selectedStatusIds,
  );
  $: groups = view === "backlog" ? [] : issueGroups(view, result, visibleSprintIssues);
  $: title = viewTitle(view, result, selectedFilterName);
  $: count = sprintResult ? visibleSprintIssues.length : result ? jiraResultCount(result) : 0;
  $: countLabel = backlogResult
    ? `${backlogResult.issues.length} из ${backlogResult.total} задач`
    : view === "filters"
    ? `${count} фильтров`
    : sprintResult && (selectedAssigneeIds.length > 0 || selectedStatusIds.length > 0)
      ? `${count} из ${jiraResultCount(sprintResult)} задач`
      : `${count} задач`;

  async function reload(force = false): Promise<void> {
    if (!initData) return;
    if (view === "backlog") {
      await reloadBacklog(force);
      return;
    }
    const request = viewRequests.start();
    const requestedView = view;
    const requestedFilterId = selectedFilterId;
    if (force) refreshing = true;
    else loading = true;
    error = "";
    try {
      const next = await loadJiraView(requestedView, initData, {
        refresh: force,
        filterId: requestedFilterId,
      });
      if (viewRequests.isLatest(request)) result = next;
    } catch (cause) {
      if (viewRequests.isLatest(request)) {
        error = cause instanceof Error ? cause.message : "Не удалось загрузить Jira";
        haptic("error");
      }
    } finally {
      if (viewRequests.isLatest(request)) {
        loading = false;
        refreshing = false;
      }
    }
  }

  async function reloadBacklog(force: boolean): Promise<void> {
    const request = viewRequests.start();
    backlogLoadingNext = false;
    backlogNextError = "";
    if (force) refreshing = true;
    else loading = true;
    error = "";
    try {
      const next = await loadJiraBacklog(initData, {
        startAt: 0,
        limit: BACKLOG_PAGE_SIZE,
        refresh: force,
      });
      if (viewRequests.isLatest(request) && view === "backlog") {
        result = next;
        backlogRefreshPaging = force;
      }
    } catch (cause) {
      if (viewRequests.isLatest(request)) {
        error = cause instanceof Error ? cause.message : "Не удалось загрузить бэклог";
        haptic("error");
      }
    } finally {
      if (viewRequests.isLatest(request)) {
        loading = false;
        refreshing = false;
      }
    }
  }

  async function loadNextBacklog(): Promise<void> {
    const current = backlogResult;
    if (!current || refreshing || backlogLoadingNext || current.returned >= current.total) return;
    const request = viewRequests.start();
    backlogLoadingNext = true;
    backlogNextError = "";
    try {
      const next = await loadJiraBacklog(initData, {
        startAt: current.returned,
        limit: BACKLOG_PAGE_SIZE,
        refresh: backlogRefreshPaging,
      });
      if (viewRequests.isLatest(request) && view === "backlog") {
        result = mergeBacklogPage(current, next);
      }
    } catch (cause) {
      if (viewRequests.isLatest(request)) {
        backlogNextError = cause instanceof Error
          ? cause.message
          : "Не удалось загрузить следующие задачи";
        haptic("error");
      }
    } finally {
      if (viewRequests.isLatest(request)) backlogLoadingNext = false;
    }
  }

  async function selectTab(next: JiraTab): Promise<void> {
    haptic("tap");
    closeIssue();
    view = next;
    selectedAssigneeIds = [];
    selectedStatusIds = [];
    selectedFilterId = undefined;
    selectedFilterName = "";
    backlogLoadingNext = false;
    backlogNextError = "";
    backlogRefreshPaging = false;
    result = null;
    await reload();
  }

  async function selectFilter(id: string, name: string): Promise<void> {
    haptic("tap");
    closeIssue();
    view = "filter";
    selectedAssigneeIds = [];
    selectedStatusIds = [];
    selectedFilterId = id;
    selectedFilterName = name;
    result = null;
    await reload();
  }

  async function openIssue(issue: JiraIssue, force = false): Promise<void> {
    const request = issueRequests.start();
    detailLoading = true;
    error = "";
    detailRetry = null;
    try {
      const next = await loadJiraIssue(issue.key, initData, force);
      if (issueRequests.isLatest(request)) {
        selectedIssue = next;
        haptic("tap");
      }
    } catch (cause) {
      if (issueRequests.isLatest(request)) {
        error = cause instanceof Error ? cause.message : "Не удалось загрузить задачу";
        detailRetry = selectedIssue ? "refresh" : null;
        haptic("error");
      }
    } finally {
      if (issueRequests.isLatest(request)) detailLoading = false;
    }
  }

  async function openThread(): Promise<void> {
    if (!selectedIssue || openingThread) return;
    const issue = selectedIssue;
    const request = issueRequests.start();
    openingThread = true;
    error = "";
    detailRetry = null;
    try {
      const thread = await openJiraIssueThread(
        issue.key,
        initData,
        openTelegramUrl,
        fetch,
        () => issueRequests.isLatest(request),
      );
      if (issueRequests.isLatest(request)) {
        selectedIssue = { ...issue, telegramUrl: thread.url };
        haptic("success");
      }
    } catch (cause) {
      if (issueRequests.isLatest(request)) {
        error = cause instanceof Error ? cause.message : "Не удалось открыть тред";
        detailRetry = "thread";
        haptic("error");
      }
    } finally {
      if (issueRequests.isLatest(request)) openingThread = false;
    }
  }

  function closeIssue(): void {
    issueRequests.invalidate();
    selectedIssue = null;
    detailLoading = false;
    openingThread = false;
    error = "";
    detailRetry = null;
  }

  onMount(() => {
    const stopTelegram = initializeTelegram((next) => { theme = next; });
    void reload();
    return stopTelegram;
  });

  function isIssueList(value: JiraViewResult | null): value is JiraIssueList {
    return Boolean(value && "issues" in value);
  }

  function isKanban(value: JiraViewResult | null): value is JiraKanban {
    return Boolean(value && "columns" in value);
  }

  function isFilters(value: JiraViewResult | null): value is JiraFilters {
    return Boolean(value && "filters" in value);
  }

  function issueGroups(
    currentView: JiraView,
    value: JiraViewResult | null,
    sprintIssues: JiraIssue[],
  ): JiraStatusGroup[] {
    if (currentView === "kanban" && isKanban(value)) {
      return sortStatusGroups(value.columns.map((column) => ({
        status: column.status,
        statusCategory: column.status_category,
        issues: column.issues,
      })));
    }
    if (!isIssueList(value)) return [];
    return groupIssuesByStatus(currentView === "sprint" ? sprintIssues : value.issues);
  }

  function viewTitle(currentView: JiraView, value: JiraViewResult | null, filterName: string): string {
    if (currentView === "my-sprint" && isIssueList(value)) return value.filter?.name ?? "Мой спринт";
    if (currentView === "sprint" && isIssueList(value)) {
      return value.sprints?.find((sprint) => sprint.state === "ACTIVE")?.name ?? "Текущий спринт";
    }
    if (currentView === "kanban" && isKanban(value)) return value.title;
    if (currentView === "backlog") return "Бэклог";
    if (currentView === "filter") return filterName;
    return "Мои фильтры";
  }

  function statusType(group: JiraStatusGroup): "red" | "purple" | "green" | "blue" | "cool-gray" {
    if (group.status.toLowerCase() === "blocked") return "red";
    if (group.statusCategory === "indeterminate") return "purple";
    if (group.statusCategory === "done") return "green";
    if (group.statusCategory === "new") return "blue";
    return "cool-gray";
  }

  function cacheLabel(value: JiraViewResult): string {
    if (value.stale) return `Устаревший кэш · ${Math.round(value.cache_age_seconds / 60)} мин`;
    if (value.cached) return `Кэш · ${Math.round(value.cache_age_seconds / 60)} мин`;
    return "Получено из Jira";
  }
</script>

<Theme bind:theme>
  <main class="jira" class:jira--wide={!selectedIssue && Boolean(result) && view !== "filters" && view !== "backlog"}>
    {#if selectedIssue}
      <JiraIssueDetailView
        issue={selectedIssue}
        contextTitle={title}
        {error}
        refreshing={detailLoading}
        {openingThread}
        onBack={closeIssue}
        onRefresh={() => openIssue(selectedIssue!, true)}
        onRetry={() => detailRetry === "thread" ? openThread() : openIssue(selectedIssue!, true)}
        onThread={openThread}
        onJira={() => openExternalUrl(selectedIssue!.url)}
      />
    {:else}
      <header class="jira__header">
        <div><span class="jira__live" aria-hidden="true"></span><h1>Jira · mircli</h1></div>
        <Button kind="ghost" size="small" icon={Renew} iconDescription="Обновить" disabled={refreshing || loading || backlogLoadingNext || !initData} on:click={() => reload(true)} />
      </header>

      <nav class="jira__tabs" aria-label="Разделы Jira">
        {#each tabs as tab}
          <Tag interactive inline size="sm" type={activeTab === tab.id ? "blue" : "cool-gray"} on:click={() => selectTab(tab.id)}>{tab.label}</Tag>
        {/each}
      </nav>

      {#if !initData}
        <InlineNotification kind="warning" title="Нужен Telegram" subtitle="Откройте Jira кнопкой из топика." hideCloseButton lowContrast />
      {:else if error}
        <div class="jira__error"><InlineNotification kind="error" title="Ошибка" subtitle={error} hideCloseButton lowContrast /><Button kind="ghost" size="small" on:click={() => reload()}>Повторить</Button></div>
      {/if}

      {#if loading}
        <div class="jira__loading"><InlineLoading description="Загружаю Jira" /></div>
      {:else if result}
        <div class="jira__summary"><strong>{title}</strong><span>{countLabel} · {cacheLabel(result)}</span></div>

        {#if sprintResult && (assigneeOptions.length > 0 || statusOptions.length > 0)}
          <div class="jira__sprint-filters">
            {#if assigneeOptions.length > 0}
              <div class="jira__sprint-filter">
                <MultiSelect
                  items={assigneeOptions}
                  bind:selectedIds={selectedAssigneeIds}
                  labelText="Фильтр по исполнителю"
                  label="Все исполнители"
                  placeholder="Все исполнители"
                  size="sm"
                  hideLabel
                  filterable={true}
                  locale="ru"
                  sortItem={() => 0}
                />
              </div>
            {/if}
            {#if statusOptions.length > 0}
              <div class="jira__sprint-filter">
                <MultiSelect
                  items={statusOptions}
                  bind:selectedIds={selectedStatusIds}
                  labelText="Фильтр по статусу"
                  label="Все статусы"
                  placeholder="Все статусы"
                  size="sm"
                  hideLabel
                  filterable={true}
                  locale="ru"
                  sortItem={() => 0}
                />
              </div>
            {/if}
          </div>
        {/if}

        {#if view === "filters" && isFilters(result)}
          <section class="jira-filters">
            {#each result.filters as filter}
              <button class="jira-filter" on:click={() => selectFilter(filter.id, filter.name)}>
                <span><strong>{filter.name}</strong><small>{filter.owner ?? "Сохранённый фильтр"}</small></span><span>›</span>
              </button>
            {:else}<div class="jira-empty">Нет сохранённых фильтров</div>{/each}
          </section>
        {:else if view !== "backlog"}
          <section class="jira-groups" aria-live="polite">
            {#each groups as group}
              <section class="jira-group">
                <header><span>{group.status}</span><Tag inline size="sm" type={statusType(group)}>{group.issues.length}</Tag></header>
                {#each group.issues as issue}
                  <button class="jira-issue" on:click={() => openIssue(issue)}>
                    <span class={`jira-issue__rail jira-issue__rail--${statusType(group)}`} aria-hidden="true"></span>
                    <span class="jira-issue__body">
                      <span class="jira-issue__top"><span class="jira-key">{issue.key}</span><span class="jira-priority">{issue.priority ?? ""}</span></span>
                      <strong>{issue.summary}</strong>
                      <span class="jira-issue__meta"><span>{issue.issue_type ?? "Задача"}</span>{#if issue.telegramUrl}<span class="jira-thread-found">тред найден ↗</span>{/if}</span>
                      <span class="jira-assignee-chip" title={issue.assignee ?? "Не назначен"}>
                        <Tag inline size="sm" type="cool-gray" aria-label={`Исполнитель: ${issue.assignee ?? "Не назначен"}`}>
                          {assigneeInitials(issue.assignee)}
                        </Tag>
                      </span>
                    </span>
                  </button>
                {/each}
              </section>
            {:else}<div class="jira-empty">Задач нет</div>{/each}
          </section>
        {/if}
      {/if}
    {/if}

    {#if view === "backlog" && backlogResult}
      <div hidden={Boolean(selectedIssue)}>
        <JiraBacklogList
          issues={backlogResult.issues}
          total={backlogResult.total}
          loadedCount={backlogResult.returned}
          hasMore={backlogResult.returned < backlogResult.total}
          loadingNext={backlogLoadingNext}
          pagingBlocked={refreshing}
          nextError={backlogNextError}
          loadNext={loadNextBacklog}
          onOpenIssue={openIssue}
        />
      </div>
    {/if}
  </main>
</Theme>
