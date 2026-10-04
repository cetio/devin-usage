import { ChildProcess, spawn } from "node:child_process";

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

export type CliResult = {
    exit: CliExit;
    stdout: string;
    stderr: string;
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

export function runCli(command: CliCommand, signal?: AbortSignal): Promise<CliResult>
{
    return new Promise<CliResult>((resolve) =>
    {
        const process = CliProcess.start(command, signal);
        process.onExit((exit) => resolve({ exit, stdout: process.stdout, stderr: process.stderr }));
    });
}
