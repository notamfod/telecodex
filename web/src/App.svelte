<script lang="ts">
  import { readPreferences, writePreferences, type DashboardPreferences } from "./dashboard-preferences.js";
  import { runTaskAction } from "./api.js";
  import { onMount, tick } from "svelte";
  import { Button, InlineLoading, InlineNotification, Tag, Theme } from "carbon-components-svelte";
  import PlayFilled from "carbon-icons-svelte/lib/PlayFilled.svelte";
  import RecentlyViewed from "carbon-icons-svelte/lib/RecentlyViewed.svelte";
  import Renew from "carbon-icons-svelte/lib/Renew.svelte";
  import WarningAltFilled from "carbon-icons-svelte/lib/WarningAltFilled.svelte";
  import { DashboardRequestError, ensureThreadTopic, loadDashboard, loadDashboardWindow } from "./api.js";
  import {
    dashboardPollInterval,
    mergeDashboardPage,
    type DashboardPayload,
    type DashboardSession,
    type DashboardView,
    type ThreadSwipeAction,
  } from "./model.js";
  import SessionList from "./SessionList.svelte";
  import {
    carbonTheme,
    getTelegramWebApp,
    haptic,
    initializeTelegram,
    openTelegramUrl,
    type TelegramTheme,
  } from "./telegram.js";

  const PAGE_SIZE = 30;
  const emptyPage = (view: DashboardView) => ({
    view,
    offset: 0,
    limit: PAGE_SIZE,
    total: 0,
    hasMore: false,
  });

  let theme: TelegramTheme = carbonTheme();
  let view: DashboardView = "active";
  let sessions: DashboardSession[] = [];
  let counts: DashboardPayload["counts"] = { active: 0, recent: 0, attention: 0, completed: 0 };
  let page = emptyPage(view);
  let generatedAt = 0;
  let codexAvailable = true;
  let loading = false;
  let refreshing = false;
  let loadingNext = false;
  let error = "";
  let nextError = "";
  let creating = new Set<string>();
  let revealedSwipe: { key: string; action: ThreadSwipeAction } | null = null;
  let refreshTimer: number | undefined;
  let mounted = false;
  let requestVersion = 0;
  let viewGeneration = 0;
  let requestController: AbortController | undefined;
  let authExpired = false;
  let nextOffset = 0;
  let list: SessionList | undefined;

  let search = "";
  let project = "";
  let projects: NonNullable<DashboardPayload["projects"]> = [];
  let preferencesNamespace = "";
  let debounceTimer: number | undefined;
  let filtersTouched = false;
  let restoreCount = 0;
  let pendingAnchor: DashboardPreferences["anchor"];

  function persistPosition(): void {
    if (!preferencesNamespace || authExpired || loading || restoreCount > 0) return;
    try { writePreferences(window.localStorage, preferencesNamespace, {
      view, search, project, count: sessions.length,
      anchor: list?.captureAnchor(),
    }); } catch { /* localStorage can be unavailable in embedded browsers. */ }
  }

  const initData = getTelegramWebApp()?.initData ?? "";
  $: tabs = [
    { id: "active" as const, label: "В работе", value: counts.active, icon: PlayFilled },
    { id: "completed" as const, label: "Завершённые", value: counts.completed ?? 0, icon: RecentlyViewed },
    { id: "recent" as const, label: "Недавние", value: counts.recent, icon: RecentlyViewed },
    {
      id: "attention" as const,
      label: "Нужно моё действие",
      value: counts.attention,
      icon: WarningAltFilled,
    },
  ];

  function startRequest(): { version: number; signal: AbortSignal } {
    requestController?.abort();
    requestController = new AbortController();
    return { version: ++requestVersion, signal: requestController.signal };
  }

  function handleRequestError(cause: unknown, background = false): string {
    if (cause instanceof DashboardRequestError && cause.status === 401) {
      authExpired = true;
      requestController?.abort();
      requestVersion += 1;
      loading = refreshing = loadingNext = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      return "";
    }
    if (!background) haptic("error");
    return cause instanceof Error ? cause.message : "Не удалось загрузить сессии";
  }

  async function reload(background = false): Promise<void> {
    if (!initData || authExpired) return;
    if (refreshing || loadingNext) { scheduleRefresh(); return; }
    const { version, signal } = startRequest();
    const requestedView = view;
    refreshing = true;
    loading = sessions.length === 0;
    error = "";
    try {
      let result = await loadDashboardWindow(initData, requestedView, restoreCount || sessions.length, fetch, signal, { search, project });
      if (version !== requestVersion || !mounted) return;
      if (result.payload.preferencesNamespace && result.payload.preferencesNamespace !== preferencesNamespace) {
        preferencesNamespace = result.payload.preferencesNamespace;
        let saved: DashboardPreferences | undefined;
        try { saved = readPreferences(window.localStorage, preferencesNamespace); } catch { /* unavailable storage */ }
        if (saved && !filtersTouched) {
          restoreCount = saved.count;
          view = saved.view; search = saved.search; project = saved.project;
          pendingAnchor = saved.anchor;
          viewGeneration += 1;
          result = await loadDashboardWindow(initData, view, saved.count, fetch, signal, { search, project });
        }
      }
      if (version !== requestVersion || !mounted) return;
      const anchor = pendingAnchor ?? list?.captureAnchor();
      pendingAnchor = undefined;
      restoreCount = 0;
      sessions = [...result.payload.sessions];
      nextOffset = result.nextOffset;
      applyPayload(result.payload);
      if (!page.hasMore) nextError = "";
      loading = false;
      await tick();
      if (version === requestVersion && anchor) list?.restoreAnchor(anchor);
    } catch (cause) {
      if (version !== requestVersion) return;
      error = handleRequestError(cause, background);
    } finally {
      if (version === requestVersion) {
        refreshing = false;
        loading = false;
        scheduleRefresh();
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (!initData || authExpired || loadingNext || refreshing || !page.hasMore) return;
    const { version, signal } = startRequest();
    loadingNext = true;
    nextError = "";
    try {
      const result = await loadDashboard(initData, {
        view, search, project, offset: nextOffset, limit: PAGE_SIZE,
      }, fetch, signal);
      if (version !== requestVersion || !mounted) return;
      sessions = mergeDashboardPage(sessions, result.sessions);
      nextOffset = result.page.offset + result.sessions.length;
      applyPayload(result);
      // An empty page must not trigger an infinite automatic pagination loop.
      if (result.sessions.length === 0 && page.hasMore) nextError = "Список изменился. Повторите загрузку.";
    } catch (cause) {
      if (version !== requestVersion) return;
      nextError = handleRequestError(cause);
    } finally {
      if (version === requestVersion) {
        loadingNext = false;
        scheduleRefresh();
      }
    }
  }

  function applyPayload(result: DashboardPayload): void {
    counts = result.counts;
    projects = result.projects ?? [];
    page = { ...result.page, offset: 0, hasMore: nextOffset < result.page.total };
    generatedAt = result.generatedAt;
    codexAvailable = result.system.codexAvailable;
  }

  function scheduleRefresh(): void {
    if (!mounted || authExpired) return;
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      if (document.visibilityState === "visible") void reload(true);
      else scheduleRefresh();
    }, dashboardPollInterval(view));
  }

  function changeFilters(debounce = false): void {
    if (authExpired) return;
    filtersTouched = true;
    restoreCount = 0;
    requestController?.abort();
    requestVersion += 1;
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshing = loadingNext = false;
    viewGeneration += 1;
    sessions = [];
    nextOffset = 0;
    page = emptyPage(view);
    error = nextError = "";
    revealedSwipe = null;
    pendingAnchor = undefined;
    if (preferencesNamespace) {
      try { writePreferences(window.localStorage, preferencesNamespace, { view, search, project, count: 30 }); } catch { /* unavailable storage */ }
    }
    loading = true;
    if (debounce) debounceTimer = window.setTimeout(() => { void reload(); }, 250);
    else void reload();
  }

  function selectView(next: DashboardView): void {
    if (view === next || authExpired) return;
    haptic("tap");
    view = next;
    changeFilters();
  }

  function revealSessionAction(key: string, action: ThreadSwipeAction | null): void {
    revealedSwipe = action ? { key, action } : null;
  }

  function openCodex(url: string): void {
    persistPosition();
    haptic("tap");
    window.location.assign(url);
  }

  async function openSessionTopic(session: DashboardSession): Promise<void> {
    if (authExpired || creating.has(session.id)) return;
    persistPosition();
    if (session.id.startsWith("task:") && session.telegramUrl) {
      openTelegramUrl(session.telegramUrl);
      return;
    }
    if (session.id.startsWith("task:") && !session.threadId) return;
    const generation = viewGeneration;
    creating = new Set(creating).add(session.id);
    error = "";
    try {
      const result = await ensureThreadTopic(session.threadId ?? session.id, initData);
      if (!mounted || viewGeneration !== generation || authExpired) return;
      haptic("success");
      openTelegramUrl(result.url);
      sessions = sessions.map((row) => row.id === session.id
        ? { ...row, telegramUrl: result.url, canCreateTopic: false }
        : row);
    } catch (cause) {
      if (mounted && viewGeneration === generation) error = handleRequestError(cause);
    } finally {
      const next = new Set(creating);
      next.delete(session.id);
      creating = next;
    }
  }

  onMount(() => {
    const stopTelegram = initializeTelegram((next) => { theme = next; });
    mounted = true;
    window.addEventListener("pagehide", persistPosition);
    void reload();
    return () => {
      persistPosition();
      window.removeEventListener("pagehide", persistPosition);
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      mounted = false;
      requestVersion += 1;
      requestController?.abort();
      stopTelegram();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  });
</script>

<Theme bind:theme>
  <main class="dashboard">
    <header class="dashboard__header">
      <div class="dashboard__title">
        <span class:live--down={!codexAvailable} class="live" aria-hidden="true"></span>
        <h1>Codex · задачи</h1>
        {#if generatedAt}<time>{new Date(generatedAt).toLocaleTimeString("ru-RU")}</time>{/if}
      </div>
      <Button
        kind="ghost"
        size="small"
        icon={Renew}
        iconDescription="Обновить"
        disabled={refreshing || loadingNext || !initData || authExpired}
        on:click={() => reload()}
      />
    </header>

    <nav class="dashboard__tabs" aria-label="Разделы сессий">
      {#each tabs as tab (tab.id)}
        <Tag
          interactive
          inline
          size="sm"
          type={view === tab.id ? "blue" : "cool-gray"}
          icon={tab.icon}
          title={tab.label}
          aria-current={view === tab.id ? "page" : undefined}
          aria-label={`${tab.label}: ${tab.value}`}
          on:click={() => selectView(tab.id)}
        >{tab.label} · {tab.value}</Tag>
      {/each}
    </nav>

    <div class="dashboard__filters">
      <input type="search" aria-label="Поиск задач" placeholder="Название, тикет или проект" maxlength="160"
        bind:value={search} disabled={!initData || authExpired} on:input={(event) => { search = event.currentTarget.value; changeFilters(true); }} />
      <select aria-label="Проект" bind:value={project} disabled={!initData || authExpired} on:change={(event) => { project = event.currentTarget.value; changeFilters(); }}>
        <option value="">Все проекты</option>
        {#if project && !projects.some(item => item.id === project)}<option value={project}>Выбранный проект</option>{/if}
        {#each projects as item}<option value={item.id}>{item.label}</option>{/each}
      </select>
      {#if search || project}<button type="button" disabled={authExpired} on:click={() => { search = ""; project = ""; changeFilters(); }}>Сбросить</button>{/if}
    </div>

    {#if !initData}
      <InlineNotification
        kind="warning"
        title="Нужен Telegram"
        subtitle="Откройте Dashboard кнопкой из закреплённого топика."
        hideCloseButton
        lowContrast
      />
    {:else if authExpired}
      <InlineNotification
        kind="warning"
        title="Сессия истекла"
        subtitle="Откройте Dashboard заново кнопкой из закреплённого топика."
        hideCloseButton
        lowContrast
      />
    {:else}
      {#if error}
        <InlineNotification kind="error" title="Ошибка обновления" subtitle={error} hideCloseButton lowContrast />
      {/if}
      {#if loading && sessions.length === 0}
        <div class="loading"><InlineLoading description="Загружаю сессии" /></div>
      {:else}
        {#key viewGeneration}
        <SessionList
          onTaskAction={async action => { try { await runTaskAction(action, initData); } finally { await reload(); } }}
          onScroll={persistPosition}
          bind:this={list}
          {sessions}
          total={page.total}
          hasMore={page.hasMore}
          {loadingNext}
          {refreshing}
          {nextError}
          {loadMore}
          {creating}
          {revealedSwipe}
          onCodex={openCodex}
          onTelegram={openSessionTopic}
          onReveal={revealSessionAction}
        />
        {/key}
      {/if}
    {/if}
  </main>
</Theme>

<style>
  .dashboard__filters { display: flex; flex-wrap: wrap; gap: 8px; }
  .dashboard__filters input, .dashboard__filters select { min-width: 0; max-width: 100%; flex: 1 1 180px; padding: 10px; color: inherit; background: var(--cds-field); border: 1px solid var(--cds-border-subtle); }
  .dashboard__filters button { color: inherit; background: var(--cds-field); border: 1px solid var(--cds-border-subtle); padding: 8px; }
</style>
