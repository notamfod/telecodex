import { describe, expect, it, vi } from "vitest";

import {
  JiraPanel,
  renderFilter,
  renderFilters,
  renderHome,
  renderKanban,
  renderSprint,
  type JiraPanelMessage,
} from "../src/jira-panel.js";
import type { JiraClientPort } from "../src/jira-client.js";

const CHAT_ID = -1003981282865;
const TOPIC_ID = 999;

const issue = {
  key: "MIR-6789",
  summary: "[Backend]: Лист замера",
  status: "В работе",
  status_category: "indeterminate",
  assignee: "Anton Vinogradov",
  priority: "High",
  issue_type: "Задача",
  url: "https://jira.fashionhouse.by/browse/MIR-6789",
};

const source = (): JiraClientPort => ({
  getMySprint: vi.fn().mockResolvedValue({
    total: 1,
    issues: [issue],
    filter: { id: "11525", name: "Мой спринт" },
    cached: true,
    stale: false,
    cache_age_seconds: 120,
  }),
  getSprint: vi.fn().mockResolvedValue({
    total: 1,
    issues: [issue],
    sprints: [{ id: 245, name: "Mircli sprint 62", state: "ACTIVE" }],
    cached: true,
    stale: false,
    cache_age_seconds: 120,
  }),
  getKanban: vi.fn().mockResolvedValue({
    title: "Мой спринт",
    total: 1,
    columns: [{ status: "В работе", status_category: "indeterminate", count: 1, issues: [issue] }],
    cached: false,
    stale: false,
    cache_age_seconds: 0,
  }),
  getFilters: vi.fn().mockResolvedValue({
    count: 1,
    filters: [{
      id: "11525",
      name: "Мой спринт",
      owner: "Anton Vinogradov",
      favourite: true,
      url: "https://jira.fashionhouse.by/issues/?filter=11525",
    }],
    cached: false,
    stale: false,
    cache_age_seconds: 0,
  }),
  runFilter: vi.fn().mockResolvedValue({
    total: 1,
    issues: [issue],
    filter: { id: "11525", name: "Мой спринт" },
    cached: false,
    stale: false,
    cache_age_seconds: 0,
  }),
});

describe("Jira panel rendering", () => {
  it("renders the agreed home controls", () => {
    const message = renderHome();

    expect(message.html).toContain("Jira");
    expect(message.rows.flat().map((button) => button.text)).toEqual([
      "📋 Мой спринт",
      "🏃 Текущий спринт",
      "🗂 Канбан",
      "⭐ Мои фильтры",
      "🔄 Обновить",
    ]);
    expect(message.rows.flat()).toContainEqual({
      text: "📋 Мой спринт",
      callbackData: "jira:my-sprint:0",
    });
    expect(message.rows.flat()).toContainEqual({
      text: "🏃 Текущий спринт",
      callbackData: "jira:sprint:0",
    });
  });

  it("renders sprint issues as Jira links and reports cache age", () => {
    const message = renderSprint({
      total: 1,
      issues: [issue],
      sprints: [{ id: 245, name: "Mircli sprint 62", state: "ACTIVE" }],
      cached: true,
      stale: false,
      cache_age_seconds: 120,
    }, 0);

    expect(message.html).toContain("Mircli sprint 62");
    expect(message.html).toContain("MIR-6789");
    expect(message.html).toContain("Кэш: 2 мин");
    expect(message.rows.flat()).toContainEqual(expect.objectContaining({
      text: expect.stringContaining("MIR-6789"),
      url: issue.url,
    }));
  });

  it("marks stale data clearly", () => {
    const message = renderSprint({
      total: 1,
      issues: [issue],
      sprints: [],
      cached: true,
      stale: true,
      cache_age_seconds: 14_400,
    }, 0);

    expect(message.html).toContain("устаревший кэш");
  });

  it("renders kanban columns and filter selection buttons", () => {
    const kanban = renderKanban({
      title: "Мой спринт",
      total: 1,
      columns: [{ status: "В работе", status_category: "indeterminate", count: 1, issues: [issue] }],
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    }, 0);
    const filters = renderFilters({
      count: 1,
      filters: [{
        id: "11525",
        name: "Мой спринт",
        owner: "Anton Vinogradov",
        favourite: true,
        url: "https://jira.fashionhouse.by/issues/?filter=11525",
      }],
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    }, 0);

    expect(kanban.html).toContain("В работе");
    expect(filters.rows.flat()).toContainEqual({ text: "Мой спринт", callbackData: "jira:filter:11525:0" });
    expect(filters.rows.flat()).toContainEqual({ text: "↗ Jira", url: "https://jira.fashionhouse.by/issues/?filter=11525" });
  });

  it("renders a selected saved filter", () => {
    const message = renderFilter({
      total: 1,
      issues: [issue],
      filter: { id: "11525", name: "Мой спринт" },
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    }, 0);

    expect(message.html).toContain("Мой спринт");
    expect(message.html).toContain("MIR-6789");
  });
});

describe("JiraPanel lifecycle", () => {
  const createPanel = (savedMessageId?: number) => {
    const client = source();
    let state = savedMessageId === undefined ? {} : { messageId: savedMessageId };
    const send = vi.fn<(message: JiraPanelMessage) => Promise<number>>().mockResolvedValue(777);
    const edit = vi.fn<(messageId: number, message: JiraPanelMessage) => Promise<void>>().mockResolvedValue(undefined);
    const pin = vi.fn<(messageId: number) => Promise<void>>().mockResolvedValue(undefined);
    const panel = new JiraPanel({
      chatId: CHAT_ID,
      topicId: TOPIC_ID,
      client,
      send,
      edit,
      pin,
      store: {
        read: () => state,
        write: (next) => { state = next; },
      },
    });
    return { panel, client, send, edit, pin, state: () => state };
  };

  it("recognises only the configured Telegram topic", () => {
    const { panel } = createPanel();

    expect(panel.matches(CHAT_ID, TOPIC_ID)).toBe(true);
    expect(panel.matches(CHAT_ID, 1000)).toBe(false);
    expect(panel.matches(-1001, TOPIC_ID)).toBe(false);
  });

  it("creates, pins and remembers the panel message", async () => {
    const { panel, send, pin, state } = createPanel();

    expect(await panel.open()).toBe("sent");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ html: expect.stringContaining("Jira") }));
    expect(pin).toHaveBeenCalledWith(777);
    expect(state()).toEqual({ messageId: 777 });
  });

  it("restores the saved panel message after restart", async () => {
    const { panel, edit, pin } = createPanel(555);

    expect(await panel.open()).toBe("edited");
    expect(edit).toHaveBeenCalledWith(555, expect.any(Object));
    expect(pin).toHaveBeenCalledWith(555);
  });

  it("refreshes Jira explicitly from a callback", async () => {
    const { panel, client, edit, pin } = createPanel(555);

    expect(await panel.handleCallback("jira:refresh:sprint:0")).toBe(true);
    expect(client.getSprint).toHaveBeenCalledWith(true);
    expect(edit).toHaveBeenCalledWith(555, expect.objectContaining({ html: expect.stringContaining("MIR-6789") }));
    expect(pin).not.toHaveBeenCalled();
  });

  it("opens the My Sprint saved filter instead of the whole active sprint", async () => {
    const { panel, client, edit } = createPanel(555);

    expect(await panel.handleCallback("jira:my-sprint:0")).toBe(true);
    expect(client.getMySprint).toHaveBeenCalledWith(false);
    expect(client.getSprint).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith(555, expect.objectContaining({
      html: expect.stringContaining("Мой спринт"),
    }));
  });

  it("does not retry an edit immediately when Telegram rate-limits it", async () => {
    const { panel, edit } = createPanel(555);
    edit.mockRejectedValue(new Error("429: Too Many Requests: retry after 33"));

    await expect(panel.handleCallback("jira:sprint:0")).rejects.toThrow("429");
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("ignores callbacks outside the Jira namespace", async () => {
    const { panel } = createPanel(555);

    expect(await panel.handleCallback("other:action")).toBe(false);
  });

  it("leaves the current view unchanged when its page indicator is tapped", async () => {
    const { panel, edit } = createPanel(555);

    expect(await panel.handleCallback("jira:noop")).toBe(true);
    expect(edit).not.toHaveBeenCalled();
  });
});
