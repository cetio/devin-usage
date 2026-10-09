# Devin Local behaviours relevant to the Antigravity ACP shim

Empirical reference for making `bin/antigravity-acp.py` behave natively inside
Devin Desktop, and for forwarding that shim to Cognition product engineering.

Everything here was observed by driving the installed CLIs over their own
supported interfaces. Nothing was extracted from a hidden prompt, and no
credentials, tokens, or org identifiers are recorded.

| Source | Method |
| --- | --- |
| `devin acp` | Live JSON-RPC over stdio: `initialize`, `session/new`, `session/prompt`, `session/set_mode`, `session/set_config_option`, `session/list`, plus `_cognition.ai/*` method probes |
| `devin --help` and subcommands | `acp`, `skills`, `rules`, `mcp`, `doctor`, `sandbox`, `models list` on 3000.10.48 (`fcf7ba39`) |
| `agy --help`, `agy models`, `agy mcp add --help` | Installed Antigravity 1.3.2 |
| Bundled `docs/*.mdx` | `extensions/windsurf/devin/share/devin/docs` |
| `extensions/windsurf/dist/acp/AGENTS.md` | Cognition's internal ACP note, shipped in the extension |
| `schemas/acp_registry.schema.json` | Published ACP registry schema |

Probes were read-only against local state. They did create local session
records and one plan artifact under `~/.devin/plans/`, and they consumed a small
number of tokens on the account (`swe-2-high`, ~11k input per turn).

---

## 1. `initialize`: the capability contract

Baseline response from `devin acp` with a client that sends no
`cognition.ai/*` keys. This is the floor — 13 keys advertised unconditionally:

```json
"agentInfo":     { "name": "affogato", "title": "Devin Agent", "version": "0.0.0-dev" },
"agentCapabilities": {
  "loadSession": true,
  "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
  "mcpCapabilities": { "http": true, "sse": true },
  "sessionCapabilities": { "list": {}, "delete": {}, "additionalDirectories": {} },
  "auth": {},
  "_meta": {
    "cognition.ai/multiRootWorkspace": true,   "cognition.ai/sessionRename": true,
    "cognition.ai/sessionShare": true,         "cognition.ai/documentLifecycle": true,
    "cognition.ai/userEdits": true,            "cognition.ai/terminalLifecycle": true,
    "cognition.ai/userConfig": true,           "cognition.ai/userShellCommand": true,
    "cognition.ai/editableCommands": true,     "cognition.ai/commandRevision": true,
    "cognition.ai/chains": true,               "cognition.ai/megaplan": true,
    "cognition.ai/ruleMentions": true
  }
},
"authMethods": [ { "id": "devin-browser", "name": "Log in with browser" } ],
"_meta": { "mcpConfigPath": "~/.config/devin/mcp_config.json" }
```

Facts that change implementation:

- **`agentInfo.name` is `affogato`**, an internal codename. Matching on `"devin"`
  will miss. `title` is `"Devin Agent"`.
- **`version` is `0.0.0-dev`** over stdio. `devin version` is the only reliable
  source.
- **Top-level `_meta.mcpConfigPath` is a discovery channel.** The agent tells the
  client where it reads MCP config. This is the correct hook for the shim instead
  of hardcoding `~/.config/devin/mcp_config.json`.
- **`sessionCapabilities` advertises `delete` and `additionalDirectories`**, both
  of which gate real Desktop UI.
- **`promptCapabilities.audio` is explicitly `false`**, `image` is `true`.

### 1a. Which client capabilities actually gate what

Probed by varying a single `clientCapabilities._meta` key per run. Only three
keys changed the agent's response:

| Client sends | Agent adds |
| --- | --- |
| `cognition.ai/revert: true` | `revert: true`, `revertHistoryRewound: true` |
| `cognition.ai/mcp: true` | `mcp: true`, `mcpWorkspaceDirs: true` |
| `cognition.ai/plugins: true` | `plugins: true`, `pluginsRefresh: true` |

Confirmed **not** to gate anything at `initialize`: `subagentSupport`,
`subagentControl`, `messageGrouping`, `toolCallQuestions`, `editorContext`,
`fastContext`, `requestDiagnostics`, `terminalLifecycle`, `userConfig`. These are
either read later in the session or handled without an echoed capability.

Consequence for the shim: the whole `dist/acp/AGENTS.md` narrative about mutual
opt-in holds for exactly three features on this build. The other 13 are
unconditional. Do not withhold them.

### 1b. Method gating is real and enforced

With no `cognition.ai/mcp` declared, `_cognition.ai/mcp/listServers` returns
`-32601 Method not found`. With it declared, the same call returns the server
list. `revert/listSteps` behaved the same way. `clientCapabilities.fs` is
enforced identically: declaring `fs` off yields `-32601` for `fs/*`.

Observed agent-side errors, useful for a tolerant client:

| Call | Result when ungated |
| --- | --- |
| `_cognition.ai/plugins/list` | `-32602 Invalid params` (method exists, params did not) |
| `_cognition.ai/subagent/foreground` | `-32602 Invalid params` |
| `_cognition.ai/resource/load` | `-32601` |
| `_cognition.ai/browserPreview/opened` | `-32601` |
| `_cognition.ai/request_diagnostics` | `-32601` at `initialize`, but **called during a turn** when `requestDiagnostics` is declared |
| `initialized` as a notification | `-32601 Method not found`, server exits cleanly |

That last pair matters: `initialized` returning an error is normal, and
`_cognition.ai/request_diagnostics` is only reachable mid-turn. A bridge must not
treat either as fatal.

### 1c. Ordering

Responses arrive out of order relative to requests. In one session the
`initialized` error frame arrived before the `id: 1` response. Never assume
strict ordering.

---

## 2. `session/new`: modes, config options, commands

Response keys are exactly `sessionId`, `modes`, `configOptions`, `_meta`.
`_meta` carries `cognition.ai/isLocked` (`false` for a fresh session).

Session ids are human-readable two-word slugs: `hallowed-shaker`,
`proximal-rubidium`, `alert-success`, `purple-dragonfly`.

### 2a. Modes

```json
"modes": { "currentModeId": "accept-edits", "availableModes": [
  { "id": "accept-edits", "name": "Code" },
  { "id": "smart",        "name": "Smart" },
  { "id": "ask",          "name": "Ask" },
  { "id": "plan",         "name": "Plan" },
  { "id": "bypass",       "name": "Bypass Permissions" } ] }
```

Note the ids differ from the CLI's `--permission-mode` values (`auto`,
`accept-edits`, `smart`, `dangerous`) and that `ask` and `plan` are agent-modes,
not permission modes. Switching via `session/set_mode` with `modeId` works and
emits both `config_option_update` and `current_mode_update`.

`config_option_update` also carries a `workspace-dirs` option:

```json
{ "id": "workspace-dirs", "name": "Workspace Directories",
  "type": "select", "currentValue": "[]", "options": [] }
```

It arrives only when `cognition.ai/workspaceDirCommands` is declared. Passing
`additionalDirectories` to `session/new` did **not** populate it in this build —
it stayed `"[]"`. So directory management is not yet round-tripping, which is
worth raising with product engineering.

### 2b. Config options

Two options at `session/new`: `mode` (category `mode`) and `model` (category
`model`, description "AI model to use"). `model` carried **841 options** on this
account. `summarizer` agent type omits `model` entirely and offers only `mode`,
which is the clearest signal that the agent type is a real tool-restricted
configuration rather than a prompt variant.

`session/set_config_option` requires **`configId`**, not `optionId`:

```json
{ "sessionId": "...", "configId": "model", "value": "swe-2-medium" }
```

Sending `optionId` fails with `-32602` and a `data.error` of
`missing field 'configId'`. On success it returns the full refreshed
`configOptions` array. This is an easy thing to get wrong.

### 2c. Model identifier vocabulary

The 841 options across 42 families, with these shapes:

| Shape | Examples |
| --- | --- |
| SWE family | `swe-2-high`, `swe-2-medium`, `swe-2-max`, `swe-1-7-lightning`, `swe-1-6-fast` |
| Router | `adaptive` |
| Fusion pair | `fusion-claude-opus-5-5-high-sidekick-swe-2-medium` — frontier model plus a cheaper "sidekick" |
| Inkling (image-incapable) | `inkling-none`, `inkling-low`, `inkling-medium`, `inkling-high`, `inkling-xhigh`, `inkling-max` |
| Legacy uppercase | `MODEL_GPT_5_2_HIGH`, `MODEL_PRIVATE_11`, `MODEL_CHAT_GPT_4_1_2025_04_14` |
| Tier tokens | `none` (18), `minimal` (2), `low` (160), `medium` (283), `high` (267), `xhigh` (27), `max` (50), plus `-fast` and `thinking` variants |

Every option carries `_meta.cognition.ai/supportsImages` (boolean). 576 options
carry a `description`; the rest are bare. Fusion options all describe themselves
as "Pairs frontier intelligence with cost-efficient execution".

The `MODEL_*` and `inkling-*` families are internal and should not be mapped.
Fusion has no Antigravity equivalent at all.

### 2d. Slash commands

22 commands arrive in `available_commands_update` as a `session/update` that
fires *before* the `session/new` response. Object shape is
`{name, description, input?, _meta}` with `_meta` carrying
`cognition.ai/icon` and `cognition.ai/category`.

| Category | Commands |
| --- | --- |
| Account | `login` `[api-key]`, `logout`, `status` |
| Session | `ask` `[question]`, `plan` `[prompt]`, `code` `[prompt]`, `smart` `[prompt]`, `bypass` `[prompt]`, `compact`, `context`, `fast` `[prompt]`, `loop` `<prompt>`, `recap`, `session-stats`, `rename` `<new title>`, `share`, `help` |
| System | `workspace`, `mcp`, `bug` `<description>` |
| Skills | `declarative-repo-setup` `<owner/repo>`, `upload-secrets` |

Four commands are not in the shipped docs: `code`, `smart`, `bypass`, `recap`.
`code`/`smart`/`bypass` are mode-switch commands. `available_commands_update`
also carried `_meta.cognition.ai/commandNames` and `commandRevision` in one run.

Skills appear in this list with a `Skills` category, which is how the shim's
`/devin-shim` injection should be shaped: same object, same `_meta` keys.

---

## 3. Tool calls: the wire shapes that matter

From a real read turn with a client that answered `fs/*`.

### 3a. `toolCallId` format

Two distinct shapes:

| Tool | Format | Example |
| --- | --- | --- |
| `read`, `edit`, `write` | `call_<hex>#<hex>` | `call_9f9f80a75f8b4c8ab61b1401#dbb125cfbf9c4ce6b147e661b0e5e17a` |
| `exec` | `exec:<n>#<hex>` | `exec:0#8305e859956e43baaccf1ffa9fcfade9` |

### 3b. Character-by-character title streaming

A single read produced **12** `tool_call_update` frames for one `toolCallId`,
growing the title one character at a time:

```
"Reading …" -> "Reading " -> "Reading ./" -> "Reading ./pro"
-> "Reading ./probe" -> "Reading ./probe_target" -> "Reading ./probe_target.txt"
```

with `rawInput.file_path` filling in alongside and `locations: [{path}]`
appearing at the same time. This is `cognition.ai/messageGrouping` rendering.
A client must treat `title` as transient and re-emit on every update. It is also
a genuine message-rate cost the shim should be aware of when forwarding.

### 3c. `tool_call` is emitted twice per tool

First with `title: "Reading …"`, `rawInput: ""`, no locations. Then, after the
arguments stream, a second full `tool_call` with the resolved `title: "Read file"`,
`kind: "read"`, complete `rawInput`, and `locations`. Then `tool_call_update`
with `status: "in_progress"`, then `status: "completed"` carrying content.

Statuses observed: only `in_progress`, `completed`, `failed`.

`_meta.cognition.ai/inferenceToolName` is on every tool frame and carries the
raw inference tool name — `read`, `exec`. This is the field to key permission
logic off, since `kind` is the ACP-side category and the two can differ.

### 3d. Content block shape

Tool results are wrapped, not bare:

```json
"content": [ { "type": "content", "content": { "type": "text", "text": "1 lines" } } ]
```

A double-nested `type: "content"`. Read results are summarised as `"N lines"`,
not the file body — the body went through `fs/read_text_file`, not through the
update.

Shell commands arrive pre-rendered:

```json
{ "type": "content", "content": { "type": "resource",
  "resource": { "mimeType": "text/x-shellscript", "text": "echo PERM_PROBE_7",
                "uri": "tool://preview" },
  "_meta": { "cognition.ai/preview_is_shell_command": true } } }
```

with `rawInput` carrying both `command` and a natural-language `description`
(`"Echo the PERM_PROBE_7 string"`). That description field is useful: it is
machine-generated and could seed permission prompts.

### 3e. `_meta` keys seen in tool frames

`inferenceToolName`, `preview_is_shell_command`, `streamingMessageId`,
`toolCallId` (on `fs/write_text_file` requests from the agent).

---

## 4. `fs/*` traffic

### `fs/read_text_file`

```json
{ "sessionId": "...", "path": "/tmp/...", "limit": 20001 }
```

`limit: 20001` is a fixed sentinel, not a tuned value. Exactly one request was
issued per read; the earlier apparent flood was my own probe loop re-answering,
not agent behaviour.

### `fs/write_text_file`

```json
{ "sessionId": "...", "path": "...", "content": "...",
  "_meta": { "cognition.ai/toolCallId": "call_..." } }
```

`_meta.cognition.ai/toolCallId` correlates the write back to the tool call.
Devin delegates all file I/O to the client. That is the single most important
architectural fact for the shim: **the agent has no filesystem of its own, and
the shim must answer `fs/*` or nothing works.**

---

## 5. Plan mode

`session/set_mode` with `modeId: "plan"` works and takes effect. In plan mode:

1. The agent writes a plan artifact via `fs/write_text_file` to
   `~/.devin/plans/plan-<hash>.md`, with YAML frontmatter
   (`agent: devin-local`, `session`, `created`) and a fixed section structure:
   Summary, Implementation Steps, Files to Modify, Verification,
   Risks/Considerations.
2. It then issues `session/request_permission` with mode-specific options:

```json
"options": [
  { "optionId": "plan_accept_edits", "name": "Yes, implement plan and accept edits", "kind": "allow_once" },
  { "optionId": "plan_bypass",       "name": "Yes, implement plan and bypass permissions", "kind": "allow_once" },
  { "optionId": "reject_once",       "name": "No, plan needs changes", "kind": "reject_once" } ]
```

3. On `plan_accept_edits` the agent proceeds to write the real file.

Plan mode did **not** produce a `plan` session update — the plan arrives as a
file write, not a protocol event. But `cognition.ai/megaplan` is advertised, so a
richer plan channel likely exists behind that flag.

Outside plan mode, a write with `modeId: "accept-edits"` produced **no**
`session/request_permission` at all. `accept-edits` auto-approves workspace
writes, as documented.

---

## 6. Terminals: the host owns them

`kind: "execute"` tool calls failed with `"Failed to create terminal. Please try
again."` against a headless probe client, retried three times, then the model
correctly attributed the failure to the host. Devin never called
`session/request_permission` for the shell command.

This confirms `dist/acp/AGENTS.md`: standard ACP `terminal` is deliberately
omitted, and terminal creation is host-side. **The shim cannot make `exec` work
without Devin Desktop supplying a terminal.** Antigravity's `--sandbox` and
terminal handling will differ here by construction, and no shim work changes
that.

---

## 7. Streaming and usage

| Update | Shape |
| --- | --- |
| `session_info_update` | `{title}` — fired on the first user prompt with the prompt text, then again with the final title |
| `agent_thought_chunk` | Content plus `_meta.cognition.ai/streamingMessageId` |
| `agent_message_chunk` | Same `_meta` id; token-by-token, one word per frame |
| `usage_update` | `{used, size}` plus `_meta` with `inputTokens`, `outputTokens`, `cachedReadTokens` |
| `_cognition.ai/thinking_complete` | Notification with `{durationMs, blockIndex, sessionId}` |

`streamingMessageId` is shared between a thought chunk and its message chunks,
which is how `messageGrouping` reassembles a turn. `size: 262000` is the model
context window. One `usage_update` carried `_meta.cognition.ai/subagent_context`
with `{parentAgentId: "root"}` — the subagent accounting hook.

Prompt response: `{"stopReason": "end_turn", "usage": {...}, "_meta":
{"cognition.ai/userMessageId": "<uuid>"}}`.

## 8. `session/list`

Returns `{sessions: [...]}`; 51 sessions on this account. Entry shape:
`{sessionId, title, cwd, updatedAt, _meta}` with `_meta` carrying
`cognition.ai/createdAt`, `cognition.ai/isLocked`, and
`cognition.ai/requestingTabId`. That last key is **tab-scoped session
ownership** — a UI concept leaking into the protocol.

## 9. MCP management

`_cognition.ai/mcp/listServers` (gated on `cognition.ai/mcp`) returned all 5
configured servers with per-server detail:

```json
{ "serverId": "github-mcp-server", "disabled": true, "disabledTools": [],
  "connectionStatus": "not_started", "sourcePath": ".../mcp_config.json",
  "transport": "shttp", "url": "https://api.githubcopilot.com/mcp" }
```

`transport` values: `stdio`, `shttp`. `sourcePath` per server is how the agent
reports which config file won. All servers were `disabled` on this account, which
is the state `--devin-config` merging should not try to change — the shim injects
servers into `session/new`, and the agent decides whether to start them.

The agent also pushes `_cognition.ai/mcp/serversChanged` notifications, twice at
session start.

## 10. Permissions, config, skills, rules (from the shipped surface)

Tool names are `read`, `edit`, `grep`, `glob`, `exec`. Resolution within a level:
`deny` → blocked; `ask` → prompt unless an equally or more specific `allow`
matches; `allow` → run; else prompt. A deny always wins.

Matchers: `Read(glob)` / `Write(glob)`; `Exec(prefix)` matched as a complete word
(`Exec(git)` matches `git status`, not `gitk`); `Fetch(pattern)` per WHATWG URL
Pattern with a `domain:` shorthand; bare tool names; and
`mcp__server__tool` / `mcp__server__*` / `mcp__*`.

The specificity carve-out (`ask: ["exec"]` + `allow: ["Exec(git status)]`) applies
within one level only, and does **not** apply to `Read`/`Write` globs.

Bare `Read(**)` is cwd-relative; use `Read(/**)` to match absolute paths.

Config precedence: org → session grants → `.devin/config.local.json` →
`.devin/config.json` → `~/.config/devin/config.json`. MCP servers moved to
dedicated `mcp_config.json` in v3000.3; read both, dedicated file wins.

The live user config on this machine, account fields redacted:

```json
{ "version": 1,
  "permissions": { "allow": ["mcp__<server>__*", "Fetch(domain:*)", "Exec(ls)"] },
  "hooks": {}, "devin": { "org_id": "<redacted>" },
  "shell": { "setup_complete": true }, "theme_mode": "dark" }
```

`version` is an integer and a `devin.org_id` block exists, so the schema is
wider than the documented keys. Do not validate strictly.

CLI flag values differ from the docs' prose: `--permission-mode` takes `auto`
(default), `accept-edits`, `smart`, `dangerous`; `--sandbox` selects Autonomous.
Env: `DEVIN_PERMISSION_MODE`, `DEVIN_MODEL`, `DEVIN_SANDBOX`.
`--respect-workspace-trust` defaults true and non-interactive print mode **fails**
in an untrusted directory.

Skills search `~/.config/devin/skills/`, `~/.config/cognition/skills/`,
`~/.agents/skills/` globally and `.devin/skills/`, `.cognition/skills/`,
`.agents/skills/` per project — note `.cognition/`, which the docs omit.
`devin skills show` prints provider, base dir, triggers, allowed tools, content.

Rules accept `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `.windsurfrules`,
`CLAUDE.md`, plus `.devin/rules/*.md` and `.devin/global_rules.md`. Trigger
values: `always_on`, `manual`, `model_decision`, `agent`, `glob`. On this machine
`devin rules list` shows one always-on rule from
`~/.codeium/windsurf/memories/global_rules.md` — the user's own conventions
surfaced through Devin, not Cognition-authored.

`devin doctor --json` is the supported way to read effective config without
touching credential stores.

## 11. Antigravity 1.3.2, for contrast

- `--mode` accepts only `accept-edits` and `plan`. No `smart`, no `dangerous`.
  `--dangerously-skip-permissions` is the blanket equivalent.
- `--effort low|medium|high|xhigh|max` is per-session — this is the natural target
  for Devin's tier vocabulary.
- `--sandbox` restricts terminals; `--add-dir` is repeatable.
- 13 models with tier-in-suffix naming (`gemini-3.8-flash-high`) rather than
  Devin's distinct-IDs-per-tier. Strip the suffix, pass `--effort`, and read
  `agy models` at runtime. No `xhigh` equivalent for Gemini.
- `agy mcp` has **no `login`** — OAuth MCP servers cannot be brought up the way
  `devin mcp login` allows.
- `agy plugin import` reads gemini or claude only.
- `--disable-slash-commands` must never be passed (repo integration rule).
- `--input-format stream-json` + `--output-format stream-json` for scripted turns;
  `--json-schema` for structured final output.
- `agy agent` listed nothing on this install, so no agent-type equivalent to
  `devin acp --agent-type` is confirmed.

Gap list for product engineering: no Smart mode, no MCP OAuth, no cross-agent
plugin import, different model naming, no visible agent-type selection, and no
Fusion-style pair routing.

## 12. Recommendations for the shim

1. **Answer `fs/*` or nothing works.** Devin has no filesystem of its own. This is
   the highest-priority item and the current shim does not implement it.
2. **Declare `clientCapabilities.fs` honestly.** It is enforced; an undeclared
   capability gets `-32601`.
3. **Always advertise the 13 baseline keys** the agent sends unconditionally.
   Only `revert`, `mcp`, and `plugins` are conditional, and they are conditional
   on what the *client* declared, not on the agent.
4. **Use `configId`, not `optionId`,** in `session/set_config_option`.
5. **Treat `title` as transient** and re-emit on every `tool_call_update`.
   Expect high message rates from argument streaming.
6. **Map the tier vocabulary to `--effort`.** Read `agy models` at runtime; skip
   `MODEL_*`, `inkling-*`, and Fusion families.
7. **Consume `_meta.mcpConfigPath`** rather than hardcoding the path.
8. **Keep the in-band identity markers** (`agentInfo.title`, version suffix,
   `/devin-shim`). A user must never be misled about which agent answered,
   especially in a shim forwarded to Cognition.
9. **Expect no terminal from a headless client.** `exec` will fail with "Failed to
   create terminal"; that is host behaviour, not a shim bug.
10. **Tolerate `-32601` on `initialized`**, out-of-order responses, and
    `-32602` on half-implemented `_cognition.ai/*` methods.

## 13. Still unknown

- Whether `additionalDirectories` populating `workspace-dirs` is a bug or a
  separate flow; it stayed `"[]"` here.
- What `cognition.ai/megaplan` changes about the plan channel.
- Whether `_cognition.ai/subagent/*` is reachable once params are right; the
  probe returned `-32602`, meaning the method exists behind the right capability.
- Whether `chains`, `userEdits`, and `documentLifecycle` alter turn behaviour.
  They are advertised unconditionally and did not alter `initialize`.
- Terminal creation specifics, which need Devin Desktop rather than a probe.