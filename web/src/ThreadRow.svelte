<script lang="ts">
  import { Tag } from "carbon-components-svelte";
  import Add from "carbon-icons-svelte/lib/Add.svelte";
  import Code from "carbon-icons-svelte/lib/Code.svelte";
  import Launch from "carbon-icons-svelte/lib/Launch.svelte";
  import Time from "carbon-icons-svelte/lib/Time.svelte";
  import {
    relativeTime,
    settleThreadSwipe,
    threadGestureAxis,
    THREAD_SWIPE_ACTION_WIDTH,
    type DashboardSession,
    type ThreadSwipeAction,
  } from "./model.js";

  export let thread: DashboardSession;
  export let swipeKey: string;
  export let revealedAction: ThreadSwipeAction | null = null;
  export let creating = false;
  export let now = Date.now();
  export let onCodex: (url: string) => void;
  export let onTelegram: (thread: DashboardSession) => void;
  export let onReveal: (key: string, action: ThreadSwipeAction | null) => void;

  let surface: HTMLDivElement;
  let offset = 0;
  let dragging = false;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startOffset = 0;
  let axis: "pending" | "horizontal" | "vertical" = "pending";

  $: statusLabel = thread.state === "stalled"
    ? "зависла"
    : thread.waitingOn === "approval"
      ? "нужно подтвердить"
      : thread.waitingOn === "input"
        ? "нужно ответить"
        : thread.state === "waiting"
          ? "ожидает"
          : thread.state === "recent" ? "недавняя" : "активна";
  $: tagType = (thread.state === "stalled"
    ? "red"
    : thread.state === "waiting"
      ? "purple"
      : thread.state === "recent" ? "cool-gray" : "green") as "red" | "purple" | "cool-gray" | "green";
  $: canOpenCodex = Boolean(thread.codexUrl);
  $: canOpenTelegram = Boolean(thread.telegramUrl || (thread.canCreateTopic && !creating));
  $: if (!dragging) {
    offset = revealedAction === "codex"
      ? THREAD_SWIPE_ACTION_WIDTH
      : revealedAction === "telegram" ? -THREAD_SWIPE_ACTION_WIDTH : 0;
  }

  function runAction(action: ThreadSwipeAction): void {
    onReveal(swipeKey, null);
    if (action === "codex") onCodex(thread.codexUrl);
    else onTelegram(thread);
  }

  function startSwipe(event: PointerEvent): void {
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startOffset = offset;
    axis = "pending";
    dragging = true;
  }

  function moveSwipe(event: PointerEvent): void {
    if (!dragging || event.pointerId !== pointerId) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (axis === "pending") {
      const nextAxis = threadGestureAxis(deltaX, deltaY);
      if (nextAxis) axis = nextAxis;
      if (nextAxis === "horizontal") {
        onReveal(swipeKey, null);
        surface.setPointerCapture(event.pointerId);
      }
    }
    if (axis !== "horizontal") return;
    event.preventDefault();
    const width = surface.clientWidth;
    offset = Math.max(
      canOpenTelegram ? -width : 0,
      Math.min(canOpenCodex ? width : 0, startOffset + deltaX),
    );
  }

  function finishSwipe(event: PointerEvent): void {
    if (!dragging || event.pointerId !== pointerId) return;
    const finishedAxis = axis;
    dragging = false;
    pointerId = null;
    if (finishedAxis === "horizontal") {
      const decision = settleThreadSwipe(offset, surface.clientWidth, canOpenCodex, canOpenTelegram);
      offset = decision.offset;
      onReveal(swipeKey, decision.commit ? null : decision.action);
      if (decision.commit && decision.action) runAction(decision.action);
    } else if (finishedAxis === "pending" && revealedAction) {
      onReveal(swipeKey, null);
    }
  }

  function cancelSwipe(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    axis = "pending";
    offset = revealedAction === "codex"
      ? THREAD_SWIPE_ACTION_WIDTH
      : revealedAction === "telegram" ? -THREAD_SWIPE_ACTION_WIDTH : 0;
  }
</script>

<article
  class="thread"
  class:thread--waiting={thread.state === "waiting"}
  class:thread--recent={thread.state === "recent"}
  class:thread--stalled={thread.state === "stalled"}
>
  <div class="thread__swipe-actions">
    <button
      type="button"
      class="thread__swipe-action thread__swipe-action--codex"
      aria-label="Открыть в приложении ChatGPT"
      on:focus={() => onReveal(swipeKey, "codex")}
      on:click={() => runAction("codex")}
    >
      <Code size={20} />
      <span>ChatGPT</span>
    </button>
    <button
      type="button"
      class="thread__swipe-action thread__swipe-action--telegram"
      aria-label={thread.telegramUrl ? "Открыть топик Telegram" : "Создать топик Telegram"}
      disabled={creating}
      on:focus={() => onReveal(swipeKey, "telegram")}
      on:click={() => runAction("telegram")}
    >
      {#if thread.telegramUrl}
        <Launch size={20} />
        <span>Telegram</span>
      {:else}
        <Add size={20} />
        <span>{creating ? "Создаю" : "Создать"}</span>
      {/if}
    </button>
  </div>

  <div
    bind:this={surface}
    class="thread__surface"
    class:thread__surface--dragging={dragging}
    style:transform={`translateX(${offset}px)`}
    role="group"
    aria-label={`Сессия ${thread.label}`}
    on:pointerdown={startSwipe}
    on:pointermove={moveSwipe}
    on:pointerup={finishSwipe}
    on:pointercancel={cancelSwipe}
  >
    <div class="thread__rail" aria-hidden="true"></div>
    <div class="thread__body">
      <h2 title={thread.label}>{thread.label}</h2>
      <p class="thread__meta" title={thread.workspace}>
        {thread.workspace}{thread.source ? ` · ${thread.source}` : ""}
      </p>
      <div class="thread__details">
        <Tag type={tagType} size="sm" inline>{statusLabel}</Tag>
        <span class="thread__age"><Time size={14} /> {relativeTime(thread.timestamp, now)}</span>
      </div>
    </div>
  </div>
</article>
