# Devin Local behaviours relevant to the Antigravity shim

Reference notes for making `bin/antigravity-acp.py` behave natively inside Devin
Desktop, and for forwarding this shim to Cognition product engineering.

Every fact here comes from surfaces Devin ships to its own users, discovered by
running the installed CLIs:

| Source | How it was read |
| --- | --- |
| `devin --help` and subcommand help | Installed CLI 3000.10.48 (`fcf7ba39`) |
| `devin acp` initialize handshake | Live JSON-RPC probe, `initialize` + `initialized` |
| `devin models list`, `skills list/show/paths`, `rules list/show/paths`, `doctor --json` | Read-only CLI introspection |
| `agy --help`, `agy models`, `agy mcp add --help` | Installed Antigravity 1.3.2 |
| Bundled `docs/*.mdx` under `extensions/windsurf/devin/share/devin/` | Shipped user documentation |
| `extensions/windsurf/dist/acp/AGENTS.md` | Cognition's own internal ACP note, shipped in the extension |
| `extensions/windsurf/schemas/acp_registry.schema.json` | Published ACP registry schema |

No credentials, tokens, or org identifiers are recorded here. Where a probe
returned account data, it is described rather than copied.

## 1. The live `initialize` response

This is the highest-value artifact, because it is what the real agent sends
today rather than what the shipped doc claims. Captured from `devin acp` on
3000.10.48:

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "affogato", "title": "Devin Agent", "version": "0.0.0-dev" },
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true },
    "sessionCapabilities": {
      "list": {}, "delete": {}, "additionalDirectories": {}
    },
    "auth": {},
    "_meta": { ...12 cognition.ai keys, below... }
  },
  "authMethods": [
    { "id": "devin-browser", "name": "Log in with browser", "description": "Sign in via your browser" }
  ],
  "_meta": { "mcpConfigPath": "~/.config/devin/mcp_config.json" }
}
```

Notes that change implementation decisions:

- **Internal agent codename is `affogato`.** `agentInfo.name` is not a product
  name. Any capability or telemetry matching on it should not expect `"devin"`.
- **`version` is `0.0.0-dev` over stdio.** Do not infer a released version from
  the ACP handshake; `devin version` is the reliable source.
- **Top-level `_meta.mcpConfigPath` tells the client where the agent reads MCP
  config.** This is a first-class discovery channel, and it is the cleanest hook
  for the shim: a client can learn the config path instead of guessing.
- **`sessionCapabilities.delete` and `additionalDirectories` are advertised.**
  These gate real UI. An agent that does not implement them must not claim them.
- **`promptCapabilities.audio` is explicitly `false`** while `image` is `true`.
- **`mcpCapabilities` supports both `http` and `sse`.**

### Agent-side `cognition.ai/*` capabilities actually advertised

Only 12, and several are not in the shipped `dist/acp/AGENTS.md` list — that
file describes the *client* side and is incomplete relative to this build.

| Key | Implication for the shim |
| --- | --- |
| `cognition.ai/multiRootWorkspace` | Multiple workspace roots are live |
| `cognition.ai/sessionRename` | Session rename supported |
| `cognition.ai/sessionShare` | Session sharing supported |
| `cognition.ai/documentLifecycle` | Client sends `_cognition.ai/document/*` editor state |
| `cognition.ai/userEdits` | Client reports user-made edits |
| `cognition.ai/terminalLifecycle` | Client owns terminal lifecycle events |
| `cognition.ai/userConfig` | User config surface is negotiable |
| `cognition.ai/userShellCommand` | Client can inject shell commands |
| `cognition.ai/editableCommands` | Slash commands are user-editable |
| `cognition.ai/commandRevision` | Command set carries revisions |
| `cognition.ai/chains` | Chained multi-step workflows |
| `cognition.ai/ruleMentions` | Rules are referencable by mention |

Capabilities the shipped doc claims but this build did **not** advertise in
`_meta`: `revert`, `mcp`, `plugins`, `messageGrouping`, `subagentSupport`,
`subagentControl`, `refTagsRaw`, `groupedSessionConfigOptions`,
`windsurfConfigBridge`, `loadStats`, `browserPreview`, `fastContext`. Several of
these are client-sent-only or gated by account/feature flags, so absence in an
agent response is not evidence the feature is gone. Verify against a build with
the relevant flag on.

### Protocol sharp edges observed

- `initialized` sent as a JSON-RPC **notification** returns
  `{"code": -32601, "message": "Method not found"}`. The server exits cleanly.
  A client or bridge that treats that error as fatal will break.
- Responses may arrive **out of order** relative to requests. The response
  carrying `id: 1` arrived after the unsolicited error frame.

Both matter for any bridge that assumes strict ordering.

## 2. Slash commands advertised over ACP

The agent advertises its full command set over the protocol, so commands appear
in the host's palette with descriptions, argument hints, and categories.

| Category | Commands |
| --- | --- |
| Account | `/login [api-key]`, `/logout`, `/status` |
| Session | `/ask`, `/plan`, `/compact`, `/context`, `/fast`, `/loop <prompt>`, `/btw <prompt>`, `/session-stats` (`/stats`), `/help` |
| System | `/workspace` (`/workspaces`), `/add-dir <path>`, `/remove-dir <path>`, `/mcp`, `/bug <description>` |

Host gating: `/login` and `/logout` are hidden when the host manages
authentication. The workspace-directory commands only appear when the host asks
the agent to own the workspace roots — a host that manages its own roots never
sees them. That is the `cognition.ai/workspaceDirCommands` opt-in.

`cognition.ai/editableCommands` plus `commandRevision` mean the command set is
versioned and user-editable, so the shim's `/devin-shim` injection into
`available_commands_update` follows the right shape.

## 3. Permission model

Tool names: `read`, `edit`, `grep`, `glob`, `exec` — note `edit` and `exec`, not
`write` and `shell`.

Resolution within one config level: `deny` matches → blocked; `ask` matches →
prompt unless an equally or more specific allow also matches; `allow` matches →
run; nothing matches → prompt. A deny always wins, however specific the allow.

| Form | Matches |
| --- | --- |
| `Read(glob)` / `Write(glob)` | File access; `*` within a segment, `**` across, `~` expands |
| `Exec(prefix)` | Command prefix as a complete word — `Exec(git)` matches `git status`, not `gitk` |
| `Fetch(pattern)` | WHATWG URL Pattern; `Fetch(domain:npmjs.org)` shorthand |
| `read`, `edit`, `grep`, `glob`, `exec` | The entire tool |
| `mcp__server__tool`, `mcp__server__*`, `mcp__*` | MCP tools by specificity |

Specificity carve-out, same level only: `ask: ["exec"]` + `allow:
["Exec(git status)"]` runs `git status`. Does **not** apply across levels, and
does **not** apply to `Read`/`Write` globs — a path matching an ask rule still
prompts.

Path trap: bare `Read(**)` is cwd-relative and will not match files reached by
absolute path. Use `Read(/**)` for whole-filesystem matching.

Precedence: org/team → session grants → `.devin/config.local.json` →
`.devin/config.json` → `~/.config/devin/config.json`. Org deny/ask cannot be
overridden.

Five permission modes, and the actual flag values differ from the doc's prose:

| `--permission-mode` | Doc name | Reads | Shell/fetch | Edits |
| --- | --- | --- | --- | --- |
| `auto` (default) | Normal | auto | prompt | prompt |
| `accept-edits` | Accept Edits | auto | prompt | auto in workspace |
| `smart` | Smart | auto | auto if a fast model judges safe | auto in workspace |
| `dangerous` | Bypass | auto | auto | auto |
| `--sandbox` | Autonomous | auto | auto | still prompt |

Env: `DEVIN_PERMISSION_MODE`, `DEVIN_MODEL`, `DEVIN_SANDBOX`.

Smart mode never auto-approves package installs, mutating `git`, `rm`, `sudo`,
destructive cloud CLIs, or dotenv/keymaterial reads. Under `--sandbox` it is the
only available mode, and `edit`/`write` still prompt because they run in the CLI
process, outside the sandbox.

Three agent-modes (`/normal`, `/plan`, `/ask`) are distinct from permission
modes. Plan mode remains available under sandbox.

Workspace trust: `--respect-workspace-trust` defaults to true in every mode, and
non-interactive print mode **fails** in an untrusted directory rather than
prompting. Any automation driving `devin -p` needs
`--respect-workspace-trust false`.

## 4. Configuration files

JSON with comments. Precedence as in §3.

| File | Contents |
| --- | --- |
| `~/.config/devin/config.json` | User settings. Only level accepting `agent.model`, `theme_mode`, `sandbox`, `proxy`, `notify`, `read_config_from` |
| `.devin/config.json` | Committed project: `permissions`, `mcpServers`, `read_config_from`, `hooks` |
| `.devin/config.local.json` | Gitignored overrides |
| `~/.config/devin/mcp_config.json` | User MCP servers |
| `.devin/mcp_config.json` | Project MCP servers |

MCP servers moved to dedicated `mcp_config.json` in v3000.3; older configs keep
`mcpServers` inline and newer versions migrate on startup. Read both, dedicated
file wins.

The live user config on this machine has this shape, with account-specific
values redacted:

```json
{
  "version": 1,
  "permissions": { "allow": ["mcp__<server>__*", "Fetch(domain:*)", "Exec(ls)"] },
  "hooks": {},
  "devin": { "org_id": "<redacted>" },
  "shell": { "setup_complete": true },
  "theme_mode": "dark"
}
```

Two things a shim should notice: `version` is an integer, and there is a
`devin.org_id` block, so the schema is not limited to the documented agent and
permissions keys. Do not validate strictly against the published list.

Standalone, Devin honours only `.gitignore`. Inside Devin Desktop all four of
`.gitignore`, `.devinignore`, `.codeiumignore`, `.windsurfignore` are enforced.

## 5. Skills

`SKILL.md` with frontmatter `name`, `description`, `allowed-tools`, `triggers`,
`permissions`, `model`, `subagent` / `agent`.

- `triggers`: `user` (slash command) and `model` (agent may self-invoke), both
  default on. `triggers: [user]` forbids autonomous use.
- `allowed-tools` auto-approves those tools while the skill runs.
- Skills can run as subagents with their own context window.
- Search paths, from `devin skills paths` — note the extra `.cognition/` and
  `.agents/` locations beyond the docs:

  | Scope | Paths |
  | --- | --- |
  | Global | `~/.config/devin/skills/`, `~/.config/cognition/skills/`, `~/.agents/skills/` |
  | Project | `.devin/skills/`, `.cognition/skills/`, `.agents/skills/` |

- `devin skills show <name>` prints provider, base directory, triggers, allowed
  tools, and full content. The `devin-cli` skill is a `Builtin` provider skill
  that points the agent at the on-disk `docs/` directory with
  `allowed-tools: read, grep, glob` — a self-documenting agent.

Cognition's own guidance: prefer skills over rules, because skills load only
when relevant and rules are always resident. Keep rules small and use them to
point at skills.

## 6. Rules

`devin rules show <name>` prints path, provider, activation, and content.
`devin rules paths` lists `.windsurf/rules/*.md` (always-on) and
`.cursor/rules/*.md` (conditional) — the Devin-native paths are not what this
command reports, so it is not a complete inventory.

Recognised names, all equivalent: `AGENTS.md`, `AGENTS.local.md` (gitignored),
`AGENT.md`, `.windsurfrules`, `CLAUDE.md`. Also `.devin/rules/*.md` (one rule
per file, `trigger` frontmatter) and `.devin/global_rules.md`. `.devin/` takes
precedence over `.windsurf/`.

Frontmatter `trigger` values: `always_on`, `manual`, `model_decision`, `agent`,
`glob`. Cursor `.mdc` frontmatter uses `description` / `globs` /
`alwaysApply`.

Subdirectory rules load lazily when the agent touches that directory.

On this machine `devin rules list` reports one `always-on` rule,
`global_rules`, with `Provider: Windsurf`, resolved from
`~/.codeium/windsurf/memories/global_rules.md`. That is the user's own
conventions file surfaced through Devin, not Devin-authored content — worth
knowing before attributing rule text to Cognition.

`cognition.ai/ruleMentions` means rules are addressable by mention.

## 7. Hooks

Fired at lifecycle points, filtered by `matcher`, a regex against `tool_name`.
`PreToolUse` sees `tool_name` and `tool_input` and can block, modify, or add
context before a tool runs. Every stdin payload carries `session_id` and a
per-turn `prompt_id`, rotated on each user prompt.

## 8. Models

`devin models list` reports 54 families with context sizes and per-1M-token
pricing, plus family aliases. Resolution accepts a family slug, an alias, or a
partial name — `opus`, `swe`, `claude-opus-4.6` all work, and `--model` takes
the same fuzzy forms.

Antigravity 1.3.2 exposes 13 models with a different naming scheme:

| Pattern | Antigravity |
| --- | --- |
| `gemini-3.8-flash-{high,medium,low}` | Reasoning tier is a **suffix**, not a separate flag |
| `gemini-3.1-pro-{high,low}` | |
| `claude-sonnet-4-6`, `claude-opus-4-6-thinking` | Thinking baked into the name |
| `gpt-oss-120b-medium` | |

Devin's default is `swe-1-6-fast` per the docs; the live list shows
`swe-2-{high,medium,max}` as the current SWE-2 family. Adaptive routing is a
first-class model (`adaptive`, `$0.5/1M` input) that picks per task.

### The reasoning-tier mapping

Devin expresses effort as distinct model IDs per tier. Antigravity has both a
tier-in-suffix convention **and** a separate `--effort low|medium|high|xhigh|max`
flag. A shim mapping Devin-style tiered IDs onto Antigravity should:

- strip the tier suffix from Gemini IDs and pass the value to `--effort`
- keep `thinking` in Claude names as-is, since that is part of the ID
- not invent an `xhigh` equivalent where the provider only advertises the tiers
  that `agy models` actually lists

`agy models` is authoritative for what is available; do not hardcode the list.

## 9. Antigravity surface, for comparison

From `agy --help` on 1.3.2:

- `--mode` accepts `accept-edits` and `plan`. There is no `smart` and no
  `dangerous`. `--dangerously-skip-permissions` is the blanket equivalent.
- `--effort low|medium|high|xhigh|max` is per-session.
- `--sandbox` restricts terminal access.
- `--add-dir` is repeatable, which is the natural implementation of
  `sessionCapabilities.additionalDirectories` and `cognition.ai/multiRootWorkspace`.
- `--disable-slash-commands` disables slash-command and skill expansion in
  print mode. Per this repo's integration rules, never pass it.
- `--input-format stream-json` reads NDJSON and requires
  `--output-format stream-json`; one turn per line. This is the path for
  multi-turn scripted use.
- `--json-schema` enforces structured output, for the final result only.
- `agy mcp` supports `add/remove/list/enable/disable` but **no `login`**, so
  OAuth-authenticated MCP servers cannot be brought up the way `devin mcp login`
  allows. Worth flagging to product engineering.
- `agy plugin import` can import plugins from **gemini or claude**, not from
  Devin or Windsurf.
- `agy plugin` has `validate`, `link <mp>`, and marketplace support; Devin's
  plugin CLI has `install/list/info/update/remove`.

This is the concrete gap list for the shim: no Smart mode, no MCP OAuth, no
cross-agent plugin import, and a different model-naming convention.

## 10. Diagnostics

`devin doctor` and `devin doctor --json` are supported and cheap. On this
machine the JSON form reported one passing check (`custom subagent profiles`:
none configured). This is the intended way to read effective config without
reading credential stores, and it is a good model for what the shim's own
`--debug` should grow into.

## 11. Recommendations for the shim

1. **Read `.devin/` config rather than mimicking Devin's prose.** `--devin-config`
   merges `mcpServers` from `.devin/mcp_config*.json`, `.devin/config.json`, and
   `~/.config/devin/` into `session/new` and `session/load`. Documented public
   surface; it is what makes Antigravity as capable as Devin in the same
   project. Client-supplied servers always win on name conflicts.
2. **Prefer the agent's advertised `_meta.mcpConfigPath` when present.** It is
   authoritative over guessing `~/.config/devin/mcp_config.json`.
3. **Handle `initialized` returning `-32601`.** Do not treat it as fatal, and do
   not assume response ordering.
4. **Treat `cognition.ai/*` as mutual opt-in.** Echo back only what the shim
   actually implements, or Devin Desktop will render controls that dead-end.
5. **Declare `fs` only if you answer `fs/*`.** The client enforces it: an
   undeclared capability gets `method_not_found`.
6. **Map reasoning tier to `--effort`, not to a synthetic model ID.** Read
   `agy models` at runtime.
7. **Keep the in-band identity markers.** `agentInfo.title`, version suffix, and
   `/devin-shim` in `available_commands_update`. A user must never be misled
   about which agent is answering, especially in a shim forwarded to Cognition.
8. **Be explicit that tool names differ.** Devin's `read`/`edit`/`grep`/`glob`/
   `exec` do not map cleanly onto Antigravity's surface; document the mapping
   rather than implying 1:1.

## 12. Open questions

- Which of the 12 advertised `cognition.ai/*` keys actually change Desktop UI
  in 1.126. A `--debug` session with the real client answers this empirically;
  the shipped `dist/acp/AGENTS.md` describes the client side and is incomplete
  against this build.
- Whether Antigravity accepts injected `mcpServers` on `session/load` as well as
  `session/new`. The shim sends both; only `session/new` is verified.
- Whether `--agent-type` (`summarizer`, `review`) on `devin acp` has an
  Antigravity equivalent. This is the most promising route to closer behavioural
  parity, since those are distinct tool-restricted agents rather than prompt
  variants.
- Whether `agy` exposes a stable agent-type or subagent flag; `agy agent` lists
  agents but returned nothing on this install.