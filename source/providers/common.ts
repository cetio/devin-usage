import { runCli, CliExit } from "../cli";
import { AdapterError, ConnectionState, ProviderInvocation } from "../usage";

export function asRecord(value: unknown): Record<string, unknown> | undefined
{
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined
{
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}

export function asNumber(value: unknown): number | undefined
{
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function classifyExit(exit: CliExit, label: string): AdapterError
{
    if (exit.spawnError !== undefined)
        return new AdapterError(ConnectionState.MissingCli, `${label} could not be started (${exit.spawnError}).`);
    if (exit.timedOut)
        return new AdapterError(ConnectionState.Unavailable, `${label} timed out.`);
    if (exit.aborted)
        return new AdapterError(ConnectionState.Unavailable, `${label} was cancelled.`);
    if (exit.outputLimitExceeded)
        return new AdapterError(ConnectionState.Unsupported, `${label} returned more data than expected.`);
    return new AdapterError(ConnectionState.Unavailable, `${label} exited unexpectedly (code ${exit.code ?? "none"}).`);
}

export async function probeVersion(invocation: ProviderInvocation, signal: AbortSignal): Promise<string>
{
    const result = await runCli({
        command: invocation.command,
        args: invocation.versionArgs,
        cwd: invocation.cwd,
        timeoutMs: invocation.versionTimeoutMs,
        maxStdoutBytes: 64 * 1024,
    }, signal);
    if (result.exit.spawnError !== undefined)
        throw classifyExit(result.exit, "The CLI");
    const text = result.stdout.trim();
    if (result.exit.timedOut || result.exit.aborted || result.exit.code !== 0 || text.length === 0)
        throw classifyExit(result.exit, "The CLI version check");
    return text;
}
