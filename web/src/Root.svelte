<script lang="ts">
  import App from "./App.svelte";
  import JiraApp from "./JiraApp.svelte";
  import { resolveMiniAppRoute } from "./route.js";
  import { getTelegramWebApp } from "./telegram.js";

  const route = resolveMiniAppRoute(
    window.location.pathname,
    window.location.search,
    getTelegramWebApp()?.initDataUnsafe?.start_param,
  );
</script>

{#if route === "jira"}
  <JiraApp />
{:else}
  <App />
{/if}
