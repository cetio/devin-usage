import { ConnectionState, ProviderSnapshot, ProviderStatus } from "./usage";

export const MAX_BACKOFF_MS = 30 * 60 * 1000;

export function backoffDelayMs(intervalMs: number, failures: number): number
{
    if (intervalMs <= 0)
        return 0;
    const factor = 2 ** Math.min(Math.max(failures, 0), 5);
    return Math.min(intervalMs * factor, MAX_BACKOFF_MS);
}

export function earliestResetAt(snapshot: ProviderSnapshot | undefined, now: number): number | undefined
{
    if (snapshot === undefined)
        return undefined;
    let ret: number | undefined;
    for (const pool of snapshot.pools)
    {
        for (const window of pool.windows)
        {
            if (window.resetsAt === undefined || window.resetsAt <= now)
                continue;
            if (ret === undefined || window.resetsAt < ret)
                ret = window.resetsAt;
        }
    }
    return ret;
}

export function isStale(lastSuccessAt: number | undefined, now: number, staleAfterMs: number): boolean
{
    if (lastSuccessAt === undefined || !Number.isFinite(staleAfterMs))
        return false;
    return now - lastSuccessAt > staleAfterMs;
}

export function snapshotIsStale(status: ProviderStatus, now: number, staleAfterMs: number): boolean
{
    if (status.snapshot === undefined)
        return false;
    if (status.state !== ConnectionState.Ready && status.state !== ConnectionState.Partial)
        return true;
    return isStale(status.lastSuccessAt, now, staleAfterMs);
}

export function isTerminal(state: ConnectionState): boolean
{
    return state === ConnectionState.AuthRequired
        || state === ConnectionState.MissingCli
        || state === ConnectionState.Unsupported
        || state === ConnectionState.Disabled;
}

export function isHealthy(state: ConnectionState): boolean
{
    return state === ConnectionState.Ready || state === ConnectionState.Partial;
}
