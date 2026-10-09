# Agents

## Verification

```sh
npm ci
npm run check                 # tsc --noEmit
npm test                      # build + unit tests (fake CLIs, no account access)
npm run package               # build the VSIX
npm run package:files         # list the packaged files
```

`npm run test:integration` needs a host that forwards `--extensionTestsPath` to
the renderer. Devin Desktop 1.126 does not (its window configuration only
carries an `isExtensionTestHost` boolean), so the extension-host test module
never runs there. Do not work around this by patching the application or by
weakening Electron flags; use the Extension Development Host or an installed
VSIX for host verification instead.

Manual host check:

```sh
devin-desktop --user-data-dir=/tmp/devin-better-acp-dev --extensions-dir=/tmp/devin-better-acp-ext \
  --extensionDevelopmentPath="$PWD"
```

## Integration boundaries

- Codex is read through an ephemeral `codex app-server --stdio` that may only
  send `initialize`, `initialized`, `account/read`, and
  `account/rateLimits/read`. Never start a thread or turn, never log in or out,
  and never consume reset credits or send nudge emails.
- Antigravity is read with the standalone
  `agy --print /usage --output-format json --print-timeout 20s --mode plan`
  invocation. Never pass `--disable-slash-commands`, never reword `/usage` as a
  prompt, and stop polling if the envelope reports nonzero token usage.
- The extension never discovers, reads, copies, or refreshes provider
  credentials, and never writes to provider configuration.
- CLI output is untrusted: validate shapes, bound output size, keep provider
  text escaped in hover markdown, and never surface raw stderr or API bodies.
- Status items use the host's native status-bar, hover, and Quick Pick APIs with
  stable identifiers so the application's own visibility controls keep working.
- Diagnostics stay redacted: provider name, CLI version, classified state,
  timings, and successful-refresh age only.

## Style

TypeScript follows the conventions used in `~/Repos/autonom`: four-space
indentation, Allman braces, double quotes, camelCase functions, PascalCase
types, `ret` for explicit return values, `source/` for code, `tests/` for tests,
and `dist/` for build output. Group source modules by domain, mirror those
folders under `tests/unit/`, keep shared fixtures in `tests/support.ts`, and
put host checks in `tests/integration/`. Do not add comments unless they carry
protocol information that names cannot.
