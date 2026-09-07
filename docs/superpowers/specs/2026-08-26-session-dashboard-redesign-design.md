# Session Dashboard Redesign

## Goal

Replace the current technical Dashboard with a focused Telegram Mini App for finding and opening Codex sessions. The screen must remain usable on a narrow phone viewport when there are many sessions and when stored thread titles contain full prompts or payloads.

## Approved scope

The Dashboard contains three session views:

1. Active
2. Recent
3. Stalled and waiting

It does not render Runtime status, Canonical jobs, job identifiers, delivery timelines, or operator actions for canonical jobs. Reliability and guardian data remain internal inputs used to classify sessions.

The Jira Mini App is unchanged. The session Dashboard reuses Jira's header and horizontally scrollable Carbon tag navigation pattern so both Mini Apps behave consistently.

## Information architecture

The page contains, in order:

1. A compact header with a live indicator, `Сессии · Codex`, and refresh action.
2. One horizontally scrollable navigation row with three icon tags and counts.
3. A short summary for the selected view.
4. A compact session list.
5. An inline loading, empty, or retry state when required.

The navigation row never wraps. It uses horizontal touch scrolling, hidden scrollbar chrome, contained horizontal overscroll, and fixed-width tag items. The active tag uses the same Carbon high-contrast treatment as Jira. Every tag retains a minimum 44px touch target even when its visible pill is compact.

The navigation labels are:

- `Активные`
- `Недавние`
- `Зависшие и ожидающие`

Each label has a state icon and the exact number of sessions available in that view.

## Session card

Each card shows only:

- a narrow semantic state rail;
- a normalized session title;
- the workspace basename;
- the source when it is safe and not unknown;
- relative age.

Titles are normalized to one whitespace-separated line in data, bounded to 160 Unicode code points before they reach the browser, and clamped to two visual lines. The complete raw prompt is not sent as an alternative title and cannot expand inside the list.

Workspace labels use the safe basename rather than an absolute path. Technical thread, turn, and job identifiers are not displayed.

Cards use Carbon's dark surfaces and border hierarchy already established by Jira. State rails provide the only strong status color:

- green for active;
- gray for recent;
- yellow for waiting on input or approval;
- red for stalled or operator attention required.

## Classification and deduplication

The server builds one normalized record per root thread and assigns it to exactly one view. Subagents remain internal children of their root session and do not render as separate rows. A waiting or stalled child can promote its root session into the attention view without exposing the child prompt in the card.

Classification precedence is:

1. `Stalled and waiting`
2. `Active`
3. `Recent`

A root session belongs to `Stalled and waiting` when at least one of these conditions is true:

- its root thread waits on user input;
- its root thread waits on approval;
- a canonical projection tied to the same thread has `health === "stalled"`;
- a canonical projection tied to the same thread requires operator attention.

A root session belongs to `Active` when the host reports it active and it was not assigned to the attention view.

A root session belongs to `Recent` when it is neither active nor attention-required, is not archived, and was updated during the previous 24 hours.

When several canonical projections reference the same thread, the server uses the strongest status by the precedence above and the newest status timestamp. A canonical job without a thread ID does not produce a session card.

All counters are calculated from the same normalized and deduplicated sets that back the lists. A counter may not include a session that the corresponding view cannot load.

## API and pagination

The Dashboard endpoint accepts:

- `view=active|recent|attention`;
- `offset`, starting at zero;
- `limit`, bounded by the server.

The response contains:

- generation time;
- counts for all three views;
- the requested session page;
- page metadata: `offset`, `returned`, `total`, and `hasMore`;
- Codex availability for the header live indicator.

Telegram slot usage and raw reliability groups are omitted from this response because the approved screen has no place to display them.

The default page size is 30 and the maximum page size is 100. Active and attention views use the same contract even though they are normally small.

Recent sessions are ordered by update time descending. Active and attention sessions are ordered by their newest meaningful activity descending. Subsequent recent pages load when the user approaches the bottom of the list. The browser merges pages by thread ID and preserves the server order.

Changing the selected view cancels or invalidates older requests. A late response from a previously selected view cannot replace the current list.

## Refresh behavior

Active and attention views refresh every five seconds while the Mini App is visible. Recent refreshes every fifteen seconds. Hidden tabs do not poll until the document becomes visible again.

A background refresh replaces the first page and retains already loaded later pages only when their ordering boundary is still compatible. Otherwise it resets recent pagination to the refreshed first page, preventing duplicates and stale ordering.

Manual refresh affects the selected view and its counters. It does not change the selected view or scroll position unless the refreshed ordering invalidates the loaded page sequence.

## Swipe interactions

Every session card supports two horizontal actions:

- swipe right: open the local chat in the ChatGPT app with `codex://threads/<thread-id>`;
- swipe left: open its Telegram topic.

A short swipe reveals the action. A committed long swipe executes it immediately. Vertical movement wins over horizontal movement once a vertical gesture is established, so list scrolling is not blocked.

For Telegram:

- when the session already has a live topic URL, the action opens it;
- when no topic exists, the action calls the existing ensure-topic endpoint, waits for the result, and opens the returned URL;
- while topic creation is running, only that session's Telegram action is disabled;
- repeated gestures for the same session share the in-flight operation and cannot create duplicate topics.

For ChatGPT, the client uses the documented canonical deep link. The implementation must be verified from Telegram on the target phone because official OpenAI documentation confirms the link for ChatGPT Desktop but does not separately guarantee mobile handling.

## Loading, empty, and error states

Initial loading shows one compact inline loader below the navigation. Background loading keeps the current rows visible.

An empty view shows one short message:

- `Нет активных сессий`
- `Нет недавних сессий за последние 24 часа`
- `Нет зависших или ожидающих сессий`

If loading fails, existing rows stay visible. A compact inline notification and retry action appear above the list. A next-page failure leaves loaded rows intact and shows retry at the list boundary.

If topic creation fails, the error is attached to that session and its swipe action becomes available for retry. Other cards remain interactive.

If the ChatGPT deep link is not handled by the device, the browser cannot reliably detect that handoff. Mobile acceptance testing therefore records the device and ChatGPT version and treats successful handoff as a release check.

## Accessibility and motion

The navigation exposes the selected view with `aria-current` or tab semantics. Counts are included in accessible names. Focus order follows header, navigation, then cards.

Session cards and revealed actions remain keyboard accessible. Status is conveyed through text and icon as well as rail color. Focus rings meet the existing Carbon contrast treatment.

Reduced-motion preference disables swipe transition animation. Touch actions preserve vertical scrolling, and horizontal navigation scrolling does not move the page sideways.

## Testing

Server and model tests cover:

- classification precedence;
- root and subagent deduplication;
- stalled, input, and approval states;
- exclusion of canonical jobs without thread IDs;
- count and list consistency;
- 24-hour recent boundary;
- newest-first ordering;
- page metadata and page merging;
- bounded labels and safe workspace names.

UI tests cover:

- the three icon tags and selected state;
- horizontally scrollable, non-wrapping navigation;
- removal of Runtime status and Canonical jobs;
- two-line title clamping;
- loading, empty, retry, and next-page states;
- stale-request rejection;
- swipe direction, reveal threshold, commit threshold, and vertical gesture priority;
- opening existing Telegram topics;
- creating and opening missing Telegram topics without duplicate requests;
- generation of the canonical ChatGPT deep link.

Verification runs targeted tests first, then the full test suite, web type checking, production build, and diff checks.

## Release verification

After build and service restart:

1. Verify health and readiness endpoints.
2. Open the Dashboard from Telegram on the target phone.
3. Confirm navigation matches Jira and scrolls horizontally on a narrow viewport.
4. Confirm counts equal the sessions reachable in each view.
5. Load all recent pages and confirm newest-first order without duplicates.
6. Confirm long source titles occupy no more than two lines.
7. Swipe right and verify the exact session opens in ChatGPT.
8. Swipe left on a session with a topic and verify that topic opens.
9. Swipe left on a session without a topic and verify one topic is created and opened.
10. Confirm Runtime status and Canonical jobs are absent from the session Dashboard.

The Jira Mini App and its backlog behavior receive a focused regression check after the shared web build.
