# Devin Usage

[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE.txt)

Devin Usage is a Devin Desktop status-bar extension that shows Codex
subscription allowance and Antigravity CLI allowance using the CLIs you are
already signed in to. It adds three native status-bar items for Codex,
Gemini (AG), and Other (AG). Each one has a one-line hover and a native Quick
Pick focused on its pool.

```
Codex    Gemini (AG)    Other (AG)
```

## Requirements

| Requirement | Notes |
| --- | --- |
| Devin Desktop | 1.90 or newer on Linux, or a VS Code-compatible host |
| `codex` | Signed in with a ChatGPT plan (`codex login`) |
| `agy` | Signed in (`agy`), version 1.2.16 or newer |

Both CLIs are resolved from `PATH`, `~/.local/bin`, or an explicit absolute path
in settings. The extension never reads, copies, or refreshes stored credentials.
Each CLI uses its own login and its own network calls.

## Installation

Build the VSIX and install it:

```sh
npm ci
npm run package
devin-desktop --install-extension bin/devin-usage-0.3.3.vsix
```

Reload the window after installing. The three items appear on the right side of
the status bar.

## Usage

| Surface | Behaviour |
| --- | --- |
| Status bar | One labelled item per pool with no percentage. The native warning or error background tracks the most-used limit. |
| Hover | One line like `5h: 6% quota used · Weekly: 17% quota used` (notes when stale.) |
| Click | Opens the native Quick Pick focused on the clicked pool. Each limit row shows its used percentage in the row text and the reset time on the muted second line. |
| Navigation | Back returns from the settings page to the pool, then to the all-provider overview. |
| Refresh | The toolbar refresh updates the selected provider. The all-provider overview refreshes both. |

Codex and Antigravity share the same limit-row layout. Antigravity meters the
Gemini models and the Claude and GPT models reachable through Antigravity as
separate pools, so Other (AG) does not describe the standalone Codex
subscription. Codex shows its plan and credit metadata under Details. A stale or
partially available result is labelled without changing unknown usage values to
zero.

The items are real status-bar contributions with stable identifiers
(`devinUsage.codex`, `devinUsage.gemini`, `devinUsage.other`), so the hide and
show menu and the visibility settings both work. The picker shows used allowance
only and does not list remaining percentages.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `devinUsage.codex.enabled` | `true` | Enable the Codex provider |
| `devinUsage.codex.path` | empty | Absolute path to `codex`. Empty searches `PATH` and `~/.local/bin`. |
| `devinUsage.antigravity.enabled` | `true` | Enable the Antigravity provider |
| `devinUsage.antigravity.path` | empty | Absolute path to `agy` |
| `devinUsage.refreshIntervalSeconds` | `300` | Background refresh interval. `0` refreshes at startup and on request only. |
| `devinUsage.statusBar.alignment` | `right` | Status-bar side |
| `devinUsage.statusBar.showCodex` | `true` | Show the Codex item |
| `devinUsage.statusBar.showGemini` | `true` | Show the Gemini (AG) item |
| `devinUsage.statusBar.showOther` | `true` | Show the Other (AG) item |

Refreshes pause while the window is unfocused and back off after transient
failures. Automatic polling stops after a sign-in, missing-CLI, or
unsupported-schema result until you retry. Monitoring is paused until the
workspace is trusted. The extension stays local when you edit a remote
workspace.

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

## How It Works

| Provider | Read-only integration | Verified on |
| --- | --- | --- |
| Codex | Ephemeral `codex app-server --stdio` with `initialize`, `account/read`, and `account/rateLimits/read` | codex-cli 0.160.0 |
| Antigravity | `agy --print /usage --output-format json --print-timeout 20s --mode plan` | agy 1.2.16 |

The Codex connection performs only those three read requests and never starts a
thread or a turn. The Antigravity invocation is a standalone slash command that
reports zero model tokens. The extension verifies that and stops polling if a
future CLI version consumes tokens instead of answering.

Percentages are read as `usedPercent` (Codex) or derived from
`remaining_fraction` (Antigravity). Missing values stay missing. The extension
never invents a 0% or 100% reading.

## Development

```sh
npm ci
npm run check          # type check
npm test               # type check + unit tests with fake CLIs
npm run package        # build and produce the VSIX
npm run package:files  # list the files that would ship
```

Source is grouped by domain under `source/`. `extension.ts` wires activation and
commands, `monitor.ts` owns refreshes, backoff, staleness, and cancellation,
`providers/` holds the Codex and Antigravity adapters, `process/` runs bounded
CLIs, `picker/` and `status/` render the Quick Pick and the status items, and
`allowance/` holds the usage model, formatting, and scheduling rules. Unit tests
mirror those folders under `tests/unit/` and never touch your real accounts.
They run generated fake `codex` and `agy` executables from a temporary
directory.

`npm run test:integration` runs the extension-host checks against a VS Code
host. It is blocked on Devin Desktop 1.126, whose window configuration passes
only an `isExtensionTestHost` boolean and never the `--extensionTestsPath` value
to the renderer, so the test module is never executed. Use the Extension
Development Host or an installed VSIX for manual verification until the host
forwards the test path again.

```sh
devin-desktop --user-data-dir=/tmp/devin-usage-dev --extensions-dir=/tmp/devin-usage-ext \
  --extensionDevelopmentPath="$PWD"
```

Load the extension in your own Devin Desktop and confirm the three items match
`agy`'s `/usage` panel and the Codex usage page for the same account.

## Antigravity ACP Patch

`bin/patch-agy-acp.py` patches the Antigravity ACP server so it assumes the
client is Zed, which allows using other models. It rewrites the packaged
`client_info` source and bytecode in place, preserves the PAR layout and file
size, and leaves a timestamped `.bak` backup beside the file.

Run the script directly to use it (at your own risk). Use the CPython version
matching the ACP's packaged bytecode, and pass the PAR path if it is not at the
default `~/.local/opt/agy-acp/current/agy_acp_server.par`.

## License

Devin Usage is licensed under [MIT](LICENSE.txt).
