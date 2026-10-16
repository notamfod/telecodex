<script lang="ts">
  import { onMount } from "svelte";
  import { highlightGitlabDiff } from "./gitlab-review-highlight.js";
  import { Button, InlineLoading, InlineNotification, Tag, Theme } from "carbon-components-svelte";
  import Renew from "carbon-icons-svelte/lib/Renew.svelte";
  import Launch from "carbon-icons-svelte/lib/Launch.svelte";
  import {
    isSafeGitlabUrl,
    emptyGitlabReviewSummary,
    loadGitlabReview,
    type GitlabReviewFinding,
    type GitlabReviewResult,
  } from "./gitlab-review-api.js";
  import {
    carbonTheme,
    getTelegramWebApp,
    haptic,
    initializeTelegram,
    openExternalUrl,
    type TelegramTheme,
  } from "./telegram.js";

  export let requestId: string;

  let theme: TelegramTheme = carbonTheme();
  let review: GitlabReviewResult | null = null;
  let loading = false;
  let refreshing = false;
  let error = "";
  let requestVersion = 0;

  const initData = getTelegramWebApp()?.initData ?? "";
  $: pending = review ? review.status !== "completed" : false;
  $: safeGitlabUrl = review && isSafeGitlabUrl(review.gitlabUrl) ? review.gitlabUrl : undefined;
  $: emptySummary = review ? emptyGitlabReviewSummary(review) : undefined;
  $: highlightedChanges = (review?.changes ?? []).map((change) => {
    const lines = highlightGitlabDiff(change.diff, change.newPath, change.oldPath);
    const lineDigits = lines.reduce((width, line) => Math.max(width, String(line.oldLine ?? "").length, String(line.newLine ?? "").length), 3);
    return { ...change, lines, lineDigits };
  });

  async function reload(force = false): Promise<void> {
    if (!initData) return;
    const version = ++requestVersion;
    if (force) refreshing = true;
    else loading = true;
    error = "";
    try {
      const next = await loadGitlabReview(requestId, initData, force);
      if (version === requestVersion) review = next;
    } catch (cause) {
      if (version === requestVersion) {
        error = cause instanceof Error ? cause.message : "Не удалось загрузить ревью";
        haptic("error");
      }
    } finally {
      if (version === requestVersion) {
        loading = false;
        refreshing = false;
      }
    }
  }

  function statusLabel(status: GitlabReviewResult["status"]): string {
    return {
      offered: "Ожидает запуска",
      queued: "В очереди",
      running: "ИИ проверяет изменения",
      retrying: "Повторная проверка",
      completed: "Ревью готово",
    }[status];
  }

  function statusType(status: GitlabReviewResult["status"]): "green" | "blue" | "purple" | "cool-gray" {
    if (status === "completed") return "green";
    if (status === "running" || status === "retrying") return "purple";
    if (status === "queued") return "blue";
    return "cool-gray";
  }

  function findingType(priority: GitlabReviewFinding["priority"]): "red" | "magenta" | "warm-gray" | "cool-gray" {
    if (priority === "P0") return "red";
    if (priority === "P1") return "magenta";
    if (priority === "P2") return "warm-gray";
    return "cool-gray";
  }

  onMount(() => {
    const stopTelegram = initializeTelegram((next) => { theme = next; });
    void reload();
    return stopTelegram;
  });
</script>

<Theme bind:theme>
  <main class="review">
    <header class="review__header">
      <div>
        <span class:review__live--pending={pending} class="review__live" aria-hidden="true"></span>
        <h1>GitLab review</h1>
      </div>
      <Button kind="ghost" size="small" icon={Renew} iconDescription="Обновить" disabled={loading || refreshing || !initData} on:click={() => reload(true)} />
    </header>

    {#if !initData}
      <InlineNotification kind="warning" title="Нужен Telegram" subtitle="Откройте дифф кнопкой из сообщения о ревью." hideCloseButton lowContrast />
    {:else if error}
      <section class="review__error">
        <InlineNotification kind="error" title="Не удалось загрузить ревью" subtitle={error} hideCloseButton lowContrast />
        <Button kind="ghost" size="small" on:click={() => reload(true)}>Повторить</Button>
      </section>
    {/if}

    {#if loading}
      <div class="review__loading"><InlineLoading description="Загружаю ревью" /></div>
    {:else if review}
      <section class="review__identity" aria-label="Проверяемый коммит">
        <div class="review__project"><strong>{review.projectPath}</strong><Tag inline size="sm" type={statusType(review.status)}>{statusLabel(review.status)}</Tag></div>
        {#if review.commitTitle}<p>{review.commitTitle}</p>{/if}
        <dl>
          <div><dt>База</dt><dd>{review.baseSha ?? "не указана"}</dd></div>
          <div><dt>Коммит</dt><dd>{review.headSha}</dd></div>
        </dl>
        {#if safeGitlabUrl}
          <Button kind="tertiary" size="small" icon={Launch} on:click={() => openExternalUrl(safeGitlabUrl)}>Открыть в GitLab</Button>
        {/if}
      </section>

      {#if pending}
        <section class="review__pending" aria-live="polite">
          <strong>{statusLabel(review.status)}</strong>
          <span>Обновите страницу, чтобы получить свежий результат.</span>
          <Button kind="ghost" size="small" disabled={refreshing} on:click={() => reload(true)}>Проверить снова</Button>
        </section>
      {:else}
        <section class="review__findings" aria-labelledby="findings-title">
          <header><h2 id="findings-title">Саммари ИИ</h2><span>{review.findings === undefined ? "сводка" : `${review.findings} замеч.`}</span></header>
          {#each review.items as item}
            <article class="review__finding">
              <Tag inline size="sm" type={findingType(item.priority)}>{item.priority}</Tag>
              <div><strong>{item.file}{#if item.line}: {item.line}{/if}</strong><p>{item.description}</p></div>
            </article>
          {:else}
            <p class="review__muted" class:review__muted--warning={emptySummary?.kind === "report-unavailable"}>{emptySummary?.text}</p>
          {/each}
        </section>
      {/if}

      <section class="review__changes" aria-labelledby="changes-title">
        <header><h2 id="changes-title">Изменения</h2><span>{review.changes.length} файлов</span></header>
        {#if review.truncated}<p class="review__notice">Показана сокращённая версия диффа.</p>{/if}
        {#each highlightedChanges as change, index}
          <details class="review__file" open={index === 0}>
            <summary><span>{change.oldPath === change.newPath ? change.newPath : `${change.oldPath} → ${change.newPath}`}</span>{#if change.truncated}<small>сокращён</small>{/if}</summary>
            <pre aria-label={`Дифф ${change.newPath}`} style={`--review-line-digits: ${change.lineDigits}ch`}>{#each change.lines as line}<code class={`review__line review__line--${line.kind}`}><span class="review__gutter" aria-hidden="true"><span title="Строка в старой версии">{line.oldLine ?? ""}</span><span title="Строка в новой версии">{line.newLine ?? ""}</span></span><span class="review__source">{#each line.tokens as token}<span class={`review__token ${token.className}`}>{token.text}</span>{/each}</span></code>{/each}</pre>
          </details>
        {:else}
          <p class="review__muted">Дифф пока недоступен.</p>
        {/each}
      </section>
    {/if}
  </main>
</Theme>

<style>
  .review { width: 100%; max-width: 48rem; min-height: 100vh; margin: 0 auto; padding: max(0.75rem, env(safe-area-inset-top)) 0.75rem max(1rem, env(safe-area-inset-bottom)); }
  .review__header, .review__header > div, .review__project, .review__findings > header, .review__changes > header, .review__file summary { display: flex; min-width: 0; align-items: center; }
  .review__header { justify-content: space-between; min-height: 2.5rem; border-bottom: 1px solid var(--cds-border-subtle, #525252); }
  .review__header > div { gap: 0.5rem; } .review__header h1 { margin: 0; font-size: 1.25rem; font-weight: 400; }
  .review__live { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--cds-support-success, #42be65); } .review__live--pending { background: var(--cds-support-info, #4589ff); }
  .review__loading { padding: 2rem 0; } .review__error { display: grid; gap: 0.25rem; margin-top: 0.75rem; } .review__error :global(.bx--inline-notification) { width: 100%; max-width: none; margin: 0; }
  .review__identity, .review__findings, .review__changes { padding: 1rem 0; border-bottom: 1px solid var(--cds-border-subtle, #525252); }
  .review__project { flex-wrap: wrap; gap: 0.5rem; } .review__project strong { overflow-wrap: anywhere; font-size: 0.875rem; } .review__project :global(.bx--tag) { margin: 0; }
  .review__identity p { margin: 0.5rem 0; font-size: 0.875rem; line-height: 1.4; } .review__identity dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0 0 0.75rem; }
  .review__identity dt { color: var(--cds-text-secondary, #c6c6c6); font-size: 0.6875rem; text-transform: uppercase; } .review__identity dd { margin: 0.25rem 0 0; overflow: hidden; font-family: "IBM Plex Mono", monospace; font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
  .review__pending { display: grid; gap: 0.375rem; padding: 1rem; border-bottom: 1px solid var(--cds-border-subtle, #525252); background: var(--cds-layer-accent, #393939); } .review__pending span, .review__muted { color: var(--cds-text-secondary, #c6c6c6); font-size: 0.8125rem; } .review__pending :global(.bx--btn) { justify-self: start; margin-top: 0.25rem; }
  .review__findings > header, .review__changes > header { justify-content: space-between; gap: 0.75rem; margin-bottom: 0.75rem; } .review h2 { margin: 0; font-size: 0.875rem; font-weight: 600; } .review__findings > header span, .review__changes > header span { color: var(--cds-text-secondary, #c6c6c6); font-size: 0.75rem; }
  .review__finding { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.5rem; padding: 0.75rem 0; border-top: 1px solid var(--cds-border-subtle, #525252); } .review__finding :global(.bx--tag) { height: fit-content; margin: 0; } .review__finding strong { display: block; overflow-wrap: anywhere; font-family: "IBM Plex Mono", monospace; font-size: 0.75rem; } .review__finding p { margin: 0.25rem 0 0; overflow-wrap: anywhere; font-size: 0.8125rem; line-height: 1.45; }
  .review__notice { margin: 0 0 0.75rem; color: var(--cds-support-warning, #f1c21b); font-size: 0.75rem; } .review__muted { margin: 0; } .review__muted--warning { color: var(--cds-support-warning, #f1c21b); }
  .review__file { border: 1px solid var(--cds-border-subtle, #525252); background: var(--cds-layer, #262626); } .review__file + .review__file { margin-top: 0.5rem; } .review__file summary { min-height: 2.75rem; justify-content: space-between; gap: 0.75rem; padding: 0.5rem 0.75rem; cursor: pointer; font-family: "IBM Plex Mono", monospace; font-size: 0.75rem; } .review__file summary span { min-width: 0; overflow-wrap: anywhere; } .review__file summary small { flex: 0 0 auto; color: var(--cds-text-secondary, #c6c6c6); font-family: "IBM Plex Sans", sans-serif; }
  /* Monokai editor colors stay paired in both Telegram themes. */
  .review__file pre { max-height: 32rem; margin: 0; overflow: auto; border-top: 1px solid var(--cds-border-subtle, #525252); background: #272822; color: #f8f8f2; font-family: "IBM Plex Mono", monospace; font-size: 0.75rem; line-height: 1.6; tab-size: 2; }
  .review__line { display: flex; min-width: max-content; min-height: 1.6em; border-left: 3px solid transparent; white-space: pre; color: inherit; }
  .review__line--added { border-left-color: #a6e22e; background: #2d3327; }
  .review__line--removed { border-left-color: #ff6188; background: #39282a; }
  .review__line--hunk { background: #303126; color: #66d9ef; }
  .review__gutter { position: sticky; left: 3px; z-index: 1; display: inline-grid; flex-shrink: 0; grid-template-columns: repeat(2, var(--review-line-digits, 3ch)); column-gap: 0.5ch; padding: 0 0.5rem; border-right: 1px solid #45463b; background: #272822; color: #a6a28c; text-align: right; user-select: none; }
  .review__source { flex: 1; padding: 0 0.75rem; }
  .review__token { color: inherit; }
  .review__line :global(.hljs-keyword), .review__line :global(.hljs-selector-tag), .review__line :global(.hljs-name), .review__line :global(.hljs-doctag) { color: #ff6188; }
  .review__line :global(.hljs-string), .review__line :global(.hljs-regexp), .review__line :global(.hljs-template-tag), .review__line :global(.hljs-template-variable) { color: #e6db74; }
  .review__line :global(.hljs-number), .review__line :global(.hljs-literal), .review__line :global(.hljs-symbol), .review__line :global(.hljs-bullet) { color: #b79aff; }
  .review__line :global(.hljs-title), .review__line :global(.hljs-section), .review__line :global(.hljs-attr), .review__line :global(.hljs-attribute), .review__line :global(.hljs-selector-class), .review__line :global(.hljs-selector-id) { color: #a6e22e; }
  .review__line :global(.hljs-type), .review__line :global(.hljs-built_in), .review__line :global(.hljs-code) { color: #66d9ef; }
  .review__line :global(.hljs-comment), .review__line :global(.hljs-quote), .review__line :global(.hljs-meta) { color: #a6a28c; }
  @media (min-width: 40rem) { .review { padding-inline: 1rem; } }
  @media (prefers-reduced-motion: reduce) { .review * { scroll-behavior: auto; } }
</style>
