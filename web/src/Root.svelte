<script lang="ts">
  import App from "./App.svelte";
  import GitlabReviewApp from "./GitlabReviewApp.svelte";
  import JiraApp from "./JiraApp.svelte";
  import { resolveGitlabReviewRequestId, resolveMiniAppRoute } from "./route.js";
  import { getTelegramWebApp } from "./telegram.js";

  const route = resolveMiniAppRoute(
    window.location.pathname,
    window.location.search,
    getTelegramWebApp()?.initDataUnsafe?.start_param,
  );
  const requestId = resolveGitlabReviewRequestId(
    window.location.pathname,
    window.location.search,
    getTelegramWebApp()?.initDataUnsafe?.start_param,
  );
</script>

{#if route === "review" && requestId}
  <GitlabReviewApp {requestId} />
{:else if route === "jira"}
  <JiraApp />
{:else}
  <App />
{/if}
