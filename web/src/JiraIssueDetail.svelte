<script lang="ts">
  import { Button, InlineLoading, InlineNotification, Tag } from "carbon-components-svelte";
  import ArrowLeft from "carbon-icons-svelte/lib/ArrowLeft.svelte";
  import ChatLaunch from "carbon-icons-svelte/lib/ChatLaunch.svelte";
  import Launch from "carbon-icons-svelte/lib/Launch.svelte";
  import Renew from "carbon-icons-svelte/lib/Renew.svelte";
  import type { JiraIssueDetail } from "./jira-model.js";
  import { assigneeInitials } from "./jira-model.js";

  export let issue: JiraIssueDetail;
  export let contextTitle: string;
  export let error = "";
  export let refreshing = false;
  export let openingThread = false;
  export let onBack: () => void;
  export let onRefresh: () => void;
  export let onRetry: () => void;
  export let onThread: () => void;
  export let onJira: () => void;

  let expandedComments = false;
  $: comments = [...(issue.comments ?? [])].reverse();
  $: visibleComments = expandedComments ? comments : comments.slice(0, 3);
  $: statusType = (issue.status.toLowerCase() === "blocked"
    ? "red"
    : issue.status_category === "indeterminate"
      ? "purple"
      : issue.status_category === "done" ? "green" : "blue") as "red" | "purple" | "green" | "blue";

  function dateLabel(value?: string): string {
    if (!value) return "-";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function cacheLabel(): string {
    const minutes = Math.round(issue.cache_age_seconds / 60);
    if (issue.stale) return `Устаревший кэш · ${minutes} мин`;
    if (issue.cached) return `Кэш · ${minutes} мин`;
    return "Получено из Jira";
  }
</script>

<section class="jira-detail" aria-label={`Задача ${issue.key}`}>
  <header class="jira-detail__bar">
    <Button kind="ghost" size="small" icon={ArrowLeft} iconDescription="Назад" on:click={onBack} />
    <span>{contextTitle}</span>
    <Button kind="ghost" size="small" icon={Renew} iconDescription="Обновить задачу" disabled={refreshing} on:click={onRefresh} />
  </header>

  <div class="jira-detail__heading">
    <div>
      <span class="jira-key">{issue.key}</span>
      <Tag inline size="sm" type={statusType}>{issue.status}</Tag>
      <Tag inline size="sm" type={issue.stale ? "red" : "cool-gray"}>{cacheLabel()}</Tag>
    </div>
    <h1>{issue.summary}</h1>
  </div>

  {#if error}
    <div class="jira-detail__error">
      <InlineNotification kind="error" title="Ошибка" subtitle={error} hideCloseButton lowContrast />
      <Button kind="ghost" size="small" on:click={onRetry}>Повторить</Button>
    </div>
  {/if}

  <dl class="jira-facts">
    <div>
      <dt>Исполнитель</dt>
      <dd class="jira-assignee-detail">
        <span class="jira-assignee-chip" title={issue.assignee ?? "Не назначен"}>
          <Tag inline size="sm" type="cool-gray">{assigneeInitials(issue.assignee)}</Tag>
        </span>
        <span>{issue.assignee ?? "Не назначен"}</span>
      </dd>
    </div>
    <div><dt>Приоритет</dt><dd>{issue.priority ?? "-"}</dd></div>
    <div><dt>Тип</dt><dd>{issue.issue_type ?? "-"}</dd></div>
    <div><dt>Обновлено</dt><dd>{dateLabel(issue.updated)}</dd></div>
  </dl>

  <section class="jira-detail__section">
    <h2>Описание</h2>
    <p class="jira-description">{issue.description?.trim() || "Описание отсутствует."}</p>
  </section>

  <section class="jira-detail__section">
    <h2>Комментарии · {comments.length}</h2>
    {#each visibleComments as comment}
      <article class="jira-comment">
        <header><strong>{comment.author}</strong><time>{dateLabel(comment.created)}</time></header>
        <p>{comment.body}</p>
      </article>
    {:else}
      <p class="jira-muted">Комментариев нет.</p>
    {/each}
    {#if comments.length > 3}
      <Button kind="ghost" size="small" on:click={() => { expandedComments = !expandedComments; }}>
        {expandedComments ? "Свернуть" : `Показать ещё ${comments.length - 3}`}
      </Button>
    {/if}
  </section>

  <footer class="jira-detail__actions">
    <Button kind="primary" size="lg" icon={ChatLaunch} disabled={openingThread} on:click={onThread}>
      {#if openingThread}<InlineLoading description="Создаю тред" />{:else}{issue.telegramUrl ? "Перейти в тред" : "Создать тред"}{/if}
    </Button>
    <Button kind="secondary" size="lg" icon={Launch} on:click={onJira}>Открыть в Jira</Button>
  </footer>
</section>
