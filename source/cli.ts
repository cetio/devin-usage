import { ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";

const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024;
const KILL_GRACE_MS = 2000;

export type CliCommand = {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
};

export type CliExit = {
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    aborted: boolean;
    spawnError: string | undefined;
    outputLimitExceeded: boolean;
};

export type Version = {
    major: number;
    minor: number;
    patch: number;
};

export class CliProcess
{
    private readonly command: CliCommand;
    private readonly child: ChildProcess;
    private readonly stdoutChunks: string[] = [];
    private readonly lineHandlers: Array<(line: string) => void> = [];
    private readonly exitHandlers: Array<(exit: CliExit) => void> = [];
    private stderrText = "";
    private lineBuffer = "";
    private stdoutBytes = 0;
    private stderrBytes = 0;
    private timedOut = false;
    private aborted = false;
    private outputLimitExceeded = false;
    private exited = false;
    private exit: CliExit | undefined;
    private timeoutTimer: NodeJS.Timeout | undefined;
    private killTimer: NodeJS.Timeout | undefined;
    private abortHandler: (() => void) | undefined;

    static start(command: CliCommand, signal?: AbortSignal): CliProcess
    {
        const child = spawn(command.command, command.args, {
            cwd: command.cwd,
            detached: process.platform !== "win32",
            windowsHide: true,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        return new CliProcess(command, child, signal);
    }

    private constructor(command: CliCommand, child: ChildProcess, signal: AbortSignal | undefined)
    {
        this.command = command;
        this.child = child;
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => this.consumeStdout(chunk));
        child.stderr?.on("data", (chunk: string) => this.consumeStderr(chunk));
        child.on("error", (error: NodeJS.ErrnoException) => this.finish({ spawnError: error.code ?? error.message }));
        child.on("close", (code: number | null, signalName: NodeJS.Signals | null) =>
        {
            this.finish({ code, signal: signalName });
        });
        this.timeoutTimer = setTimeout(() => this.handleTimeout(), command.timeoutMs);
        this.timeoutTimer.unref();
        if (signal !== undefined)
        {
            this.abortHandler = () => this.handleAbort();
            if (signal.aborted)
                this.handleAbort();
            else
                signal.addEventListener("abort", this.abortHandler, { once: true });
        }
    }

    get stdout(): string
    {
        return this.stdoutChunks.join("");
    }

    get stderr(): string
    {
        return this.stderrText;
    }

    get pid(): number | undefined
    {
        return this.child.pid;
    }

    get running(): boolean
    {
        return !this.exited;
    }

    onLine(handler: (line: string) => void): void
    {
        this.lineHandlers.push(handler);
    }

    onExit(handler: (exit: CliExit) => void): void
    {
        if (this.exit !== undefined)
        {
            handler(this.exit);
            return;
        }
        this.exitHandlers.push(handler);
    }

    write(text: string): void
    {
        if (this.exited || this.child.stdin === null || this.child.stdin.destroyed)
            return;
        try
        {
            this.child.stdin.write(text);
        }
        catch
        {
            this.closeInput();
        }
    }

    closeInput(): void
    {
        if (this.child.stdin === null || this.child.stdin.destroyed)
            return;
        this.child.stdin.end();
    }

    terminate(): void
    {
        if (this.exited)
            return;
        this.signalGroup("SIGTERM");
        if (this.killTimer === undefined)
        {
            this.killTimer = setTimeout(() => this.signalGroup("SIGKILL"), KILL_GRACE_MS);
            this.killTimer.unref();
        }
    }

    private consumeStdout(chunk: string): void
    {
        if (this.outputLimitExceeded)
            return;
        this.stdoutBytes += Buffer.byteLength(chunk);
        if (this.stdoutBytes > (this.command.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES))
        {
            this.outputLimitExceeded = true;
            this.signalGroup("SIGKILL");
            return;
        }
        this.stdoutChunks.push(chunk);
        this.lineBuffer += chunk;
        let index = this.lineBuffer.indexOf("\n");
        while (index >= 0)
        {
            const line = this.lineBuffer.slice(0, index).replace(/\r$/, "");
            this.lineBuffer = this.lineBuffer.slice(index + 1);
            for (const handler of this.lineHandlers)
                handler(line);
            index = this.lineBuffer.indexOf("\n");
        }
    }

    private consumeStderr(chunk: string): void
    {
        const limit = this.command.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
        if (this.stderrBytes >= limit)
            return;
        this.stderrBytes += Buffer.byteLength(chunk);
        this.stderrText = `${this.stderrText}${chunk}`.slice(0, limit);
    }

    private handleTimeout(): void
    {
        if (this.exited)
            return;
        this.timedOut = true;
        this.terminate();
    }

    private handleAbort(): void
    {
        if (this.exited)
            return;
        this.aborted = true;
        this.terminate();
    }

    private signalGroup(signal: NodeJS.Signals): void
    {
        const pid = this.child.pid;
        if (pid === undefined)
            return;
        if (process.platform === "win32")
        {
            CliProcess.attempt(() => this.child.kill(signal));
            return;
        }
        if (!CliProcess.attempt(() => process.kill(-pid, signal)))
            CliProcess.attempt(() => this.child.kill(signal));
    }

    private static attempt(action: () => void): boolean
    {
        try
        {
            action();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private finish(partial: { code?: number | null; signal?: NodeJS.Signals | null; spawnError?: string }): void
    {
        if (this.exited)
            return;
        this.exited = true;
        if (this.timeoutTimer !== undefined)
            clearTimeout(this.timeoutTimer);
        if (this.killTimer !== undefined)
            clearTimeout(this.killTimer);
        if (this.abortHandler !== undefined)
            this.abortHandler = undefined;
        if (this.lineBuffer.length > 0 && !this.outputLimitExceeded)
        {
            const line = this.lineBuffer.replace(/\r$/, "");
            this.lineBuffer = "";
            for (const handler of this.lineHandlers)
                handler(line);
        }
        this.exit = {
            code: partial.code ?? null,
            signal: partial.signal ?? null,
            timedOut: this.timedOut,
            aborted: this.aborted,
            spawnError: partial.spawnError,
            outputLimitExceeded: this.outputLimitExceeded,
        };
        const handlers = this.exitHandlers.splice(0, this.exitHandlers.length);
        for (const handler of handlers)
            handler(this.exit);
    }
}

export type CliResult = {
    exit: CliExit;
    stdout: string;
    stderr: string;
};

export function runCli(command: CliCommand, signal?: AbortSignal): Promise<CliResult>
{
    return new Promise<CliResult>((resolve) =>
    {
        const process = CliProcess.start(command, signal);
        process.onExit((exit) => resolve({ exit, stdout: process.stdout, stderr: process.stderr }));
    });
}

export type CliResolution = { path: string } | { error: string };

export type ResolveCliOptions = {
    name: string;
    configuredPath: string;
    workspacePaths: string[];
    environment: NodeJS.ProcessEnv;
    home: string;
};

export function resolveCli(options: ResolveCliOptions): CliResolution
{
    const configured = options.configuredPath.trim();
    if (configured.length > 0)
    {
        if (!isAbsolute(configured))
            return { error: `The configured ${options.name} path must be absolute.` };
        if (!isExecutableFile(configured))
            return { error: `The configured ${options.name} path is not an executable file.` };
        return { path: configured };
    }
    const candidates: string[] = [join(options.home, ".local", "bin", options.name)];
    const entries = (options.environment.PATH ?? "").split(delimiter);
    for (const entry of entries)
    {
        if (entry.length === 0 || !isAbsolute(entry))
            continue;
        if (isInsideAny(entry, options.workspacePaths))
            continue;
        candidates.push(join(entry, options.name));
    }
    for (const candidate of candidates)
    {
        if (isExecutableFile(candidate))
            return { path: candidate };
    }
    return { error: `The ${options.name} CLI was not found. Install it or set an absolute path in settings.` };
}

export function isExecutableFile(path: string): boolean
{
    try
    {
        if (!statSync(path).isFile())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch
    {
        return false;
    }
}

function isInsideAny(path: string, parents: string[]): boolean
{
    for (const parent of parents)
    {
        if (parent.length === 0)
            continue;
        const rel = relative(parent, path);
        if (rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel)))
            return true;
    }
    return false;
}

export function parseVersion(text: string): Version | undefined
{
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
    if (match === null)
        return undefined;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch))
        return undefined;
    return { major, minor, patch };
}

export function versionAtLeast(version: Version, minimum: Version): boolean
{
    if (version.major !== minimum.major)
        return version.major > minimum.major;
    if (version.minor !== minimum.minor)
        return version.minor > minimum.minor;
    return version.patch >= minimum.patch;
}

export function formatVersion(version: Version): string
{
    return `${version.major}.${version.minor}.${version.patch}`;
}
