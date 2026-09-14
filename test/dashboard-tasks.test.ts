import { buildDashboardPayload } from "../src/dashboard-api.js";
import type { TopicTaskRecord } from "../src/topic-task-store.js";
import type { StatusSnapshot } from "../src/status-board.js";
const chatId = -100123;
const snapshot: StatusSnapshot = { running: [], queued: [], recent: [], recentThreads: [], recentThreadCount: 0, now: 900, limit: 10, telegramActive: 0, codexAvailable: true, failedJobs24h: 0 };
function task(index: number, patch: Partial<TopicTaskRecord> = {}): TopicTaskRecord {
  return { taskId: String(index), chatId, messageThreadId: index + 10, title: `Task ${index}`, workspace: '/a/project', threadId: null, lifecycle: 'completed', agentState: 'result_ready', updatedAt: index, lastEventAt: 100, lastResultMessageId: null, ...patch } as TopicTaskRecord;
}
it('includes all persisted completed tasks before search and pagination, excluding another chat', () => {
  const tasks = Array.from({ length: 205 }, (_, i) => task(i));
  Object.assign(tasks[204], { ticketKey: 'MIR-9876', workspace: '/late/target-project' });
  tasks.push(task(999, { chatId: -100999 }));
  const payload = buildDashboardPayload(snapshot, chatId, [], { view: 'completed', offset: 200, limit: 30 }, tasks);
  expect(payload.counts.completed).toBe(205);
  expect(payload.sessions).toHaveLength(5);
  const found = buildDashboardPayload(snapshot, chatId, [], { view: 'completed', offset: 0, limit: 30, search: 'task 204' }, tasks);
  expect(found.sessions.map(row => row.id)).toEqual(['task:204']);
  expect(found.sessions[0]).toMatchObject({ threadId: null, canCreateTopic: false });
  expect(found.sessions[0].codexUrl).toBeUndefined();
  for (const search of ['mir-9876', 'target-project']) {
    const result = buildDashboardPayload(snapshot, chatId, [], { view: 'completed', offset: 0, limit: 30, search }, tasks);
    expect(result.sessions.map(row => row.id)).toEqual(['task:204']);
    expect(result.counts.completed).toBe(1);
  }
  const empty = buildDashboardPayload(snapshot, chatId, [], { view: 'completed', offset: 0, limit: 30, search: 'missing-ticket' }, tasks);
  expect(empty.sessions).toEqual([]);
  expect(empty.projects).toHaveLength(2);
});
it('keeps duplicate host bindings and distinct projects and historical results during delivery', () => {
  const tasks = [task(1, { threadId: 'host', lifecycle: 'open', agentState: 'delivering', lastResultMessageId: 55 }), task(2, { threadId: 'host', workspace: '/b/project' })];
  const host = { ...snapshot, recentThreads: [{ threadId: 'host', workspace: '/a/project', label: 'Host', source: 'cli', updatedAt: 50 }] };
  const payload = buildDashboardPayload(host, chatId, [], { view: 'active', offset: 0, limit: 30 }, tasks);
  expect(payload.counts).toEqual({ active: 1, completed: 1, recent: 0, attention: 0 });
  expect(payload.projects).toHaveLength(2);
  expect(new Set(payload.projects.map(p => p.id)).size).toBe(2);
  expect(payload.sessions[0]).toMatchObject({ id: 'task:1', threadId: 'host', taskContext: { resultStatus: 'pending', resultUrl: 'https://t.me/c/123/11/55' } });
  const filtered = buildDashboardPayload(host, chatId, [], { view: 'active', offset: 0, limit: 30, project: payload.sessions[0].projectId }, tasks);
  expect(filtered.projects).toHaveLength(2);
  expect(filtered.counts.completed).toBe(0);
});
it('classifies queued, approval, failure and completed independently of host availability', () => {
  const tasks = [task(1, { lifecycle: 'open', agentState: 'queued' }), task(2, { lifecycle: 'open', agentState: 'needs_approval' }), task(3, { lifecycle: 'open', agentState: 'failed' })];
  const payload = buildDashboardPayload(snapshot, chatId, [], { view: 'active', offset: 0, limit: 30 }, tasks);
  expect(payload.counts).toEqual({ active: 1, attention: 2, recent: 0, completed: 0 });
  expect(payload.sessions[0].state).toBe('queued');
});
it('keeps current host activity and child approval visible for disabled and duplicate task bindings', () => {
  const host: StatusSnapshot = { ...snapshot, running: [
    { threadId: 'running', label: 'Live', workspace: '/a/project', source: 'cli', since: 50, children: [] },
    { threadId: 'waiting', label: 'Wait', workspace: '/a/project', source: 'cli', since: 50,
      children: [{ threadId: 'child', label: 'Child', since: 60, waitingOn: 'approval' }] },
  ] };
  const tasks = [task(1, { threadId: 'running', lifecycle: 'open', agentState: 'idle', enabled: false }),
    task(2, { threadId: 'waiting', lifecycle: 'open', agentState: 'result_ready', lastResultMessageId: 55 }),
    task(3, { threadId: 'waiting', lifecycle: 'open', agentState: 'running' })];
  const active = buildDashboardPayload(host, chatId, [], { view: 'active', offset: 0, limit: 30 }, tasks);
  expect(active.sessions.map(row => row.id)).toEqual(['task:1']);
  const attention = buildDashboardPayload(host, chatId, [], { view: 'attention', offset: 0, limit: 30 }, tasks);
  expect(attention.sessions.map(row => row.id)).toEqual(['task:2', 'task:3']);
  expect(attention.sessions.every(row => row.waitingOn === 'approval')).toBe(true);
  expect(attention.sessions[0].taskContext).toMatchObject({ stateLabel: 'Нужно твоё разрешение', resultStatus: 'pending', resultUrl: 'https://t.me/c/123/12/55' });
  expect(attention.sessions.every(row => row.taskContext?.confirmedAt === 100)).toBe(true);
});
it('preserves completed lifecycle and known queue despite host activity while newer canonical attention wins', () => {
  const host: StatusSnapshot = { ...snapshot, running: [
    { threadId: 'host', label: 'Live', workspace: '/a/project', source: 'cli', since: 50, children: [] },
  ] };
  const tasks = [task(1, { threadId: 'host' }), task(2, { threadId: 'host', lifecycle: 'open', agentState: 'queued' }),
    task(3, { threadId: 'host', lifecycle: 'open', agentState: 'running', lastEventAt: null })];
  const active = buildDashboardPayload(host, chatId, [], { view: 'active', offset: 0, limit: 30 }, tasks);
  expect(active.sessions.find(row => row.id === 'task:2')?.state).toBe('queued');
  expect(active.counts.completed).toBe(1);
  const attention = buildDashboardPayload(host, chatId, [{ threadId: 'host', health: 'stalled', attentionKind: 'required', updatedAt: 200 }], { view: 'attention', offset: 0, limit: 30 }, tasks);
  expect(attention.sessions).toHaveLength(2);
  expect(attention.sessions.every(row => row.state === 'stalled')).toBe(true);
  expect(attention.sessions.find(row => row.id === 'task:3')?.taskContext?.confirmedAt).toBeNull();
});
it('uses newer canonical attention even when host recent-thread timestamp predates task confirmation', () => {
  const host = { ...snapshot, recentThreads: [{ threadId: 'host', workspace: '/a/project', label: 'Host', source: 'cli', updatedAt: 50 }] };
  const tasks = [task(1, { threadId: 'host', lifecycle: 'open', agentState: 'result_ready' })];
  const result = buildDashboardPayload(host, chatId, [{ threadId: 'host', health: 'healthy', attentionKind: 'required', updatedAt: 200 }], { view: 'attention', offset: 0, limit: 30 }, tasks);
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]).toMatchObject({ state: 'waiting', taskContext: { confirmedAt: 100, stateLabel: 'Нужно твоё действие' } });
});
