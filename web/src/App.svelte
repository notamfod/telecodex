<script lang="ts">
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
  let counts: DashboardPayload["counts"] = { active: 0, recent: 0, attention: 0 };
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

  const initData = getTelegramWebApp()?.initData ?? "";
  $: tabs = [
    { id: "active" as const, label: "Активные", value: counts.active, icon: PlayFilled },
    { id: "recent" as const, label: "Недавние", value: counts.recent, icon: RecentlyViewed },
    {
      id: "attention" as const,
      label: "Зависшие и ожидающие",
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
      const result = await loadDashboardWindow(initData, requestedView, sessions.length, fetch, signal);
      if (version !== requestVersion || !mounted) return;
      const anchor = list?.captureAnchor();
      sessions = [...result.payload.sessions];
      nextOffset = result.nextOffset;
      applyPayload(result.payload);
      if (!page.hasMore) nextError = "";
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
        view, offset: nextOffset, limit: PAGE_SIZE,
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

  function selectView(next: DashboardView): void {
    if (view === next || authExpired) return;
    haptic("tap");
    requestController?.abort();
    requestVersion += 1;
    refreshing = loadingNext = false;
    viewGeneration += 1;
    view = next;
    sessions = [];
    nextOffset = 0;
    page = emptyPage(next);
    error = "";
    nextError = "";
    revealedSwipe = null;
    void reload();
  }

  function revealSessionAction(key: string, action: ThreadSwipeAction | null): void {
    revealedSwipe = action ? { key, action } : null;
  }

  function openCodex(url: string): void {
    haptic("tap");
    window.location.assign(url);
  }

  async function openSessionTopic(session: DashboardSession): Promise<void> {
    if (authExpired || creating.has(session.id)) return;
    const generation = viewGeneration;
    creating = new Set(creating).add(session.id);
    error = "";
    try {
      const result = await ensureThreadTopic(session.id, initData);
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
    void reload();
    return () => {
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
        <h1>Codex · сессии</h1>
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
        {#key view}
        <SessionList
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
