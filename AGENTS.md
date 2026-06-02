# AGENTS.md — WrongStack Developer Reference

> **DO NOT DELETE THIS FILE.** It is loaded into WrongStack's system prompt as
> persistent project context. Previous content here may contain decisions,
> architecture notes, domain knowledge, or verification history that should be
> preserved. Merge additions rather than replacing.

## Project brief

WrongStack is a terminal AI coding agent built in TypeScript. It runs an LLM that reads code, edits files, runs shell commands, and reasons through bugs — with explicit permission prompts before every mutating or destructive tool call. The project is a monorepo of 10+ packages.

**Runtime:** CLI (REPL), optional TUI (React/Ink), optional WebUI (Vite/React)
**Primary users:** Individual developers, teams
**Entry point:** `apps/wrongstack/src/main.ts` → `packages/cli/src/index.ts`

## Package map

```
packages/core/        — Kernel: Container, Pipeline, EventBus, RunController, Context
packages/providers/  — Anthropic, OpenAI, Google, OpenAI-compatible, Kiro adapters
packages/tools/      — Builtin tools: read, write, bash, exec, git, grep, glob, ...
packages/mcp/         — MCP client + registry + stdio/SSE/streamable-http transports
packages/plug-lsp/   — LSP bridge (slash commands: /lsp:start, /lsp:diag, /lsp:goto)
packages/cli/        — REPL, subcommands, slash commands, plugin management
packages/tui/        — React/Ink terminal UI (lazy-loaded behind --tui)
packages/runtime/    — Default runtime wiring: makeDefaultRuntime()
packages/telegram/   — Telegram bridge plugin
packages/webui/      — Vite+React web UI served by the CLI
apps/wrongstack/     — bin entry (wrongstack / wstack)
```

**Dependency direction:** `core` → nothing WrongStack-internal. `providers/tools/mcp/plug-lsp/runtime/telegram` → `core`. `cli/tui` → everything beneath. Never reverse these layers.

## Key architectural concepts

### Kernel (≤600 lines total)

`packages/core/src/kernel/` has four primitives:

**Container** — Typed DI indexed by `Token<T>` (branded symbol). Bindings: `factory`, `value`, `decorator`. Resolution is lazy and memoized. Well-known tokens in `tokens.ts`:

```
TOKENS.Logger · TOKENS.TokenCounter · TOKENS.SessionStore · TOKENS.MemoryStore
TOKENS.PermissionPolicy · TOKENS.Compactor · TOKENS.PathResolver · TOKENS.ConfigLoader
TOKENS.Renderer · TOKENS.InputReader · TOKENS.ErrorHandler · TOKENS.RetryPolicy
TOKENS.SkillLoader · TOKENS.SystemPromptBuilder · TOKENS.SecretScrubber
TOKENS.ModelsRegistry · TOKENS.ModeStore
```

Plugins rebind any token before `Agent.run`. No service-locator pattern — every dependency is explicit.

**Pipeline<T>** — Linear middleware chain. Six pipelines fire per agent step:

| Pipeline | Fires |
|---|---|
| `userInput` | Every user turn |
| `request` | Before each provider call |
| `response` | After each provider call |
| `assistantOutput` | Per assistant text block |
| `toolCall` | After every tool call |
| `contextWindow` | Before sending if context might be too large |

Middleware shape:
```ts
const mw: Middleware<Request> = {
  name: 'my-mw',
  owner: 'my-plugin',
  handler: async (req, next) => { /* before */ const out = await next(req); /* after */ return out; },
};
```

**EventBus** — Typed pub/sub. Key events: `iteration.started/completed`, `provider.text_delta/response/retry/error`, `tool.started/progress/executed/confirm_needed`, `compaction.fired/failed`, `mcp.server.connected/reconnected/disconnected`, `subagent.started/stopped`, `task.assigned/completed/done`. Full list in `packages/core/src/kernel/events.ts`.

**RunController** — One per `Agent.run`. Owns `AbortController`, chains parent signal, drains abort hooks LIFO on dispose.

### Context and ConversationState

`Context` is the live agent-run object: messages, todos, system prompt, session writer, tools, provider, signal, cwd, model, meta.

After L1-A, `Context` implements `RunEnv` (read-only env interface). `ctx.state: ConversationState` is an observable wrapper over mutable fields. `ctx.state.appendMessage(m)` and `ctx.state.replaceMessages(ms)` fire `onChange` events. Direct mutation still works for backward compat but subscribers won't see those changes.

### Agent lifecycle

```
user input → Agent.run
  ↓ normalizeAndEmitUserInput (userInput pipeline + ctx.state.appendMessage)
  ↓ for each iteration:
      checkIterationLimit
      build request → request pipeline
      runProviderWithRetry → provider text_delta / response pipeline
      if text only → done
      else tool_use blocks:
          ToolExecutor.executeBatch
            permission check
            tool.execute → toolCall pipeline → ctx.state.append
      compactContextIfNeeded → contextWindow pipeline
  ↓ RunResult
```

### Tools streaming contract

```ts
interface Tool<I, O> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permission: 'auto' | 'confirm' | 'deny';
  mutating: boolean;
  execute(input, ctx, opts): Promise<O>;
  executeStream?(input, ctx, opts): AsyncIterable<ToolStreamEvent<O>>; // preferred when available
  cleanup?(input, ctx): Promise<void>;
}
```

`executeStream` yields `log`, `partial_output`, `metric`, `file_changed`, `warning` events, then terminal `{ type: 'final', output }`. The executor publishes each as `tool.progress` on the EventBus. Tool execution strategies: `parallel` (all at once), `sequential`, or `smart` (auto, defaults to parallel for independent tools).

### Multi-agent

`DefaultMultiAgentCoordinator` manages a fleet with:
- Task queue with `maxConcurrent` (default 4) in-flight limit
- Per-subagent `SubagentBudget`: maxIterations, maxToolCalls, maxTokens, maxCostUsd, timeoutMs
- `AgentBridge` for bidirectional parent↔subagent messaging
- `BudgetExceededError` → `timeout` or `stopped` result status
- Subagent signal lifecycle: `AbortController` recycled between tasks

For director-driven evolution, see `docs/director-architecture.md`.

### Collab Debug Session

A **CollabSession** (triggered by `/collab <paths>` or `collab_debug` tool) runs a three-agent parallel pipeline: `bug-hunter` → `refactor-planner` → `critic`. Each agent emits structured events via `fleet_emit` tool, which the Director routes to the `FleetBus`. Downstream agents consume events in real time (not just at task completion).

**Event types:**
| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `bug.found` | BugHunter | RefactorPlanner, Critic |
| `refactor.plan` | RefactorPlanner | Critic |
| `critic.evaluation` | Critic | Director (aggregated into final report) |

**Key rules:**
- Agents use `fleet_emit` tool for real-time event emission, NOT scratchpad JSON parsing
- BugHunter emits `bug.found` per-finding as soon as each is found (no batching)
- RefactorPlanner reads the BugHunter report from scratchpad, emits `refactor.plan` per bug
- Critic reads both reports, emits `critic.evaluation` per subject
- FleetMonitor (Ctrl+F) and FleetPanel show real-time agent status + event counts
- Timeline in FleetMonitor shows last 20 events across all agents

**Code references:**
- `packages/core/src/coordination/collab-debug.ts` — `CollabSession` class
- `packages/core/src/coordination/fleet-bus.ts` — `FleetBus` event routing
- `packages/tui/src/components/fleet-monitor.tsx` — Ctrl+F dashboard
- `packages/tui/src/components/fleet-panel.tsx` — status bar compact view

### TUI Fleet Commands

| Key / Command | Effect |
|---|---|
| `Ctrl+F` | Toggle full fleet monitor dashboard |
| `Ctrl+G` | Toggle agents monitor (per-agent live view) |
| `/fleet status` | Pending + completed task table per subagent |
| `/fleet dispatch <task>` | Route task to best agent (heuristic + LLM) and spawn |
| `/fleet log <id>` | Compact JSONL transcript summary for subagent |
| `/fleet usage` | Per-agent iterations, tool calls, cost rollup |
| `/fleet spawn <role> [n]` | Spawn N agents of given role |
| `/fleet stream on\|off` | Show/hide subagent activity in leader history |

### MCP integration

`MCPClient` speaks JSON-RPC 2.0 over three transports: `stdio` (child process), `sse` (server-sent events), `streamable-http` (NDJSON). `MCPRegistry` manages the fleet with exponential backoff + jitter on reconnect (cap 5 cycles, then `failed`). Tools get namespace prefix `mcp__<serverName>__<toolName>`.

### Compactors

Three strategies compose in `HybridCompactor`:

| Compactor | Strategy |
|---|---|
| `SelectiveCompactor` | Preserves task-critical messages, elides the rest |
| `IntelligentCompactor` | LLM-assisted summarization of ancient turns |
| `LLMSelector` | Picks best model for context reduction decisions |

`AutoCompactionMiddleware` wraps the `contextWindow` pipeline and fires automatically when token thresholds are crossed. `repairToolUseAdjacency()` removes orphan `tool_use`/`tool_result` blocks after context surgery or compaction.

Context modes: `balanced` (default), `frugal` (compacts early), `deep` (delays compaction), `archival` (keeps summaries prominent).

### Plugins

Declare `capabilities: { tools, providers, slashCommands, mcp, pipelines }` and receive a scoped `api`:

```ts
export default {
  name: 'my-plugin',
  apiVersion: '^0.1.0',
  capabilities: { tools: true },
  async setup(api) { api.tools.register(myTool); },
  async teardown() { /* close handles */ },
};
```

The loader runs `teardown()` on SIGINT and natural exit. See `docs/plugin-author-guide.md`.

## Session storage

All persistent per-project state (including sessions) lives under the user home:

```
~/.wrongstack/projects/<sha256(absProjectRoot).slice(0,12)>/sessions/<id>.jsonl
```

Each line is a `SessionEvent`. See `packages/core/src/types/session.ts` for the full
union and two-tier audit model (`session.auditLevel`).

Key events that are **always** written (Core Reconstruct Set):
- `user_input`, `llm_response`, `tool_result`
- `checkpoint`, `in_flight_start`/`in_flight_end`, `session_*`

Many richer audit events (`compaction`, `tool_call_*`, provider retries, etc.)
are controlled by `Config.session.auditLevel` (default: "standard").

`DefaultSessionStore.list()` reads a side-car `<id>.summary.json` for fast listing.
`DefaultSessionReader` provides query/replay/search/export.

**Source of truth for paths:** `resolveWstackPaths()` in `packages/core/src/utils/wstack-paths.ts`.

The **only** things that live inside the project tree itself are the committed
`.wrongstack/AGENTS.md` and `.wrongstack/skills/`. Everything else is in
`~/.wrongstack/projects/<hash>/`.

## Observability

Three pillars, all behind noop-default interfaces:

| Pillar | Interface | Default | Opt-in |
|---|---|---|---|
| Metrics | `MetricsSink` | `NoopMetricsSink` | `--metrics` |
| Traces | `Tracer` | `NoopTracer` | bind real `OTelTracer` |
| Health | `HealthRegistry` | `DefaultHealthRegistry` | `--metrics` |

Prometheus endpoint: `--metrics-port 9090`. OTLP exporters available.

## Commands

| Command | Script |
|---------|--------|
| Build | `pnpm run build` |
| Test | `pnpm test` |
| Typecheck | `pnpm run typecheck` |
| Lint | `pnpm run lint` |
| Dev | `pnpm run dev` |

## Key files and entry points

| File | Role |
|---|---|
| `apps/wrongstack/src/main.ts` | Binary entry point |
| `packages/cli/src/index.ts` | CLI boot: parse argv → wire container → run REPL/TUI |
| `packages/cli/src/repl.ts` | REPL implementation, slash command dispatch |
| `packages/cli/src/slash-commands/index.ts` | All builtin slash commands registered here |
| `packages/cli/src/slash-commands/helpers.ts` | Shared helpers: `detectProjectFacts`, `renderAgentsTemplate`, `countTurnPairs`, etc. |
| `packages/core/src/kernel/container.ts` | DI container |
| `packages/core/src/kernel/pipeline.ts` | Middleware pipeline |
| `packages/core/src/kernel/event-bus.ts` | Typed pub/sub |
| `packages/core/src/kernel/run-controller.ts` | Abort signal and cleanup management |
| `packages/core/src/agent.ts` | `Agent.run` — the main loop |
| `packages/core/src/execution/tool-executor.ts` | Tool batch execution |
| `packages/core/src/execution/intelligent-compactor.ts` | LLM-assisted compaction + repair |
| `packages/core/src/coordination/multi-agent-coordinator.ts` | Subagent fleet coordinator |
| `packages/tools/src/builtin.ts` | All builtin tools |
| `packages/mcp/src/client.ts` | MCP client + transport layer |
| `packages/core/src/storage/session-store.ts` | Session persistence |
| `packages/core/src/storage/memory-store.ts` | Memory persistence |
| `packages/core/src/storage/plan-store.ts` | Plan persistence |

## Slash commands

All slash commands live in `packages/cli/src/slash-commands/`. Each is a `buildXxxCommand(opts: SlashCommandContext): SlashCommand` that returns an object with `name`, `description`, optional `aliases`, optional `help`, and an `async run(args, ctx)` method.

Key `SlashCommandContext` fields wired in `packages/cli/src/index.ts`:
```
registry · toolRegistry · context · cwd · projectRoot · renderer
memoryStore · sessionStore · skillLoader · modeStore · compactor
tokenCounter · llmProvider · llmModel · planPath
onSpawn · onAgents · onDirector · onFleet · onFleetRetry · onFleetLog
onYolo · onAutonomy · onEternalStart · onEternalStop · onPlugin
statuslineConfig · statuslineHiddenItems · metricsSink · healthRegistry
```

Slash commands are documented in `docs/slash/`. When adding a new one:
1. Create `packages/cli/src/slash-commands/<name>.ts`
2. Export `buildXxxCommand(opts: SlashCommandContext): SlashCommand`
3. Import and add to `buildBuiltinSlashCommands()` in `index.ts`
4. Add tests: `packages/cli/tests/slash-<name>.test.ts`
5. Add docs: `docs/slash/<name>.md`

## Skill system

Skills are `SKILL.md` files loaded by `DefaultSkillLoader` from three scopes (first-seen wins by name):

| Priority | Location |
|---|---|
| 1 | `<project>/.wrongstack/skills/` |
| 2 | `~/.wrongstack/skills/` |
| 3 | `packages/core/skills/` (bundled) |

Format:
```markdown
---
name: my-skill
description: |
  Use this skill when <trigger condition>.
  Triggers: user says "X", "Y".
version: 1.0.0
---

# My Skill

## Overview
One-line description of what this skill does.

## Rules
1. Rule one
2. Rule two

## Patterns
### Do
```ts
// good example
```

### Don't
```ts
// bad example
```

## Skills in scope
- `other-skill` — for delegation when this skill needs help
```

Bundled skills: `api-design`, `audit-log`, `bug-hunter`, `docker-deploy`, `git-flow`, `multi-agent`, `node-modern`, `observability`, `prompt-engineering`, `react-modern`, `refactor-planner`, `sdd`, `security-scanner`, `skill-creator`, `testing`, `typescript-strict`.

See `docs/skills.md` for the full authoring guide.

## Domain knowledge

- **IDs are ULIDs** not UUIDs — see `ulid.ts` in core
- **Token brandings** — `Token<T>` is a branded `symbol` for type-safe DI, not a string
- **Pipeline middleware** can `replace` a step — the last `replace` in the chain wins (position-aware)
- **Compactor runs after every iteration** via the `contextWindow` pipeline, not explicitly in the agent loop
- **MCP reconnect** uses exponential backoff with jitter, capped at 5 cycles, then the server transitions to `failed`
- **`tool.executed` events** are truncated before writing to the session log to avoid flooding — truncation threshold is configurable
- **Secret encryption** — API keys in `~/.wrongstack/config.json` are encrypted with a per-machine key derived from `~/.wrongstack/.key` using `DefaultSecretVault`
- **`runText` in slash command results** — when a slash command returns `{ runText: "..." }`, the REPL injects that text as the next user turn (used by `/goal`, `/sdd`, `/autonomy` for steering)
- **Kiro provider** (`packages/providers/src/kiro/`) — speaks the AWS CodeWhisperer / Amazon Q `GenerateAssistantResponse` wire format. It is NOT in the models.dev catalog, so it is registered as a static `kiro` factory in `buildProviderFactoriesFromRegistry` and intercepted in `makeProviderFromConfig`. The bearer access token from a Kiro login is passed through as `apiKey` (or `KIRO_ACCESS_TOKEN`). The streaming body is the binary Event Stream protocol (not SSE) — parsed by `kiro/event-parser.ts`. Model ids use dashes for versions (`claude-opus-4-6`) and are converted to dots (`claude-opus-4.6`) for the API. Select it via config `provider: "kiro"` + `providers.kiro = { type: "kiro", apiKey: "<bearer>" }`.

## Verification checklist

- Run `pnpm run typecheck` before any PR
- Run `pnpm test` — 3091+ tests should all pass
- New slash commands need tests in `packages/cli/tests/slash-<name>.test.ts`
- New tools need tests in the corresponding package
- If adding a new kernel token, update `tokens.ts` and document in this file
- If adding a new EventBus event type, add it to `events.ts` with doc comment

## Useful pointers

- **Architecture decisions:** `docs/adr/` — architectural decision records
- **Plugin authoring:** `docs/plugin-author-guide.md`
- **Provider authoring:** `docs/provider-author-guide.md`
- **Tool authoring:** `docs/tool-author-guide.md`
- **Skill authoring:** `docs/skills.md`
- **Troubleshooting:** `docs/troubleshooting.md`
- **Slash command docs:** `docs/slash/README.md`
- **Changelog:** `CHANGELOG.md`
- **Configuration:** `docs/configuration.md`