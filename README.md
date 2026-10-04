# Devin Usage

Devin Usage is a Devin Desktop status-bar extension that shows Codex subscription
allowance and Antigravity CLI allowance using the CLIs you are already signed in
to. It adds three native status-bar items — Codex, Gemini (AG), and Other (AG) —
with a one-line hover and a native, pool-focused Quick Pick for usage details.

```
Codex    Gemini (AG)    Other (AG)
```

## Requirements

- Devin Desktop (or a VS Code-compatible host) 1.90 or newer on Linux
- The `codex` CLI signed in with a ChatGPT plan (`codex login`)
- The `agy` CLI signed in (`agy`), version 1.2.16 or newer

Both CLIs are resolved from `PATH`, `~/.local/bin`, or an explicit absolute path
in settings. The extension never reads, copies, or refreshes stored credentials;
each CLI uses its own login and its own network calls.

## Installation

```sh
npm ci
npm run package
devin-desktop --install-extension devin-usage-0.3.1.vsix
```

Reload the window after installing. The three items appear on the right side of
the status bar.

## Usage

| Surface | Behaviour |
| --- | --- |
| Status bar | One labelled item per pool — `Codex`, `Gemini (AG)`, `Other (AG)` — with no percentage; the native warning/error background still tracks the most-used limit |
| Hover | One line: `5h: 6% quota used · Weekly: 17% quota used`, plus a muted line when the values are stale |
| Click | Opens a native Quick Pick focused on the clicked pool; each limit row shows its used percentage in the row text with the reset time on the muted second line. Limit rows are informational, so selecting one does nothing |
| Navigation | Back returns from the settings page to the pool, then to the all-provider overview |
| Refresh | Toolbar refresh updates just the selected provider; the all-provider overview refreshes both |
| Actions | Connection/settings controls live on a separate page so usage rows stay uncluttered |

Codex and Antigravity use the same limit-row layout. Antigravity identifies its
separate Gemini and Other Models pools; Codex shows its plan and credit metadata
under Details. A stale or partially available result is called out without
changing unknown usage values to zero.

The picker shows used allowance only — remaining percentages and balances are
not listed. Percentages are placed in the row text so the host renders them in
the normal foreground colour, with reset timing as the muted secondary line;
Quick Pick styling is otherwise controlled by Devin Desktop.

The items are real status-bar contributions with stable identifiers
(`devinUsage.codex`, `devinUsage.gemini`, `devinUsage.other`), so Devin Desktop's
own hide/show menu and the visibility settings both work. Codex uses priority 3
and the two Antigravity items share priority 2, which keeps them adjacent in
creation order instead of interleaving with other status-bar entries.

Antigravity meters two pools separately: the Gemini models and the Claude/GPT
models reachable through Antigravity. They are shown as separate items because
they are separate allowances. The Other (AG) item does not describe the
standalone Codex subscription.

## How It Works

| Provider | Read-only integration | Verified on |
| --- | --- | --- |
| Codex | Ephemeral `codex app-server --stdio`; `initialize`, `account/read`, `account/rateLimits/read` | codex-cli 0.160.0 |
| Antigravity | `agy --print /usage --output-format json --print-timeout 20s --mode plan` | agy 1.2.16 |

The Codex connection performs only those three read requests and never starts a
thread or a turn. The Antigravity invocation is a standalone slash command that
reports zero model tokens; the extension verifies that invariant and stops
polling if a future CLI version consumes tokens instead of answering.

Percentages are read as `usedPercent` (Codex) or derived from
`remaining_fraction` (Antigravity). Missing values stay missing: the extension
never invents a 0% or 100% reading.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `devinUsage.codex.enabled` | `true` | Enable the Codex provider |
| `devinUsage.codex.path` | empty | Absolute path to `codex`; empty searches `PATH` and `~/.local/bin` |
| `devinUsage.antigravity.enabled` | `true` | Enable the Antigravity provider |
| `devinUsage.antigravity.path` | empty | Absolute path to `agy` |
| `devinUsage.refreshIntervalSeconds` | `300` | Background refresh interval; `0` refreshes at startup and on request only |
| `devinUsage.statusBar.alignment` | `right` | Status-bar side |
| `devinUsage.statusBar.showCodex` | `true` | Show the Codex item |
| `devinUsage.statusBar.showGemini` | `true` | Show the Gemini (AG) item |
| `devinUsage.statusBar.showOther` | `true` | Show the Other (AG) item |

Refreshes pause while the window is unfocused, back off after transient
failures, and skip automatic polling after a sign-in, missing-CLI, or
unsupported-schema result until you retry. The extension stays local when you
edit a remote workspace.

## Commands

| Command | Purpose |
| --- | --- |
| `Devin Usage: Show Usage` | Open the details and actions menu |
| `Devin Usage: Refresh All` | Refresh both providers now |
| `Devin Usage: Retry Connection` | Retry a provider, including the CLI version check |
| `Devin Usage: Configure CLI Path` | Pick the CLI executable and store its absolute path |
| `Devin Usage: Open Settings` | Open the extension settings |
| `Devin Usage: Show Diagnostics` | Show classified provider state and recent refresh events |
| `Devin Usage: Open ChatGPT Usage Page` | Open the account usage page for Codex |

## Code Structure

| Path | Responsibility |
| --- | --- |
| `source/extension.ts` | Activation, commands, settings wiring, disposal |
| `source/controller.ts` | Single-flight refreshes, backoff, staleness, reset-boundary refresh, cancellation |
| `source/providers/codex.ts` | Codex app-server protocol and rate-limit mapping |
| `source/providers/antigravity.ts` | Antigravity usage envelope and pool mapping |
| `source/providers/specs.ts` | The verified CLI invocations and provider wiring |
| `source/cli.ts` | Bounded subprocesses, process-group termination, CLI discovery, versions |
| `source/presentation.ts` | Status text, hover markdown, Quick Pick models |
| `source/statusbar.ts` | Native status-bar items |
| `source/quickpick.ts` | Pool-focused usage, details, and management pages in one native picker |
| `source/format.ts` | Percent, duration, reset, and escaping helpers |
| `source/schedule.ts` | Backoff, reset, and staleness decisions |
| `source/configuration.ts` | Settings normalisation |
| `source/diagnostics.ts` | Redacted diagnostics output channel |
| `tests/` | Unit tests with fake CLIs and fixtures |

## Development

```sh
npm ci
npm run check          # type check
npm test               # type check + unit tests with fake CLIs
npm run package        # build and produce the VSIX
npm run package:files  # list the files that would ship
```

Unit tests never touch your real accounts: they run generated fake `codex` and
`agy` executables from a temporary directory.

`npm run test:integration` runs the extension-host checks against a VS Code
host. It is blocked on Devin Desktop 1.126, whose window configuration passes
only an `isExtensionTestHost` boolean and never the `--extensionTestsPath` value
to the renderer, so the test module is never executed. Use the Extension
Development Host or an installed VSIX for manual verification until the host
forwards the test path again.

Manual verification:

```sh
devin-desktop --user-data-dir=/tmp/devin-usage-dev --extensions-dir=/tmp/devin-usage-ext \
  --extensionDevelopmentPath="$PWD"
```

Load the extension in your own Devin Desktop and confirm the three items match
`agy`'s `/usage` panel and the Codex usage page for the same account.
