import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { CliProcess, runCli } from "../../../source/process/runner";
import { CliResolution, resolveCli } from "../../../source/process/discovery";
import { formatVersion, parseVersion, versionAtLeast } from "../../../source/process/version";
import { tempDir, writeScript } from "../../support";

const SLEEP_SCRIPT = `
setTimeout(() => process.exit(0), 5000);
`;

const LINES_SCRIPT = `
process.stdout.write("alpha\\nbeta\\ngamma");
`;

type ResolveOptions = {
    configuredPath?: string;
    workspacePaths?: string[];
    path?: string;
    home: string;
};

function resolve(name: string, options: ResolveOptions): CliResolution
{
    return resolveCli({
        name,
        configuredPath: options.configuredPath ?? "",
        workspacePaths: options.workspacePaths ?? [],
        environment: options.path === undefined ? {} : { PATH: options.path },
        home: options.home,
    });
}

test("configured CLI paths must be absolute executable files", (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "tool.cjs", "process.exit(0);\n");
    const plain = join(directory, "plain.txt");
    writeFileSync(plain, "not a program");

    const relative = resolve("tool", { configuredPath: "./tool", home: directory });
    assert.ok("error" in relative && relative.error.includes("absolute"));

    const missing = resolve("tool", { configuredPath: join(directory, "missing"), home: directory });
    assert.ok("error" in missing && missing.error.includes("executable"));

    const notExecutable = resolve("tool", { configuredPath: plain, home: directory });
    assert.ok("error" in notExecutable && notExecutable.error.includes("executable"));

    const resolved = resolve("tool", { configuredPath: script, home: directory });
    assert.ok("path" in resolved && resolved.path === script);
});

test("CLI discovery ignores relative and workspace PATH entries", (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const home = join(directory, "home");
    const bin = join(directory, "bin");
    const workspace = join(directory, "workspace");
    writeScript(bin, "tool.cjs", "process.exit(0);\n");
    writeScript(workspace, "tool.cjs", "process.exit(0);\n");

    const found = resolve("tool.cjs", { path: `${bin}:relative`, home });
    assert.ok("path" in found && found.path === join(bin, "tool.cjs"));

    const blocked = resolve("tool.cjs", { workspacePaths: [workspace], path: workspace, home });
    assert.ok("error" in blocked);

    const homeBin = join(home, ".local", "bin");
    writeScript(homeBin, "tool.cjs", "process.exit(0);\n");
    const fallback = resolve("tool.cjs", { workspacePaths: [workspace], path: "", home });
    assert.ok("path" in fallback && fallback.path === join(homeBin, "tool.cjs"));
});

test("version parsing and comparison are exact", () =>
{
    assert.deepEqual(parseVersion("codex-cli 0.160.0"), { major: 0, minor: 160, patch: 0 });
    assert.deepEqual(parseVersion("1.2.16"), { major: 1, minor: 2, patch: 16 });
    assert.equal(parseVersion("no version here"), undefined);
    assert.equal(formatVersion({ major: 1, minor: 2, patch: 16 }), "1.2.16");
    assert.equal(versionAtLeast({ major: 1, minor: 2, patch: 16 }, { major: 1, minor: 2, patch: 16 }), true);
    assert.equal(versionAtLeast({ major: 1, minor: 2, patch: 15 }, { major: 1, minor: 2, patch: 16 }), false);
    assert.equal(versionAtLeast({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 }), true);
});

test("a CLI run captures output and exit codes", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "lines.cjs", LINES_SCRIPT);
    const result = await runCli({ command: script, args: [], cwd: directory, timeoutMs: 5000 });

    assert.equal(result.exit.code, 0);
    assert.equal(result.exit.timedOut, false);
    assert.equal(result.stdout, "alpha\nbeta\ngamma");
});

test("a CLI run reports line events and final partial lines", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "lines.cjs", LINES_SCRIPT);
    const lines: string[] = [];
    const process = CliProcess.start({ command: script, args: [], cwd: directory, timeoutMs: 5000 });
    process.onLine((line) => lines.push(line));
    await new Promise<void>((resolve) => process.onExit(() => resolve()));

    assert.deepEqual(lines, ["alpha", "beta", "gamma"]);
});

test("a hanging CLI is terminated as a group and reaped", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "sleep.cjs", SLEEP_SCRIPT);
    const process = CliProcess.start({ command: script, args: [], cwd: directory, timeoutMs: 300 });
    const pid = process.pid;
    const result = await new Promise<{ timedOut: boolean }>((resolve) => process.onExit((exit) => resolve(exit)));

    assert.equal(result.timedOut, true);
    assert.ok(pid !== undefined);
    assert.equal(processIsRunning(pid), false);
});

test("a CLI that spawns a child has its whole group terminated", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const marker = join(directory, "marker.txt");
    const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1200)`;
    const script = writeScript(directory, "parent.cjs", `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });
setTimeout(() => process.exit(0), 30000);
`);
    const process = CliProcess.start({ command: script, args: [], cwd: directory, timeoutMs: 30000 });
    await delay(200);
    process.terminate();
    await new Promise<void>((resolve) => process.onExit(() => resolve()));
    await delay(1600);

    assert.equal(existsSync(marker), false);
});

test("output limits stop runaway CLI output", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "flood.cjs", `
process.stdout.write("x".repeat(2048));
setTimeout(() => process.exit(0), 30000);
`);
    const result = await runCli({ command: script, args: [], cwd: directory, timeoutMs: 5000, maxStdoutBytes: 256 });
    assert.equal(result.exit.outputLimitExceeded, true);
});

test("missing executables surface as spawn errors", async () =>
{
    const result = await runCli({ command: "/nonexistent/devin-better-acp-tool", args: [], cwd: "/tmp", timeoutMs: 1000 });
    assert.equal(result.exit.spawnError, "ENOENT");
});

test("aborting a CLI run terminates it", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "sleep.cjs", SLEEP_SCRIPT);
    const controller = new AbortController();
    const running = runCli({ command: script, args: [], cwd: directory, timeoutMs: 30000 }, controller.signal);
    await delay(150);
    controller.abort();
    const result = await running;

    assert.equal(result.exit.aborted, true);
});

function processIsRunning(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch
    {
        return false;
    }
}

function removeDirectory(path: string): void
{
    rmSync(path, { recursive: true, force: true });
}
