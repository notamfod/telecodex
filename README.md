# TeleCodex

TeleCodex is a Telegram bridge for the OpenAI Codex CLI SDK. It keeps a Codex thread alive from your phone, streams agent responses and tool output in real time, and lets you hand the thread back to the CLI whenever you want.

> **This is a fork.** On top of upstream it adds a project registry, a ticket inbox,
> a GitLab bridge, scheduled review recipes, and a few fixes to how turns are
> delivered. See [Fork additions](#fork-additions).

## Features

- **Per-context sessions** — each Telegram chat or forum topic gets its own independent Codex session with separate thread, model, and busy state
- **Streaming responses** — agent text edits in-place as Codex generates it
- **Full tool visibility** — shell commands, file changes, web searches, MCP calls, and error items shown with configurable verbosity
- **Live plan display** — Codex's todo list rendered as a separate message and updated as steps complete
- **Voice transcription** — send a voice message or audio file; TeleCodex transcribes it (local parakeet-coreml or OpenAI Whisper) and forwards the text to Codex
- **Image input** — send a photo (with optional caption) to pass screenshots or images directly to Codex
- **File ingest & artifacts** — send a document to stage it for Codex; generated files are delivered back as Telegram documents
- **Session browser** — `/sessions` lists recent threads from `~/.codex`, grouped by workspace; tap to switch
- **Telegram login** — `/login` authenticates against the Codex CLI via device auth flow, no terminal needed
- **Launch profiles** — `/launch_profiles` selects the sandbox + approval mode for new or reattached threads in the current Telegram context (`/launch` remains an alias)
- **Model picker** — `/model` shows available models and lets you switch for new threads
- **Reasoning effort** — `/effort` lets you dial from `minimal` to `xhigh` for new threads
- **Optional message reactions** — 👀 while processing, 👍 on success when enabled; silently degrades in chats without reaction support
- **Friendly errors** — common SDK and network errors are translated to actionable messages with command hints
- **Token usage** — session token totals shown on `/session`, with optional per-turn footer in replies
- **Handback flow** — `/handback` prints a ready-to-run `codex resume <id>` command (copied to clipboard on macOS)
- **User allowlist** — only configured Telegram user IDs can interact with the bot
- **Docker-friendly** — workspace auto-detected (`/workspace` in containers, `cwd` otherwise)

## Prerequisites

- Node.js 22+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The Codex CLI installed and authenticated on the host:
  - API key auth: set `CODEX_API_KEY`
  - ChatGPT login: `codex login` on the machine, or use `/login` from Telegram
- *(Optional)* `ffmpeg` — required for local voice transcription via parakeet-coreml
- *(Optional)* `OPENAI_API_KEY` — enables OpenAI Whisper as a voice transcription fallback

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

3. Fill in `.env`:

   | Variable | Required | Description |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
   | `TELEGRAM_ALLOWED_USER_IDS` | ✅ | Comma-separated Telegram user IDs |
   | `TELEGRAM_FORUM_CHAT_ID` | — | Forum supergroup ID; enables automatic topic creation for visible Codex chats |
   | `TOPIC_SYNC_INTERVAL_SECONDS` | — | Topic reconciliation interval, at least 5 seconds (default `30`) |
   | `CODEX_API_KEY` | — | API key for Codex (alternative to ChatGPT login) |
   | `CODEX_MODEL` | — | Default model, e.g. `gpt-5.4`, `o3` |
   | `CODEX_SANDBOX_MODE` | — | `read-only`, `workspace-write` *(default)*, `danger-full-access` |
   | `CODEX_APPROVAL_POLICY` | — | `never` *(default)*, `on-request`, `on-failure`, `untrusted` |
   | `CODEX_LAUNCH_PROFILES_JSON` | — | Optional JSON array of named launch profiles for `/launch_profiles` |
   | `CODEX_DEFAULT_LAUNCH_PROFILE` | — | Default launch profile id (defaults to `default`) |
   | `ENABLE_UNSAFE_LAUNCH_PROFILES` | — | Set to `true` to allow extra `danger-full-access` launch profiles |
   | `TOOL_VERBOSITY` | — | `all`, `summary` *(default)*, `errors-only`, `none` |
   | `SHOW_TURN_TOKEN_USAGE` | — | Show the per-turn `in/cached/out` footer in final replies (`false` by default) |
   | `MAX_FILE_SIZE` | — | Max upload size in bytes (default `20971520` = 20 MB) |
   | `ENABLE_TELEGRAM_LOGIN` | — | Allow `/login` and `/logout` from Telegram (`false` by default) |
   | `ENABLE_TELEGRAM_REACTIONS` | — | Enable Telegram emoji reactions like 👀 / 👍 (`false` by default) |
   | `OPENAI_API_KEY` | — | Enables OpenAI Whisper voice transcription fallback |

4. Start the bot:
   ```bash
   npm run dev
   ```

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Welcome & status (concise for returning users) |
| `/help` | Grouped command reference |
| `/new` | Start a fresh thread (workspace picker if multiple workspaces) |
| `/session` | Current thread ID, workspace, model, effort, and token totals |
| `/sessions` | Browse recent threads grouped by workspace; tap to switch |
| `/switch <id>` | Switch directly to a thread by ID |
| `/retry` | Resend the last prompt |
| `/abort` | Cancel the current turn |
| `/launch_profiles` | Select launch profile for new or reattached threads (`/launch` alias kept) |
| `/model` | View and change the model |
| `/effort` | Set reasoning effort: `minimal` · `low` · `medium` · `high` · `xhigh` |
| `/auth` | Check authentication status |
| `/login` | Start Codex device-auth flow from Telegram |
| `/logout` | Sign out of Codex |
| `/voice` | Check voice transcription backend status |
| `/handback` | Print `codex resume <id>` for CLI handoff |
| `/attach <id>` | Bind an existing Codex thread to this forum topic |
| `/projects` | Threads grouped by project, with links to their topics |
| `/inbox on\|off\|status` | Turn this topic into a ticket inbox for forwarded messages |
| `/mr` | Open merge requests from GitLab; tap one to open a review topic |
| `/done` | Draft a "done" comment for the merge request linked to this ticket |

### Voice, image & file input

- **Voice / audio** — send any voice message or audio file; TeleCodex transcribes it and sends the result to Codex
- **Photos** — send a photo with an optional caption; the image is forwarded to Codex as visual input
- **Documents** — send a file (with optional caption); TeleCodex stages it in the workspace, runs Codex, and delivers any generated files back as Telegram documents

### Tool verbosity

| Mode | What you see |
|---|---|
| `all` | Every tool start, streaming output, and result |
| `summary` *(default)* | A short grouped footer such as `Tools used: 3x bash, 2x subagents, web_fetch` |
| `errors-only` | Only failed tool calls |
| `none` | Silent |

Per-turn token usage is hidden by default. Set `SHOW_TURN_TOKEN_USAGE=true` if you want the `in / cached / out` footer appended to final replies.

### Launch profiles

- TeleCodex always provides a built-in `default` profile synthesized from `CODEX_SANDBOX_MODE` and `CODEX_APPROVAL_POLICY`
- Built-in Telegram-visible presets are:
  - `Default`
  - `Read Only`
  - `Review`
  - `Full Access` when `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- `Workspace Write` is not listed separately because it is already the default behavior in the shipped config
- Optional extra profiles can be configured with `CODEX_LAUNCH_PROFILES_JSON`, for example:
  ```json
  [
    { "id": "readonly", "label": "Read Only", "sandboxMode": "read-only", "approvalPolicy": "never" },
    { "id": "review", "label": "Review", "sandboxMode": "workspace-write", "approvalPolicy": "on-request" }
  ]
  ```
- `/launch_profiles` changes only future thread creation or reattachment in the current chat/topic context; it does not mutate an already active thread in place
- Extra `danger-full-access` profiles are blocked unless `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- Selecting a `danger-full-access` profile from Telegram requires an explicit confirmation step

## Multi-Session Architecture

Each Telegram chat or forum topic is identified by a **context key** — the chat ID alone for private chats, or `chatId:threadId` for forum topics. This means every topic in a supergroup gets its own independent Codex session.

The `SessionRegistry` maps context keys to `CodexSessionService` instances:

```
┌───────────────────┐      ┌───────────────────────────────┐
│ Private Chat A     │─────▶│ CodexSessionService (thread X) │
│ key: "111"         │      └───────────────────────────────┘
├───────────────────┤      ┌───────────────────────────────┐
│ Group B / Topic 1  │─────▶│ CodexSessionService (thread Y) │
│ key: "222:1"       │      └───────────────────────────────┘
├───────────────────┤      ┌───────────────────────────────┐
│ Group B / Topic 2  │─────▶│ CodexSessionService (thread Z) │
│ key: "222:2"       │      └───────────────────────────────┘
└───────────────────┘
```

- **First message** in a context → creates a new `CodexSessionService` → starts a new Codex thread
- **Subsequent messages** → same context key → same session → conversation continues
- **`/new`** → replaces the thread within the same context (optionally picking a workspace first)
- **`/sessions`** → lists all Codex threads from `~/.codex`, lets you switch within the current context
- **`/attach <id>`** → resumes a specific Codex CLI thread (useful for picking up work started in the terminal)

Session metadata (thread ID, workspace, launch profile, model, effort) is persisted to `.telecodex/contexts.json` and restored on restart so threads survive bot reboots.

Each context has independent busy-state tracking, so a running prompt in one topic doesn't block another.

When `TELEGRAM_FORUM_CHAT_ID` is configured, TeleCodex periodically creates one forum topic for every visible top-level Codex chat (`source = vscode`). CLI automation runs and subagent threads are ignored. The persisted context binding also acts as a tombstone: deleting a Telegram topic does not delete its Codex thread and does not cause the topic to be recreated automatically.

## Handoff: Telegram → CLI

1. Run `/handback` in Telegram
2. TeleCodex replies with:
   ```bash
   cd '/path/to/project' && codex resume 'thread-abc123'
   ```
3. Paste and run in your terminal

On macOS the command is also copied to the clipboard automatically.

## Architecture

```
Telegram ←→ Grammy bot (auto-retry, HTML formatting, inline keyboards)
                |
                v
        SessionRegistry  ──→  per-context CodexSessionService instances
                |
                ├── @openai/codex-sdk  ──→  spawns Codex CLI subprocess
                │     └── ThreadEvents (agent text, commands, file changes,
                │                       MCP calls, web searches, todo lists,
                │                       reasoning, errors, token usage)
                ├── CodexStateReader  ──→  ~/.codex/state_*.sqlite  (threads)
                │                    ──→  ~/.codex/models_cache.json (models)
                ├── CodexAuth        ──→  codex login/logout subprocess
                ├── Attachments      ──→  .telecodex/inbox/<turnId>/ (staged files)
                ├── Artifacts        ──→  .telecodex/outbox/<turnId>/ (generated files)
                └── VoiceTranscriber  ──→  parakeet-coreml (local)
                                     ──→  OpenAI Whisper (cloud fallback)
```

## Fork additions

Everything below is specific to this fork.

### Project registry and topics

`/projects` lists live threads grouped by the project they run in, each with a link
to its forum topic. Topics that were deleted in Telegram are detected and pruned, so
the list never offers a link that goes nowhere.

### Ticket inbox

`/inbox on [workspace]` turns the current forum topic into an inbox. Anything
forwarded into it becomes a ticket in its own topic, with a start button and the
session defaults the inbox was configured with.

- A message that carries a known issue key (`ABC-1234`) lands in the topic that key
  already has, instead of opening a second one for the same issue.
- Attachments are forwarded into the ticket topic, so the context arrives with it.
- A ticket topic gets the same launch profile a hand-made topic gets. A topic that
  cannot write to the repository it was opened for is useless.

### GitLab bridge

With `GITLAB_URL`, `GITLAB_TOKEN` and `GITLAB_GROUP_ID` set:

- `/mr` lists open merge requests across the group. Tapping one opens a review topic
  with the diff already fetched and a review prompt sent.
- `/done [KEY] [text]` finds the merge requests linked to a ticket and drafts a
  comment for each. **Nothing is posted until you tap "send"** — the draft is shown
  first, exactly as it will appear on GitLab.

### Scheduled review recipes

A recipe is a deterministic prepare step (run by the runner, not by the agent) plus a
prompt that asks for machine-readable findings:

```
FINDING|severity|file:line|category|description
```

Three example prompts ship in `recipes/`: a daily diff review, a migration audit and a
dependency review with changelog links. Which recipes exist, where they run and where
they report is deployment-specific, so it lives in `recipes/recipes.json` — copy
`recipes/recipes.example.json` and edit it. `RECIPES_CONFIG` overrides the path.

```bash
node dist/recipe-run.js daily-diff-review              # as the timer runs it
node dist/recipe-run.js daily-diff-review --from HEAD~20   # probe: never delivers, never saves state
```

- A finding is fingerprinted by file, category and description with digits masked, so
  the same issue is reported once and not again on every run.
- A finding naming a file that does not exist is dropped, which is what an agent
  copying the prompt's own examples produces.
- A recipe with no `deliver` target runs in shadow mode: findings go to a file and
  nothing reaches Telegram. Run a week that way before turning delivery on.
- Delivered findings carry two buttons: open a fix thread (a ticket, with the finding
  as its prompt) or mute the fingerprint for good.

Schedule them with a systemd timer:

```ini
# /etc/systemd/system/telecodex-recipe@.service
[Service]
Type=oneshot
WorkingDirectory=/opt/telecodex
EnvironmentFile=/opt/telecodex/.env
ExecStart=/usr/bin/node /opt/telecodex/dist/recipe-run.js %i
```

### Turn delivery

- **Every turn gets an outbox.** Files the agent produces are delivered as documents
  whether or not the turn started with an upload. Read-only contexts are excluded,
  since they cannot write one.
- **A long answer is sent as a `.md` document** with its opening as the caption:
  Telegram renders attached Markdown in place, which beats an answer chopped into
  four messages. If the upload fails the answer still goes out as plain chunks.

### Blocking hooks

A Codex hook can stop a turn — `UserPromptSubmit` hooks that guard against editing a
thread that changed elsewhere, for instance. The app-server reports such a turn as
`status: "completed"` with nothing in it, so it used to arrive as a cheerful `Done`.

TeleCodex now reads `hook/completed`, and on `status: "blocked"` reports what the hook
said instead. It then tries to recover once:

1. `thread/archive` + `thread/unarchive` — this is what actually evicts a thread from
   the daemon. `thread/unsubscribe` does not: a thread stays loaded after its last
   subscriber leaves, and a resume then rejoins the copy already in memory.
2. `thread/resume`, which now reads the rollout from disk.
3. `THREAD_REOPEN_COMMAND` (optional) is run as `<command> <threadId>`, telling the
   sync tool that the thread really was re-read.
4. The prompt is retried exactly once. If it is blocked again, the reason is shown.

With no `THREAD_REOPEN_COMMAND` configured, nothing is retried and the block is simply
reported.

## Project Layout

```
TeleCodex/
├── src/
│   ├── index.ts           — startup, signal handling, polling loop
│   ├── bot.ts             — Telegram bot, all commands and handlers
│   ├── bot-ui.ts          — pure render helpers (/help, /start, session labels)
│   ├── codex-launch.ts    — launch profile parsing, validation, and formatting
│   ├── codex-session.ts   — CodexSessionService wrapping the SDK
│   ├── codex-state.ts     — SQLite reader for thread/model discovery
│   ├── codex-auth.ts      — Codex CLI auth (login status, device auth, logout)
│   ├── session-registry.ts — per-context session map with persistence
│   ├── context-key.ts     — Telegram chat/topic → context key derivation
│   ├── attachments.ts     — file staging (sanitization, size limits)
│   ├── artifacts.ts       — generated file collection and Telegram delivery
│   ├── error-messages.ts  — SDK/network error → user-friendly translation
│   ├── voice.ts           — voice transcription (parakeet / Whisper)
│   ├── config.ts          — environment loading and validation
│   ├── format.ts          — Markdown → Telegram HTML conversion
│   ├── projects.ts        — thread grouping and topic links for /projects
│   ├── inbox.ts           — ticket store: inboxes, tickets, dedup by issue key
│   ├── gitlab.ts          — GitLab API client, review prompts, done comments
│   ├── recipes.ts         — finding parsing, fingerprints, triage, rendering
│   ├── recipe-config.ts   — recipes.json parsing and validation
│   ├── recipe-run.ts      — scheduled runner (prepare, run agent, deliver)
│   ├── recipe-store.ts    — pending runs and muted fingerprints
│   ├── deps.ts            — go.mod / composer manifests and version comparison
│   ├── markdown-document.ts — long answers as .md with a lead-in caption
│   ├── thread-reopen.ts   — the command that says a thread was re-read
│   ├── topic-sync.ts      — forum topic reconciliation
│   └── thread-links.ts    — thread id detection and copy buttons
├── recipes/               — review prompts and recipes.example.json
├── test/                  — 33 test files, 430+ tests (vitest)
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── tsconfig.json
└── vitest.config.ts
```

## Docker

```bash
docker compose up --build
```

The compose file:
- loads environment from `.env`
- mounts `~/.codex` for auth state and persisted threads
- mounts `./workspace` as `/workspace`
- runs as a non-root user

## Development

```bash
npm run dev      # run with tsx (no build step)
npm run build    # compile TypeScript
npm test         # run vitest
```

## Release Automation

TeleCodex does not yet use the TelePi npm release pipeline, but the exact Trusted Publishing process has been documented so it can be adopted here.

See:
- `docs/npm-trusted-publishing.md`

That playbook covers:
- making the package publishable on npm
- adding a tag-driven GitHub Actions workflow
- configuring npm Trusted Publishing
- the maintainer release flow (`npm version ...` + `git push --follow-tags`)

## Security Notes

- Only users in `TELEGRAM_ALLOWED_USER_IDS` can interact with the bot
- Default sandbox mode is `workspace-write` — Codex can read and write within the working directory
- Use `danger-full-access` only if you fully trust the user and the host environment
- The built-in `Full Access` profile and any extra `danger-full-access` launch profiles are opt-in via `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- Default approval policy is `never` - suited for headless use; the sandbox still blocks actions outside its boundary
- `/launch_profiles` only selects from validated configured profiles; Telegram users cannot submit arbitrary sandbox or approval values
- `CODEX_API_KEY` (agent auth) and `OPENAI_API_KEY` (voice transcription) are separate credentials
- `/login` and `/logout` are disabled by default; set `ENABLE_TELEGRAM_LOGIN=true` to enable them
- Files uploaded via Telegram are sanitized (name, size, type) before staging in the workspace
- All Markdown output is sanitized before being sent as Telegram HTML
