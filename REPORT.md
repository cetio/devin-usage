# Devin Better ACP — Codebase Research Report

**Repository:** `devin-better-acp`  
**Version:** `0.3.3`  
**Target Environment:** Devin Desktop (VS Code-compatible host, version >= 1.90 on Linux)  
**License:** MIT  

---

## 1. Executive Summary

**Devin Better ACP** is a dual-purpose developer tooling project tailored for Devin Desktop / VS Code hosts:

1. **Usage & Allowance Status Bar Extension (`source/`):**  
   A lightweight, privacy-focused TypeScript extension that monitors subscription allowances and quota pools for **OpenAI Codex** and **Google Antigravity (`agy`)**. It reads usage statistics through existing CLI sign-ins without ever accessing, copying, or refreshing stored credentials.
2. **ACP Bridge & Integration Utilities (`bin/`):**  
   - `bin/antigravity-acp.py`: A standalone Python 3.10+ ACP (Agent Client Protocol) proxy/bridge that connects Devin Desktop with Antigravity ACP servers, spoofing client identities (e.g. Zed), merging Devin MCP configs, and mapping Antigravity tool output into Devin-compatible terminal frames.
   - `bin/patch-agy-acp.py`: A binary / bytecode patching utility for Antigravity's self-contained Python PAR archive (`agy_acp_server.par`) that adjusts client identification in-place while strictly preserving PAR zip layout and byte sizes.

---

## 2. Architecture & Component Overview

```
devin-better-acp/
├── source/                          # TypeScript Extension Source
│   ├── allowance/                   # Quota models, calculations, time formatting
│   │   ├── model.ts                 # Domain interfaces (UsagePool, UsageWindow, ProviderStatus)
│   │   ├── format.ts                # Time formatting, percent calculations, tone mapping
│   │   └── schedule.ts              # Reset scheduling, backoff calculation, staleness
│   ├── process/                     # Process management & CLI execution
│   │   ├── discovery.ts             # Safe executable discovery in PATH / ~/.local/bin
│   │   ├── runner.ts                # Child process management, process groups, timeouts
│   │   └── version.ts               # SemVer parsing and comparison
│   ├── providers/                   # Allowance data providers
│   │   ├── adapter.ts               # Common provider interfaces & error classification
│   │   ├── antigravity.ts           # Antigravity CLI (/usage JSON) adapter
│   │   ├── codex.ts                 # Codex app-server JSON-RPC adapter
│   │   ├── envelope.ts              # Type validation & safe JSON unpacking helpers
│   │   └── registry.ts              # Provider specifications & registry
│   ├── picker/                      # Quick Pick menus & interactive UI
│   │   ├── model.ts                 # Quick Pick row structure & navigation states
│   │   └── view.ts                  # Interactive VS Code Quick Pick UI
│   ├── status/                      # VS Code Status Bar representation
│   │   ├── display.ts               # Status tone & display text derivation
│   │   └── items.ts                 # Status bar item management
│   ├── diagnostics.ts               # Diagnostics logging and display modal
│   ├── extension.ts                 # Extension entry point, lifecycle, subscriptions
│   ├── monitor.ts                   # UsageController background polling loop
│   └── settings.ts                  # Settings normalization & schema parsing
├── bin/                             # Auxiliary Scripts and Bridges
│   ├── antigravity-acp.py           # Full-featured ACP shim / proxy between Devin and Antigravity
│   └── patch-agy-acp.py             # Bytecode & PAR patcher for Antigravity ACP server
├── docs/                            # Internal architectural notes & behavior specs
├── tests/                           # Comprehensive test suite
│   ├── unit/                        # Node.js built-in test runner unit tests
│   │   └── acp/                     # Python unittest suite for antigravity-acp.py
│   └── integration/                 # Host & ACP integration test scripts
└── package.json                     # Extension manifest, commands, settings, scripts
```

---

## 3. Core Subsystems

### A. Provider Integrations & Allowance Monitoring

The extension connects to two main AI assistants/providers in read-only mode:

1. **OpenAI Codex (`source/providers/codex.ts`):**
   - Launches an ephemeral `codex app-server --stdio` process.
   - Issues JSON-RPC handshake (`initialize`, `initialized`), reads account info (`account/read`), and rate limit windows (`account/rateLimits/read`).
   - Strictly read-only: never starts turns, threads, logins, or consume credits.
2. **Google Antigravity (`source/providers/antigravity.ts`):**
   - Invokes `agy --print /usage --output-format json --print-timeout 20s --mode plan`.
   - Separately categorizes Gemini models and Other Models (Claude/GPT) pools.
   - Enforces a zero-token check: fails if `/usage` reports any model token consumption.

### B. Usage Controller & Lifecycle (`source/monitor.ts`)

- **Focus Awareness:** Pauses automatic polling when the VS Code window loses focus to avoid unnecessary process spawns.
- **Backoff & Exponential Retry:** Implements exponential backoff upon transient network/process failures, but stops auto-polling upon authentication failure or missing binaries until explicit user retry.
- **Workspace Trust:** Automatically pauses usage monitoring in untrusted workspaces.
- **Shared In-Flight Requests:** Deduplicates concurrent refresh requests into single executions.

### C. Status Bar & Quick Pick UI (`source/status/`, `source/picker/`)

- **Status Bar Items:** Provides distinct items (`Codex`, `Gemini (AG)`, `Other (AG)`) with stable IDs so users can independently position or hide them.
- **Visual Alerting (Tone):** Escalates background tones (`Normal`, `Warning` at 80% quota, `Error` at 95%+ quota or exhausted window).
- **Interactive Quick Pick Menu:** Clicking a status bar item opens a focused drill-down detailing:
  - Exact percentage consumed and remaining.
  - Reset countdowns and timestamps in local time.
  - Actions to refresh, configure executable paths, view diagnostics, or open web usage dashboards.

### D. Python ACP Shim (`bin/antigravity-acp.py`)

A standalone, production-grade ACP (Agent Client Protocol) bridge designed to run Antigravity inside Devin Desktop:
- **Client Identity Spoofing:** Optionally spoofs client as Zed (`--spoof-zed`) to unlock provider features.
- **Devin Config & MCP Ingestion:** Automatically reads and merges MCP configurations from `.devin/mcp_config*.json`, `.devin/config.json`, and `~/.config/devin/mcp_config.json`.
- **Terminal Rendering Adaptation:** Translates Antigravity's `rawOutput` / `combinedOutput` into Devin Desktop's expected `_meta.terminal_info`, `_meta.terminal_output`, and `_meta.terminal_exit` structures.
- **In-band Management Command:** Merges a local `/devin-shim` slash command into the UI to inspect bridge health without invoking LLM models.

### E. ACP PAR Patcher (`bin/patch-agy-acp.py`)

- Performs byte-accurate in-place patching of `agy_acp_server.par` ZIP archives.
- Modifies both Python source and compiled `.pyc` bytecode inside the archive to spoof the client as `zed`.
- Retains exact member lengths, byte alignments, and checksums to ensure file stability.

---

## 4. Security & Safety Principles

1. **Credential Isolation:** The extension never inspects, caches, or interacts with user tokens, API keys, or login files. It delegates entirely to the user's logged-in CLIs.
2. **Safe Process Isolation:** CLI processes are run in isolated process groups (`setpgid`) with bounded output buffers (1 MB limit) and strict timeouts, preventing hanging sub-processes.
3. **No Unsanitized Shell Calls:** Discovery avoids relative paths or workspace-local `PATH` overrides to prevent code execution vulnerabilities.
4. **Markdown Escaping:** All CLI output strings rendered in UI hovers and Quick Picks are strictly escaped and sanitized.

---

## 5. Verification & Testing

The project maintains a 100% passing automated test suite:
- **TypeScript Unit Tests (77 tests):** Covers formatting, reset timers, backoff curves, process timeouts, mock CLI output handling, and UI state models.
- **Python ACP Unit Tests (33 tests):** Covers JSON-RPC framing, MCP translation, terminal output restructuring, and error classification.
- **Command:** `npm test` runs both suites seamlessly.
