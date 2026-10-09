# Cancellation and permissions: Antigravity shim vs Devin Local

Two reported differences, measured against `devin acp` 3000.10.48 (`fcf7ba39`)
and reviewed against the current shim at `bin/antigravity-acp.py` (689 lines,
`--version` 0.2.0).

Method: driven JSON-RPC over stdio with a synthetic client that answers
`fs/*` and permission requests. Account data is not reproduced.

## Summary

| Behaviour | Devin Local | Current shim | Severity |
| --- | --- | --- | --- |
| Cancel with turn in flight | `stopReason: "cancelled"` + 2 notifications | forwards `session/cancel`, no normalisation | **cause of the "cancelled by the client" text** |
| Cancel with no turn in flight | silent, but emits `agent_stopped` anyway | forwarded verbatim | minor, spurious stop signal |
| Permission prompt option set | 5 options incl. `switch_bypass` | pass-through | needs mapping check |
| Reject outcome | `failed` + `"User rejected this tool call"` | n/a | verify Antigravity wording |
| Mode ids | 5 ids incl. `ask`, `plan` | n/a | passthrough |

Neither reported symptom is caused by the shim inventing text. Both come from
missing normalisation on frames it currently passes through untouched.

---

## 1. Cancellation

### 1a. What Devin Local emits

Cancelling a turn 6 s in, mid-stream:

```
_cognition.ai/turn_stats    {sessionId, turnClientMessageId, turnRequestId}
_cognition.ai/agent_stopped {cause: "cancelled", stats: {...}, sessionId}
id=3 result {"stopReason": "cancelled", "usage": {...},
             "_meta": {"cognition.ai/userMessageId": "<uuid>"}}
```

Three things, in that order. Full payloads:

```json
{ "cause": "cancelled",
  "stats": { "toolCalls": 0, "filesChanged": 0, "commandsRun": 0,
             "inputTokens": 12553, "outputTokens": 458,
             "ttftMs": 1986, "tokensPerSec": 114.96, "totalTimeMs": 5970,
             "requestId": "59fad7d1-...", "modelLabel": "SWE-2 High" },
  "sessionId": "..." }
```

`agent_stopped.stats` carries real per-turn accounting (`ttftMs`,
`tokensPerSec`, `filesChanged`, `commandsRun`) and `modelLabel` as a
human-readable string (`"SWE-2 High"`), not the wire id.

`stopReason` is the string `"cancelled"`. The phrase "cancelled by the client"
appears **nowhere** in any frame — I grepped the full trace. It is a client-side
string, so Devin Desktop must special-case this reason, or Antigravity emits a
different reason string that falls through to a default message.

### 1b. Cancel with nothing in flight

Devin Local accepts an idle `session/cancel` silently, and for a **wrong**
`sessionId` it emits `_cognition.ai/agent_stopped` with `cause: "cancelled"` and
zeroed stats anyway — two of them, for two idle cancels. The server survives and
the next turn works normally.

So `agent_stopped` is not a reliable "a turn was interrupted" signal; Devin
emits it for cancels that interrupted nothing. A shim synthesising
`agent_stopped` must not treat it as evidence of a real interruption.

### 1c. Why the shim shows the wrong text

`session/cancel` has no handler anywhere in the shim. Confirmed by grep: the
only `stopReason` in the file is the literal `"end_turn"` on line 357, in the
local `/devin-shim` command reply. Cancel frames reach the client exactly as
Antigravity produced them.

Two likely causes, both in Antigravity's frames rather than the shim:

1. Antigravity returns a different `stopReason` on cancel (`"cancelled"` vs
   something else), and Devin Desktop has no mapping for it, so it falls back to
   a generic "The request was cancelled by the client."
2. Antigravity never sends a `stopReason` at all and just closes the turn, so
   Desktop synthesises the message.

To tell these apart, capture a real cancel through the shim. The debug log
already records both directions:

```sh
~/.local/bin/devin-desktop --user-data-dir=/tmp/dba-dev \
  --extensions-dir=/tmp/dba-ext --extensionDevelopmentPath="$PWD"
```

then `/devin-shim` in a session with `--debug --debug-log` set, cancel a turn,
and read `~/.local/state/devin-better-acp/antigravity-acp.jsonl`. Look for the
`a2c` frame whose `id` matches the `session/prompt` id.

### 1d. What normalisation would fix it

Three additions, all small:

1. **Normalise `stopReason` on the prompt response.** If Antigravity returns
   anything other than the ACP vocabulary (`end_turn`, `max_tokens`,
   `refusal`, `cancelled`), rewrite to `cancelled` when a cancel is in flight for
   that session, else `end_turn`.
2. **Synthesise `_cognition.ai/agent_stopped`** when a cancel is observed and the
   agent did not send one. Requires tracking the in-flight prompt id per session.
3. **Only emit it for a cancel that actually interrupted a turn.** Per 1b,
   Devin does not make this distinction, but matching that exact behaviour means
   emitting on idle cancels too. Pick deliberately: fidelity says match Devin,
   usefulness says suppress. I'd match Devin and let Desktop decide.

Devin also sends `_cognition.ai/turn_stats` with `turnClientMessageId` and
`turnRequestId`. That is only useful if Desktop is already rendering a stats
panel; otherwise skip it.

### 1e. Not implemented in the shim today

No `session/cancel` interception, no per-session in-flight prompt tracking
(`self.pending` maps id to method name only, and `session/cancel` is a
notification with no id, so it never enters that map), and no
`agent_stopped`/`turn_stats` synthesis. `self.interrupted` only tracks OS signals
to the shim process, which is unrelated to ACP cancellation.

---

## 2. Permissions

### 2a. Option sets differ by trigger

**Plan-mode accept** (after `session/set_mode` to `plan`), 3 options:

```json
[ { "optionId": "plan_accept_edits", "name": "Yes, implement plan and accept edits", "kind": "allow_once" },
  { "optionId": "plan_bypass",       "name": "Yes, implement plan and bypass permissions", "kind": "allow_once" },
  { "optionId": "reject_once",       "name": "No, plan needs changes", "kind": "reject_once" } ]
```

Note `reject_once` here means "the plan is wrong", not "this one call is
denied". Different semantics from the normal reject.

**Path-scoped edit prompt** (`ask: ["Write(**)"]` in `.devin/config.json`, write
outside the workspace), 5 options:

```json
[ { "optionId": "allow_once",    "name": "Allow",                                            "kind": "allow_once" },
  { "optionId": "allow_session", "name": "Yes, allow edits in <dir> (this session)",        "kind": "allow_always" },
  { "optionId": "allow_always",  "name": "Yes, always allow edits in <dir>",                 "kind": "allow_always" },
  { "optionId": "switch_bypass", "name": "Yes, switch to bypass mode",                       "kind": "allow_always" },
  { "optionId": "reject_once",   "name": "Reject",                                          "kind": "reject_once" } ]
```

Only `switch_bypass` has no ACP-standard equivalent; it is a Cognition extension
that changes session mode mid-prompt. `allow_session` and `allow_always` map to
ACP's `allow_always` kind but carry different persistence semantics that Devin
handles internally.

The prompt carries only `toolCall` (just `toolCallId`) and `options` — **no
tool name, no arguments, no path.** The human-readable scope ("edits in
/tmp/opencode/cancel") lives only in the option *names*. A client cannot render
the target from structured fields.

### 2b. Reject produces `failed`, not `completed`

Choosing `reject_once`:

```
tool_call_update status="failed"
  content [{type:"content", content:{type:"text",
             text:"Tool execution was rejected: User rejected this tool call"}}]
```

`stopReason` stays `end_turn`. So a rejection is a failed tool, not a failed
turn. Status values across all probes: only `in_progress`, `completed`, `failed`.

### 2c. Repeats on re-ask

An idle-outside-workspace write produced **6** identical `session/request_permission`
calls for the same `toolCallId` when I always chose the first option, and **9**
when I always rejected. The agent re-prompts rather than giving up. A client must
tolerate repeated prompts for one `toolCallId` and must not treat the second as a
duplicate to suppress.

### 2d. Which writes actually prompt

With no `permissions` block, `accept-edits` mode wrote a file with **zero**
permission requests. `ask` mode refused to write at all, also with zero prompts —
it just declined. `smart` mode wrote with zero prompts.

Prompts appeared only when an explicit `ask` rule matched. So Devin's prompting
is rule-driven, not mode-driven, and the mode only changes what happens when no
rule matches. This matters for the shim: Antigravity will prompt far more often
for the same project because it has no equivalent rule engine.

### 2e. Terminals never prompt

`kind: "execute"` against a headless client failed with `"Failed to create
terminal. Please try again."` and issued **no** `session/request_permission`,
even with `ask: ["exec"]` configured. Terminal creation is host-owned; the agent
never gates it. Confirms `dist/acp/AGENTS.md` and means shell permission
behaviour is not observable without Devin Desktop.

### 2f. Shim side

The shim does not touch `session/request_permission` in either direction —
correct, since it should forward the decision. Two gaps worth noting:

- `INFERENCE_NAMES` only maps `execute`→`exec` and `search`→`grep`. Devin also
  emits `read`, `edit`, and `write` as inference tool names. Antigravity's `read`
  and `edit` kinds pass through unchanged, which happens to match, but there is
  no test pinning that.
- Nothing normalises Antigravity's option set to the 5-option Devin shape, and
  nothing synthesises `switch_bypass`. Whether Desktop renders Antigravity's
  permission prompt correctly is unverified.

---

## 3. Other gaps in the current shim

Found while reviewing, not part of either reported symptom.

### 3a. `fs/*` still unimplemented — highest impact

Devin Local delegates **all** file I/O to the client. A read emits
`fs/read_text_file` with `limit: 20001`; results come back as `"N lines"` in the
tool update while the body travels client-side. The shim passes `fs/*` straight
through to Antigravity, which executes internally and never asks the client.

If Antigravity doesn't answer, nothing works. If it does answer, the shim is
merely relaying. Either way the shim has no `fs/*` handling of its own, which
means Devin Desktop's `fs` capability declaration is doing work the shim never
implements.

### 3b. `terminal_exit` adds `signal: null`

The shim emits:

```python
ret["terminal_exit"] = {"terminal_id": tool_call_id, "exit_code": exit_code, "signal": None}
```

Devin Local never put `signal` on terminal frames, because it has no such field
in observed traffic. An unconditional `signal: null` may render as "signal: null"
in a UI that reflects unknown fields. Worth checking against Desktop's renderer.

### 3c. `exitCode` key is a guess

The shim reads `raw.get("exitCode", raw.get("exit_code"))`, hedging across
conventions. Only `terminal_output` was verified against a real `terminal_output`
capability declaration; the exit-code path is unverified because Antigravity's
`rawOutput` shape was never captured. Same for `combinedOutput` and
`formatted_output`.

### 3d. `tool_kinds` grows unbounded

`self.tool_kinds` is never pruned. A long session accumulates one entry per
`toolCallId` forever. Same for `self.titled_sessions`, which is smaller but also
unbounded. Not urgent; worth a cap.

### 3e. `agent_stopped` would need a session map

Any `agent_stopped` synthesis needs per-session state: which prompt id is in
flight, and whether a cancel arrived for it. The current `self.pending` is keyed
by JSON-RPC id and stores only the method name, so it cannot answer "is session X
cancelling turn Y". A small `dict[str, int]` mapping session id to prompt id
would be enough.

---

## 4. Recommended order

1. Capture a real cancel through the shim with `--debug` on, and read the
   `stopReason` Antigravity actually returns. Everything in 1d depends on this
   and costs one session to obtain.
2. Implement `fs/*` relaying (3a). Without it no tool parity is possible.
3. Normalise `stopReason` and synthesise `agent_stopped` (1d).
4. Verify permission option rendering in Desktop (2f), then pin `INFERENCE_NAMES`
   with a test.
5. Drop `signal: null` unless Desktop's renderer wants it (3b).
6. Bound `tool_kinds` (3d).

## 5. Verified unknowns

- Whether Devin Desktop's "cancelled by the client" is triggered by an
  unrecognised `stopReason` or by a missing response. Needs one live capture.
- What Antigravity's `rawOutput` looks like for `execute`, and whether
  `exitCode`/`combinedOutput` are the right keys.
- Whether Desktop renders Antigravity's permission options without the
  `switch_bypass` extension.
- Whether `signal: null` is visible in the UI.