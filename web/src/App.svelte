<script lang="ts">
  import { onMount } from "svelte";
  import { Button, InlineLoading, InlineNotification, Tag, Theme } from "carbon-components-svelte";
  import PlayFilled from "carbon-icons-svelte/lib/PlayFilled.svelte";
  import RecentlyViewed from "carbon-icons-svelte/lib/RecentlyViewed.svelte";
  import Renew from "carbon-icons-svelte/lib/Renew.svelte";
  import WarningAltFilled from "carbon-icons-svelte/lib/WarningAltFilled.svelte";
  import { ensureThreadTopic, loadDashboard } from "./api.js";
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

  async function reload(): Promise<void> {
    if (!initData || refreshing || loadingNext) return;
    const requestedView = view;
    const version = ++requestVersion;
    refreshing = true;
    loading = sessions.length === 0;
    error = "";
    try {
      const result = await loadDashboard(initData, {
        view: requestedView,
        offset: 0,
        limit: PAGE_SIZE,
      });
      if (version !== requestVersion || requestedView !== view) return;
      sessions = sessions.length === 0
        ? [...result.sessions]
        : mergeDashboardPage(sessions, result.sessions);
      applyPayload(result);
      revealedSwipe = null;
    } catch (cause) {
      if (version !== requestVersion) return;
      error = cause instanceof Error ? cause.message : "Не удалось обновить сессии";
      haptic("error");
    } finally {
      if (version === requestVersion) {
        refreshing = false;
        loading = false;
        scheduleRefresh();
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (!initData || loadingNext || refreshing || !page.hasMore) return;
    const requestedView = view;
    const offset = sessions.length;
    loadingNext = true;
    nextError = "";
    try {
      const result = await loadDashboard(initData, {
        view: requestedView,
        offset,
        limit: PAGE_SIZE,
      });
      if (requestedView !== view) return;
      sessions = mergeDashboardPage(sessions, result.sessions);
      applyPayload(result);
    } catch (cause) {
      nextError = cause instanceof Error ? cause.message : "Не удалось загрузить следующие сессии";
      haptic("error");
    } finally {
      loadingNext = false;
    }
  }

  function applyPayload(result: DashboardPayload): void {
    counts = result.counts;
    page = {
      ...result.page,
      offset: 0,
      total: result.page.total,
      hasMore: sessions.length < result.page.total,
    };
    generatedAt = result.generatedAt;
    codexAvailable = result.system.codexAvailable;
  }

  function scheduleRefresh(): void {
    if (!mounted) return;
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      if (document.visibilityState === "visible") void reload();
      else scheduleRefresh();
    }, dashboardPollInterval(view));
  }

  function selectView(next: DashboardView): void {
    if (view === next) return;
    haptic("tap");
    requestVersion += 1;
    refreshing = false;
    view = next;
    sessions = [];
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
    if (creating.has(session.id)) return;
    creating = new Set(creating).add(session.id);
    error = "";
    try {
      const result = await ensureThreadTopic(session.id, initData);
      haptic("success");
      openTelegramUrl(result.url);
      sessions = sessions.map((row) => row.id === session.id
        ? { ...row, telegramUrl: result.url, canCreateTopic: false }
        : row);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Не удалось открыть топик";
      haptic("error");
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
        disabled={refreshing || !initData}
        on:click={reload}
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
    {:else}
      {#if error}
        <InlineNotification kind="error" title="Ошибка обновления" subtitle={error} hideCloseButton lowContrast />
      {/if}
      {#if loading && sessions.length === 0}
        <div class="loading"><InlineLoading description="Загружаю сессии" /></div>
      {:else}
        <SessionList
          {sessions}
          total={page.total}
          hasMore={page.hasMore}
          {loadingNext}
          {nextError}
          {loadMore}
          {creating}
          {revealedSwipe}
          onCodex={openCodex}
          onTelegram={openSessionTopic}
          onReveal={revealSessionAction}
        />
      {/if}
    {/if}
  </main>
</Theme>
